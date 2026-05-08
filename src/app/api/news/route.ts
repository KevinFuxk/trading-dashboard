import { NextResponse } from "next/server";
import { fetchNewsFeed } from "@/lib/data-sources";

export const dynamic = "force-dynamic";

export async function GET() {
  const news = await fetchNewsFeed();
  return NextResponse.json(news);
}
