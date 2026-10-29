import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import http from 'http';
import proxyaddr from 'proxy-addr';
import * as db from './db.js';
import { rateLimit } from './rate-limit.js';
import {
  AUDIT_CATEGORIES,
  MAX_AUDIT_ENTRIES,
  auditCsv,
  queryAudit,
  recordAudit,
} from './audit.js';
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
  normalizeTelegramProxy,
  checkAdmin,
  getAdmins,
  addAdmin,
  removeAdmin,
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
const APP_VERSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
).version;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
initSettings();

const app = express();
const server = http.createServer(app);
// Clients only send small typing frames; refuse anything large.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 });

// Behind a reverse proxy, honour X-Forwarded-Proto/Host so Ubuntu SSO return URLs are correct.
if (process.env.TRUST_PROXY) {
  const value = process.env.TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(value) ? Number(value) : value === 'true' ? true : value);
}

app.disable('x-powered-by');

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

/** True when a browser request comes from another site (CSRF / cross-site WebSocket). */
function isCrossSite(headers) {
  // Modern browsers say directly whether a request is same-origin.
  const fetchSite = headers['sec-fetch-site'];
  if (fetchSite) return !['same-origin', 'none'].includes(fetchSite);
  // Older browsers: compare Origin with the host. Non-browser clients send neither.
  const origin = headers.origin;
  if (!origin) return false;
  try {
    const { host } = new URL(origin);
    return host !== headers.host && host !== headers['x-forwarded-host'];
  } catch {
    return true;
  }
}

// Reject cross-site state-changing requests. The Ubuntu SSO callback is the one
// cross-site POST we expect (login.ubuntu.com may POST back to us).
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path === '/auth/sso/callback') return next();
  if (isCrossSite(req.headers)) {
    req.audit = { action: 'http.cross_site_blocked', details: { origin: req.get('origin') } };
    return res.status(403).json({ error: 'Cross-site request blocked' });
  }
  next();
});

/** The signed-in Ubuntu SSO user if they are a support admin, else null. */
function adminUser(user) {
  return user && checkAdmin(user).ok ? user : null;
}

/** Who is making a request, for the audit log. */
function describeActor(ssoUser) {
  if (!ssoUser) return 'anonymous';
  const name = ssoUser.email || ssoUser.nickname || ssoDisplayName(ssoUser);
  return adminUser(ssoUser) ? `${name} (admin)` : name;
}

/** Attach a meaningful audit event to this request; it is written when the response finishes. */
function audit(req, action, details = {}, target) {
  req.audit = { action, details, target };
}

function isPageView(req) {
  return (
    (req.method === 'GET' || req.method === 'HEAD') &&
    !req.path.startsWith('/api/') &&
    req.path !== '/ws' &&
    !path.extname(req.path)
  );
}

// Audit every page view, every change, and every denied request (with the client IP).
app.use((req, res, next) => {
  const actor = describeActor(getSsoUser(req));
  res.on('finish', () => {
    const base = {
      ip: req.ip,
      actor: req.auditActor || actor,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      userAgent: req.get('user-agent'),
    };
    if (req.audit) {
      recordAudit({ ...base, ...req.audit });
    } else if (isPageView(req)) {
      recordAudit({ ...base, action: 'page.view', details: { query: req.originalUrl.split('?')[1] } });
    } else if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      recordAudit({ ...base, action: 'http.request' });
    } else if (res.statusCode === 401 || res.statusCode === 403) {
      recordAudit({ ...base, action: 'http.denied' });
    }
  });
  next();
});
app.get('/favicon.ico', (_req, res) => res.redirect(301, '/favicon.png'));
const publicDir = path.join(__dirname, '..', 'public');

// Clean URLs: /admin.html → /admin, /index.html → /, /chat.html?id=X → /chat/X.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const match = /^(.*)\.html$/.exec(req.path);
  if (!match) return next();
  const params = new URLSearchParams(req.query);
  // Collapse leading slashes so //evil.com/x.html cannot become an off-site redirect.
  let target = match[1] === '/index' ? '/' : `/${match[1].replace(/^[/\\]+/, '')}`;
  if (target === '/chat' && params.get('id')) {
    target = `/chat/${encodeURIComponent(params.get('id'))}`;
    params.delete('id');
  }
  const qs = params.toString();
  res.redirect(301, qs ? `${target}?${qs}` : target);
});

