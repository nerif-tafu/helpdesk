import { bindTyping } from './typing.js';

let selectedId = null;
let ws = null;
let pollTimer = null;
let typing = null;

export async function initAdmin() {
  const loginSection = document.getElementById('login-section');
  const dashboard = document.getElementById('dashboard-section');
  const navGuest = document.querySelector('.js-nav-guest');
  const navAuth = document.querySelector('.js-nav-authenticated');
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  const logoutBtn = document.getElementById('logout-btn');

  const meRes = await fetch('/api/admin/me', { credentials: 'include' });
  const { authenticated } = await meRes.json();
  if (authenticated) showDashboard();
  else showLogin();

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.classList.add('u-hide');
    const password = document.getElementById('password').value;
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ password }),
    });
    if (res.ok) showDashboard();
    else loginError.classList.remove('u-hide');
  });

  logoutBtn.addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST', credentials: 'include' });
    selectedId = null;
    disconnectWs();
    showChatEmpty();
    showLogin();
  });

  document.getElementById('filter-status').addEventListener('change', loadQueue);
  document.getElementById('admin-chat-form').addEventListener('submit', sendReply);
  document.getElementById('resolve-btn').addEventListener('click', markResolved);
  initTabs();
  initSettingsForms();

  function showLogin() {
    loginSection.classList.remove('u-hide');
    dashboard.classList.add('u-hide');
    navGuest?.classList.remove('u-hide');
    navGuest?.classList.add('is-selected');
    navAuth?.classList.add('u-hide');
    stopPolling();
  }

  function showDashboard() {
    loginSection.classList.add('u-hide');
    dashboard.classList.remove('u-hide');
    navGuest?.classList.add('u-hide');
    navGuest?.classList.remove('is-selected');
    navAuth?.classList.remove('u-hide');
    loadQueue();
    loadSettings();
    startPolling();
  }
}

function initTabs() {
  const tabs = [
    { btn: 'tab-conversations-btn', panel: 'tab-conversations', onShow: null },
    { btn: 'tab-rooms-btn', panel: 'tab-rooms', onShow: loadSettings },
    { btn: 'tab-settings-btn', panel: 'tab-settings', onShow: loadSettings },
  ];

  function showTab(activeId) {
    for (const { btn, panel, onShow } of tabs) {
      const button = document.getElementById(btn);
      const panelEl = document.getElementById(panel);
      const isActive = btn === activeId;
      button?.classList.toggle('is-active', isActive);
      button?.setAttribute('aria-selected', String(isActive));
      panelEl?.classList.toggle('u-hide', !isActive);
      if (panelEl) panelEl.hidden = !isActive;
      if (isActive && onShow) onShow();
    }
  }

  for (const { btn } of tabs) {
    document.getElementById(btn)?.addEventListener('click', () => showTab(btn));
  }
}

