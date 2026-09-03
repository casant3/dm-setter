import { supabaseConfigured } from "@/core/db";
import { LocalStore } from "@/lib/store/local-store";
import { SupabaseStore } from "@/lib/store/supabase-store";
import type { Store } from "@/lib/store/store";

let cached: Store | null = null;

/**
 * Supabase when credentials are present, otherwise the local development store.
 * Set `FORCE_LOCAL_STORE=1` to use the local store even with credentials configured.
 */
export function getStore(): Store {
  if (cached) return cached;
  const forced = process.env.FORCE_LOCAL_STORE === "1";
  const useLocal = forced || !supabaseConfigured();

  // The local store writes JSON to disk, which a serverless host does not have.
  // Failing here with the reason beats an EROFS stack trace on the first write,
  // and beats quietly running a hosted app on a store that resets constantly.
  if (useLocal && !forced && process.env.NODE_ENV === "production") {
    throw new Error(
      "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY — the local development store cannot be used in production.",
    );
  }

  cached = useLocal ? new LocalStore() : new SupabaseStore();
  return cached;
}

export function resetStoreCache(): void {
  cached = null;
}

export type { Store } from "@/lib/store/store";
