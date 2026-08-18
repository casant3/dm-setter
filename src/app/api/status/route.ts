import { supabaseConfigured } from "@/core/db";
import { openaiConfigured } from "@/core/openai";
import { handleError, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Tells the UI whether it is running on live credentials or in development mode. */
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    return ok({
      store_mode: getStore().mode,
      supabase_configured: supabaseConfigured(),
      openai_configured: openaiConfigured(),
      setter_model: process.env.OPENAI_MODEL || "gpt-5.6",
    });
  } catch (error) {
    return handleError(error);
  }
}
