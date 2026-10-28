// Vanilla p-modal helpers. Use these instead of window.alert / confirm / prompt.

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const openStack = [];

function onKeydown(event) {
  const top = openStack[openStack.length - 1];
  if (!top) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    top.onDismiss();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...top.el.querySelectorAll(FOCUSABLE)].filter(
    (node) => node.offsetParent !== null
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Show an existing `.p-modal` element. `onDismiss` runs on Escape, a click on the
 * backdrop, or any `[aria-controls=<modal id>]` button inside the modal.
 */
export function showModal(el, { onDismiss, initialFocus } = {}) {
  if (!el || openStack.some((entry) => entry.el === el)) return;
  const entry = {
    el,
    returnFocus: document.activeElement,
    onDismiss: () => (onDismiss ? onDismiss() : hideModal(el)),
  };
  entry.onClick = (event) => {
    if (event.target === el) {
      entry.onDismiss();
      return;
    }
    const closer = event.target.closest(`[aria-controls="${el.id}"]`);
    if (closer && el.contains(closer)) {
      event.preventDefault();
      entry.onDismiss();
    }
  };
  el.addEventListener('click', entry.onClick);
  if (!openStack.length) {
    document.addEventListener('keydown', onKeydown);
    document.body.classList.add('helpdesk-modal-open');
  }
  openStack.push(entry);
  el.classList.remove('u-hide');
  el.setAttribute('aria-hidden', 'false');
  const target =
    (initialFocus && el.querySelector(initialFocus)) ||
    el.querySelector('[data-modal-autofocus]') ||
    el.querySelector(FOCUSABLE);
  target?.focus();
}

export function hideModal(el) {
  const index = openStack.findIndex((entry) => entry.el === el);
  if (index === -1) return;
  const [entry] = openStack.splice(index, 1);
  el.removeEventListener('click', entry.onClick);
  el.classList.add('u-hide');
  el.setAttribute('aria-hidden', 'true');
  if (!openStack.length) {
    document.removeEventListener('keydown', onKeydown);
    document.body.classList.remove('helpdesk-modal-open');
  }
  if (entry.returnFocus && document.contains(entry.returnFocus)) entry.returnFocus.focus();
}

let modalCount = 0;

function buildDialog({ title, message, actions }) {
  modalCount += 1;
  const id = `helpdesk-modal-${modalCount}`;
  const el = document.createElement('div');
  el.className = 'p-modal u-hide';
  el.id = id;
  el.setAttribute('aria-hidden', 'true');

  const dialog = document.createElement('section');
  dialog.className = 'p-modal__dialog helpdesk-modal__dialog--narrow';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', `${id}-title`);
  dialog.setAttribute('aria-describedby', `${id}-description`);

  const header = document.createElement('header');
  header.className = 'p-modal__header';
  const heading = document.createElement('h2');
  heading.className = 'p-modal__title';
  heading.id = `${id}-title`;
  heading.textContent = title;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'p-modal__close';
  close.setAttribute('aria-label', 'Close dialog');
  close.setAttribute('aria-controls', id);
  close.textContent = 'Close';
  header.append(heading, close);

  const body = document.createElement('p');
  body.id = `${id}-description`;
  body.textContent = message;

  const footer = document.createElement('footer');
  footer.className = 'p-modal__footer';
  const buttons = actions.map((action) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${action.className || 'p-button'} u-no-margin--bottom`;
    btn.textContent = action.label;
    if (action.autofocus) btn.dataset.modalAutofocus = '';
    footer.appendChild(btn);
    return btn;
  });

  dialog.append(header, body, footer);
  el.appendChild(dialog);
  return { el, buttons };
}

function runDialog({ title, message, actions, dismissValue }) {
  return new Promise((resolve) => {
    const { el, buttons } = buildDialog({ title, message, actions });
    document.body.appendChild(el);
    const finish = (value) => {
      hideModal(el);
      el.remove();
      resolve(value);
    };
    buttons.forEach((btn, i) => btn.addEventListener('click', () => finish(actions[i].value)));
    showModal(el, { onDismiss: () => finish(dismissValue) });
  });
}

/** Ask a yes/no question. Resolves `true` only when the confirm button is pressed. */
export function confirmModal({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
}) {
  return runDialog({
    title,
    message,
    dismissValue: false,
    actions: [
      { label: cancelLabel, value: false, className: 'p-button', autofocus: true },
      {
        label: confirmLabel,
        value: true,
        className: danger ? 'p-button--negative' : 'p-button--positive',
      },
    ],
  });
}

/** Show a message with a single dismiss button. */
export function messageModal({ title, message, closeLabel = 'OK' }) {
  return runDialog({
    title,
    message,
    dismissValue: undefined,
    actions: [{ label: closeLabel, value: undefined, className: 'p-button--positive' }],
  });
}
