# stripe2zohobooks

Sync multiple Stripe accounts to a single Zoho Books organization.

## Tech Stack
- Node.js 20+ / TypeScript (ESM)
- Hono (HTTP framework)
- SQLite via better-sqlite3 + Drizzle ORM
- HTMX + PicoCSS for dashboard
- Pino for logging

## Commands
- `pnpm dev` — start dev server with hot reload
- `pnpm build` — compile TypeScript
- `pnpm start` — run compiled code
- `pnpm setup` — interactive setup wizard
- `pnpm lint` — lint with Biome
- `pnpm lint:fix` — lint and auto-fix
- `pnpm test` — run tests with vitest

## Project Structure
- `src/index.ts` — entry point
- `src/server.ts` — Hono app with route mounting
- `src/config.ts` — env var loading with Zod
- `src/db/` — schema and database connection
- `src/routes/` — webhooks, API, dashboard, auth
- `src/sync/` — sync handlers (customers, invoices, payments, refunds, etc.)
- `src/clients/` — Stripe and Zoho API clients
- `src/queue/` — SQLite-based job queue with retry
- `src/backfill/` — historical data sync
- `src/views/` — HTML templates

## Key Design Decisions
- Zoho API client uses native fetch (no SDK)
- Job queue is SQLite-based (no Redis dependency)
- Subscriptions handled via invoice.paid events (not Zoho Recurring Invoices)
- Fee/payout journal entries use Zoho account IDs configured via Settings dashboard
- API keys encrypted at rest with AES-256-GCM (requires ENCRYPTION_KEY in .env)
- Zoho API usage tracked with configurable soft limits and dashboard warnings
