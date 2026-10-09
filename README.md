# Telegram Bot Service

A TypeScript/Node.js service with an Express API, React frontend, Telegram bot integration, background jobs, and Supabase PostgreSQL.

## Requirements

- Node.js 22 or newer
- npm
- A Supabase project
- Telegram bot token
- Git

## Configure

Copy `.env.example` to `.env` and configure the values required by your deployment.

Required server-side settings include:

```env
BOT_TOKEN=
SUPABASE_URL=
SUPABASE_SECRET_KEY=
ADMIN_API_KEY=
DUMP_CHAT_ID=
ADMIN_IDS=
PORT=3000
```

Keep `.env` out of version control. Never expose bot tokens or the Supabase secret key in browser code.

## Install and run locally

```bash
npm install
cp .env.example .env
npm run lint
npm run dev
```

The development command runs the TypeScript server and Vite middleware.

## Production build and start

Install dependencies including development dependencies in the build environment, then run:

```bash
npm install
npm run lint
npm run build
NODE_ENV=production npm start
```

The build creates the frontend in `dist/` and bundles the server into `dist-server/server.js`. The production start command runs the compiled server with Node.js, so the production runtime does not depend on the TypeScript runner.

Set the deployment platform's start command to `npm start` and its build command to `npm install && npm run lint && npm run build`.

## Database setup

1. Create a Supabase project.
2. Open the Supabase SQL Editor.
3. Apply the SQL files in `supabase/migrations/` in numeric order.
4. Configure the matching environment variables.
5. Verify that the required tables and database functions exist.

## HTTP endpoints

- `/health` — basic process health
- `/ready` — readiness and critical dependency check
- `/api/status` — authenticated service diagnostics

Administrative endpoints require an authenticated admin session or the configured admin API key.

## Linux service example

Create `/etc/systemd/system/telegram-bot-service.service` and replace `YOUR_LINUX_USER` with the account that owns the application files:

```ini
[Unit]
Description=Telegram Bot Service
After=network.target

[Service]
Type=simple
User=YOUR_LINUX_USER
WorkingDirectory=/opt/Piratecultjav
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-bot-service
sudo systemctl status telegram-bot-service
```

View logs with:

```bash
sudo journalctl -u telegram-bot-service -f
```

After updating the source, rebuild before restarting:

```bash
cd /opt/Piratecultjav
git pull
npm install
npm run lint
npm run build
sudo systemctl restart telegram-bot-service
```

## Operational notes

- Keep secrets in environment variables.
- Use HTTPS when exposing the service publicly.
- Keep Node.js and dependencies updated.
- Ensure only one active polling process uses a given Telegram bot token.
- Monitor the readiness endpoint and application logs after deployment.
