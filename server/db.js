import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(dataDir, 'helpdesk.json');

const DB_VERSION = 1;

const EMPTY_STORE = {
  version: DB_VERSION,
  conversations: [],
  messages: [],
  settings: {},
};

let store;

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function readStoreFromDisk() {
  ensureDataDir();
  if (fs.existsSync(DB_PATH)) {
    return normalizeStore(JSON.parse(fs.readFileSync(DB_PATH, 'utf8')));
  }
  const initial = { ...EMPTY_STORE };
  writeStoreToDisk(initial);
  return initial;
}

store = readStoreFromDisk();

function normalizeStore(raw) {
  return {
    version: DB_VERSION,
    conversations: Array.isArray(raw?.conversations) ? raw.conversations : [],
    messages: Array.isArray(raw?.messages) ? raw.messages : [],
    settings: raw?.settings && typeof raw.settings === 'object' ? raw.settings : {},
  };
}

function writeStoreToDisk(next) {
  ensureDataDir();
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, DB_PATH);
}

function persist(next) {
  store = next;
  writeStoreToDisk(store);
}

function now() {
  return new Date().toISOString();
}

function id() {
  return crypto.randomUUID();
}

export function createConversation(room, participantName) {
  const conversationId = id();
  const timestamp = now();
  const conversation = {
    id: conversationId,
    room,
    participant_name: participantName || null,
    status: 'waiting',
    created_at: timestamp,
    updated_at: timestamp,
  };
  persist({
    ...store,
    conversations: [...store.conversations, conversation],
  });
  return conversation;
}

export function getConversation(conversationId) {
  return store.conversations.find((c) => c.id === conversationId) ?? null;
}

function lastMessageForConversation(conversationId) {
  let last = null;
  for (const message of store.messages) {
    if (message.conversation_id !== conversationId) continue;
    if (!last || message.created_at > last.created_at) last = message;
  }
  return last;
}

export function conversationNeedsReply(conversation) {
  if (!conversation || conversation.status === 'resolved') return false;
  if (conversation.status === 'waiting' || conversation.status === 'joined') return true;
  const last = lastMessageForConversation(conversation.id);
  return last ? last.sender === 'participant' : true;
}

export function listConversations(status) {
  const list = [...store.conversations]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((c) => ({ ...c, needs_reply: conversationNeedsReply(c) }));
  if (status) return list.filter((c) => c.status === status);
  return list;
}

export function markSupportJoined(conversationId) {
  const conversation = getConversation(conversationId);
  if (!conversation || conversation.status !== 'waiting') return null;
  return updateConversationStatus(conversationId, 'joined');
}

export function updateConversationStatus(conversationId, status) {
  const conversations = store.conversations.map((c) =>
    c.id === conversationId ? { ...c, status } : c
  );
  persist({ ...store, conversations });
  return getConversation(conversationId);
}

export function addMessage(conversationId, sender, body) {
  const messageId = id();
  const timestamp = now();
  const message = {
    id: messageId,
    conversation_id: conversationId,
    sender,
    body: body.trim(),
    created_at: timestamp,
  };
  let conversations = store.conversations.map((c) =>
    c.id === conversationId ? { ...c, updated_at: timestamp } : c
  );
  const conversation = conversations.find((c) => c.id === conversationId);
  if (
    conversation &&
    ['waiting', 'joined'].includes(conversation.status) &&
    sender === 'support'
  ) {
    conversations = conversations.map((c) =>
      c.id === conversationId ? { ...c, status: 'active', updated_at: timestamp } : c
    );
  }
  persist({
    ...store,
    conversations,
    messages: [...store.messages, message],
  });
  return message;
}

export function getMessage(messageId) {
  return store.messages.find((m) => m.id === messageId) ?? null;
}

export function getMessages(conversationId) {
  return store.messages
    .filter((m) => m.conversation_id === conversationId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function getSettings() {
  return { ...store.settings };
}

export function patchSettings(partial) {
  persist({
    ...store,
    settings: { ...store.settings, ...partial },
  });
}

export function getExportSnapshot() {
  return {
    version: DB_VERSION,
    exportedAt: now(),
    conversations: store.conversations,
    messages: store.messages,
    settings: store.settings,
  };
}

export function importSnapshot(payload, { settingsOnly = false } = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Import data must be a JSON object');
  }

  const incomingSettings =
    payload.settings && typeof payload.settings === 'object'
      ? payload.settings
      : null;

  if (settingsOnly) {
    if (!incomingSettings) {
      throw new Error('Import file has no settings object');
    }
    persist({
      ...store,
      settings: { ...incomingSettings },
    });
    return;
  }

  const conversations = Array.isArray(payload.conversations) ? payload.conversations : null;
  const messages = Array.isArray(payload.messages) ? payload.messages : null;
  if (!conversations || !messages || !incomingSettings) {
    throw new Error(
      'Full import requires conversations, messages, and settings arrays/objects'
    );
  }

  persist(
    normalizeStore({
      conversations,
      messages,
      settings: incomingSettings,
    })
  );
}

export function reloadStore() {
  store = readStoreFromDisk();
}
