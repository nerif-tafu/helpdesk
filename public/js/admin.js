import { bindTyping } from './typing.js';
import { confirmModal, hideModal, showModal } from './modal.js';

let selectedId = null;
let ws = null;
let pollTimer = null;
let typing = null;

const ADMIN_TABS = [
  { key: 'conversations', btn: 'tab-conversations-btn', panel: 'tab-conversations', onShow: null },
  { key: 'rooms', btn: 'tab-rooms-btn', panel: 'tab-rooms', onShow: loadSettings },
  { key: 'guides', btn: 'tab-guides-btn', panel: 'tab-guides', onShow: loadGuides },
  { key: 'settings', btn: 'tab-settings-btn', panel: 'tab-settings', onShow: loadSettings },
];

let showAdminTab = () => {};

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
    history.replaceState(null, '', window.location.pathname);
    showLogin();
  });

  document.getElementById('filter-status').addEventListener('change', loadQueue);
  document.getElementById('admin-chat-form').addEventListener('submit', sendReply);
  document.getElementById('resolve-btn').addEventListener('click', markResolved);
  initTabs();
  initSettingsForms();
  initGuides();

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
    loadSettings();
    loadQueue().then(() => applyAdminUrlState({ initial: true }));
    startPolling();
  }
}

function getAdminUrlState() {
  const params = new URLSearchParams(window.location.search);
  let tab = params.get('tab') || 'conversations';
  if (!ADMIN_TABS.some((t) => t.key === tab)) tab = 'conversations';
  return { tab, conversation: params.get('conversation') };
}

function setAdminUrl(updates, { replace = false } = {}) {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === '') params.delete(key);
    else params.set(key, value);
  }
  if (params.has('conversation')) params.set('tab', 'conversations');
  const qs = params.toString();
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  const state = { admin: true };
  if (replace) history.replaceState(state, '', url);
  else history.pushState(state, '', url);
}

function applyAdminUrlState({ initial = false } = {}) {
  const { tab, conversation } = getAdminUrlState();
  showAdminTab(tab, { updateUrl: false });
  if (initial) {
    setAdminUrl(
      { tab, conversation: conversation || null },
      { replace: true }
    );
  }
}

function initTabs() {
  function showTabByKey(tabKey, { updateUrl = true, replace = false } = {}) {
    const tab =
      ADMIN_TABS.find((t) => t.key === tabKey) ?? ADMIN_TABS[0];
    for (const { btn, panel, onShow } of ADMIN_TABS) {
      const button = document.getElementById(btn);
      const panelEl = document.getElementById(panel);
      const isActive = btn === tab.btn;
      button?.classList.toggle('is-active', isActive);
      button?.setAttribute('aria-selected', String(isActive));
      panelEl?.classList.toggle('u-hide', !isActive);
      if (panelEl) panelEl.hidden = !isActive;
      if (isActive && onShow) onShow();
    }
    if (updateUrl) {
      const { conversation } = getAdminUrlState();
      setAdminUrl({ tab: tab.key, conversation }, { replace });
    }
    if (tab.key === 'conversations') {
      const { conversation } = getAdminUrlState();
      if (conversation) {
        if (selectedId !== conversation) {
          void selectConversation(conversation, { updateUrl: false });
        }
      } else {
        selectedId = null;
        disconnectWs();
        showChatEmpty();
        loadQueue();
      }
    } else {
      selectedId = null;
      disconnectWs();
      loadQueue();
    }
  }

  showAdminTab = showTabByKey;

  for (const tab of ADMIN_TABS) {
    document.getElementById(tab.btn)?.addEventListener('click', () => {
      showTabByKey(tab.key);
    });
  }

  window.addEventListener('popstate', () => applyAdminUrlState());
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

  document.getElementById('sso-required')?.addEventListener('change', saveSsoSetting);

  document
    .getElementById('telegram-proxy-enabled')
    ?.addEventListener('change', toggleTelegramProxyFields);
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
    const body = { telegramChatId: chatInput.value.trim(), telegramProxy: collectTelegramProxy() };
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
  const confirmed = await confirmModal({
    title: `Import ${label}?`,
    message: `Importing "${file.name}" will overwrite existing ${label}.`,
    confirmLabel: 'Import',
    danger: true,
  });
  if (!confirmed) return;
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
    applySsoSettings(view.ssoRequired);
    applyTelegramSettings(view.telegram);
    loadGuides();
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
  applySsoSettings(data.ssoRequired);
  applyTelegramSettings(data.telegram);
}

