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
  const useLocal = process.env.FORCE_LOCAL_STORE === "1" || !supabaseConfigured();
  cached = useLocal ? new LocalStore() : new SupabaseStore();
  return cached;
}

export function resetStoreCache(): void {
  cached = null;
}

export type { Store } from "@/lib/store/store";
