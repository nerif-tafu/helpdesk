import * as db from './db.js';

const DEFAULT_ROOMS = ['Main Hall', 'Workshop A', 'Workshop B'];

let rooms = [...DEFAULT_ROOMS];
let telegramBotToken = '';
let telegramChatId = '';

function getDefaultTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const DEFAULT_SCHEDULE = {
  startDate: null,
  endDate: null,
  openTime: null,
  closeTime: null,
  timeZone: getDefaultTimeZone(),
};

let schedule = { ...DEFAULT_SCHEDULE };
let wifi = { enabled: true, ssid: '', password: '' };
let helpBaseUrl = '';

function isValidTimeZone(timeZone) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

function getZonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const p of formatter.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function parseRoomsValue(raw) {
  if (Array.isArray(raw)) {
    const cleaned = raw.map((r) => String(r).trim()).filter(Boolean);
    return cleaned.length ? cleaned : null;
  }
  if (typeof raw === 'string') {
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return parseRoomsValue(list);
    } catch {
      const fromCsv = raw
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean);
      return fromCsv.length ? fromCsv : null;
    }
  }
  return null;
}

function normalizeRooms(list) {
  const seen = new Set();
  const out = [];
  for (const name of list) {
    const trimmed = String(name).trim();
    if (!trimmed || trimmed.length > 120 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  if (!out.length) throw new Error('At least one room is required');
  return out;
}

function parseWifi(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    enabled: raw.enabled !== false,
    ssid: String(raw.ssid ?? '').trim(),
    password: String(raw.password ?? '').trim(),
  };
}

function parseSchedule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return normalizeSchedule(raw, false);
}

function emptyToNull(value) {
  const v = value == null ? '' : String(value).trim();
  return v || null;
}

function normalizeSchedule(input, validate = true) {
  const timeZone = emptyToNull(input.timeZone) || getDefaultTimeZone();
  if (!isValidTimeZone(timeZone)) {
    throw new Error('Invalid timezone (use an IANA name such as Europe/London)');
  }

  const next = {
    startDate: emptyToNull(input.startDate),
    endDate: emptyToNull(input.endDate),
    openTime: emptyToNull(input.openTime),
    closeTime: emptyToNull(input.closeTime),
    timeZone,
  };

  if (next.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(next.startDate)) {
    throw new Error('Start date must be YYYY-MM-DD');
  }
  if (next.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(next.endDate)) {
    throw new Error('End date must be YYYY-MM-DD');
  }
  if (next.startDate && next.endDate && next.endDate < next.startDate) {
    throw new Error('End date must be on or after start date');
  }
  if ((next.openTime && !next.closeTime) || (!next.openTime && next.closeTime)) {
    throw new Error('Set both open and close times, or leave both empty for 24-hour access');
  }
  if (next.openTime && !/^\d{2}:\d{2}$/.test(next.openTime)) {
    throw new Error('Open time must be HH:MM (24-hour)');
  }
  if (next.closeTime && !/^\d{2}:\d{2}$/.test(next.closeTime)) {
    throw new Error('Close time must be HH:MM (24-hour)');
  }
  if (validate && next.openTime && next.closeTime && next.openTime >= next.closeTime) {
    throw new Error('Close time must be after open time');
  }

  return next;
}

function timeToMinutes(str) {
  const [h, m] = str.split(':').map(Number);
  return h * 60 + m;
}

function formatDate(str, timeZone) {
  const [y, m, d] = str.split('-').map(Number);
  const ref = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return ref.toLocaleDateString(undefined, {
    timeZone,
    day: 'numeric',
    month: 'short',
  });
}

function formatTime(str, timeZone) {
  const [h, mins] = str.split(':').map(Number);
  const ref = new Date(Date.UTC(2000, 0, 1, h, mins, 0));
  return ref.toLocaleTimeString(undefined, {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  });
}

function buildClosedMessage(s) {
  const hours =
    s.openTime && s.closeTime
      ? `${formatTime(s.openTime, s.timeZone)} – ${formatTime(s.closeTime, s.timeZone)}`
      : null;
  const dates =
    s.startDate && s.endDate
      ? `${formatDate(s.startDate, s.timeZone)} – ${formatDate(s.endDate, s.timeZone)}`
      : s.startDate
        ? `from ${formatDate(s.startDate, s.timeZone)}`
        : s.endDate
          ? `until ${formatDate(s.endDate, s.timeZone)}`
          : null;

  if (dates && hours) return `Open ${dates}, ${hours}.`;
  if (hours) return `Open ${hours} daily.`;
  if (dates) return `Open ${dates}.`;
  return 'Please try again later.';
}

