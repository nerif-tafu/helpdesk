import QRCode from 'qrcode';
import { roomSlug } from './rooms.js';
import { getWifi, resolveHelpBaseUrl } from './settings.js';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wifiQrPayload(ssid, password) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/([;,:"])/g, '\\$1');
  return `WIFI:T:WPA;S:${esc(ssid)};P:${esc(password)};;`;
}

function formatUrlForPrint(url) {
  return String(url).replace(/^https?:\/\//i, '');
}

function helpUrl(base, roomName) {
  const root = base.replace(/\/$/, '');
  if (root.includes('/location')) {
    return `${root}/${roomSlug(roomName)}`;
  }
  return `${root}/?room=${encodeURIComponent(roomSlug(roomName))}`;
}

async function qrDataUrl(text) {
  return QRCode.toDataURL(text, { width: 280, margin: 1, errorCorrectionLevel: 'M' });
}

function renderEmptyColumn() {
  return `<div class="tent-column tent-column--spacer" aria-hidden="true"></div>`;
}

function renderSupportFace(supportUrlDisplay, supportQr, layout) {
  if (layout === 'room') {
    return `
    <div class="tent-column tent-column--face">
      <div class="tent-face tent-face--room">
        <h2 class="tent-face__title">Need technical support?</h2>
        <p class="tent-face__lead">Scan the QR code for our help page!</p>
        <div class="tent-face__qr">
          <img src="${supportQr}" alt="QR code for help desk" width="140" height="140" />
        </div>
        <p class="tent-face__footer">${escapeHtml(supportUrlDisplay)}</p>
      </div>
    </div>`;
  }
  return `
    <div class="tent-column tent-column--face">
      <div class="tent-face tent-face--ccw">
        <h2 class="tent-face__title">Need technical support?</h2>
        <p class="tent-face__lead">Scan the QR code for our help page!</p>
        <div class="tent-face__qr">
          <img src="${supportQr}" alt="QR code for help desk" width="140" height="140" />
        </div>
        <p class="tent-face__footer">${escapeHtml(supportUrlDisplay)}</p>
      </div>
    </div>`;
}

function renderWifiFace(wifiFooter, wifiQr, rotation) {
  return `
    <div class="tent-column tent-column--face">
      <div class="tent-face tent-face--${rotation}">
        <h2 class="tent-face__title">Join the Canonical WiFi</h2>
        <p class="tent-face__lead">Scan the QR code to join the WiFi</p>
        <div class="tent-face__qr">
          ${
            wifiQr
              ? `<img src="${wifiQr}" alt="QR code for WiFi" width="140" height="140" />`
              : '<div class="tent-face__qr-placeholder">No WiFi QR</div>'
          }
        </div>
        <p class="tent-face__footer">${wifiFooter}</p>
      </div>
    </div>`;
}

function renderTabColumn() {
  return `<div class="tent-column tent-column--tab" aria-hidden="true"></div>`;
}

async function renderRoomPage(roomName, { wifi, helpBase }) {
  const supportUrl = helpUrl(helpBase, roomName);
  const supportUrlDisplay = formatUrlForPrint(supportUrl);
  const supportQr = await qrDataUrl(supportUrl);

  let column2;
  if (wifi.enabled) {
    const wifiQr =
      wifi.ssid ? await qrDataUrl(wifiQrPayload(wifi.ssid, wifi.password)) : null;
    const wifiFooter = wifi.ssid
      ? `SSID: ${escapeHtml(wifi.ssid)} — PW: ${escapeHtml(wifi.password)}`
      : 'WiFi not configured in Settings';
    column2 = renderWifiFace(wifiFooter, wifiQr, 'ccw');
  } else {
    column2 = renderSupportFace(supportUrlDisplay, supportQr, 'ccw');
  }

  const column3 = renderSupportFace(supportUrlDisplay, supportQr, 'room');

  return `
    <section class="tent-sheet">
      <div class="tent-sheet__row">
        ${renderEmptyColumn()}
        ${column2}
        ${column3}
        ${renderTabColumn()}
      </div>
    </section>
  `;
}

const UBUNTU_FONT_URL =
  'https://assets.ubuntu.com/v1/f1ea362b-Ubuntu%5Bwdth,wght%5D-latin-v0.896a.woff2';

const PRINT_STYLES = `
  @font-face {
    font-family: 'Ubuntu';
    font-style: normal;
    font-weight: 300 700;
    font-display: swap;
    src: url('${UBUNTU_FONT_URL}') format('woff2-variations');
  }

  @page { size: A4 landscape; margin: 8mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Ubuntu', 'Ubuntu variable', sans-serif;
    margin: 0;
    color: #111;
  }
  .tent-sheet {
    page-break-after: always;
    width: 100%;
  }
  .tent-sheet:last-child {
    page-break-after: auto;
  }
  .tent-sheet__row {
    display: flex;
    min-height: 185mm;
    width: 100%;
  }
  .tent-column {
    min-height: 185mm;
    position: relative;
  }
  .tent-column--spacer {
    flex: 3 1 0;
    min-width: 0;
  }
  .tent-column--face {
    flex: 3 1 0;
    min-width: 0;
    overflow: hidden;
  }
  .tent-column--tab {
    flex: 1 1 0;
    min-width: 12mm;
  }
  .tent-sheet__row > .tent-column + .tent-column {
    border-left: 2px dashed #000;
  }
  .tent-column--face {
    align-items: center;
    display: flex;
    justify-content: center;
  }
  .tent-face {
    align-items: center;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    justify-content: center;
    padding: 4mm;
    text-align: center;
    width: 175mm;
    height: 68mm;
  }
  .tent-face--ccw {
    transform: rotate(90deg);
  }
  .tent-face--room {
    transform: rotate(270deg);
  }
  .tent-face__qr {
    margin-bottom: 4mm;
  }
  .tent-face__qr img {
    display: block;
    height: auto;
    margin: 0 auto;
    width: 36mm;
  }
  .tent-face__qr-placeholder {
    border: 1px dashed #999;
    color: #666;
    font-size: 9pt;
    padding: 6mm 4mm;
  }
  .tent-face__title {
    color: #e95420;
    font-size: 18pt;
    font-weight: 700;
    line-height: 1.15;
    margin: 0 0 3mm;
  }
  .tent-face__lead {
    font-size: 12pt;
    line-height: 1.35;
    margin: 0 0 4mm;
  }
  .tent-face__footer {
    border-top: 1px solid #ccc;
    color: #666;
    font-size: 9pt;
    line-height: 1.3;
    margin-top: 3mm;
    max-width: 160mm;
    padding-top: 3mm;
    word-break: break-all;
  }
  @media screen {
    body { background: #eee; padding: 12px; }
    .tent-sheet {
      background: #fff;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
      margin: 0 auto 24px;
      max-width: 297mm;
    }
  }
  @media print {
    .print-toolbar { display: none !important; }
    body { background: #fff; padding: 0; }
  }
`;

export async function renderPrintDocument(roomNames, req) {
  const wifi = getWifi();
  const helpBase = resolveHelpBaseUrl(req);
  const pages = await Promise.all(
    roomNames.map((name) => renderRoomPage(name, { wifi, helpBase }))
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Room tent cards</title>
  <link rel="preconnect" href="https://assets.ubuntu.com" crossorigin />
  <link
    rel="stylesheet"
    href="https://fonts.googleapis.com/css2?family=Ubuntu:ital,wght@0,300;0,400;0,500;0,700;1,400&display=swap"
  />
  <style>${PRINT_STYLES}</style>
</head>
<body>
  <div class="print-toolbar" style="position:sticky;top:0;background:#fff;border-bottom:1px solid #ccc;padding:12px;text-align:center;z-index:1;">
    <button type="button" onclick="window.print()" style="font-size:14px;padding:8px 16px;cursor:pointer;">Print</button>
    <span style="margin-left:12px;font-size:14px;color:#666;">A4 landscape — empty | WiFi/room | room | tab</span>
  </div>
  ${pages.join('\n')}
</body>
</html>`;
}
