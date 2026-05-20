# Conference Help Desk

Live support chat for conference participants, built with [Vanilla Framework](https://vanillaframework.io/), Node.js, and WebSockets. Support staff use an admin panel; new participant messages can notify a Telegram channel.

## Workflow

1. Participant selects a **conference room** and optionally enters their name.
2. They are taken to a **live chat** and wait until support replies (status: waiting → active).
3. Support answers from the **admin panel** and marks the conversation **resolved** when done.

## Quick start

```bash
cp .env.example .env
# Edit .env — set ADMIN_PASSWORD and SESSION_SECRET

npm install
npm run dev
```

`npm run dev` builds CSS once, then runs the server and Sass in watch mode. SCSS changes rebuild automatically; server code restarts on save. Refresh the browser for HTML/JS changes in `public/`.

For production, use `npm run build:css && npm start`.

Open http://localhost:3000 for participants and http://localhost:3000/admin.html for support.

### Access from other devices (same Wi‑Fi / LAN)

The server listens on `0.0.0.0` by default (`HOST` in `.env`). After `npm run dev` or `npm start`, the terminal lists URLs such as `http://192.168.x.x:3000` — use that address on phones, tablets, or other computers on the same network.

Set **Admin → Settings → Help desk URL** to your LAN URL (e.g. `http://192.168.1.42:3000/location`) so room printout QR codes work for participants too.

Default admin password (if unset in `.env`): `helpdesk`

## Configuration

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP port (default `3000`) |
| `HOST` | Bind address (default `0.0.0.0` — all interfaces, for LAN access) |
| `ADMIN_PASSWORD` | Password for support login |
| `SESSION_SECRET` | Secret for admin session cookies (change in production) |

Rooms, WiFi, help desk URL, hours, timezone, and Telegram are configured in **Admin → Settings** and **Admin → Rooms** (not in `.env`).

### Telegram setup

1. Create a bot via BotFather and copy the token.
2. Send a message to the bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` to find your `chat_id`.
3. Enter the bot token and chat ID in **Admin → Settings**. Participant messages trigger a notification; support replies do not.

## Data storage

All data lives in `data/helpdesk.json` (created on first run):

- **settings** — rooms, WiFi, help URL, schedule, Telegram credentials
- **conversations** and **messages** — live chat history

Use **Admin → Settings → Backup & restore** to export or import JSON. Export downloads a full snapshot; import can replace everything or update **settings only** while keeping existing chats.

## Vanilla Framework conventions

This project follows the same patterns as [canonical.com](https://github.com/canonical/canonical.com) and [snapcraft.io](https://github.com/canonical/snapcraft.io):

- Sass settings overridden **before** `@import "vanilla-framework"`
- Build with `--load-path=node_modules`
- `body.l-site`, `p-navigation--sliding`, `p-strip` + `u-fixed-width`, responsive `p-grid__cell--small-span-4`
- Custom UI only in `scss/_pattern_*.scss` mixins using Vanilla tokens

## Project layout

- `public/` — HTML and client JS (Vanilla Framework markup)
- `scss/main.scss` — settings, Vanilla imports, pattern includes
- `scss/_pattern_helpdesk-chat.scss` — app-specific chat/queue styles
- `server/` — Express API, WebSockets, JSON store, Telegram
- `.cursor/rules/vanilla-framework.mdc` — UI must follow Vanilla Framework

## Scripts

- `npm run dev` — Watch SCSS + auto-restart server (use this while developing)
- `npm run build:css` — Compile SCSS (production)
- `npm run watch:css` — Watch SCSS only
- `npm start` — Run server (build CSS first for production)
