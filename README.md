# PiratecultJAV

Production Telegram JAV metadata and video indexing bot with Supabase PostgreSQL, Javtiful metadata provider, and Telegram Dump Channel storage.

## Architecture

```
                 ┌──────────────────────┐
                 │      Javtiful        │
                 │   Metadata Provider  │
                 └──────────┬───────────┘
                            │
                            ▼
                 ┌──────────────────────┐
                 │ PiratecultJAV Bot    │
                 │ Provider Layer       │
                 └──────────┬───────────┘
                            │
                            ▼
                 ┌──────────────────────┐
                 │ Supabase PostgreSQL   │
                 │ Metadata + References │
                 └──────────┬───────────┘
                            ▲
                            │
                 ┌──────────┴───────────┐
                 │ Telegram Dump Channel│
                 │ Videos + Thumbnails  │
                 └──────────────────────┘
```

- **Telegram Dump Channel (`-1004426377644`)**: Real media storage layer for videos and thumbnails.
- **Supabase PostgreSQL**: Relational metadata index storing message references (`dump_chat_id`, `video_message_id`), user accounts, force-subscription configs, and index jobs.
- **Zero Video Stream URLs**: Strict security policy ensuring no temporary HLS, MP4, or expiring CDN URLs are captured or persisted.
- **Atomic Job Queue**: Worker uses PostgreSQL `FOR UPDATE SKIP LOCKED` (`claim_next_index_job`) with unique idempotency on `(dump_chat_id, video_message_id)`.

## Environment Variables

Copy `.env.example` to `.env` or set in your hosting platform:

```env
BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=ey...
DUMP_CHAT_ID=-1004426377644
ADMIN_IDS=12345678,87654321
JAVTIFUL_BASE_URL=https://javtiful.com
PORT=3000
```

## Database Migration

Run `supabase/migrations/001_initial_schema.sql` in your Supabase SQL Editor. It creates:
- `users`: Tracked Telegram accounts with blocked state
- `videos`: Indexed metadata with Telegram dump message pointers
- `index_jobs`: Atomic queue with duplicate constraint
- `force_sub_channels`: Channel subscription enforcement
- `bot_settings`: Key/value configuration
- `claim_next_index_job()`: Atomic PostgreSQL row-locking function

## Quick Start

```bash
# Install dependencies
npm install

# Start development server & console
npm run dev

# Start production service
npm start
```

Health check available at `/health` and readiness check at `/ready`:
```json
{ "ok": true, "service": "PiratecultJAV", "timestamp": "..." }
```