function initSettingsForms() {
  populateTimezoneSelect();
  initWifiFormToggle();

  document.getElementById('wifi-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideNotice('wifi-saved', 'wifi-error');
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        wifi: collectWifiForm(),
      }),
    });
    if (res.ok) {
      applyWifiSettings((await res.json()).wifi);
      showNotice('wifi-saved');
      return;
    }
    const err = await res.json().catch(() => ({}));
    showError('wifi-error', 'wifi-error-text', err.error || 'Failed to save WiFi');
  });

  document.getElementById('help-url-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideNotice('help-url-saved', 'help-url-error');
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        helpBaseUrl: document.getElementById('help-base-url')?.value ?? '',
      }),
    });
    if (res.ok) {
      applyHelpUrlSettings((await res.json()).helpBaseUrl);
      showNotice('help-url-saved');
      return;
    }
    const err = await res.json().catch(() => ({}));
    showError('help-url-error', 'help-url-error-text', err.error || 'Failed to save URL');
  });

  document.getElementById('print-one-btn')?.addEventListener('click', () => {
    const room = document.getElementById('print-room-select')?.value;
    if (!room) return;
    window.open(`/api/admin/print?room=${encodeURIComponent(room)}`, '_blank');
  });

  document.getElementById('print-all-btn')?.addEventListener('click', () => {
    window.open('/api/admin/print?room=all', '_blank');
  });

  document.getElementById('rooms-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideNotice('rooms-saved', 'rooms-error');
    const rooms = parseRoomsCsv(document.getElementById('rooms-csv')?.value ?? '');
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ rooms }),
    });
    if (res.ok) {
      const data = await res.json();
      renderRoomsList(data.rooms);
      populatePrintRoomSelect(data.rooms);
      showNotice('rooms-saved');
      return;
    }
    const err = await res.json().catch(() => ({}));
    showError('rooms-error', 'rooms-error-text', err.error || 'Failed to save rooms');
  });

  document.getElementById('schedule-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideNotice('schedule-saved', 'schedule-error');
    const schedule = collectScheduleForm();
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ schedule }),
    });
    if (res.ok) {
      const data = await res.json();
      applyScheduleSettings(data.schedule);
      showNotice('schedule-saved');
      return;
    }
    const err = await res.json().catch(() => ({}));
    showError('schedule-error', 'schedule-error-text', err.error || 'Failed to save hours');
  });

  document.getElementById('telegram-test-btn')?.addEventListener('click', sendTelegramTest);
  document.getElementById('telegram-logs-btn')?.addEventListener('click', toggleTelegramLogs);
  document.getElementById('telegram-logs-refresh')?.addEventListener('click', loadTelegramLogs);

  document.getElementById('data-export-btn')?.addEventListener('click', () => {
    window.open('/api/admin/data/export', '_blank');
  });

  document.getElementById('data-import-form')?.addEventListener('submit', importHelpdeskData);

  document.getElementById('telegram-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideNotice('telegram-saved', 'telegram-error');
    const tokenInput = document.getElementById('telegram-bot-token');
    const chatInput = document.getElementById('telegram-chat-id');
    const body = { telegramChatId: chatInput.value.trim() };
    if (tokenInput.value.trim()) {
      body.telegramBotToken = tokenInput.value.trim();
    }
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      applyTelegramSettings(data.telegram);
      tokenInput.value = '';
      const savedMsg = document.querySelector('#telegram-saved .p-notification__message');
      if (savedMsg) savedMsg.textContent = 'Telegram settings saved.';
      showNotice('telegram-saved');
      return;
    }
    const err = await res.json().catch(() => ({}));
    showError('telegram-error', 'telegram-error-text', err.error || 'Failed to save Telegram');
  });
}

async function importHelpdeskData(e) {
  e.preventDefault();
  hideNotice('data-import-saved', 'data-import-error');
  const fileInput = document.getElementById('data-import-file');
  const file = fileInput?.files?.[0];
  if (!file) {
    showError('data-import-error', 'data-import-error-text', 'Choose a JSON file to import');
    return;
  }
  const settingsOnly =
    document.querySelector('input[name="data-import-mode"]:checked')?.value === 'settings';
  const label = settingsOnly ? 'settings only' : 'all data';
  if (
    !window.confirm(
      `Import ${label} from "${file.name}"? This will overwrite existing ${label}.`
    )
  ) {
    return;
  }
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    showError('data-import-error', 'data-import-error-text', 'File is not valid JSON');
    return;
  }
  const res = await fetch('/api/admin/data/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ data, settingsOnly }),
  });
  if (res.ok) {
    const view = await res.json();
    renderRoomsList(view.rooms);
    populatePrintRoomSelect(view.rooms);
    applyScheduleSettings(view.schedule);
    applyWifiSettings(view.wifi);
    applyHelpUrlSettings(view.helpBaseUrl);
    applyTelegramSettings(view.telegram);
    fileInput.value = '';
    showNotice('data-import-saved');
    return;
  }
  const err = await res.json().catch(() => ({}));
  showError('data-import-error', 'data-import-error-text', err.error || 'Import failed');
}

async function loadSettings() {
  const res = await fetch('/api/admin/settings', { credentials: 'include' });
  if (!res.ok) return;
  const data = await res.json();
  renderRoomsList(data.rooms);
  populatePrintRoomSelect(data.rooms);
  applyScheduleSettings(data.schedule);
  applyWifiSettings(data.wifi);
  applyHelpUrlSettings(data.helpBaseUrl);
  applyTelegramSettings(data.telegram);
}

function populatePrintRoomSelect(rooms) {
  const select = document.getElementById('print-room-select');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">Choose a room…</option>';
  for (const room of rooms || []) {
    const opt = document.createElement('option');
    opt.value = room;
    opt.textContent = room;
    select.appendChild(opt);
  }
  if (current && [...select.options].some((o) => o.value === current)) {
    select.value = current;
  }
}

