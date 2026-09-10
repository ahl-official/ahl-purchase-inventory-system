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
  const mutation = action !== 'auth.login' && !/\.(read|list)$/.test(action);
  if (!navigator.onLine) return { ok:false, error:'OFFLINE', message:'Connect to the internet to view or change live stock.' };
  const key = 'ahl-submit:' + action + ':' + JSON.stringify(data);
  let operationId = '';
  try {
    if (mutation) {
      operationId = sessionStorage.getItem(key) || crypto.randomUUID();
      sessionStorage.setItem(key, operationId);
    }
    const res = await fetch("/api/gas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data: mutation ? { ...(data as object), operationId } : data }),
    });

    const parsed = (await res.json()) as ApiResult<TResponse>;
    if (mutation && (parsed.ok || !['TIMEOUT','NETWORK_ERROR','BAD_GATEWAY','OUTCOME_UNKNOWN'].includes(parsed.error))) sessionStorage.removeItem(key);
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
