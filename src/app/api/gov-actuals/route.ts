/**
 * /api/gov-actuals — Direct BLS + ONS data, bypassing ForexFactory.
 *
 * This endpoint is polled every 2s by the release sniper during
 * known release windows (e.g. 8:29:30–8:32:00 ET).
 * At all other times it's polled every 30s to keep actuals fresh.
 */
import { NextResponse } from "next/server";
import { fetchBLSData, fetchONSData } from "@/lib/gov-calendar";

export const dynamic = "force-dynamic";

export async function GET() {
  const [bls, ons] = await Promise.allSettled([
    fetchBLSData(),
    fetchONSData(),
  ]);

  return NextResponse.json({
    bls: bls.status === "fulfilled" ? bls.value : [],
    ons: ons.status === "fulfilled" ? ons.value : [],
    fetchedAt: new Date().toISOString(),
  });
}
