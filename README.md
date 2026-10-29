# Event Help Desk

Live chat for conference rooms. Participants use `/`, support uses `/admin`.

## Run locally

```bash
cp .env.example .env

npm install
npm run dev
```

- http://localhost:3000 — participants  
- http://localhost:3000/admin — support (sign in with Ubuntu SSO)

Rooms, WiFi, hours, Telegram, Ubuntu SSO, printouts, and Guides & FAQ are configured in the admin UI. Data is stored in `data/helpdesk.json`.

## Support admins

The support dashboard at `/admin` is Ubuntu SSO only; there is no password. `finn.rawles@canonical.com` is the default admin, and admins can add or remove others in the **Admins** tab. An admin's first sign-in links their email to that Ubuntu One account, so a different account claiming the same email is refused. `ADMIN_EMAILS` grants permanent access from the server side if you ever lock yourself out.

## Ubuntu SSO

Turn on **Settings → Ubuntu SSO** to require participants to sign in at [login.ubuntu.com](https://login.ubuntu.com/) (OpenID 2.0) before starting or continuing a chat. Their name and email are shown to support. The callback is `/auth/sso/callback` on the URL participants use; behind an HTTPS reverse proxy set `TRUST_PROXY` so the return URL uses the public protocol and host. SSO sessions are kept in memory, so participants sign in again after a restart.

## Telegram

Set the bot token and chat ID in **Settings → Telegram notifications**. If the server cannot reach `api.telegram.org` directly, turn on **Send through a proxy** and enter the proxy URL (for example `http://squid.internal:3128`); only Telegram requests use it. **View logs** shows each send attempt with its route, timing, and the underlying error.

## Guides & FAQ

The **Guides & FAQ** admin tab adds, edits, reorders, enables/disables, and deletes the cards on the home page. Each guide is served at `/guides/<slug>`. Content uses a small Markdown subset: `## Heading`, `1. Step`, `- Bullet`, `**bold**`, and `[link](https://…)`.

## Audit log

The **Audit log** admin tab records page views, chats, live connections, sign-ins, settings and guide changes, printouts, backups, and denied requests, each with the client IP address, actor, and user agent. Passwords and tokens are never logged. Entries are stored in `data/audit.jsonl` (the latest 20,000 are kept) and can be filtered, searched, and downloaded as CSV. Behind a reverse proxy, set `TRUST_PROXY` so the real client IP is recorded.

## Environment

| Variable | Purpose |
|----------|---------|
| `PORT` | Port (default `3000`) |
| `HOST` | Bind address (default `0.0.0.0`) |
| `PUBLIC_URL` | Optional public address (e.g. `https://help.example.com`) for Telegram links when no help desk URL is set in Settings |
| `ADMIN_EMAILS` | Optional comma-separated emails that always have admin access (lock-out recovery) |
| `TRUST_PROXY` | Express `trust proxy` value (e.g. `1` or `loopback`) when behind a reverse proxy |

## Docker

Push a version tag to build an image on GHCR:

```bash
git tag v1.6.2 && git push origin v1.6.2
```

```bash
docker run -d -p 3000:3000 \
  -v helpdesk-data:/app/data \
  ghcr.io/nerif-tafu/helpdesk:1.6.2
```

## Production

```bash
npm run build:css && npm start
```
