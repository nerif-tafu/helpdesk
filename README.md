# Event Help Desk

Live chat for conference rooms. Participants use `/`, support uses `/admin.html`.

## Run locally

```bash
cp .env.example .env
# Set ADMIN_PASSWORD and SESSION_SECRET

npm install
npm run dev
```

- http://localhost:3000 — participants  
- http://localhost:3000/admin.html — support (password from `.env`)

Rooms, WiFi, hours, Telegram, and printouts are configured in the admin UI. Data is stored in `data/helpdesk.json`.

## Environment

| Variable | Purpose |
|----------|---------|
| `PORT` | Port (default `3000`) |
| `HOST` | Bind address (default `0.0.0.0`) |
| `ADMIN_PASSWORD` | Support login |
| `SESSION_SECRET` | Admin session secret |

## Docker

Push a version tag to build an image on GHCR:

```bash
git tag v1.2.0 && git push origin v1.2.0
```

```bash
docker run -d -p 3000:3000 \
  -e ADMIN_PASSWORD=change-me \
  -e SESSION_SECRET=change-me \
  -v helpdesk-data:/app/data \
  ghcr.io/nerif-tafu/helpdesk:1.2.0
```

## Production

```bash
npm run build:css && npm start
```
