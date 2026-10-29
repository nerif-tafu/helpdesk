import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { getTelegramConfig } from './settings.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const MAX_LOGS = 200;
const logs = [];

// https://core.telegram.org/bots/api#markdownv2-style
const MARKDOWN_V2_ESCAPE =
  /[_*[\]()~`>#+\-=|{}.!\\]/g;

function redactToken(text) {
  const { token } = getTelegramConfig();
  if (!token || !text) return text;
  return String(text).split(token).join('***');
}

function formatDetail(detail) {
  if (!detail) return undefined;
  const text = Array.isArray(detail) ? detail.filter(Boolean).join('\n') : String(detail);
  return redactToken(text).slice(0, 2000);
}

function addLog(level, message, detail) {
  logs.unshift({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    level,
    message,
    detail: formatDetail(detail),
  });
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
}

export function getTelegramLogs() {
  return [...logs];
}

function resolveConfig(overrides = {}) {
  const saved = getTelegramConfig();
  const token =
    overrides.token !== undefined && overrides.token !== ''
      ? String(overrides.token).trim()
      : saved.token;
  const chatId =
    overrides.chatId !== undefined && overrides.chatId !== ''
      ? String(overrides.chatId).trim()
      : saved.chatId;
  const proxy = overrides.proxy !== undefined ? overrides.proxy : saved.proxy;
  return { token, chatId, proxy };
}

/** Escape text for parse_mode MarkdownV2 (outside link URLs). */
export function escapeMarkdownV2(text) {
  return String(text).replace(MARKDOWN_V2_ESCAPE, '\\$&');
}

/** Inside inline link (...), only \\ and ) must be escaped. */
function escapeMarkdownV2LinkUrl(url) {
  return String(url).replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
}

const REQUEST_TIMEOUT_MS = 15000;
const proxyAgents = new Map();

function proxyAgentFor(url) {
  if (!proxyAgents.has(url)) proxyAgents.set(url, new ProxyAgent(url));
  return proxyAgents.get(url);
}

/** Hide any user:password in a proxy URL before logging it. */
function displayProxyUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '';
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

const ERROR_HINTS = {
  ENOTFOUND: 'DNS lookup failed. Check the host name (proxy host if a proxy is set).',
  EAI_AGAIN: 'DNS lookup timed out. Check DNS or the proxy host name.',
  ECONNREFUSED: 'Connection refused. Check the proxy address and port.',
  ECONNRESET: 'Connection reset. The proxy or network dropped the connection.',
  ETIMEDOUT: 'Connection timed out. Direct internet access is probably blocked; set a proxy.',
  ENETUNREACH: 'Network unreachable. Direct internet access is probably blocked; set a proxy.',
  EHOSTUNREACH: 'Host unreachable. Direct internet access is probably blocked; set a proxy.',
  UND_ERR_CONNECT_TIMEOUT:
    'Connection timed out. Direct internet access is probably blocked; set a proxy.',
  UND_ERR_HEADERS_TIMEOUT: 'No response in time. The proxy or Telegram is slow or blocking.',
  UND_ERR_ABORTED: 'Request was aborted.',
  TimeoutError: `No response within ${REQUEST_TIMEOUT_MS / 1000}s.`,
};

/** Flatten an error and its `cause` chain into readable lines. */
function describeError(err) {
  const lines = [];
  let hint = null;
  let current = err;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const parts = [`${current.name || 'Error'}: ${current.message || String(current)}`];
    for (const key of ['code', 'errno', 'syscall', 'hostname', 'address', 'port']) {
      if (current[key] !== undefined && current[key] !== '') parts.push(`${key}=${current[key]}`);
    }
    lines.push(`${depth === 0 ? 'Error' : 'Caused by'}: ${parts.join(' ')}`);
    hint = hint || ERROR_HINTS[current.code] || ERROR_HINTS[current.name] || null;
    if (!hint && /Proxy response \((\d+)\)/.test(current.message || '')) {
      hint = 'The proxy refused the connection to api.telegram.org. Check the proxy allows it.';
    }
    current = current.cause;
  }
  if (hint) lines.push(`Hint: ${hint}`);
  return lines;
}

export async function sendTelegramMessage(text, overrides = {}, { kind = 'Notification' } = {}) {
  const { token, chatId, proxy } = resolveConfig(overrides);
  if (!token || !chatId) {
    const msg = 'Bot token and chat ID must be configured';
    addLog('skip', `${kind} skipped`, msg);
    return { ok: false, skipped: true, error: msg };
  }

  const viaProxy = proxy?.enabled && proxy.url;
  const route = viaProxy ? `via proxy ${displayProxyUrl(proxy.url)}` : 'direct (no proxy)';
  const context = [`Route: ${route}`, `Chat ID: ${chatId}`];
  const url = `${TELEGRAM_API}${token}/sendMessage`;
  const started = Date.now();
  try {
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(viaProxy ? { dispatcher: proxyAgentFor(proxy.url) } : {}),
    });
    const body = await res.text();
    const elapsed = `Time: ${Date.now() - started} ms`;
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      // non-JSON body (e.g. a proxy error page)
    }
    if (!res.ok || json?.ok === false) {
      const description = json?.description || body.slice(0, 300) || res.statusText;
      addLog('error', `${kind} failed: Telegram returned HTTP ${res.status}`, [
        ...context,
        elapsed,
        `Telegram error: ${json?.error_code ?? res.status} ${description}`,
        res.status === 401 ? 'Hint: The bot token is wrong or was revoked.' : null,
        res.status === 400 && /chat not found/i.test(description)
          ? 'Hint: Check the chat ID, and that the bot has been added to that chat.'
          : null,
        res.status === 403 ? 'Hint: The bot was removed from the chat or blocked.' : null,
        res.status === 407 ? 'Hint: The proxy requires authentication.' : null,
      ]);
      console.error(`Telegram ${kind.toLowerCase()} failed (HTTP ${res.status}): ${description}`);
      return { ok: false, error: description };
    }
    const chat = json?.result?.chat;
    const chatName = chat?.title || chat?.username || chat?.first_name;
    addLog('info', `${kind} sent`, [
      ...context,
      elapsed,
      `HTTP ${res.status}`,
      json?.result?.message_id !== undefined ? `Message ID: ${json.result.message_id}` : null,
      chatName ? `Chat: ${chatName}${chat?.type ? ` (${chat.type})` : ''}` : null,
    ]);
    return { ok: true };
  } catch (err) {
    const lines = describeError(err);
    addLog('error', `${kind} failed: could not reach api.telegram.org`, [
      ...context,
      `Time: ${Date.now() - started} ms`,
      ...lines,
    ]);
    console.error(`Telegram ${kind.toLowerCase()} error (${route}): ${lines.join(' | ')}`);
    const hint = lines.find((line) => line.startsWith('Hint: '));
    return { ok: false, error: hint ? `${err.message}. ${hint.slice(6)}` : err.message };
  }
}

export async function notifyTelegram(text) {
  return sendTelegramMessage(text);
}

export async function sendTelegramTestMessage(overrides = {}) {
  return sendTelegramMessage(
    '*Help desk test*\nThis is a test notification from the admin panel\\.',
    overrides,
    { kind: 'Test message' }
  );
}

export function buildAdminChatUrl(baseUrl, conversationId) {
  // The help URL may include a path such as /location; admin links live at the site root.
  let root = String(baseUrl || '').trim().replace(/\/$/, '');
  try {
    root = new URL(root).origin;
  } catch {
    // keep as-is
  }
  const id = encodeURIComponent(conversationId);
  return `${root}/admin?tab=conversations&conversation=${id}`;
}

/**
 * MarkdownV2: [Room](adminUrl) 💬 *Name*:
 * message
 * @see https://core.telegram.org/bots/api#markdownv2-style
 */
export function formatNewMessageNotification({
  baseUrl,
  room,
  conversationId,
  participantName,
  sender,
  body,
}) {
  // Without a configured public URL, name the room without a link.
  const roomLink = baseUrl
    ? `[${escapeMarkdownV2(room)}](${escapeMarkdownV2LinkUrl(buildAdminChatUrl(baseUrl, conversationId))})`
    : `*${escapeMarkdownV2(room)}*`;
  let header = `${roomLink} 💬`;
  if (sender === 'support') {
    header += ` *Support*:`;
  } else if (participantName) {
    header += ` *${escapeMarkdownV2(participantName)}*:`;
  }
  return `${header}\n${escapeMarkdownV2(body)}`;
}