function applySsoSettings(required) {
  const input = document.getElementById('sso-required');
  if (input) input.checked = Boolean(required);
}

async function saveSsoSetting(e) {
  const input = e.currentTarget;
  const required = input.checked;
  hideNotice('sso-saved', 'sso-error');
  if (required) {
    const confirmed = await confirmModal({
      title: 'Require Ubuntu SSO?',
      message:
        'Participants will need to sign in with an Ubuntu One account before starting a chat. Anyone with an open chat who is not signed in will be asked to sign in to continue.',
      confirmLabel: 'Require sign-in',
    });
    if (!confirmed) {
      input.checked = false;
      return;
    }
  }
  input.disabled = true;
  const res = await fetch('/api/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ ssoRequired: required }),
  });
  input.disabled = false;
  if (res.ok) {
    const data = await res.json();
    applySsoSettings(data.ssoRequired);
    const text = document.getElementById('sso-saved-text');
    if (text) {
      text.textContent = data.ssoRequired
        ? 'Ubuntu SSO sign-in is now required for participants.'
        : 'Ubuntu SSO sign-in is no longer required.';
    }
    showNotice('sso-saved');
    return;
  }
  input.checked = !required;
  const err = await res.json().catch(() => ({}));
  showError('sso-error', 'sso-error-text', err.error || 'Failed to save Ubuntu SSO setting');
}

let guides = [];
let editingGuideId = null;
let guideSlugEdited = false;

function initGuides() {
  document.getElementById('guide-add-btn')?.addEventListener('click', () => openGuideEditor(null));
  document.getElementById('guide-form')?.addEventListener('submit', saveGuide);
  document.getElementById('guide-title')?.addEventListener('input', (e) => {
    if (editingGuideId || guideSlugEdited) return;
    const slug = document.getElementById('guide-slug');
    if (slug) slug.value = slugify(e.target.value);
    updateSlugHelp();
  });
  document.getElementById('guide-slug')?.addEventListener('input', () => {
    guideSlugEdited = true;
    updateSlugHelp();
  });
  document.getElementById('guides-list')?.addEventListener('click', onGuideAction);
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function updateSlugHelp() {
  const help = document.getElementById('guide-slug-help');
  const slug = document.getElementById('guide-slug')?.value.trim();
  if (help) help.textContent = slug ? `Page address: /guides/${slug}` : '';
}

async function loadGuides() {
  const res = await fetch('/api/admin/guides', { credentials: 'include' });
  if (!res.ok) return;
  guides = (await res.json()).guides;
  renderGuides();
}

function renderGuides() {
  const tbody = document.getElementById('guides-list');
  const empty = document.getElementById('guides-empty');
  if (!tbody) return;
  tbody.innerHTML = '';
  empty?.classList.toggle('u-hide', guides.length > 0);
  guides.forEach((guide, index) => {
    const tr = document.createElement('tr');
    tr.dataset.id = guide.id;
    const status = guide.enabled
      ? '<span class="p-status-label--positive">Enabled</span>'
      : '<span class="p-status-label">Disabled</span>';
    tr.innerHTML = `
      <td>
        <span class="helpdesk-admin-guides__title">${escapeHtml(guide.title)}</span>
        <a class="helpdesk-admin-guides__meta" href="/guides/${encodeURIComponent(guide.slug)}" target="_blank" rel="noopener">/guides/${escapeHtml(guide.slug)}</a>
      </td>
      <td>${status}</td>
      <td class="helpdesk-admin-guides__actions-cell">
        <span class="helpdesk-admin-guides__actions">
          <button type="button" class="p-button is-dense has-icon" data-action="up" aria-label="Move ${escapeHtml(guide.title)} up" ${index === 0 ? 'disabled' : ''}><i class="p-icon--chevron-up"></i></button>
          <button type="button" class="p-button is-dense has-icon" data-action="down" aria-label="Move ${escapeHtml(guide.title)} down" ${index === guides.length - 1 ? 'disabled' : ''}><i class="p-icon--chevron-down"></i></button>
          <button type="button" class="p-button is-dense" data-action="toggle">${guide.enabled ? 'Disable' : 'Enable'}</button>
          <button type="button" class="p-button is-dense" data-action="edit">Edit</button>
          <button type="button" class="p-button--negative is-dense" data-action="delete">Delete</button>
        </span>
      </td>`;
    tbody.appendChild(tr);
  });
}

function showGuidesError(message) {
  hideNotice('guides-saved');
  showError('guides-error', 'guides-error-text', message);
}

function showGuidesSaved(message) {
  hideNotice('guides-error');
  const text = document.getElementById('guides-saved-text');
  if (text) text.textContent = message;
  showNotice('guides-saved');
}

async function guideRequest(url, options) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  if (Array.isArray(data.guides)) {
    guides = data.guides;
    renderGuides();
  }
  return data;
}

