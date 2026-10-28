// Guides and FAQ: defaults, validation, and page rendering.
//
// Guide content uses a small Markdown subset:
//   ## Heading / ### Subheading
//   1. Numbered step        - Bullet point
//   **bold**  [link text](https://example.com)
// Blank lines separate paragraphs. All other HTML is escaped.

import crypto from 'crypto';

const IMAGE_BASE =
  'https://res.cloudinary.com/canonical/image/fetch/c_fill,f_auto,q_auto,fl_sanitize,w_924,h_520/';

const STILL_STUCK = '- Still stuck? [Open the help desk chat](/) and tell us your room name.';

export const DEFAULT_GUIDES = [
  {
    id: 'wifi',
    slug: 'wifi',
    title: 'Connect to WiFi',
    excerpt: 'Join WiFi from your tent card or QR code, and fix password or connection problems.',
    summary: 'Join the conference network using the details on your room tent card.',
    imageUrl: `${IMAGE_BASE}https%3A%2F%2Fassets.ubuntu.com%2Fv1%2Ffaafd59d-wifi.webp`,
    enabled: true,
    content: `## Steps
1. Find the WiFi details on the tent card in your room (SSID and password), or scan the WiFi QR code on the card.
2. On your device, open WiFi settings and select that network. Enter the password when prompted.
3. Wait a few seconds for “Connected” before opening apps or joining a call.

## Troubleshooting
- **Wrong password:** Re-check the tent card; passwords are case-sensitive.
- **Stuck connecting:** Turn WiFi off and on, or “Forget” the network and join again.
${STILL_STUCK}`,
  },
  {
    id: 'projectors',
    slug: 'projectors',
    title: 'Projectors & TVs',
    excerpt:
      'Turn on the display, plug in HDMI, choose duplicate or extend, and fix signal or sound.',
    summary: 'Connect your laptop to the room display with HDMI.',
    imageUrl: `${IMAGE_BASE}https%3A%2F%2Fassets.ubuntu.com%2Fv1%2F9b9dab98-projector.jpg`,
    enabled: true,
    content: `## Steps
1. Turn on the display if it is not already on; the remote should be on the table.
2. Connect the HDMI cable to your laptop directly, or using the USB-C adapter provided.
3. On your laptop, open the display settings and choose **Duplicate** or **Extend** as needed.

## Troubleshooting
- **No signal:** Firmly press the HDMI into your laptop or adapter, or try another hub.
- **No sound:** Set the output device to either the USB device or headphone jack.
${STILL_STUCK}`,
  },
  {
    id: 'remote-meetings-small-room',
    slug: 'remote-meetings-small-room',
    title: 'Remote meetings (Small room)',
    excerpt: 'Plug in the Jabra speakerphone and set it as your mic and speaker in Google Meet.',
    summary: 'Use the room Jabra speakerphone for clear audio on Google Meet.',
    imageUrl: `${IMAGE_BASE}https%3A%2F%2Fassets.ubuntu.com%2Fv1%2Fd8c9b24f-smallbreak.jpg`,
    enabled: true,
    content: `## Steps
1. Plug the Jabra speakerphone into the room PC or your laptop with the USB cable (USB-A or USB-C as provided).
2. In Google Meet, open **Settings → Audio** and set both the **Speaker** and **Microphone** to the Jabra device.
3. Use **Test speaker / Test mic** in the meeting app before the session starts.

## Troubleshooting
- **Echo or feedback:** Make sure there is only one laptop from the room in the meeting.
- **Bluetooth instead of USB:** Pair from system Bluetooth only if USB is unavailable; USB is preferred in conference rooms.
- **Remote attendees can’t hear the room:** Confirm the meeting mic is Jabra, not “Built-in”, and that you are not muted in the app.
${STILL_STUCK}`,
  },
  {
    id: 'remote-meetings-large-room',
    slug: 'remote-meetings-large-room',
    title: 'Remote meetings (Large room)',
    excerpt:
      'Plug in the USB soundcard, set meeting audio and camera, and use both handheld mics.',
    summary:
      'Use the USB soundcard, room speakers, camera, and handheld mics for video calls on the room PC.',
    imageUrl: `${IMAGE_BASE}https%3A%2F%2Fassets.ubuntu.com%2Fv1%2F07859b3f-largebreak.webp`,
    enabled: true,
    content: `## Steps
1. Plug in the USB soundcard to the room PC (USB-A or USB-C as provided).
2. In the meeting app, open **Settings → Audio & Video** and set the **Speaker** and **Microphone** to the USB soundcard. Choose the room **camera** for video.
3. Run **Test speaker / Test mic** and check the camera preview before the session starts.
4. Use both handheld mics for presenters and audience questions so everyone in the room can be heard.

## Troubleshooting
- **USB soundcard not listed:** Unplug it, wait a few seconds, and plug into a different USB port on the room PC; avoid unpowered hubs.
- **Handheld mic not working:** Check the mic is switched on, held close to the mouth, and not covered; try the other handheld mic to rule out a flat battery.
- **Echo or feedback:** Only join the meeting from the room PC—mute or disconnect other laptops in the room; do not use built-in laptop speakers or mics alongside the USB soundcard.
- **Remote attendees can’t hear the room:** Confirm the meeting microphone is the USB soundcard, not “Built-in”; check you are not muted in the app and that both handheld mics are in use for presenters and Q&A.
- **No sound from the room speakers:** Set the meeting **Speaker** to the USB soundcard and raise the room PC or amplifier volume if provided.
${STILL_STUCK}`,
  },
];

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function text(value, max, label, { required = false } = {}) {
  const v = String(value ?? '').trim();
  if (required && !v) throw new Error(`${label} is required`);
  if (v.length > max) throw new Error(`${label} must be ${max} characters or fewer`);
  return v;
}

