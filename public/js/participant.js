import { bindTyping } from './typing.js';

const STORAGE_KEY = 'helpdesk_conversation_id';

export async function initHome() {
  const roomSelect = document.getElementById('room');
  const form = document.getElementById('start-form');
  const errorBox = document.getElementById('start-error');
  const errorText = document.getElementById('start-error-text');
  const openBtn = document.getElementById('open-chat-btn');
  const nameInput = document.getElementById('participant-name');
  const closedBox = document.getElementById('helpdesk-closed');
  const closedMessage = document.getElementById('helpdesk-closed-message');

  const [roomsRes, availRes] = await Promise.all([
    fetch('/api/rooms'),
    fetch('/api/availability'),
  ]);
  const { rooms } = await roomsRes.json();
  for (const room of rooms) {
    const opt = document.createElement('option');
    opt.value = room;
    opt.textContent = room;
    roomSelect.appendChild(opt);
  }

  const roomParam = new URLSearchParams(window.location.search).get('room');
  if (roomParam) {
    const decoded = decodeURIComponent(roomParam);
    const exact = rooms.includes(decoded);
    const slug = decoded.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const match =
      exact ? decoded : rooms.find((r) => r.toLowerCase().replace(/[^a-z0-9]+/g, '') === slug);
    if (match) roomSelect.value = match;
  }

  let helpdeskOpen = true;
  if (availRes.ok) {
    const availability = await availRes.json();
    helpdeskOpen = availability.open;
    if (!helpdeskOpen) {
      closedMessage.textContent = availability.message || 'The help desk is currently closed.';
      closedBox?.classList.remove('u-hide');
      roomSelect.disabled = true;
      nameInput.disabled = true;
      openBtn.disabled = true;
    }
  }

  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing) {
    try {
      const check = await fetch(`/api/conversations/${existing}`);
      if (check.ok) {
        const { conversation } = await check.json();
        if (conversation.status !== 'resolved') {
          window.location.href = `/chat.html?id=${existing}`;
          return;
        }
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!helpdeskOpen) return;
    errorBox.classList.add('u-hide');
    const btn = document.getElementById('open-chat-btn');
    btn.disabled = true;
    try {
      const room = roomSelect.value;
      const participantName = document.getElementById('participant-name').value.trim();
      const createRes = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room, participantName: participantName || undefined }),
      });
      if (!createRes.ok) {
        const err = await createRes.json();
        throw new Error(err.error || 'Failed to start');
      }
      const { conversation } = await createRes.json();
      localStorage.setItem(STORAGE_KEY, conversation.id);
      window.location.href = `/chat.html?id=${conversation.id}`;
    } catch (err) {
      errorText.textContent = err.message;
      errorBox.classList.remove('u-hide');
      btn.disabled = false;
    }
  });
}

