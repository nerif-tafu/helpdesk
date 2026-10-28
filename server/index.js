import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import http from 'http';
import * as db from './db.js';
import {
  initSettings,
  getRooms,
  setRooms,
  getAdminSettingsView,
  getAvailability,
  resolveHelpBaseUrl,
  setSchedule,
  setWifi,
  setHelpBaseUrl,
  getSsoRequired,
  setSsoRequired,
  getGuides,
  getGuideBySlug,
  createGuide,
  updateGuide,
  deleteGuide,
  moveGuide,
  updateTelegram,
  exportHelpdeskData,
  importHelpdeskData,
} from './settings.js';
import { findRoomByParam } from './rooms.js';
import { renderPrintDocument } from './print.js';
import { renderGuidePage, renderGuideNotFoundPage, toGuideCard } from './guides.js';
import {
  getSsoUser,
  getSsoUserFromHeaders,
  startLogin as startSsoLogin,
  handleCallback as handleSsoCallback,
  logout as ssoLogout,
  ssoDisplayName,
} from './sso.js';
import {
  notifyTelegram,
  formatNewMessageNotification,
  getTelegramLogs,
  sendTelegramTestMessage,
} from './telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'helpdesk';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret';
initSettings();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Behind a reverse proxy, honour X-Forwarded-Proto/Host so Ubuntu SSO return URLs are correct.
if (process.env.TRUST_PROXY) {
  const value = process.env.TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(value) ? Number(value) : value === 'true' ? true : value);
}

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.get('/favicon.ico', (_req, res) => res.redirect(301, '/favicon.png'));
app.use(express.static(path.join(__dirname, '..', 'public')));

const sessions = new Map();

function signSession() {
  return crypto.randomBytes(32).toString('hex');
}

function isAdmin(req) {
  const token = req.cookies?.admin_session;
  return token && sessions.has(token);
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function publicSsoUser(user) {
  return user ? { name: ssoDisplayName(user), email: user.email, nickname: user.nickname } : null;
}

// Participants may use a conversation when it was started by the same Ubuntu SSO
// account, or (for conversations without an SSO owner) when SSO is not required
// or they are signed in. Support admins can always access conversations.
function canParticipantAccess(conversation, user) {
  if (conversation.participant_sso) {
    return Boolean(user) && user.id === conversation.participant_sso.id;
  }
  return !getSsoRequired() || Boolean(user);
}

function requireConversationAccess(req, res, conversation) {
  if (isAdmin(req) || canParticipantAccess(conversation, getSsoUser(req))) return true;
  res.status(getSsoUser(req) ? 403 : 401).json({
    error: 'Sign in with Ubuntu SSO to access this chat',
    ssoRequired: true,
  });
  return false;
}

const clients = new Map();
const typingTimers = new Map();

function broadcast(conversationId, payload, except) {
  const set = clients.get(conversationId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const client of set) {
    if (client.ws.readyState !== 1) continue;
    if (except && client.ws === except) continue;
    client.ws.send(data);
  }
}

function typingKey(conversationId, sender) {
  return `${conversationId}:${sender}`;
}

function clearTypingTimer(conversationId, sender) {
  const key = typingKey(conversationId, sender);
  const t = typingTimers.get(key);
  if (t) clearTimeout(t);
  typingTimers.delete(key);
}

function relayTyping(conversationId, sender, typing, except) {
  clearTypingTimer(conversationId, sender);
  broadcast(conversationId, { type: 'typing', sender, typing }, except);
  if (typing) {
    typingTimers.set(
      typingKey(conversationId, sender),
      setTimeout(() => {
        typingTimers.delete(typingKey(conversationId, sender));
        broadcast(conversationId, { type: 'typing', sender, typing: false });
      }, 5000)
    );
  }
}

function isParticipantOnline(conversationId) {
  const set = clients.get(conversationId);
  if (!set) return false;
  for (const client of set) {
    if (client.sender === 'participant' && client.ws.readyState === 1) return true;
  }
  return false;
}

function enrichConversation(conversation) {
  if (!conversation) return null;
  return {
    ...conversation,
    participant_online: isParticipantOnline(conversation.id),
  };
}

function broadcastPresence(conversationId) {
  const payload = {
    type: 'presence',
    conversationId,
    participantOnline: isParticipantOnline(conversationId),
  };
  broadcast(conversationId, payload);
  const data = JSON.stringify(payload);
  for (const set of clients.values()) {
    for (const client of set) {
      if (client.sender !== 'support' || client.ws.readyState !== 1) continue;
      client.ws.send(data);
    }
  }
}

function dropClient(conversationId, client) {
  const set = clients.get(conversationId);
  if (!set) return;
  set.delete(client);
  if (client.sender) {
    clearTypingTimer(conversationId, client.sender);
    broadcast(conversationId, { type: 'typing', sender: client.sender, typing: false });
  }
  broadcastPresence(conversationId);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const conversationId = url.searchParams.get('conversationId');
  const role = url.searchParams.get('role');
  if (!conversationId) {
    ws.close(4000, 'conversationId required');
    return;
  }
  if (!['participant', 'support'].includes(role)) {
    ws.close(4000, 'role must be participant or support');
    return;
  }
  const conversation = db.getConversation(conversationId);
  if (!conversation) {
    ws.close(4004, 'Conversation not found');
    return;
  }
  const adminToken = parseCookieHeader(req.headers.cookie).admin_session;
  if (role === 'support' && !(adminToken && sessions.has(adminToken))) {
    ws.close(4001, 'Unauthorized');
    return;
  }
  if (role === 'participant' && !canParticipantAccess(conversation, getSsoUserFromHeaders(req.headers))) {
    ws.close(4001, 'Unauthorized');
    return;
  }
  const client = { ws, sender: role };
  if (!clients.has(conversationId)) clients.set(conversationId, new Set());
  clients.get(conversationId).add(client);

  if (role === 'support') {
    const updated = db.markSupportJoined(conversationId);
    if (updated) {
      broadcast(conversationId, {
        type: 'status',
        conversation: enrichConversation(updated),
      });
    }
  }
  if (role === 'participant') {
    broadcastPresence(conversationId);
  }

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(String(raw));
      if (data.type === 'typing' && data.sender === role && typeof data.typing === 'boolean') {
        relayTyping(conversationId, role, data.typing, ws);
      }
    } catch {
      // ignore malformed frames
    }
  });

  ws.on('close', () => dropClient(conversationId, client));
});

