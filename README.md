# Event Help Desk

Live chat for conference rooms. Participants use `/`, support uses `/admin`.

## Run locally

```bash
cp .env.example .env
# Set ADMIN_PASSWORD and SESSION_SECRET

npm install
npm run dev
```

- http://localhost:3000 — participants  
- http://localhost:3000/admin — support (password from `.env`)

Rooms, WiFi, hours, Telegram, Ubuntu SSO, printouts, and Guides & FAQ are configured in the admin UI. Data is stored in `data/helpdesk.json`.

## Ubuntu SSO

Turn on **Settings → Ubuntu SSO** to require participants to sign in at [login.ubuntu.com](https://login.ubuntu.com/) (OpenID 2.0) before starting or continuing a chat. Their name and email are shown to support. The callback is `/auth/sso/callback` on the URL participants use; behind an HTTPS reverse proxy set `TRUST_PROXY` so the return URL uses the public protocol and host. SSO sessions are kept in memory, so participants sign in again after a restart.

## Guides & FAQ

The **Guides & FAQ** admin tab adds, edits, reorders, enables/disables, and deletes the cards on the home page. Each guide is served at `/guides/<slug>`. Content uses a small Markdown subset: `## Heading`, `1. Step`, `- Bullet`, `**bold**`, and `[link](https://…)`.

## Environment

| Variable | Purpose |
|----------|---------|
| `PORT` | Port (default `3000`) |
| `HOST` | Bind address (default `0.0.0.0`) |
| `ADMIN_PASSWORD` | Support login |
| `SESSION_SECRET` | Admin session secret |
| `TRUST_PROXY` | Express `trust proxy` value (e.g. `1` or `loopback`) when behind a reverse proxy |

## Docker

Push a version tag to build an image on GHCR:

```bash
git tag v1.4.1 && git push origin v1.4.1
```

```bash
docker run -d -p 3000:3000 \
  -e ADMIN_PASSWORD=change-me \
  -e SESSION_SECRET=change-me \
  -v helpdesk-data:/app/data \
  ghcr.io/nerif-tafu/helpdesk:1.4.1
```

## Production

```bash
npm run build:css && npm start
```
