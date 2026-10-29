// Audit log: append-only JSON lines in data/audit.jsonl. The newest entries are
// kept in memory for the admin Audit log tab; the file is trimmed when it grows.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const AUDIT_PATH = path.join(dataDir, 'audit.jsonl');

export const MAX_AUDIT_ENTRIES = 20000;
const TRIM_THRESHOLD = Math.round(MAX_AUDIT_ENTRIES * 1.25);

export const AUDIT_CATEGORIES = {
  page: 'Page views',
  chat: 'Chats',
  connection: 'Live connections',
  admin: 'Support login',
  sso: 'Ubuntu SSO',
  settings: 'Settings',
  guide: 'Guides',
  telegram: 'Telegram',
  print: 'Printouts',
  data: 'Backup & restore',
  audit: 'Audit log',
  http: 'Other requests',
  system: 'System',
};

let entries = [];

function load() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(AUDIT_PATH)) return;
  const lines = fs.readFileSync(AUDIT_PATH, 'utf8').split('\n');
  const parsed = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // skip a partially written line
    }
  }
  entries = parsed.slice(-MAX_AUDIT_ENTRIES);
  if (parsed.length > MAX_AUDIT_ENTRIES) rewriteFile();
}

function rewriteFile() {
  const tmp = `${AUDIT_PATH}.tmp`;
  fs.writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, AUDIT_PATH);
}

load();

/** Strip the IPv4-mapped IPv6 prefix so addresses read naturally. */
export function normalizeIp(ip) {
  const value = String(ip || '').trim();
  if (!value) return 'unknown';
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

/** Short, stable tag for an admin session token so sessions can be told apart. */
export function sessionTag(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 8);
}

function clean(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return value.slice(0, 500);
  return value;
}

/**
 * Record an audit event.
 * @param {object} event
 * @param {string} event.action   e.g. "chat.start", "admin.login_failed"
 * @param {string} [event.ip]
 * @param {string} [event.actor]  who did it, e.g. "admin (a1b2c3d4)", "alex@example.com"
 * @param {string} [event.target] what it affected, e.g. a conversation id or guide slug
 * @param {object} [event.details]
 */
export function recordAudit(event) {
  const details = {};
  for (const [key, value] of Object.entries(event.details || {})) {
    const v = clean(value);
    if (v !== undefined) details[key] = v;
  }
  const entry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    action: event.action,
    category: String(event.action).split('.')[0],
    ip: normalizeIp(event.ip),
    actor: clean(event.actor) || 'anonymous',
    target: clean(event.target),
    method: clean(event.method),
    path: clean(event.path),
    status: event.status,
    userAgent: clean(event.userAgent),
    details: Object.keys(details).length ? details : undefined,
  };
  entries.push(entry);
  try {
    fs.appendFileSync(AUDIT_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
    if (entries.length > TRIM_THRESHOLD) {
      entries = entries.slice(-MAX_AUDIT_ENTRIES);
      rewriteFile();
    }
  } catch (err) {
    console.error(`Audit log write failed: ${err.message}`);
  }
  return entry;
}

function matches(entry, { category, q }) {
  if (category && entry.category !== category) return false;
  if (!q) return true;
  const haystack = [
    entry.action,
    entry.ip,
    entry.actor,
    entry.target,
    entry.path,
    entry.userAgent,
    entry.details ? JSON.stringify(entry.details) : '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

/** Newest-first page of entries. `before` is the id of the last entry already shown. */
export function queryAudit({ category = '', q = '', before = '', limit = 100 } = {}) {
  const filters = { category, q: String(q).trim().toLowerCase() };
  const size = Math.min(Math.max(Number(limit) || 100, 1), 500);
  let index = entries.length - 1;
  if (before) {
    const found = entries.findIndex((e) => e.id === before);
    index = found === -1 ? -1 : found - 1;
  }
  const page = [];
  for (; index >= 0 && page.length < size; index -= 1) {
    if (matches(entries[index], filters)) page.push(entries[index]);
  }
  let hasMore = false;
  for (; index >= 0; index -= 1) {
    if (matches(entries[index], filters)) {
      hasMore = true;
      break;
    }
  }
  return { entries: page, hasMore, total: entries.length };
}

/** All matching entries, newest first, as CSV. */
export function auditCsv({ category = '', q = '' } = {}) {
  const filters = { category, q: String(q).trim().toLowerCase() };
  const cell = (value) => {
    let text = value === undefined || value === null ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // avoid spreadsheet formula injection
    return `"${text.replace(/"/g, '""')}"`;
  };
  const rows = [
    ['Time', 'IP', 'Actor', 'Event', 'Target', 'Method', 'Path', 'Status', 'Details', 'User agent'],
  ];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (!matches(e, filters)) continue;
    rows.push([
      e.at,
      e.ip,
      e.actor,
      e.action,
      e.target,
      e.method,
      e.path,
      e.status,
      e.details ? JSON.stringify(e.details) : '',
      e.userAgent,
    ]);
  }
  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