function parseCookieHeader(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

app.get('/auth/sso/login', (req, res) => startSsoLogin(req, res));

app.get('/auth/sso/callback', (req, res) => handleSsoCallback(req, res));

// OpenID providers may return large responses as a cross-site form POST, which
// would not carry our SameSite=Lax state cookie. Re-issue it as a top-level GET.
app.post('/auth/sso/callback', express.urlencoded({ extended: false }), (req, res) => {
  const params = new URLSearchParams(req.query);
  for (const [key, value] of Object.entries(req.body || {})) params.set(key, String(value));
  res.redirect(303, `/auth/sso/callback?${params}`);
});

app.post('/auth/sso/logout', (req, res) => {
  ssoLogout(req, res);
  res.json({ ok: true });
});

app.get('/api/sso/me', (req, res) => {
  res.json({ ssoRequired: getSsoRequired(), user: publicSsoUser(getSsoUser(req)) });
});

app.get('/api/guides', (_req, res) => {
  res.json({ guides: getGuides().filter((g) => g.enabled).map(toGuideCard) });
});

app.get(['/guides/:slug.html', '/guides/:slug'], (req, res) => {
  const guide = getGuideBySlug(req.params.slug);
  if (!guide || (!guide.enabled && !isAdmin(req))) {
    return res.status(404).type('html').send(renderGuideNotFoundPage());
  }
  res.type('html').send(renderGuidePage(guide));
});

app.get('/location/:slug', (req, res) => {
  res.redirect(`/?room=${encodeURIComponent(req.params.slug)}`);
});

app.get('/api/rooms', (_req, res) => {
  res.json({ rooms: getRooms() });
});

app.get('/api/availability', (_req, res) => {
  res.json(getAvailability());
});

app.post('/api/conversations', (req, res) => {
  const availability = getAvailability();
  if (!availability.open) {
    return res.status(403).json({ error: availability.message });
  }
  const ssoUser = getSsoUser(req);
  if (getSsoRequired() && !ssoUser) {
    return res
      .status(401)
      .json({ error: 'Sign in with Ubuntu SSO to start a chat', ssoRequired: true });
  }
  const { room, participantName } = req.body || {};
  if (!room || !getRooms().includes(room)) {
    return res.status(400).json({ error: 'Invalid room' });
  }
  const name = String(participantName || '').trim() || (ssoUser ? ssoDisplayName(ssoUser) : '');
  const conversation = db.createConversation(room, name, ssoUser);
  res.status(201).json({ conversation });
});

app.get('/api/conversations/:id', (req, res) => {
  const conversation = db.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Not found' });
  if (!requireConversationAccess(req, res, conversation)) return;
  res.json({ conversation: enrichConversation(conversation) });
});

app.get('/api/conversations/:id/messages', (req, res) => {
  const conversation = db.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Not found' });
  if (!requireConversationAccess(req, res, conversation)) return;
  res.json({ messages: db.getMessages(req.params.id) });
});

app.post('/api/conversations/:id/messages', async (req, res) => {
  const { body, sender } = req.body || {};
  const conversation = db.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Not found' });
  if (conversation.status === 'resolved') {
    return res.status(400).json({ error: 'Conversation is resolved' });
  }
  if (!body?.trim()) return res.status(400).json({ error: 'Message required' });
  if (!['participant', 'support'].includes(sender)) {
    return res.status(400).json({ error: 'Invalid sender' });
  }
  if (sender === 'support' && !isAdmin(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (sender === 'participant' && !requireConversationAccess(req, res, conversation)) return;
  const message = db.addMessage(req.params.id, sender, body);
  const updated = enrichConversation(db.getConversation(req.params.id));
  broadcast(req.params.id, { type: 'message', message, conversation: updated });
  relayTyping(req.params.id, sender, false);
  await notifyTelegram(
    formatNewMessageNotification({
      baseUrl: resolveHelpBaseUrl(req),
      room: conversation.room,
      conversationId: conversation.id,
      participantName: conversation.participant_name,
      sender,
      body: message.body,
    })
  );
  res.status(201).json({ message, conversation: updated });
});

function setConversationStatus(conversationId, status) {
  db.updateConversationStatus(conversationId, status);
  const updated = enrichConversation(db.getConversation(conversationId));
  broadcast(conversationId, { type: 'status', conversation: updated });
  return updated;
}

app.post('/api/conversations/:id/end', (req, res) => {
  const conversation = db.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Not found' });
  if (!requireConversationAccess(req, res, conversation)) return;
  if (conversation.status === 'resolved') {
    return res.json({ conversation });
  }
  const updated = setConversationStatus(req.params.id, 'resolved');
  res.json({ conversation: updated });
});

app.patch('/api/conversations/:id', requireAdmin, (req, res) => {
  const { status } = req.body || {};
  const conversation = db.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Not found' });
  if (!['waiting', 'joined', 'active', 'resolved'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const updated = setConversationStatus(req.params.id, status);
  res.json({ conversation: updated });
});

app.get('/api/admin/conversations', requireAdmin, (req, res) => {
  const status = req.query.status;
  const conversations = db
    .listConversations(status || undefined)
    .map((c) => enrichConversation(c));
  res.json({ conversations });
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = signSession();
  sessions.set(token, { createdAt: Date.now() });
  res.cookie('admin_session', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    signed: false,
  });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  const token = req.cookies?.admin_session;
  if (token) sessions.delete(token);
  res.clearCookie('admin_session');
  res.json({ ok: true });
});

app.get('/api/admin/me', (req, res) => {
  res.json({ authenticated: isAdmin(req) });
});

app.get('/api/admin/settings', requireAdmin, (_req, res) => {
  res.json(getAdminSettingsView());
});

app.get('/api/admin/telegram/logs', requireAdmin, (_req, res) => {
  res.json({ logs: getTelegramLogs() });
});

app.post('/api/admin/telegram/test', requireAdmin, async (req, res) => {
  const { telegramBotToken, telegramChatId } = req.body || {};
  const overrides = {};
  if (telegramBotToken !== undefined) overrides.token = telegramBotToken;
  if (telegramChatId !== undefined) overrides.chatId = telegramChatId;
  const result = await sendTelegramTestMessage(overrides);
  if (result.ok) return res.json({ ok: true });
  res.status(400).json({ error: result.error || 'Test message failed' });
});

app.get('/api/admin/print', requireAdmin, async (req, res) => {
  const roomParam = req.query.room;
  if (!roomParam) {
    return res.status(400).send('Missing room query (room name or "all")');
  }
  const allRooms = getRooms();
  let names;
  if (roomParam === 'all') {
    names = allRooms;
  } else {
    const match = findRoomByParam(roomParam, allRooms);
    if (!match) return res.status(404).send('Room not found');
    names = [match];
  }
  if (!names.length) return res.status(400).send('No rooms configured');
  try {
    const html = await renderPrintDocument(names, req);
    res.type('html').send(html);
  } catch (err) {
    res.status(500).send(err.message || 'Failed to generate printout');
  }
});

app.get('/api/admin/guides', requireAdmin, (_req, res) => {
  res.json({ guides: getGuides() });
});

function sendGuideError(res, err) {
  res.status(400).json({ error: err.message || 'Invalid guide' });
}

app.post('/api/admin/guides', requireAdmin, (req, res) => {
  try {
    const guide = createGuide(req.body || {});
    res.status(201).json({ guide, guides: getGuides() });
  } catch (err) {
    sendGuideError(res, err);
  }
});

app.put('/api/admin/guides/:id', requireAdmin, (req, res) => {
  try {
    const guide = updateGuide(req.params.id, req.body || {});
    if (!guide) return res.status(404).json({ error: 'Guide not found' });
    res.json({ guide, guides: getGuides() });
  } catch (err) {
    sendGuideError(res, err);
  }
});

app.post('/api/admin/guides/:id/move', requireAdmin, (req, res) => {
  const { direction } = req.body || {};
  if (!['up', 'down'].includes(direction)) {
    return res.status(400).json({ error: 'direction must be "up" or "down"' });
  }
  const guides = moveGuide(req.params.id, direction);
  if (!guides) return res.status(404).json({ error: 'Guide not found' });
  res.json({ guides });
});

app.delete('/api/admin/guides/:id', requireAdmin, (req, res) => {
  if (!deleteGuide(req.params.id)) return res.status(404).json({ error: 'Guide not found' });
  res.json({ guides: getGuides() });
});

app.get('/api/admin/data/export', requireAdmin, (_req, res) => {
  const snapshot = exportHelpdeskData();
  const filename = `helpdesk-export-${snapshot.exportedAt.slice(0, 10)}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(snapshot, null, 2));
});

app.post('/api/admin/data/import', requireAdmin, (req, res) => {
  const { data, settingsOnly } = req.body || {};
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'data must be a JSON object' });
  }
  try {
    importHelpdeskData(data, { settingsOnly: Boolean(settingsOnly) });
    res.json({ ok: true, ...getAdminSettingsView() });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Import failed' });
  }
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const {
    rooms,
    schedule: scheduleBody,
    telegramBotToken,
    telegramChatId,
    wifi: wifiBody,
    helpBaseUrl,
    ssoRequired,
  } = req.body || {};
  try {
    if (rooms !== undefined) {
      if (!Array.isArray(rooms)) {
        return res.status(400).json({ error: 'rooms must be an array' });
      }
      setRooms(rooms);
    }
    if (wifiBody !== undefined) {
      if (!wifiBody || typeof wifiBody !== 'object') {
        return res.status(400).json({ error: 'wifi must be an object' });
      }
      setWifi(wifiBody);
    }
    if (helpBaseUrl !== undefined) {
      setHelpBaseUrl(helpBaseUrl);
    }
    if (ssoRequired !== undefined) {
      setSsoRequired(ssoRequired);
    }
    if (scheduleBody !== undefined) {
      if (!scheduleBody || typeof scheduleBody !== 'object') {
        return res.status(400).json({ error: 'schedule must be an object' });
      }
      setSchedule(scheduleBody);
    }
    if (telegramBotToken !== undefined || telegramChatId !== undefined) {
      updateTelegram({
        botToken: telegramBotToken,
        chatId: telegramChatId,
      });
    }
    res.json(getAdminSettingsView());
  } catch (err) {
    res.status(400).json({ error: err.message || 'Invalid settings' });
  }
});

function listAccessUrls(port) {
  const urls = new Set([`http://localhost:${port}`]);
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      const v4 = iface.family === 'IPv4' || iface.family === 4;
      if (v4 && !iface.internal) {
        urls.add(`http://${iface.address}:${port}`);
      }
    }
  }
  return [...urls];
}

server.listen(PORT, HOST, () => {
  console.log(`Help desk listening on ${HOST}:${PORT}`);
  for (const url of listAccessUrls(PORT)) {
    console.log(`  ${url}`);
    console.log(`  ${url}/admin.html`);
  }
  const { telegram } = getAdminSettingsView();
  if (!telegram.tokenSet || !telegram.chatId) {
    console.log('Telegram notifications disabled (configure in admin Settings)');
  }
});
