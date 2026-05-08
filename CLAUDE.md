# CLAUDE.md

## Commands

```bash
npm run dev         # Start dev server (http://localhost:3000)
npm run build       # Production build
npm run lint        # ESLint
```

## Architecture

Real-time trading intelligence dashboard for GBPUSD and Oil. Four resizable panels:

1. **Economic Calendar** — ForexFactory-style event table with USD/GBP filter, impact levels, actual vs forecast
2. **Oil Intelligence** — Trump Truth Social posts (filtered by oil/energy keywords), Strait of Hormuz vessel monitor, EIA inventory data
3. **News Feed** — Aggregated from Fed RSS, BOE RSS, OPEC, Reuters with category filters
4. **Alerts & Signals** — Auto-generated alerts for imminent high-impact events and data deviations

### Data Flow

- **`src/lib/data-sources.ts`** — Server-side fetchers with in-memory cache. Scrapes ForexFactory, polls Truth Social, aggregates RSS feeds. Falls back to realistic mock data when sources are unreachable.
- **`src/app/api/`** — Next.js Route Handlers exposing each data source as a JSON endpoint.
- **`src/hooks/use-dashboard-stream.ts`** — Client-side hook that polls all API endpoints at different intervals (30s–5min) and generates alerts from calendar events.
- **`src/components/dashboard/`** — Pure display components. Zero AI tokens consumed.

### Key Files

- `src/app/page.tsx` — Main dashboard with 4-panel resizable layout
- `src/lib/types.ts` — All TypeScript interfaces
- `src/lib/data-sources.ts` — Data fetching + parsing + caching
- `src/components/dashboard/` — All panel components
