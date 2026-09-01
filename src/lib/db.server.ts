import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

/** Publishable-key client for public, RLS-respecting reads from the server. */
export function publicDb() {
  const url = process.env["SUPABASE_URL"]!;
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        if (key.startsWith("sb_") && headers.get("Authorization") === `Bearer ${key}`) {
          headers.delete("Authorization");
        }
        headers.set("apikey", key);
        return fetch(input, { ...init, headers });
      },
    },
  });
}

/** Service-role client. Only for validated writes (holds, orders, metrics, admin). */
export async function adminDb() {
  const { supabaseServer } = await import("@/integrations/supabase/client.server");
  return supabaseServer;
}
