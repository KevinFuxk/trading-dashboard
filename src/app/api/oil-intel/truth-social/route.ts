import { NextResponse } from "next/server";
import { fetchTruthSocialPosts } from "@/lib/data-sources";

export const dynamic = "force-dynamic";

export async function GET() {
  const posts = await fetchTruthSocialPosts();
  return NextResponse.json(posts);
}
