import { NextResponse } from "next/server";
import { fetchHormuzData } from "@/lib/data-sources";

export const dynamic = "force-dynamic";

export async function GET() {
  const data = await fetchHormuzData();
  return NextResponse.json(data);
}
