import { getTelegramConfig } from './settings.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const MAX_LOGS = 200;
const logs = [];

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
        parse_mode: 'HTML',
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
    '<b>Help desk test</b>\nThis is a test notification from the admin panel.',
    overrides
  );
}

export function formatNewMessageNotification({ room, participantName, body, conversationId }) {
  const who = participantName ? escapeHtml(participantName) : 'Participant';
  const preview = escapeHtml(body.slice(0, 200));
  return (
    `<b>New help desk message</b>\n` +
    `Room: <b>${escapeHtml(room)}</b>\n` +
    `From: ${who}\n` +
    `Message: ${preview}\n` +
    `ID: <code>${conversationId.slice(0, 8)}</code>`
  );
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