function collectWifiForm() {
  const enabled = document.querySelector('input[name="wifi-enabled"]:checked')?.value === 'true';
  return {
    enabled,
    ssid: document.getElementById('wifi-ssid')?.value ?? '',
    password: document.getElementById('wifi-password')?.value ?? '',
  };
}

function applyWifiSettings(wifi) {
  const enabled = wifi?.enabled !== false;
  const yes = document.getElementById('wifi-enabled-yes');
  const no = document.getElementById('wifi-enabled-no');
  if (yes) yes.checked = enabled;
  if (no) no.checked = !enabled;
  const ssid = document.getElementById('wifi-ssid');
  const password = document.getElementById('wifi-password');
  const fields = document.getElementById('wifi-fields');
  if (ssid) ssid.value = wifi?.ssid || '';
  if (password) password.value = wifi?.password || '';
  if (fields) {
    fields.classList.toggle('u-hide', !enabled);
    if (ssid) ssid.disabled = !enabled;
    if (password) password.disabled = !enabled;
  }
}

function initWifiFormToggle() {
  for (const input of document.querySelectorAll('input[name="wifi-enabled"]')) {
    input.addEventListener('change', () => {
      applyWifiSettings(collectWifiForm());
    });
  }
}

function applyHelpUrlSettings(url) {
  const input = document.getElementById('help-base-url');
  if (input) input.value = url || '';
}

let timezonesPopulated = false;

function populateTimezoneSelect() {
  const select = document.getElementById('schedule-timezone');
  if (!select || timezonesPopulated) return;
  const saved = select.value;
  for (const tz of Intl.supportedValuesOf('timeZone').sort()) {
    const opt = document.createElement('option');
    opt.value = tz;
    opt.textContent = tz;
    select.appendChild(opt);
  }
  timezonesPopulated = true;
  if (saved) select.value = saved;
}

function collectScheduleForm() {
  return {
    startDate: document.getElementById('schedule-start-date')?.value || null,
    endDate: document.getElementById('schedule-end-date')?.value || null,
    openTime: document.getElementById('schedule-open-time')?.value || null,
    closeTime: document.getElementById('schedule-close-time')?.value || null,
    timeZone: document.getElementById('schedule-timezone')?.value || null,
  };
}

function applyScheduleSettings(schedule) {
  if (!schedule) return;
  populateTimezoneSelect();
  const start = document.getElementById('schedule-start-date');
  const end = document.getElementById('schedule-end-date');
  const open = document.getElementById('schedule-open-time');
  const close = document.getElementById('schedule-close-time');
  const tz = document.getElementById('schedule-timezone');
  if (start) start.value = schedule.startDate || '';
  if (end) end.value = schedule.endDate || '';
  if (open) open.value = schedule.openTime || '';
  if (close) close.value = schedule.closeTime || '';
  if (tz && schedule.timeZone) tz.value = schedule.timeZone;
}

function renderRoomsList(rooms) {
  const input = document.getElementById('rooms-csv');
  if (!input) return;
  input.value = rooms?.length ? rooms.join(', ') : '';
}

