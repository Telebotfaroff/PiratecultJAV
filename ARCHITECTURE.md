# Codebase Architecture

This document describes the current application layout and the responsibility of each major area.

## Application lifecycle

- `server.ts` is the process entry point. It starts Express, serves the web app, starts the background worker, and starts Telegram polling.
- `src/app.ts` builds the Express application and its HTTP routes.
- `src/main.tsx` mounts the React frontend from `src/App.tsx`.
- `src/config.ts` loads and validates environment configuration.
- `src/database/supabase.ts` owns the Supabase client and connectivity check.
- `supabase/migrations/` contains ordered database schema changes.

## Backend areas

| Path | Responsibility |
| --- | --- |
| `src/bot/index.ts` | Telegram bot lifecycle and remaining handler registration |
| `src/bot/events/payments.ts` | Telegram Stars pre-checkout and successful-payment events |
| `src/bot/middleware/userTracking.ts` | User profile tracking and blocked-user filtering |
| `src/bot/middleware/errorHandler.ts` | Central Telegram error handling |
| `src/bot/premium.ts` | Premium package definitions, invoice creation, and invoice payload validation |
| `src/bot/state.ts` | Shared bot runtime state used by helper modules |
| `src/bot/helpers.ts` | Bot helper operations |
| `src/bot/helpers/formatting.ts` | Reusable HTML escaping and timer formatting |
| `src/services/` | Business logic and database-facing operations |
| `src/workers/indexer.ts` | Background indexing worker lifecycle |
| `src/providers/` | External metadata provider integration |
| `src/database/` | Database client and connection helpers |

## Where to make changes

- **HTTP endpoint:** start in `src/app.ts`.
- **Frontend UI:** start in `src/App.tsx`.
- **Database schema:** add a new migration under `supabase/migrations/`; do not edit an already-applied migration.
- **Database/business logic:** use or extend the matching module under `src/services/`.
- **Premium payment event:** edit `src/bot/events/payments.ts`.
- **Premium package or invoice logic:** edit `src/bot/premium.ts`.
- **User tracking or blocked-user behavior:** edit `src/bot/middleware/userTracking.ts`.
- **Telegram error handling:** edit `src/bot/middleware/errorHandler.ts`.
- **Shared text formatting:** edit `src/bot/helpers/formatting.ts`.

## Refactoring notes

The Telegram bot's historical entry module still contains a large set of handlers. Move handlers one feature at a time, keep a single registration path for each command/callback, and remove the old implementation only after imports and behavior have been verified. Some older files under `src/bot/commands/` and `src/bot/callbacks/` are not yet the active registration path; do not register them wholesale, because doing so can create duplicate handlers.

## Validation

Run these checks before deploying:

```sh
npm run lint
npm run build
```

The lint script runs TypeScript checking. The build script builds the frontend; it does not replace the TypeScript check.
