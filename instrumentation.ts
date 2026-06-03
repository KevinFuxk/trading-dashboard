/**
 * Next.js instrumentation hook — runs once at server startup.
 *
 * Pre-loads:
 *   1. S&P 500 + Nasdaq 100 universe (GitHub CSV cached to disk for 7 days)
 *   2. First Finviz screener fetch (so the first user request hits a warm result)
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  console.log("[BOOT] Pre-warming news screener…");
  const t0 = Date.now();

  const { loadUniverse, fetchScreenedHeadlines } = await import("./src/lib/news-screener");

  await loadUniverse();
  const initial = await fetchScreenedHeadlines();
  console.log(`[BOOT] Initial fetch: ${initial.length} TIER 1 headlines in ${Date.now() - t0}ms`);
  console.log("[BOOT] ✓ Ready");
}