function parseRoomsCsv(text) {
  return text
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

async function sendTelegramTest() {
  hideNotice('telegram-saved', 'telegram-error');
  const tokenInput = document.getElementById('telegram-bot-token');
  const chatInput = document.getElementById('telegram-chat-id');
  const btn = document.getElementById('telegram-test-btn');
  const body = {};
  if (tokenInput?.value.trim()) body.telegramBotToken = tokenInput.value.trim();
  if (chatInput?.value.trim()) body.telegramChatId = chatInput.value.trim();
  btn.disabled = true;
  const res = await fetch('/api/admin/telegram/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  btn.disabled = false;
  const logsPanel = document.getElementById('telegram-logs-panel');
  if (!logsPanel?.classList.contains('u-hide')) await loadTelegramLogs();
  if (res.ok) {
    showNotice('telegram-saved');
    document.querySelector('#telegram-saved .p-notification__message').textContent =
      'Test message sent. Check your Telegram chat.';
    return;
  }
  const err = await res.json().catch(() => ({}));
  showError('telegram-error', 'telegram-error-text', err.error || 'Test message failed');
}

async function toggleTelegramLogs() {
  const panel = document.getElementById('telegram-logs-panel');
  if (!panel) return;
  const opening = panel.classList.contains('u-hide');
  panel.classList.toggle('u-hide');
  if (opening) await loadTelegramLogs();
}

async function loadTelegramLogs() {
  const pre = document.getElementById('telegram-logs-content');
  if (!pre) return;
  pre.textContent = 'Loading…';
  const res = await fetch('/api/admin/telegram/logs', { credentials: 'include' });
  if (!res.ok) {
    pre.textContent = 'Could not load logs.';
    return;
  }
  const { logs } = await res.json();
  if (!logs.length) {
    pre.textContent = 'No log entries yet. Logs appear when participant messages trigger notifications.';
    return;
  }
  pre.textContent = logs
    .map((entry) => {
      const time = new Date(entry.at).toLocaleString();
      const detail = entry.detail ? `\n  ${entry.detail}` : '';
      return `[${time}] ${entry.level.toUpperCase()}: ${entry.message}${detail}`;
    })
    .join('\n\n');
}

function applyTelegramSettings(telegram) {
  const chatInput = document.getElementById('telegram-chat-id');
  const hint = document.getElementById('telegram-token-hint');
  if (chatInput) chatInput.value = telegram.chatId || '';
  if (hint) {
    hint.textContent = telegram.tokenSet
      ? 'A bot token is saved. Enter a new token only to replace it.'
      : 'No bot token saved yet.';
  }
}

function showChatEmpty() {
  document.getElementById('chat-empty')?.classList.remove('u-hide');
  document.getElementById('chat-active')?.classList.add('u-hide');
}

function showChatActive() {
  document.getElementById('chat-empty')?.classList.add('u-hide');
  document.getElementById('chat-active')?.classList.remove('u-hide');
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(loadQueue, 5000);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function loadQueue() {
  const filter = document.getElementById('filter-status').value;
  const q = filter ? `?status=${filter}` : '';
  const res = await fetch(`/api/admin/conversations${q}`, { credentials: 'include' });
  if (!res.ok) return;
  const { conversations } = await res.json();
  const list = document.getElementById('queue');
  const empty = document.getElementById('queue-empty');
  list.innerHTML = '';
  const items = filter
    ? conversations
    : conversations.filter((c) => c.status !== 'resolved');
  if (!items.length) {
    empty.classList.remove('u-hide');
    return;
  }
  empty.classList.add('u-hide');
  for (const c of items) {
    const li = document.createElement('li');
    li.className = 'helpdesk-admin-queue__item';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'helpdesk-queue-btn' +
      (c.needs_reply ? ' helpdesk-queue-btn--needs-reply' : '') +
      (selectedId === c.id ? ' is-active' : '');
    const name = c.participant_name || 'Anonymous';
    btn.innerHTML = `<span class="helpdesk-queue-btn__room">${escapeHtml(c.room)}</span>
      <span class="helpdesk-queue-btn__meta u-text-muted">${escapeHtml(name)}</span>`;
    btn.addEventListener('click', () => selectConversation(c.id));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function statusLabel(status) {
  return (
    { waiting: 'Waiting', joined: 'Joined', active: 'Active', resolved: 'Resolved' }[status] ||
    status
  );
}

function presenceLabel(online) {
  return online ? 'User online' : 'User offline';
}

function applyPresenceToHeader(online) {
  const el = document.getElementById('chat-presence');
  if (!el) return;
  el.textContent = presenceLabel(online);
  el.className =
    'p-status-label' + (online ? ' p-status-label--positive' : '');
}

async function selectConversation(id) {
  selectedId = id;
  disconnectWs();
  showChatActive();
  await loadConversation(id);
  connectWs(id);
  loadQueue();
}

function connectWs(conversationId) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(
    `${protocol}//${window.location.host}/ws?conversationId=${encodeURIComponent(conversationId)}&role=support`
  );
  if (!typing) {
    typing = bindTyping({
      getWs: () => ws,
      sender: 'support',
      indicatorEl: document.getElementById('typing-indicator'),
      textEl: document.getElementById('typing-indicator-text'),
    });
  }
  const adminInput = document.getElementById('admin-message-input');
  adminInput.oninput = () => {
    if (!adminInput.disabled) typing.onInput();
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'typing') {
      typing.handleEvent(data);
      return;
    }
    if (data.type === 'presence') {
      if (selectedId === data.conversationId) {
        applyPresenceToHeader(data.participantOnline);
      }
      loadQueue();
      return;
    }
    if (data.conversation?.id !== selectedId) return;
    if (data.type === 'message') {
      typing.handleEvent({ type: 'typing', sender: 'participant', typing: false });
      appendAdminMessage(data.message);
      updateAdminHeader(data.conversation);
      loadQueue();
    }
    if (data.type === 'status') {
      updateAdminHeader(data.conversation);
      loadQueue();
    }
  };
}

function disconnectWs() {
  typing?.stop();
  typing?.handleEvent({ type: 'typing', sender: 'participant', typing: false });
  if (ws) ws.close();
  ws = null;
}

async function loadConversation(id) {
  const [convRes, msgRes] = await Promise.all([
    fetch(`/api/conversations/${id}`, { credentials: 'include' }),
    fetch(`/api/conversations/${id}/messages`, { credentials: 'include' }),
  ]);
  if (!convRes.ok) return;
  const { conversation } = await convRes.json();
  const { messages } = await msgRes.json();
  typing?.handleEvent({ type: 'typing', sender: 'participant', typing: false });
  const box = document.getElementById('admin-messages');
  box.innerHTML = '';
  for (const m of messages) appendAdminMessage(m);
  updateAdminHeader(conversation);
  const title = document.getElementById('chat-title');
  if (title) title.textContent = conversation.room;
  const resolved = conversation.status === 'resolved';
  document.getElementById('admin-message-input').disabled = resolved;
  document.getElementById('resolve-btn').disabled = resolved;
}

function updateAdminHeader(c) {
  const statusEl = document.getElementById('chat-status');
  if (c.status === 'joined' || c.status === 'active') {
    statusEl.textContent = '';
    statusEl.className = 'p-status-label u-hide';
  } else {
    statusEl.classList.remove('u-hide');
    statusEl.textContent = statusLabel(c.status);
    statusEl.className =
      'p-status-label' +
      (c.status === 'waiting' ? ' p-status-label--warning' : '');
  }
  if ('participant_online' in c) {
    applyPresenceToHeader(Boolean(c.participant_online));
  }
}

function appendAdminMessage(msg) {
  const box = document.getElementById('admin-messages');
  if (box.querySelector(`[data-id="${msg.id}"]`)) return;
  const div = document.createElement('div');
  div.className =
    'helpdesk-chat__message' +
    (msg.sender === 'support' ? ' helpdesk-chat__message--support' : '');
  div.dataset.id = msg.id;
  const time = new Date(msg.created_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const who = msg.sender === 'support' ? 'Support' : 'Participant';
  div.innerHTML = `
    <div class="helpdesk-chat__meta">${who} · ${time}</div>
    <div class="helpdesk-chat__bubble">${escapeHtml(msg.body)}</div>
  `;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

async function sendReply(e) {
  e.preventDefault();
  if (!selectedId) return;
  const input = document.getElementById('admin-message-input');
  const body = input.value.trim();
  if (!body) return;
  typing?.stop();
  input.value = '';
  const res = await fetch(`/api/conversations/${selectedId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ body, sender: 'support' }),
  });
  if (res.ok) {
    const data = await res.json();
    appendAdminMessage(data.message);
    updateAdminHeader(data.conversation);
    loadQueue();
  }
}

async function markResolved() {
  if (!selectedId) return;
  const res = await fetch(`/api/conversations/${selectedId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ status: 'resolved' }),
  });
  if (res.ok) {
    const { conversation } = await res.json();
    updateAdminHeader(conversation);
    document.getElementById('admin-message-input').disabled = true;
    document.getElementById('resolve-btn').disabled = true;
    loadQueue();
  }
}

function hideNotice(...ids) {
  for (const id of ids) document.getElementById(id)?.classList.add('u-hide');
}

function showNotice(id) {
  document.getElementById(id)?.classList.remove('u-hide');
  setTimeout(() => document.getElementById(id)?.classList.add('u-hide'), 4000);
}

function showError(boxId, textId, message) {
  const box = document.getElementById(boxId);
  const text = document.getElementById(textId);
  if (text) text.textContent = message;
  box?.classList.remove('u-hide');
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
