import { NextResponse } from "next/server";
import { fetchEconomicCalendar } from "@/lib/data-sources";

export const dynamic = "force-dynamic";

export async function GET() {
  const events = await fetchEconomicCalendar();
  return NextResponse.json(events);
}