export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function isSafeUrl(url, { allowRelative = true } = {}) {
  if (allowRelative && (url.startsWith('/') || url.startsWith('#')) && !url.startsWith('//')) {
    return true;
  }
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function normalizeGuide(input) {
  if (!input || typeof input !== 'object') throw new Error('Guide must be an object');
  const title = text(input.title, 120, 'Title', { required: true });
  const slug = text(input.slug, 80, 'URL slug') || slugify(title);
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error('URL slug may only contain lowercase letters, numbers, and single hyphens');
  }
  const imageUrl = text(input.imageUrl, 1000, 'Image URL');
  if (imageUrl && !isSafeUrl(imageUrl)) {
    throw new Error('Image URL must start with http://, https://, or /');
  }
  return {
    id: String(input.id || '').trim() || crypto.randomUUID(),
    slug,
    title,
    excerpt: text(input.excerpt, 300, 'Card summary'),
    summary: text(input.summary, 300, 'Page subtitle'),
    imageUrl,
    enabled: input.enabled !== false,
    content: text(input.content, 20000, 'Content').replace(/\r\n?/g, '\n'),
  };
}

export function normalizeGuides(list) {
  if (!Array.isArray(list)) throw new Error('guides must be an array');
  const seenIds = new Set();
  const seenSlugs = new Set();
  return list.map((raw) => {
    const guide = normalizeGuide(raw);
    if (seenIds.has(guide.id)) throw new Error(`Duplicate guide id "${guide.id}"`);
    if (seenSlugs.has(guide.slug)) {
      throw new Error(`Another guide already uses the URL slug "${guide.slug}"`);
    }
    seenIds.add(guide.id);
    seenSlugs.add(guide.slug);
    return guide;
  });
}

/** Public card data for the home page. */
export function toGuideCard(guide) {
  return {
    slug: guide.slug,
    title: guide.title,
    excerpt: guide.excerpt,
    imageUrl: guide.imageUrl,
    url: `/guides/${guide.slug}.html`,
  };
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInline(raw) {
  const links = [];
  let out = String(raw).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    if (!isSafeUrl(url)) return match;
    links.push({ label, url });
    return `\u0000${links.length - 1}\u0000`;
  });
  out = escapeHtml(out).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => {
    const { label, url } = links[Number(i)];
    const labelHtml = escapeHtml(label).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    return `<a href="${escapeHtml(url)}">${labelHtml}</a>`;
  });
}

