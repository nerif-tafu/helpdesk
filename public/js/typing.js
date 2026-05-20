const TYPING_IDLE_MS = 2000;
const TYPING_LABELS = {
  participant: 'Participant',
  support: 'Support',
};

export function bindTyping({ getWs, sender, indicatorEl, textEl }) {
  let idleTimer = null;
  let active = false;

  function send(typing) {
    const ws = getWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (active === typing) return;
    active = typing;
    ws.send(JSON.stringify({ type: 'typing', sender, typing }));
  }

  function stop() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    send(false);
  }

  function onInput() {
    send(true);
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(stop, TYPING_IDLE_MS);
  }

  function handleEvent(data) {
    if (data.type !== 'typing' || data.sender === sender) return;
    const typing = Boolean(data.typing);
    if (!indicatorEl) return;
    indicatorEl.classList.toggle('u-hide', !typing);
    if (textEl) {
      const who = TYPING_LABELS[data.sender] || 'Someone';
      textEl.textContent = `${who} is typing…`;
    }
    if (!typing) return;
    indicatorEl.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }

  return { onInput, stop, handleEvent };
}
