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
  setSchedule,
  setWifi,
  setHelpBaseUrl,
  updateTelegram,
  exportHelpdeskData,
  importHelpdeskData,
} from './settings.js';
import { findRoomByParam } from './rooms.js';
import { renderPrintDocument } from './print.js';
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

app.use(express.json());
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
  if (!db.getConversation(conversationId)) {
    ws.close(4004, 'Conversation not found');
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
  const { room, participantName } = req.body || {};
  if (!room || !getRooms().includes(room)) {
    return res.status(400).json({ error: 'Invalid room' });
  }
  const conversation = db.createConversation(room, participantName);
  res.status(201).json({ conversation });
});

app.get('/api/conversations/:id', (req, res) => {
  const conversation = db.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Not found' });
  res.json({ conversation: enrichConversation(conversation) });
});

app.get('/api/conversations/:id/messages', (req, res) => {
  const conversation = db.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Not found' });
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
  const message = db.addMessage(req.params.id, sender, body);
  const updated = enrichConversation(db.getConversation(req.params.id));
  broadcast(req.params.id, { type: 'message', message, conversation: updated });
  relayTyping(req.params.id, sender, false);
  if (sender === 'participant') {
    await notifyTelegram(
      formatNewMessageNotification({
        room: conversation.room,
        participantName: conversation.participant_name,
        body: message.body,
        conversationId: conversation.id,
      })
    );
  }
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