/** Render the guide Markdown subset to Vanilla-styled HTML. */
export function renderGuideContent(markdown) {
  const blocks = [];
  let list = null;
  let paragraph = null;

  const flushParagraph = () => {
    if (paragraph) blocks.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    paragraph = null;
  };
  const flushList = () => {
    if (list) {
      const items = list.items
        .map((item) => `<li class="p-list__item">${renderInline(item)}</li>`)
        .join('');
      blocks.push(`<${list.tag} class="p-list--divided helpdesk-guide-page-list">${items}</${list.tag}>`);
    }
    list = null;
  };

  for (const line of String(markdown || '').split('\n')) {
    const trimmed = line.trim();
    const heading = /^(#{2,3})\s+(.+)$/.exec(trimmed);
    const ordered = /^\d+[.)]\s+(.+)$/.exec(trimmed);
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);

    if (!trimmed) {
      flushParagraph();
      flushList();
    } else if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length === 2 ? 'h2' : 'h3';
      const cls = level === 'h2' ? 'p-heading--5' : 'p-heading--6';
      blocks.push(`<${level} class="${cls}">${renderInline(heading[2])}</${level}>`);
    } else if (ordered || bullet) {
      flushParagraph();
      const tag = ordered ? 'ol' : 'ul';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push((ordered || bullet)[1]);
    } else if (list && /^\s{2,}/.test(line)) {
      list.items[list.items.length - 1] += ` ${trimmed}`;
    } else {
      flushList();
      if (!paragraph) paragraph = [];
      paragraph.push(trimmed);
    }
  }
  flushParagraph();
  flushList();
  return blocks.join('\n');
}

const NAV = `    <header id="navigation" class="p-navigation--sliding is-dark">
      <div class="p-navigation__row--25-75">
        <div class="p-navigation__banner">
          <div class="p-navigation__tagged-logo">
            <a class="p-navigation__link" href="/">
              <div class="p-navigation__logo-tag">
                <img class="p-navigation__logo-icon" src="/favicon.svg" alt="" />
              </div>
              <span class="p-navigation__logo-title">Event Help Desk</span>
            </a>
          </div>
          <ul class="p-navigation__items">
            <li class="p-navigation__item">
              <a href="#" class="js-menu-button p-navigation__link">Menu</a>
            </li>
          </ul>
        </div>
        <nav class="p-navigation__nav" aria-label="Help desk">
          <div class="p-navigation__items-wrapper">
            <ul class="p-navigation__items helpdesk-nav-primary" role="menu"></ul>
            <ul class="p-navigation__items helpdesk-nav-secondary" role="menu">
              <li class="p-navigation__item" role="menuitem">
                <a class="p-navigation__link" href="/admin.html">
                  Support login <i class="p-icon--user is-light"></i>
                </a>
              </li>
            </ul>
          </div>
        </nav>
      </div>
    </header>`;

function renderShell(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} — Event Help Desk</title>
    <link rel="stylesheet" href="/css/main.css" />
    <link rel="icon" href="/favicon.png" type="image/png" sizes="16x16" />
  </head>
  <body class="l-site is-paper">
    <a href="#main-content" class="u-off-screen">Skip to main content</a>

${NAV}

    <main id="main-content" class="p-section is-paper">
      <div class="main">
        <section class="p-strip is-shallow">
          <div class="u-fixed-width">
            <p class="p-text--small-caps u-sv1">
              <a href="/">Home</a> › Guides and FAQ
            </p>
${body}
            <p class="u-sv1">
              <a class="p-button" href="/">Back to help desk</a>
            </p>
          </div>
        </section>
      </div>
    </main>

    <script src="/js/snapcraft-navigation.js" defer></script>
  </body>
</html>
`;
}

export function renderGuidePage(guide) {
  const summary = guide.summary
    ? `            <p class="p-heading--6 u-sv1">${escapeHtml(guide.summary)}</p>\n`
    : '';
  return renderShell(
    guide.title,
    `            <h1 class="p-heading--3">${escapeHtml(guide.title)}</h1>
${summary}${renderGuideContent(guide.content)}`
  );
}

export function renderGuideNotFoundPage() {
  return renderShell(
    'Guide not found',
    `            <h1 class="p-heading--3">Guide not found</h1>
            <p class="u-sv1">This guide does not exist or is no longer available.</p>`
  );
}