export function initChat() {
  const params = new URLSearchParams(window.location.search);
  const conversationId = params.get('id') || localStorage.getItem(STORAGE_KEY);
  if (!conversationId) {
    window.location.href = '/';
    return;
  }
  localStorage.setItem(STORAGE_KEY, conversationId);

  const messagesEl = document.getElementById('messages');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('message-input');
  const statusBanner = document.getElementById('status-banner');
  const chatEndedModal = document.getElementById('chat-ended-modal');
  const statusTitle = document.getElementById('status-title');
  const statusMessage = document.getElementById('status-message');
  const roomHeading = document.getElementById('chat-room-heading');
  const endChatBtn = document.getElementById('end-chat-btn');

  let conversation = null;
  let ws = null;
  let endedModalDismissed = false;
  const typing = bindTyping({
    getWs: () => ws,
    sender: 'participant',
    indicatorEl: document.getElementById('typing-indicator'),
    textEl: document.getElementById('typing-indicator-text'),
  });

  let wsHadConnection = false;

  async function syncFromServer({ clearMessages = false, redirectIfMissing = false } = {}) {
    const [convRes, msgRes] = await Promise.all([
      fetch(`/api/conversations/${conversationId}`),
      fetch(`/api/conversations/${conversationId}/messages`),
    ]);
    if (!convRes.ok) {
      if (redirectIfMissing) {
        localStorage.removeItem(STORAGE_KEY);
        window.location.href = '/';
      }
      return false;
    }
    const { conversation: c } = await convRes.json();
    const wasOpen = conversation && conversation.status !== 'resolved';
    conversation = c;
    if (c.status === 'resolved' && wasOpen) {
      endedModalDismissed = false;
    }
    if (msgRes.ok) {
      const { messages } = await msgRes.json();
      if (clearMessages) messagesEl.innerHTML = '';
      for (const m of messages) appendMessage(m);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    updateUi();
    return true;
  }

  async function refreshConversation() {
    try {
      await syncFromServer();
    } catch {
      // ignore transient network errors; will retry on next wake/reconnect
    }
  }

  function connectWs() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(
      `${protocol}//${window.location.host}/ws?conversationId=${encodeURIComponent(conversationId)}&role=participant`
    );
    ws.onopen = () => {
      if (wsHadConnection) refreshConversation();
      wsHadConnection = true;
    };
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'message') {
        typing.handleEvent({ type: 'typing', sender: 'support', typing: false });
        appendMessage(data.message);
        conversation = data.conversation;
        updateUi();
      }
      if (data.type === 'status') {
        conversation = data.conversation;
        updateUi();
      }
      typing.handleEvent(data);
    };
    ws.onclose = () => {
      if (conversation?.status === 'resolved') return;
      setTimeout(connectWs, 3000);
    };
  }

  function appendMessage(msg) {
    if (messagesEl.querySelector(`[data-id="${msg.id}"]`)) return;
    const div = document.createElement('div');
    div.className =
      'helpdesk-chat__message' +
      (msg.sender === 'support' ? ' helpdesk-chat__message--support' : '');
    div.dataset.id = msg.id;
    const time = new Date(msg.created_at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    div.innerHTML = `
      <div class="helpdesk-chat__meta">${msg.sender === 'support' ? 'Support' : 'You'} · ${time}</div>
      <div class="helpdesk-chat__bubble">${escapeHtml(msg.body)}</div>
    `;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showEndedModal() {
    if (!chatEndedModal || endedModalDismissed) return;
    chatEndedModal.classList.remove('u-hide');
    chatEndedModal.setAttribute('aria-hidden', 'false');
  }

  function hideEndedModal() {
    endedModalDismissed = true;
    chatEndedModal?.classList.add('u-hide');
    chatEndedModal?.setAttribute('aria-hidden', 'true');
  }

  function updateUi() {
    if (!conversation) return;
    if (roomHeading) {
      roomHeading.textContent = conversation.room;
      roomHeading.hidden = false;
    }
    const resolved = conversation.status === 'resolved';
    statusBanner.classList.toggle('u-hide', resolved);
    input.disabled = resolved;
    if (endChatBtn) {
      endChatBtn.disabled = resolved;
      endChatBtn.classList.toggle('u-hide', resolved);
    }
    if (resolved) {
      form.classList.add('u-hide');
      showEndedModal();
      return;
    }
    form.classList.remove('u-hide');
    if (conversation.status === 'waiting') {
      statusTitle.textContent = 'Waiting for support';
      statusMessage.textContent = 'A team member will join your chat shortly.';
      statusBanner.className = 'p-notification--information';
    } else if (conversation.status === 'joined') {
      statusTitle.textContent = 'Support has joined';
      statusMessage.textContent = 'A team member is here and will reply shortly.';
      statusBanner.className = 'p-notification--positive';
    } else {
      statusTitle.textContent = 'Connected';
      statusMessage.textContent = 'You are chatting with support.';
      statusBanner.className = 'p-notification--positive';
    }
  }

  async function load() {
    const ok = await syncFromServer({ clearMessages: true, redirectIfMissing: true });
    if (!ok) return;
    connectWs();
  }

  input.addEventListener('input', () => {
    if (!input.disabled) typing.onInput();
  });

  document.getElementById('chat-ended-dismiss')?.addEventListener('click', hideEndedModal);
  document.getElementById('chat-ended-new')?.addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
  });

  endChatBtn?.addEventListener('click', async () => {
    if (!conversation || conversation.status === 'resolved') return;
    if (
      !confirm(
        'End this chat? Support will no longer see it as open. You can start a new request from the home page.'
      )
    ) {
      return;
    }
    endChatBtn.disabled = true;
    const res = await fetch(`/api/conversations/${conversationId}/end`, { method: 'POST' });
    if (res.ok) {
      const { conversation: c } = await res.json();
      conversation = c;
      typing.stop();
      updateUi();
      return;
    }
    endChatBtn.disabled = false;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body || conversation?.status === 'resolved') return;
    typing.stop();
    input.value = '';
    const res = await fetch(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, sender: 'participant' }),
    });
    if (res.ok) {
      const data = await res.json();
      appendMessage(data.message);
      conversation = data.conversation;
      updateUi();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshConversation();
  });

  window.addEventListener('pageshow', (event) => {
    if (event.persisted) refreshConversation();
  });

  load();
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
