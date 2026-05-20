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

function addLog(level, message, detail) {
  logs.unshift({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    level,
    message,
    detail: detail ? redactToken(detail).slice(0, 500) : undefined,
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
  return { token, chatId };
}

/** Escape text for parse_mode MarkdownV2 (outside link URLs). */
export function escapeMarkdownV2(text) {
  return String(text).replace(MARKDOWN_V2_ESCAPE, '\\$&');
}

/** Inside inline link (...), only \\ and ) must be escaped. */
function escapeMarkdownV2LinkUrl(url) {
  return String(url).replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
}

export async function sendTelegramMessage(text, overrides = {}) {
  const { token, chatId } = resolveConfig(overrides);
  if (!token || !chatId) {
    const msg = 'Bot token and chat ID must be configured';
    addLog('skip', msg);
    return { ok: false, error: msg };
  }

  const url = `${TELEGRAM_API}${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      }),
    });
    const body = await res.text();
    if (!res.ok) {
      addLog('error', `sendMessage failed (${res.status})`, body);
      console.error('Telegram notify failed:', body);
      let detail = body;
      try {
        detail = JSON.parse(body).description || body;
      } catch {
        // keep raw body
      }
      return { ok: false, error: detail };
    }
    addLog('info', 'Notification sent', body);
    return { ok: true };
  } catch (err) {
    addLog('error', 'sendMessage request failed', err.message);
    console.error('Telegram notify error:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function notifyTelegram(text) {
  await sendTelegramMessage(text);
}

export async function sendTelegramTestMessage(overrides = {}) {
  return sendTelegramMessage(
    '*Help desk test*\nThis is a test notification from the admin panel\\.',
    overrides
  );
}

export function buildAdminChatUrl(baseUrl, conversationId) {
  const root = String(baseUrl || '').trim().replace(/\/$/, '');
  const id = encodeURIComponent(conversationId);
  return `${root}/admin.html?tab=conversations&conversation=${id}`;
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
  const adminUrl = escapeMarkdownV2LinkUrl(buildAdminChatUrl(baseUrl, conversationId));
  const roomLink = `[${escapeMarkdownV2(room)}](${adminUrl})`;
  let header = `${roomLink} 💬`;
  if (sender === 'support') {
    header += ` *Support*:`;
  } else if (participantName) {
    header += ` *${escapeMarkdownV2(participantName)}*:`;
  }
  return `${header}\n${escapeMarkdownV2(body)}`;
}
