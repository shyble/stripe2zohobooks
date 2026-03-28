# stripe2zohobooks

Sync multiple Stripe accounts to a single Zoho Books organization. Self-hosted, open-source, Docker-ready.

## Features

- **Multi-account** — Connect unlimited Stripe accounts, all syncing to one Zoho Books org
- **Two sync modes** — Poll mode (default, no public URL needed) or webhook mode for real-time
- **Historical backfill** — Import existing Stripe data with one click
- **Idempotent** — Safe to re-process events without creating duplicates
- **Retry with backoff** — Failed syncs automatically retry with exponential backoff
- **Dashboard** — Web UI to manage accounts, view sync status, and troubleshoot errors
- **Usage tracking** — Monitors Zoho API usage with configurable soft limits and warnings
- **Encryption** — API keys encrypted at rest in the database (AES-256-GCM)
- **Single container** — No Redis, no external dependencies. Just SQLite.

## What gets synced

| Stripe | Zoho Books |
|--------|-----------|
| Customers | Contacts |
| Invoices | Invoices |
| Payments / Charges | Customer Payments |
| Refunds | Credit Notes |
| Subscriptions | Tracked via invoice events |
| Processing Fees | Journal Entries |
| Payouts | Bank Transactions |

## Quick Start

### Prerequisites

- Node.js 20+
- A Zoho Books account with API access
- One or more Stripe accounts

### Setup

```bash
# Clone
git clone https://github.com/shyble/stripe2zohobooks.git
cd stripe2zohobooks

# Install
pnpm install

# Interactive setup (creates .env)
pnpm setup

# Start
pnpm dev
```

Open `http://localhost:3000/dashboard` and log in with your admin password.

### Add a Stripe Account

1. Go to **Accounts** in the dashboard
2. Click **Add New Account**
3. Enter your Stripe account ID and API secret key
4. That's it — in poll mode (default), the app will start fetching events automatically

### Sync Modes

**Poll mode (default)** — The app periodically fetches new events from the Stripe API. No public URL, no webhook setup, no firewall configuration needed. Set the interval with `POLL_INTERVAL_SECONDS` (default: 60).

**Webhook mode** — Stripe pushes events to your server in real-time. Requires a publicly accessible URL. Set `SYNC_MODE=webhook` in `.env` and configure webhooks in Stripe Dashboard:
   - URL: `https://your-domain/webhooks/stripe/<account_id>`
   - Events: `customer.*`, `invoice.*`, `charge.*`, `refund.*`, `payout.*`, `customer.subscription.*`

### Configure Fee & Payout Tracking (Optional)

Go to **Settings** in the dashboard and enter your Zoho Books chart-of-account IDs:

- **Stripe Processing Fees Account** — An expense account for Stripe fees
- **Stripe Clearing Account** — An asset account representing funds held by Stripe
- **Bank Account** — Your bank account where payouts arrive

## Docker

```bash
# Build and run
docker compose up -d

# Or pull and run manually
docker build -t stripe2zohobooks .
docker run -d \
  -p 3000:3000 \
  -v ./data:/app/data \
  --env-file .env \
  stripe2zohobooks
```

## Zoho Books API Limits

The tool tracks API usage and warns you before hitting limits:

| | Free Plan | Standard ($15/mo) | Professional ($40/mo) |
|---|---|---|---|
| API calls/day | 1,000 | 2,000 | 5,000 |
| Invoices/year | 1,000 | 5,000 | Unlimited |

Override defaults for paid plans in `.env`:

```bash
ZOHO_DAILY_API_LIMIT=2000
ZOHO_YEARLY_INVOICE_LIMIT=5000
```

## Zoho OAuth Setup

### 1. Create a Self Client

1. Go to [Zoho API Console](https://api-console.zoho.com/)
2. Click **Add Client** and choose **Self Client**
3. Note down the **Client ID** and **Client Secret**

### 2. Generate a Refresh Token

4. In the Self Client page, click **Generate Code**
5. Enter scope: `ZohoBooks.fullaccess.all`
6. Set any time duration and description, then click **Create**
7. Copy the generated authorization code
8. Exchange it for a refresh token:

```bash
curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
  -d "code=PASTE_YOUR_CODE_HERE" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "grant_type=authorization_code"
```

The response contains your `refresh_token` — save it, you'll need it for `.env`.

> **Note:** Use `accounts.zoho.eu`, `accounts.zoho.in`, or `accounts.zoho.com.au` if your Zoho account is in a different region.

### 3. Find Your Organization ID

9. Go to Zoho Books > **Settings** > **Organization Profile**
10. The **Organization ID** is displayed on that page

### 4. Set Your API Domain

Depends on your Zoho region:

| Region | API Domain |
|--------|-----------|
| US | `https://www.zohoapis.com` |
| EU | `https://www.zohoapis.eu` |
| India | `https://www.zohoapis.in` |
| Australia | `https://www.zohoapis.com.au` |

### 5. Add to .env

```bash
ZOHO_CLIENT_ID=1000.XXXXXXXXXXXX
ZOHO_CLIENT_SECRET=XXXXXXXXXXXX
ZOHO_REFRESH_TOKEN=1000.XXXXXXXXXXXX.XXXXXXXXXXXX
ZOHO_ORGANIZATION_ID=12345678
ZOHO_API_DOMAIN=https://www.zohoapis.com
```

Or run `pnpm setup` to configure interactively.

## Development

```bash
pnpm dev          # Start with hot reload
pnpm build        # Compile TypeScript
pnpm lint         # Lint with Biome
pnpm lint:fix     # Auto-fix lint issues
pnpm test         # Run tests
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ADMIN_PASSWORD` | Yes | — | Dashboard login password |
| `ENCRYPTION_KEY` | No | — | 32-byte hex key for encrypting API keys at rest |
| `SYNC_MODE` | No | `poll` | `poll` or `webhook` |
| `POLL_INTERVAL_SECONDS` | No | `60` | How often to fetch new Stripe events (poll mode) |
| `PORT` | No | `3000` | Server port |
| `HOST` | No | `0.0.0.0` | Server host |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |
| `DATABASE_PATH` | No | `./data/stripe2zoho.db` | SQLite database path |
| `ZOHO_CLIENT_ID` | Yes | — | Zoho OAuth Client ID |
| `ZOHO_CLIENT_SECRET` | Yes | — | Zoho OAuth Client Secret |
| `ZOHO_REFRESH_TOKEN` | Yes | — | Zoho OAuth Refresh Token |
| `ZOHO_ORGANIZATION_ID` | Yes | — | Zoho Books Organization ID |
| `ZOHO_API_DOMAIN` | No | `https://www.zohoapis.com` | `.com`, `.eu`, `.in`, `.com.au` |
| `ZOHO_DAILY_API_LIMIT` | No | `1000` | Override for paid plans |
| `ZOHO_YEARLY_INVOICE_LIMIT` | No | `1000` | Override for paid plans |

## License

[AGPL-3.0](LICENSE)
