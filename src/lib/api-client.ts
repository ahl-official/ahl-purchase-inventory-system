"use client";

/**
 * Browser-side counterpart to src/lib/api.ts.
 *
 * Client components call this; it hits the same-origin /api/gas route handler,
 * which authenticates the session, injects `actor`, and performs the HMAC
 * signing on the server. No secret ever reaches the bundle.
 */

import type { ApiResult, AppsScriptAction } from "@/lib/api";

export type { ApiResult };

export async function postAction<TResponse = unknown>(
  action: AppsScriptAction,
  data: unknown
): Promise<ApiResult<TResponse>> {
  try {
    const res = await fetch("/api/gas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data }),
    });

    const parsed = (await res.json()) as ApiResult<TResponse>;
    return parsed;
  } catch (err) {
    return {
      ok: false,
      error: "NETWORK_ERROR",
      message:
        err instanceof Error
          ? err.message
          : "Could not reach the server. Check your connection.",
    };
  }
}
