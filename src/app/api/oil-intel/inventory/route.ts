import { NextResponse } from "next/server";
import { fetchOilInventory } from "@/lib/data-sources";

export const dynamic = "force-dynamic";

export async function GET() {
  const data = await fetchOilInventory();
  return NextResponse.json(data);
}
