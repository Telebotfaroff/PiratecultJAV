# Telegram Bot Service

Telegram bot and web service with Supabase PostgreSQL, Telegram storage, and a persistent Node.js server.

## Architecture

```
Telegram Bot
     |
     v
Node.js / Express
     |
     +---- Supabase PostgreSQL
     |
     +---- Telegram storage
     |
     +---- Background worker
```

The application runs as a single persistent Node.js service. Supabase is used for PostgreSQL data and Telegram is used for bot communication and media storage.

## Requirements

- Node.js 22+
- npm
- Supabase project
- Telegram bot token
- Linux VPS
- Git

## Environment Variables

Copy `.env.example` to `.env` and configure the values:

```env
BOT_TOKEN=your_bot_token
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=your_secret_key
DUMP_CHAT_ID=your_telegram_chat_id
ADMIN_IDS=12345678,87654321
PORT=3000
```

Use the variables required by `.env.example` for the complete configuration.

Do not commit `.env` or expose `SUPABASE_SECRET_KEY` or bot tokens.

## Database Setup

1. Create a Supabase project.
2. Open the Supabase SQL Editor.
3. Apply the migrations from `supabase/migrations/` in order.
4. Confirm the required tables and functions were created.
5. Configure the environment variables.

## Local Setup

```bash
git clone https://github.com/Telebotfaroff/Piratecultjav.git
cd Piratecultjav

npm install
cp .env.example .env

npm run lint
npm start
```

The service exposes:

- `/health` — process health
- `/ready` — dependency readiness

## VPS Deployment

### 1. Create a VPS

Use any Linux VPS running Ubuntu 22.04 or newer.

Recommended minimum:

- 2 CPU cores
- 2 GB RAM
- 20 GB SSD
- Ubuntu 22.04+

### 2. Install system packages

```bash
sudo apt update
sudo apt install -y git curl
```

Install Node.js 22:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

node -v
npm -v
```

### 3. Clone the repository

```bash
cd /opt
sudo git clone https://github.com/Telebotfaroff/Piratecultjav.git
sudo chown -R $USER:$USER /opt/Piratecultjav
cd /opt/Piratecultjav
```

### 4. Install dependencies

```bash
npm install
```

### 5. Configure environment

```bash
cp .env.example .env
nano .env
```

Add your production values and save the file.

### 6. Test the application

```bash
npm run lint
npm start
```

In another terminal:

```curl http://127.0.0.1:3000/health`
```

Stop the test process with `Ctrl+C`.

### 7. Create a systemd service

Create the service:

```bash
sudo nano /etc/systemd/system/telegram-bot-service.service
```

Use:

```ini
[Unit]
Description=Telegram Bot Service Node Service
After=network.target

[Service]
Type=simple
User=%i
WorkingDirectory=/opt/Piratecultjav
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

If your VPS username is not suitable for `%i`, replace `User=%i` with your actual Linux username.

Then enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable telegram-bot-service
sudo systemctl start telegram-bot-service
```

Check status:

```bash
sudo systemctl status telegram-bot-service
```

View logs:

```bash
sudo journalctl -u telegram-bot-service -f
```

### 8. Restart after an update

```cd /opt/Piratecultjav
git pull
npm install
npm run lint
sudo systemctl restart telegram-bot-service
```

Check:

```bash
curl http://127.0.0.1:3000/ready
```

A successful readiness response indicates that the application and its critical dependencies are available.

## Updating the VPS

Use:

```bash
cd /opt/Piratecultjav
git pull
npm install
npm run lint
sudo systemctl restart telegram-bot-service
```

If the service fails after an update:

```sudo systemctl status telegram-bot-service
sudo journalctl -u telegram-bot-service -n 100 --no-pager
```

## Useful Commands

```bash
sudo systemctl start telegram-bot-service
sudo systemctl stop telegram-bot-service
sudo systemctl restart telegram-bot-service
sudo systemctl status telegram-bot-service
sudo journalctl -u telegram-bot-service -f
```

## Health Checks

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
```

`/health` confirms that the process is running.

`/ready` checks the critical application dependencies and returns an unsuccessful status when the service is not ready.

## Production Notes

- Keep the VPS firewall enabled.
- Keep secrets only in `.env`.
- Never commit production credentials.
- Use HTTPS if the service is exposed publicly.
- Keep the Node.js runtime and system packages updated.
- Use `systemd` so the service automatically restarts after crashes or VPS reboots.