function applyStoredSettings(stored) {
  const storedRooms = stored.rooms != null ? parseRoomsValue(stored.rooms) : null;
  if (storedRooms) {
    rooms = storedRooms;
  } else if (stored.rooms == null) {
    db.patchSettings({ rooms });
  }

  if (stored.telegram_bot_token != null) {
    telegramBotToken = String(stored.telegram_bot_token);
  }
  if (stored.telegram_chat_id != null) {
    telegramChatId = String(stored.telegram_chat_id);
  }

  const storedSchedule = stored.schedule ? parseSchedule(stored.schedule) : null;
  if (storedSchedule) {
    schedule = storedSchedule;
  } else if (stored.schedule == null) {
    db.patchSettings({ schedule });
  }

  const storedWifi = stored.wifi ? parseWifi(stored.wifi) : null;
  if (storedWifi) {
    wifi = storedWifi;
  } else if (stored.wifi == null) {
    db.patchSettings({ wifi });
  }

  if (stored.help_base_url != null) {
    helpBaseUrl = String(stored.help_base_url).trim().replace(/\/$/, '');
  }
}

function persistAllSettings() {
  db.patchSettings({
    rooms,
    schedule,
    wifi,
    help_base_url: helpBaseUrl,
    telegram_bot_token: telegramBotToken,
    telegram_chat_id: telegramChatId,
  });
}

export function initSettings() {
  const stored = db.getSettings();
  applyStoredSettings(stored);
  persistAllSettings();
}

export function reloadSettings() {
  db.reloadStore();
  const stored = db.getSettings();
  applyStoredSettings(stored);
}

export function getSchedule() {
  return { ...schedule };
}

export function setSchedule(next) {
  schedule = normalizeSchedule(next);
  db.patchSettings({ schedule });
  return getSchedule();
}

export function getAvailability(now = new Date()) {
  const s = getSchedule();
  const hasDates = Boolean(s.startDate || s.endDate);
  const hasHours = Boolean(s.openTime && s.closeTime);
  const zoned = getZonedParts(now, s.timeZone);

  if (!hasDates && !hasHours) {
    return { open: true, schedule: s };
  }

  if (s.startDate && zoned.dateStr < s.startDate) {
    return { open: false, message: buildClosedMessage(s), schedule: s };
  }

  if (s.endDate && zoned.dateStr > s.endDate) {
    return { open: false, message: buildClosedMessage(s), schedule: s };
  }

  if (hasHours) {
    const openMins = timeToMinutes(s.openTime);
    const closeMins = timeToMinutes(s.closeTime);
    const nowMins = zoned.hour * 60 + zoned.minute;
    if (nowMins < openMins || nowMins >= closeMins) {
      return { open: false, message: buildClosedMessage(s), schedule: s };
    }
  }

  return { open: true, schedule: s };
}

export function getRooms() {
  return [...rooms];
}

export function setRooms(list) {
  rooms = normalizeRooms(list);
  db.patchSettings({ rooms });
  return rooms;
}

export function getTelegramConfig() {
  return {
    token: telegramBotToken,
    chatId: telegramChatId,
  };
}

export function updateTelegram({ botToken, chatId }) {
  if (botToken !== undefined) {
    telegramBotToken = String(botToken).trim();
    db.patchSettings({ telegram_bot_token: telegramBotToken });
  }
  if (chatId !== undefined) {
    telegramChatId = String(chatId).trim();
    db.patchSettings({ telegram_chat_id: telegramChatId });
  }
  return getTelegramConfig();
}

export function getWifi() {
  return { ...wifi };
}

export function setWifi(next) {
  wifi = {
    enabled: next.enabled !== false,
    ssid: String(next.ssid ?? '').trim(),
    password: String(next.password ?? '').trim(),
  };
  db.patchSettings({ wifi });
  return getWifi();
}

export function getHelpBaseUrl() {
  return helpBaseUrl;
}

export function setHelpBaseUrl(url) {
  helpBaseUrl = String(url ?? '')
    .trim()
    .replace(/\/$/, '');
  db.patchSettings({ help_base_url: helpBaseUrl });
  return helpBaseUrl;
}

export function resolveHelpBaseUrl(req) {
  if (helpBaseUrl) return helpBaseUrl;
  if (req) {
    const host = req.get('host');
    const proto = req.protocol || 'http';
    return `${proto}://${host}`;
  }
  return 'http://localhost:3000';
}

export function getAdminSettingsView() {
  const { token, chatId } = getTelegramConfig();
  return {
    rooms: getRooms(),
    schedule: getSchedule(),
    wifi: getWifi(),
    helpBaseUrl,
    telegram: {
      tokenSet: Boolean(token),
      chatId,
    },
  };
}

export function exportHelpdeskData() {
  return db.getExportSnapshot();
}

export function importHelpdeskData(payload, options = {}) {
  db.importSnapshot(payload, options);
  reloadSettings();
}
