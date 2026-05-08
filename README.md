# Trading Intelligence Dashboard

Real-time trading intelligence dashboard for **GBPUSD** and **Oil** markets.

Live monitoring of:
- 📅 Economic Calendar (BLS, BEA, Census, FRED — sub-second sniper at release time)
- 🛢️ Strait of Hormuz / Brent + WTI crude prices (live, ~15-min lag)
- ⚡ EIA Crude Oil Inventory (1s burst polling at the Wed 10:30 ET release)
- 🇹🇷 Trump posts on Truth Social — filtered to oil/Iran/Hormuz only
- 📰 Telegram channels (real-time MTProto subscription) + RSS feeds
- 🎯 4 release snipers: BLS (8:30 ET), FOMC (14:00 ET), UK ONS/BOE, EIA (Wed 10:30 ET)

## Tech stack

- **Next.js 15** + React 19 + TypeScript (strict)
- **Server-Sent Events** for live push updates
- **Tailwind CSS** + Radix UI primitives
- **gramjs** for Telegram MTProto
- **No database** — in-memory + `/tmp` disk cache
- **No build server needed** — runs fine in `next dev`

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Copy env template and fill in API keys
cp .env.example .env.local
# (edit .env.local — see "API keys" section below)

# 3. (Optional) Authenticate with Telegram for real-time channel monitoring
npm run telegram:setup
# Follow the prompts — paste TELEGRAM_SESSION line into .env.local

# 4. Start the dev server
npm run dev

# Open http://localhost:3000
```

## API keys (all FREE — 5 minutes total to register)

| Key | Where to get it | Required? |
|---|---|---|
| `EIA_API_KEY` | https://www.eia.gov/opendata/register.php | Required (oil inventory) |
| `BLS_API_KEY` | https://data.bls.gov/registrationEngine/ | Required (CPI/PPI/jobs sniper) |
| `FRED_API_KEY` | https://fred.stlouisfed.org/docs/api/api_key.html | Required (most release data) |
| `TELEGRAM_API_ID` + `TELEGRAM_API_HASH` | https://my.telegram.org → API development tools | Optional (real-time news) |
| `TELEGRAM_SESSION` | run `npm run telegram:setup` after the above | Optional |

Without keys, the app falls back to public RSS feeds + ForexFactory scraping. With keys, you get sub-second sniper latency on all major releases.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  instrumentation.ts (server boot)                           │
│   ├─ Pre-warm all caches                                    │
│   ├─ Start Telegram MTProto client (always-on)              │
│   ├─ Start EIA sniper (always-on)                           │
│   └─ Start 5-min background refresh loop                    │
└─────────────────────────────────────────────────────────────┘
                              │
       ┌──────────────────────┼──────────────────────┐
       ▼                      ▼                      ▼
┌─────────────┐        ┌─────────────┐       ┌──────────────┐
│ /api/stream │        │  /api/news  │       │ /api/economic│
│   (SSE)     │        │             │       │  -calendar   │
└─────────────┘        └─────────────┘       └──────────────┘
       │                      │                      │
       └──────────────────────┼──────────────────────┘
                              ▼
              ┌────────────────────────────────┐
              │  src/lib/data-sources.ts       │
              │  src/lib/gov-calendar.ts       │
              │  src/lib/telegram.ts           │
              └────────────────────────────────┘
```

Key files:
- `src/app/page.tsx` — 4-panel dashboard (Calendar / Oil / News / Trump)
- `src/app/api/stream/route.ts` — SSE stream + per-connection snipers
- `src/lib/data-sources.ts` — Hormuz, Oil, News, Trump fetchers + SWR cache
- `src/lib/gov-calendar.ts` — BLS/FRED/Census economic data + release sniper
- `src/lib/telegram.ts` — gramjs Telegram client (oil channels)
- `instrumentation.ts` — Server boot tasks (always-on background workers)

## Daily commands

```bash
npm run dev              # Start dev server on localhost:3000
npm run build            # Production build
npm run lint             # Lint check
npm run telegram:setup   # One-time Telegram auth (phone + SMS)
```

## Always-on hosting (macOS)

For 24/7 uptime on your Mac (auto-starts on login, restarts on crash, prevents sleep), use the launchd setup:

```bash
# Files (already provided):
#   ~/.tradingdash/run.sh                       — watchdog script
#   ~/Library/LaunchAgents/com.user.tradingdash.plist  — launchd config
#   ~/.tradingdash/dash                          — control panel

dash start    # Load the service
dash status   # Check running state + URL
dash url      # Get the current public Cloudflare tunnel URL
dash logs     # Tail the watchdog log
dash stop     # Stop everything
```

The `dash` command becomes available in any new terminal after editing `~/.zshrc`.

## Deployment options

| Platform | Cost | Always-on | Background processes |
|---|---|---|---|
| Mac + launchd + cloudflared | $0 | ✅ if Mac stays on | ✅ |
| Railway | $5/mo | ✅ | ✅ |
| Fly.io | $0-5/mo | ✅ | ✅ |
| Render | $7/mo paid only | ⚠️ free tier sleeps | ✅ |
| ❌ Vercel / Netlify | $0 | ✅ | ❌ kills snipers + Telegram client |

This app uses long-running Node.js processes (Telegram MTProto, snipers) which don't fit serverless. Use a real Node host.

## Updating from your local dev → GitHub

```bash
git add .
git commit -m "what changed"
git push
```

Collaborators pull with `git pull`. Restart `npm run dev` after pulling code changes.

## License

Private. For personal use.
