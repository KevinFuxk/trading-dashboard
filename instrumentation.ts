/**
 * Next.js instrumentation hook — runs once at server startup.
 *
 *  1. Pre-warms ALL data caches in parallel (cold start → warm).
 *  2. Starts a long-running background sniper that catches the EIA crude
 *     oil release at 10:30 ET Wednesdays/Thursdays — INDEPENDENT of any
 *     SSE connection. Even if no browser is open, the data refreshes the
 *     instant EIA publishes.
 *  3. Periodic background refresh of all sources (keeps disk cache fresh).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  console.log("[BOOT] Pre-warming data caches…");
  const t0 = Date.now();

  const { fetchEconomicCalendar, fetchTruthSocialPosts, fetchHormuzData,
          fetchOilInventory, fetchNewsFeed, bypassEIACache, bypassFFCache } =
    await import("./src/lib/data-sources");

  await Promise.allSettled([
    fetchEconomicCalendar().then(r => console.log(`[BOOT] ✓ calendar (${r.length} events) ${Date.now()-t0}ms`)),
    fetchTruthSocialPosts().then(r => console.log(`[BOOT] ✓ trump (${r.length} posts) ${Date.now()-t0}ms`)),
    fetchHormuzData().then(r => console.log(`[BOOT] ✓ hormuz ($${r.brentSpot}) ${Date.now()-t0}ms`)),
    fetchOilInventory().then(r => console.log(`[BOOT] ✓ oil inv (${r?.crudeBuild}M bbl) ${Date.now()-t0}ms`)),
    fetchNewsFeed().then(r => console.log(`[BOOT] ✓ news (${r.length} items) ${Date.now()-t0}ms`)),
  ]);
  console.log(`[BOOT] All caches warmed in ${Date.now()-t0}ms`);

  // ─── Telegram client — connects to oil channels for real-time news ───────
  // No-op if env vars not configured; falls back to RSS news feed.
  try {
    const { startTelegramClient } = await import("./src/lib/telegram");
    await startTelegramClient();
  } catch (err) {
    console.warn("[BOOT] Telegram start failed (non-fatal):", (err as Error).message);
  }

  // ─── Background EIA Crude Oil Sniper — runs FOREVER, no SSE needed ──────
  // Adaptive polling around the 10:30 ET Wed/Thu release window:
  //   T−5min → T−10s : 10s polling   (warmup)
  //   T−10s  → T+30s : ⚡ 1s polling  (BURST)
  //   T+30s  → T+5min: 3s polling    (catch-up)
  //   T+5min → T+15m : 10s polling   (safety)
  //   Outside window  : sleeps until next release
  let eiaBaselinePeriod: string | null = null;
  function nextEIAReleaseTime(): number | null {
    const now = new Date();
    const m = now.getUTCMonth();
    const isEDT = (m > 2 && m < 10) || (m === 2 && now.getUTCDate() >= 8) || (m === 10 && now.getUTCDate() < 1);
    const etOffset = isEDT ? -4 : -5;
    for (let d = 0; d < 8; d++) {
      const candidate = new Date(now.getTime() + d * 86400_000);
      const etDate = new Date(candidate.getTime() + etOffset * 3600_000);
      const day = etDate.getUTCDay();
      if (day !== 3 && day !== 4) continue;  // Wed=3, Thu=4
      const release = new Date(Date.UTC(etDate.getUTCFullYear(), etDate.getUTCMonth(), etDate.getUTCDate(), 10 - etOffset, 30, 0));
      if (release.getTime() > now.getTime() - 15 * 60_000) return release.getTime();
    }
    return null;
  }
  function eiaPollInterval(secFromRelease: number): number {
    if (secFromRelease >= -10 && secFromRelease <= 30) return 1_000;
    if (secFromRelease > 30 && secFromRelease <= 300)  return 3_000;
    if (secFromRelease > 300 && secFromRelease <= 900) return 10_000;
    if (secFromRelease > -300 && secFromRelease < -10) return 10_000;  // warmup
    return 60_000;  // far outside window — slow background poll
  }

  async function eiaTick() {
    try {
      const release = nextEIAReleaseTime();
      const secFromRelease = release ? (Date.now() - release) / 1000 : -100_000;

      // Only do the expensive cache-bypass fetch when we're near the window
      const inWindow = secFromRelease >= -300 && secFromRelease <= 900;
      if (inWindow) {
        bypassEIACache();
        const fresh = await fetchOilInventory();
        const freshPeriod = fresh?.timestamp.slice(0, 10);
        if (eiaBaselinePeriod === null && freshPeriod) eiaBaselinePeriod = freshPeriod;

        if (freshPeriod && eiaBaselinePeriod && freshPeriod > eiaBaselinePeriod) {
          console.log(`[BG-EIA SNIPER] 🎯 NEW DATA at T+${secFromRelease.toFixed(2)}s: ${eiaBaselinePeriod} → ${freshPeriod} (${fresh?.crudeBuild}M bbl)`);
          eiaBaselinePeriod = freshPeriod;
          // Also bust the FF cache so the calendar event picks up the new actual
          bypassFFCache();
          await fetchEconomicCalendar();
        }
      }

      const nextDelay = eiaPollInterval(secFromRelease);
      setTimeout(eiaTick, nextDelay);
    } catch {
      // On any error, retry in 60s
      setTimeout(eiaTick, 60_000);
    }
  }
  eiaTick();
  console.log("[BOOT] ✓ Background EIA sniper started (always-on)");

  // ─── Periodic background refresh — keeps disk cache warm even when idle ──
  setInterval(() => {
    fetchOilInventory().catch(() => {});
    fetchHormuzData().catch(() => {});
    fetchNewsFeed().catch(() => {});
    fetchTruthSocialPosts().catch(() => {});
    fetchEconomicCalendar().catch(() => {});
  }, 5 * 60_000);  // every 5 min
  console.log("[BOOT] ✓ Background refresh loop started (5-min cycle)");
}