app.use(express.static(publicDir, { extensions: ['html'] }));

function isAdmin(req) {
  return Boolean(adminUser(getSsoUser(req)));
}

function requireAdmin(req, res, next) {
  const user = getSsoUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in with Ubuntu SSO' });
  const result = checkAdmin(user);
  if (!result.ok) {
    if (result.reason === 'identity-mismatch') {
      req.audit = { action: 'admin.identity_mismatch', details: { email: user.email, account: user.id } };
    }
    return res.status(403).json({ error: 'Your account is not a support admin' });
  }
  req.admin = user;
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

function wsAudit(req, action, details, target) {
  recordAudit({
    action,
    ip: proxyaddr(req, app.get('trust proxy fn')),
    actor: describeActor(getSsoUserFromHeaders(req.headers)),
    target,
    path: '/ws',
    userAgent: req.headers['user-agent'],
    details,
  });
}

// A bad frame from one client (oversized, malformed) must never crash the server.
wss.on('error', (err) => console.error(`WebSocket server error: ${err.message}`));

wss.on('connection', (ws, req) => {
  ws.on('error', (err) => {
    wsAudit(req, 'connection.error', { error: err.message, code: err.code });
    ws.terminate();
  });
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const conversationId = url.searchParams.get('conversationId');
  const role = url.searchParams.get('role');
  const connectedAt = Date.now();
  if (isCrossSite(req.headers)) {
    wsAudit(req, 'connection.denied', { role, reason: 'cross-site', origin: req.headers.origin });
    ws.close(4003, 'Cross-site connection refused');
    return;
  }
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
  if (role === 'support' && !adminUser(getSsoUserFromHeaders(req.headers))) {
    wsAudit(req, 'connection.denied', { role, room: conversation.room }, conversationId);
    ws.close(4001, 'Unauthorized');
    return;
  }
  if (role === 'participant' && !canParticipantAccess(conversation, getSsoUserFromHeaders(req.headers))) {
    wsAudit(req, 'connection.denied', { role, room: conversation.room }, conversationId);
    ws.close(4001, 'Unauthorized');
    return;
  }
  wsAudit(req, 'connection.open', { role, room: conversation.room }, conversationId);
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

  ws.on('close', () => {
    dropClient(conversationId, client);
    wsAudit(
      req,
      'connection.close',
      { role, room: conversation.room, seconds: Math.round((Date.now() - connectedAt) / 1000) },
      conversationId
    );
  });
});

const MAX_MESSAGE_LENGTH = 2000;
const MAX_NAME_LENGTH = 80;
const TEN_MINUTES = 10 * 60 * 1000;

// Generous limits: everyone at the venue can share one public IP.
const limitSsoLogin = rateLimit({ name: 'sso-login', limit: 60, windowMs: TEN_MINUTES });
const limitChatStart = rateLimit({ name: 'chat-start', limit: 60, windowMs: TEN_MINUTES });
const limitMessages = rateLimit({
  name: 'chat-message',
  limit: 20,
  windowMs: 60 * 1000,
  key: (req) => req.params.id,
});
const limitTelegramTest = rateLimit({ name: 'telegram-test', limit: 10, windowMs: 60 * 1000 });

app.get('/auth/sso/login', limitSsoLogin, (req, res) => {
  audit(req, 'sso.login_start', { next: req.query.next });
  startSsoLogin(req, res);
});

app.get('/auth/sso/callback', (req, res) => handleSsoCallback(req, res));

// OpenID providers may return large responses as a cross-site form POST, which
// would not carry our SameSite=Lax state cookie. Re-issue it as a top-level GET.
app.post('/auth/sso/callback', express.urlencoded({ extended: false }), (req, res) => {
  const params = new URLSearchParams(req.query);
  for (const [key, value] of Object.entries(req.body || {})) params.set(key, String(value));
  res.redirect(303, `/auth/sso/callback?${params}`);
});

app.post('/auth/sso/logout', (req, res) => {
  audit(req, 'sso.logout');
  ssoLogout(req, res);
  res.json({ ok: true });
});

app.get('/api/sso/me', (req, res) => {
  res.json({ ssoRequired: getSsoRequired(), user: publicSsoUser(getSsoUser(req)) });
});

app.get('/api/guides', (_req, res) => {
  res.json({ guides: getGuides().filter((g) => g.enabled).map(toGuideCard) });
});

// Unknown chat IDs (including links from the previous help desk site) go home.
app.get('/chat/:id', (req, res) => {
  if (!db.getConversation(req.params.id)) return res.redirect('/');
  res.sendFile(path.join(publicDir, 'chat.html'));
});

app.get('/guides/:slug', (req, res) => {
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

app.post('/api/conversations', limitChatStart, (req, res) => {
  const { room, participantName } = req.body || {};
  const availability = getAvailability();
  if (!availability.open) {
    audit(req, 'chat.start_denied', { room, reason: 'Help desk closed' });
    return res.status(403).json({ error: availability.message });
  }
  const ssoUser = getSsoUser(req);
  if (getSsoRequired() && !ssoUser) {
    audit(req, 'chat.start_denied', { room, reason: 'Ubuntu SSO sign-in required' });
    return res
      .status(401)
      .json({ error: 'Sign in with Ubuntu SSO to start a chat', ssoRequired: true });
  }
  if (!room || !getRooms().includes(room)) {
    audit(req, 'chat.start_denied', { room, reason: 'Unknown room' });
    return res.status(400).json({ error: 'Invalid room' });
  }
  const name = (String(participantName || '').trim() || (ssoUser ? ssoDisplayName(ssoUser) : '')).slice(
    0,
    MAX_NAME_LENGTH
  );
  const conversation = db.createConversation(room, name, ssoUser);
  audit(req, 'chat.start', { room, name }, conversation.id);
  res.status(201).json({ conversation });
});

app.get('/api/conversations/:id', (req, res) => {
  const conversation = db.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Not found' });
  if (!requireConversationAccess(req, res, conversation)) return;
  if (isAdmin(req)) audit(req, 'chat.view', { room: conversation.room }, conversation.id);
  res.json({ conversation: enrichConversation(conversation) });
});

app.get('/api/conversations/:id/messages', (req, res) => {
  const conversation = db.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Not found' });
  if (!requireConversationAccess(req, res, conversation)) return;
  res.json({ messages: db.getMessages(req.params.id) });
});

app.post('/api/conversations/:id/messages', limitMessages, async (req, res) => {
  const { body, sender } = req.body || {};
  const conversation = db.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Not found' });
  if (conversation.status === 'resolved') {
    return res.status(400).json({ error: 'Conversation is resolved' });
  }
  if (typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'Message required' });
  }
  if (body.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Messages can be up to ${MAX_MESSAGE_LENGTH} characters` });
  }
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
  const telegram = await notifyTelegram(
    formatNewMessageNotification({
      baseUrl: resolveHelpBaseUrl(req),
      room: conversation.room,
      conversationId: conversation.id,
      participantName: conversation.participant_name,
      sender,
      body: message.body,
    })
  );
  audit(
    req,
    'chat.message',
    {
      room: conversation.room,
      sender,
      characters: message.body.length,
      telegram: telegram.ok ? 'sent' : telegram.skipped ? 'not configured' : `failed: ${telegram.error}`,
    },
    conversation.id
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
  audit(req, 'chat.end', { room: conversation.room, by: isAdmin(req) ? 'support' : 'participant' }, conversation.id);
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
  audit(
    req,
    status === 'resolved' ? 'chat.resolve' : 'chat.status',
    { room: conversation.room, from: conversation.status, to: status },
    conversation.id
  );
  res.json({ conversation: updated });
});

app.get('/api/admin/conversations', requireAdmin, (req, res) => {
  const status = req.query.status;
  const conversations = db
    .listConversations(status || undefined)
    .map((c) => enrichConversation(c));
  res.json({ conversations });
});

const ADMIN_DENIED_MESSAGES = {
  'not-admin': 'Your Ubuntu One account is not a support admin.',
  'no-email': 'Your Ubuntu One account did not share an email address.',
  'identity-mismatch':
    'This email is linked to a different Ubuntu One account. Ask an admin to remove and re-add you.',
};

app.get('/api/admin/me', (req, res) => {
  const user = getSsoUser(req);
  const result = user ? checkAdmin(user) : { ok: false, reason: 'signed-out' };
  res.json({
    authenticated: result.ok,
    signedIn: Boolean(user),
    user: publicSsoUser(user),
    reason: result.ok ? null : result.reason,
    message: result.ok ? null : ADMIN_DENIED_MESSAGES[result.reason] || null,
  });
});

app.get('/api/admin/admins', requireAdmin, (_req, res) => {
  res.json({ admins: getAdmins() });
});

app.post('/api/admin/admins', requireAdmin, (req, res) => {
  const email = String(req.body?.email ?? '');
  try {
    const admins = addAdmin(email, req.admin.email);
    audit(req, 'admin.add', { email: email.trim().toLowerCase() });
    res.status(201).json({ admins });
  } catch (err) {
    audit(req, 'admin.add_failed', { email, error: err.message });
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/admins/:email', requireAdmin, (req, res) => {
  const email = String(req.params.email).trim().toLowerCase();
  if (email === String(req.admin.email).toLowerCase()) {
    return res.status(400).json({ error: 'You cannot remove yourself. Ask another admin to do it.' });
  }
  try {
    const admins = removeAdmin(email);
    if (!admins) return res.status(404).json({ error: 'Admin not found' });
    audit(req, 'admin.remove', { email });
    res.json({ admins });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/settings', requireAdmin, (_req, res) => {
  res.json(getAdminSettingsView());
});

app.get('/api/admin/telegram/logs', requireAdmin, (_req, res) => {
  res.json({ logs: getTelegramLogs() });
});

app.post('/api/admin/telegram/test', requireAdmin, limitTelegramTest, async (req, res) => {
  const { telegramBotToken, telegramChatId, telegramProxy } = req.body || {};
  const overrides = {};
  if (telegramBotToken !== undefined) overrides.token = telegramBotToken;
  if (telegramChatId !== undefined) overrides.chatId = telegramChatId;
  if (telegramProxy !== undefined) {
    try {
      overrides.proxy = normalizeTelegramProxy(telegramProxy);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  const result = await sendTelegramTestMessage(overrides);
  audit(req, 'telegram.test', {
    result: result.ok ? 'sent' : `failed: ${result.error}`,
    proxy: overrides.proxy?.enabled ? overrides.proxy.url : undefined,
  });
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
  audit(req, 'print.generate', { rooms: roomParam === 'all' ? `all (${names.length})` : names[0] });
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
    audit(req, 'guide.create', { title: guide.title, enabled: guide.enabled }, guide.slug);
    res.status(201).json({ guide, guides: getGuides() });
  } catch (err) {
    sendGuideError(res, err);
  }
});

app.put('/api/admin/guides/:id', requireAdmin, (req, res) => {
  try {
    const before = getGuides().find((g) => g.id === req.params.id);
    const guide = updateGuide(req.params.id, req.body || {});
    if (!guide) return res.status(404).json({ error: 'Guide not found' });
    const changed = Object.keys(guide).filter(
      (key) => before && JSON.stringify(before[key]) !== JSON.stringify(guide[key])
    );
    const onlyToggle = changed.length === 1 && changed[0] === 'enabled';
    audit(
      req,
      onlyToggle ? (guide.enabled ? 'guide.enable' : 'guide.disable') : 'guide.update',
      { title: guide.title, changed: changed.join(', ') || 'nothing' },
      guide.slug
    );
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
  const moved = guides.find((g) => g.id === req.params.id);
  audit(req, 'guide.move', { title: moved?.title, direction }, moved?.slug);
  res.json({ guides });
});

app.delete('/api/admin/guides/:id', requireAdmin, (req, res) => {
  const guide = getGuides().find((g) => g.id === req.params.id);
  if (!deleteGuide(req.params.id)) return res.status(404).json({ error: 'Guide not found' });
  audit(req, 'guide.delete', { title: guide?.title }, guide?.slug);
  res.json({ guides: getGuides() });
});

app.get('/api/admin/data/export', requireAdmin, (_req, res) => {
  const snapshot = exportHelpdeskData();
  const filename = `helpdesk-export-${snapshot.exportedAt.slice(0, 10)}.json`;
  audit(req, 'data.export', {
    conversations: snapshot.conversations.length,
    messages: snapshot.messages.length,
  });
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
    audit(req, 'data.import', { mode: settingsOnly ? 'settings only' : 'all data' });
    res.json({ ok: true, ...getAdminSettingsView() });
  } catch (err) {
    audit(req, 'data.import_failed', { error: err.message });
    res.status(400).json({ error: err.message || 'Import failed' });
  }
});

/** Summarise a settings change without recording secrets. */
function describeSettingsChange(body) {
  const details = {};
  if (body.rooms !== undefined) details.rooms = Array.isArray(body.rooms) ? `${body.rooms.length} rooms` : 'invalid';
  if (body.wifi !== undefined) {
    details.wifi = body.wifi?.enabled === false ? 'disabled' : `enabled, SSID "${body.wifi?.ssid ?? ''}"`;
  }
  if (body.helpBaseUrl !== undefined) details.helpBaseUrl = body.helpBaseUrl || '(this server)';
  if (body.ssoRequired !== undefined) details.ssoRequired = body.ssoRequired;
  if (body.schedule !== undefined) {
    const s = body.schedule || {};
    details.hours = [s.startDate, s.endDate, s.openTime && `${s.openTime}–${s.closeTime}`, s.timeZone]
      .filter(Boolean)
      .join(', ') || 'always open';
  }
  if (body.telegramBotToken !== undefined) details.telegramToken = 'replaced';
  if (body.telegramChatId !== undefined) details.telegramChatId = body.telegramChatId;
  if (body.telegramProxy !== undefined) {
    details.telegramProxy = body.telegramProxy?.enabled ? body.telegramProxy.url : 'off';
  }
  return details;
}

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const {
    rooms,
    schedule: scheduleBody,
    telegramBotToken,
    telegramChatId,
    telegramProxy,
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
    if (
      telegramBotToken !== undefined ||
      telegramChatId !== undefined ||
      telegramProxy !== undefined
    ) {
      updateTelegram({
        botToken: telegramBotToken,
        chatId: telegramChatId,
        proxy: telegramProxy,
      });
    }
    audit(req, 'settings.update', describeSettingsChange(req.body || {}));
    res.json(getAdminSettingsView());
  } catch (err) {
    audit(req, 'settings.update_failed', { ...describeSettingsChange(req.body || {}), error: err.message });
    res.status(400).json({ error: err.message || 'Invalid settings' });
  }
});

app.get('/api/admin/audit', requireAdmin, (req, res) => {
  const { category = '', q = '', before = '', limit = 100 } = req.query;
  res.json({
    ...queryAudit({ category, q, before, limit }),
    categories: AUDIT_CATEGORIES,
    maxEntries: MAX_AUDIT_ENTRIES,
  });
});

app.get('/api/admin/audit/export', requireAdmin, (req, res) => {
  const { category = '', q = '' } = req.query;
  audit(req, 'audit.export', { category, search: q });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="helpdesk-audit-${stamp}.csv"`);
  res.send(auditCsv({ category, q }));
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
  recordAudit({
    action: 'system.start',
    ip: 'server',
    actor: 'system',
    details: { version: APP_VERSION, port: PORT },
  });
  for (const url of listAccessUrls(PORT)) {
    console.log(`  ${url}`);
    console.log(`  ${url}/admin`);
  }
  const { telegram } = getAdminSettingsView();
  if (!telegram.tokenSet || !telegram.chatId) {
    console.log('Telegram notifications disabled (configure in admin Settings)');
  }
});
