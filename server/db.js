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

// Writes are coalesced: memory is authoritative, and bursts of changes become a
// single background save shortly after, so public traffic cannot force a full
// synchronous rewrite of the store per request. flushSync() runs on shutdown.
const SAVE_DELAY_MS = 250;
let dirty = false;
let saving = false;
let saveTimer = null;

function scheduleSave() {
  if (saveTimer || saving) return;
  saveTimer = setTimeout(saveInBackground, SAVE_DELAY_MS);
}

async function saveInBackground() {
  saveTimer = null;
  if (!dirty) return;
  dirty = false;
  saving = true;
  const tmp = `${DB_PATH}.tmp`;
  try {
    ensureDataDir();
    await fs.promises.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    await fs.promises.rename(tmp, DB_PATH);
  } catch (err) {
    console.error(`Saving ${DB_PATH} failed: ${err.message}`);
    dirty = true;
  } finally {
    saving = false;
    if (dirty) scheduleSave();
  }
}

/** Write any pending changes immediately (used on shutdown). */
export function flushSync() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  // A background save may still be running at shutdown; write the latest state now.
  if (!dirty && !saving) return;
  dirty = false;
  writeStoreToDisk(store);
}

function persist(next) {
  store = next;
  dirty = true;
  scheduleSave();
}

function now() {
  return new Date().toISOString();
}

function id() {
  return crypto.randomUUID();
}

export function createConversation(room, participantName, ssoUser = null, secretHash = null) {
  const conversationId = id();
  const timestamp = now();
  const conversation = {
    id: conversationId,
    room,
    participant_name: participantName || null,
    // Hash of the guest's secret; only the starting browser holds the secret itself.
    participant_secret_hash: ssoUser ? null : secretHash,
    participant_sso: ssoUser
      ? {
          id: ssoUser.id,
          nickname: ssoUser.nickname || null,
          email: ssoUser.email || null,
          fullname: ssoUser.fullname || null,
        }
      : null,
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

export function importSnapshot(payload, { settingsOnly = false, replaceAdmins = false } = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Import data must be a JSON object');
  }

  let incomingSettings =
    payload.settings && typeof payload.settings === 'object'
      ? { ...payload.settings }
      : null;

  // The admin list is only replaced when explicitly requested and the file
  // actually has one; otherwise the current roster is kept, so an old backup
  // can never bring back a removed admin.
  const fileAdmins = Array.isArray(incomingSettings?.admins) && incomingSettings.admins.length;
  const adminsReplaced = Boolean(replaceAdmins && fileAdmins);
  if (incomingSettings && !adminsReplaced) {
    if (Array.isArray(store.settings.admins)) incomingSettings.admins = store.settings.admins;
    else delete incomingSettings.admins;
  }

  if (settingsOnly) {
    if (!incomingSettings) {
      throw new Error('Import file has no settings object');
    }
    persist({
      ...store,
      settings: { ...incomingSettings },
    });
    return { adminsReplaced };
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
  return { adminsReplaced };
}