async function onGuideAction(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.closest('tr')?.dataset.id;
  const guide = guides.find((g) => g.id === id);
  if (!guide) return;
  const { action } = btn.dataset;

  if (action === 'edit') {
    openGuideEditor(guide);
    return;
  }

  try {
    if (action === 'up' || action === 'down') {
      await guideRequest(`/api/admin/guides/${encodeURIComponent(id)}/move`, {
        method: 'POST',
        body: JSON.stringify({ direction: action }),
      });
      document
        .querySelector(`#guides-list tr[data-id="${CSS.escape(id)}"] [data-action="${action}"]`)
        ?.focus();
    } else if (action === 'toggle') {
      await guideRequest(`/api/admin/guides/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: !guide.enabled }),
      });
      showGuidesSaved(`“${guide.title}” ${guide.enabled ? 'disabled' : 'enabled'}.`);
    } else if (action === 'delete') {
      const confirmed = await confirmModal({
        title: 'Delete guide?',
        message: `“${guide.title}” will be removed from the home page and its page will stop working. This cannot be undone.`,
        confirmLabel: 'Delete guide',
        danger: true,
      });
      if (!confirmed) return;
      await guideRequest(`/api/admin/guides/${encodeURIComponent(id)}`, { method: 'DELETE' });
      showGuidesSaved(`“${guide.title}” deleted.`);
    }
  } catch (err) {
    showGuidesError(err.message);
  }
}

function openGuideEditor(guide) {
  editingGuideId = guide?.id ?? null;
  guideSlugEdited = Boolean(guide);
  hideNotice('guide-form-error');
  document.getElementById('guide-modal-title').textContent = guide ? 'Edit guide' : 'Add guide';
  document.getElementById('guide-title').value = guide?.title ?? '';
  document.getElementById('guide-slug').value = guide?.slug ?? '';
  document.getElementById('guide-excerpt').value = guide?.excerpt ?? '';
  document.getElementById('guide-summary').value = guide?.summary ?? '';
  document.getElementById('guide-image').value = guide?.imageUrl ?? '';
  document.getElementById('guide-content').value =
    guide?.content ?? '## Steps\n1. \n\n## Troubleshooting\n- ';
  document.getElementById('guide-enabled').checked = guide ? guide.enabled : true;
  updateSlugHelp();
  showModal(document.getElementById('guide-modal'));
}

async function saveGuide(e) {
  e.preventDefault();
  hideNotice('guide-form-error');
  const title = document.getElementById('guide-title').value.trim();
  if (!title) {
    showError('guide-form-error', 'guide-form-error-text', 'Title is required');
    document.getElementById('guide-title').focus();
    return;
  }
  const body = {
    title,
    slug: document.getElementById('guide-slug').value.trim(),
    excerpt: document.getElementById('guide-excerpt').value,
    summary: document.getElementById('guide-summary').value,
    imageUrl: document.getElementById('guide-image').value.trim(),
    content: document.getElementById('guide-content').value,
    enabled: document.getElementById('guide-enabled').checked,
  };
  const saveBtn = document.getElementById('guide-save-btn');
  saveBtn.disabled = true;
  try {
    const url = editingGuideId
      ? `/api/admin/guides/${encodeURIComponent(editingGuideId)}`
      : '/api/admin/guides';
    const { guide } = await guideRequest(url, {
      method: editingGuideId ? 'PUT' : 'POST',
      body: JSON.stringify(body),
    });
    hideModal(document.getElementById('guide-modal'));
    showGuidesSaved(`“${guide.title}” saved.`);
  } catch (err) {
    showError('guide-form-error', 'guide-form-error-text', err.message);
  } finally {
    saveBtn.disabled = false;
  }
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
  body.telegramProxy = collectTelegramProxy();
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
    pre.textContent = 'No log entries yet. Logs appear when participant messages trigger notifications or you send a test message.';
    return;
  }
  pre.textContent = logs
    .map((entry) => {
      const time = new Date(entry.at).toLocaleString();
      const detail = entry.detail
        ? `\n${entry.detail
            .split('\n')
            .map((line) => `  ${line}`)
            .join('\n')}`
        : '';
      return `[${time}] ${entry.level.toUpperCase()}: ${entry.message}${detail}`;
    })
    .join('\n\n');
}

function collectTelegramProxy() {
  return {
    enabled: Boolean(document.getElementById('telegram-proxy-enabled')?.checked),
    url: document.getElementById('telegram-proxy-url')?.value.trim() ?? '',
  };
}

function toggleTelegramProxyFields() {
  const enabled = Boolean(document.getElementById('telegram-proxy-enabled')?.checked);
  document.getElementById('telegram-proxy-fields')?.classList.toggle('u-hide', !enabled);
}

function applyTelegramSettings(telegram) {
  const proxyEnabled = document.getElementById('telegram-proxy-enabled');
  const proxyUrl = document.getElementById('telegram-proxy-url');
  if (proxyEnabled) proxyEnabled.checked = Boolean(telegram.proxy?.enabled);
  if (proxyUrl) proxyUrl.value = telegram.proxy?.url || '';
  toggleTelegramProxyFields();
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
    const email = c.participant_sso?.email;
    btn.innerHTML = `<span class="helpdesk-queue-btn__room">${escapeHtml(c.room)}</span>
      <span class="helpdesk-queue-btn__meta u-text-muted">${escapeHtml(name)}</span>${
        email
          ? `<span class="helpdesk-queue-btn__meta u-text-muted">${escapeHtml(email)}</span>`
          : ''
      }`;
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

async function selectConversation(id, { updateUrl = true, replace = false } = {}) {
  selectedId = id;
  if (updateUrl) {
    // Write the URL first: showAdminTab reads the conversation from it and would
    // otherwise clear the selection.
    setAdminUrl({ tab: 'conversations', conversation: id }, { replace });
    showAdminTab('conversations', { updateUrl: false });
  }
  disconnectWs();
  showChatActive();
  const ok = await loadConversation(id);
  if (!ok) {
    selectedId = null;
    showChatEmpty();
    if (updateUrl) setAdminUrl({ conversation: null }, { replace: true });
    loadQueue();
    return;
  }
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
  if (!convRes.ok) return false;
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
  return true;
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
