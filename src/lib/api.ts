/**
 * AHL Flow -> Google Apps Script transport.
 *
 * SERVER ONLY. This module reads HMAC_SECRET and must never be imported into a
 * "use client" component. Browser code should call the /api/gas route handler
 * (see src/lib/api-client.ts), which authenticates the session and delegates here.
 *
 * Wire contract (must stay byte-identical to verifyHmac() in apps-script/Validation.gs):
 *   body      = JSON.stringify({ action, actor, data })
 *   message   = `${timestamp}.${body}`
 *   signature = base64( HMAC_SHA256(message, HMAC_SECRET) )
 *   POST ${NEXT_PUBLIC_APPS_SCRIPT_URL}?ts=${timestamp}&sig=${encodeURIComponent(signature)}
 *
 * The timestamp is epoch milliseconds. Apps Script rejects anything outside a
 * 5-minute window, so a badly skewed server clock reads as FORBIDDEN.
 */

import { createHmac } from "node:crypto";

export type AppsScriptAction =
  | "operations.read"
  | "catalogue.read"
  | "order.create"
  | "order.cancel"
  | "handover.cancel"
  | "stock.adjust"
  | "auth.login"
  | "stock.issue"
  | "stock.receive"
  | "purchase.request"
  | "purchase.approve"
  | "stock.handover"
  | "stock.confirmHandover"
  | "handover.list"
  | "opening.submit"
  | "opening.list"
  | "opening.approve"
  | "asset.issue"
  | "asset.list"
  | "asset.status"
  | "dashboard.read";

export interface AppsScriptPayload<T = unknown> {
  action: AppsScriptAction;
  actor: string;
  data: T;
}

/** Shape returned by respondJson() on the Apps Script side. */
type AppsScriptEnvelope<T> =
  | { success: true; data: T; status?: number }
  | { success: false; error: string; message: string; status?: number };

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; message: string };

/** Default ceiling for a single request. GRN payloads carry a base64 bill photo. */
const DEFAULT_TIMEOUT_MS = 45_000;

function requireEnv(name: "NEXT_PUBLIC_APPS_SCRIPT_URL" | "HMAC_SECRET"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[api] Missing ${name}. Add it to .env and restart the dev server.`
    );
  }
  return value;
}

/**
 * JSON.stringify, but every non-ASCII character comes out as \uXXXX.
 *
 * Discovered empirically: a body containing a raw em dash, ₹, a curly quote,
 * or Devanagari text (all real inputs here — notes and product names are
 * typed by Hindi-speaking staff) fails HMAC verification against the live
 * Apps Script endpoint, even though both sides compute the hash over what
 * looks like the same string. Something between here and doPost() re-encodes
 * multi-byte UTF-8 inconsistently. Sending pure ASCII sidesteps the ambiguity
 * entirely — JSON.parse() on the Apps Script side unescapes \uXXXX back to
 * the original character with no loss, so nothing about the data changes.
 */
function asciiSafeStringify(value: unknown): string {
  return JSON.stringify(value).replace(
    /[^\x00-\x7f]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

/**
 * Signs an exact request body. Exported so the signature can be unit-tested
 * against a known vector without performing a network call.
 */
export function signPayload(
  body: string,
  timestamp: number,
  secret: string = requireEnv("HMAC_SECRET")
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("base64");
}

/**
 * Posts a signed payload to the Apps Script web app, retrying once on a
 * BAD_GATEWAY (non-JSON) response before giving up.
 *
 * Why this one error and no other: a non-JSON response means Google's own
 * front end rejected the request before doPost() ran -- respondJson() always
 * returns valid JSON, success or business-error alike, so the script itself
 * never executed and nothing was written. That makes a retry safe. TIMEOUT
 * and NETWORK_ERROR are NOT retried here for the opposite reason: the
 * request may have reached the lock and the write may have landed even
 * though the response never came back, and retrying a mutation like
 * stock.receive or stock.issue in that state would double it. Confirmed
 * empirically -- a live 404 from the deployment cleared on its own within
 * seconds under real (if heavy) call volume.
 */
export async function callAppsScript<TResponse = unknown, TData = unknown>(
  payload: AppsScriptPayload<TData>,
  options: { timeoutMs?: number } = {}
): Promise<ApiResult<TResponse>> {
  return attemptCallAppsScript<TResponse, TData>(payload, options);
}

async function attemptCallAppsScript<TResponse = unknown, TData = unknown>(
  payload: AppsScriptPayload<TData>,
  options: { timeoutMs?: number } = {}
): Promise<ApiResult<TResponse>> {
  const url = requireEnv("NEXT_PUBLIC_APPS_SCRIPT_URL");
  const secret = requireEnv("HMAC_SECRET");

  // Serialize once. The bytes that are signed must be the bytes that are sent.
  // ASCII-safe, not plain JSON.stringify -- see asciiSafeStringify().
  const body = asciiSafeStringify(payload);
  const timestamp = Date.now();
  const signature = signPayload(body, timestamp, secret);

  const target = new URL(url);
  target.searchParams.set("ts", String(timestamp));
  target.searchParams.set("sig", signature);

  try {
    const res = await fetch(target.toString(), {
      method: "POST",
      // Apps Script reads e.postData.contents regardless of type. text/plain
      // keeps the request simple and avoids any proxy content sniffing.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body,
      // /exec 302-redirects to script.googleusercontent.com; follow it.
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    const text = await res.text();

    let parsed: AppsScriptEnvelope<TResponse>;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Apps Script returns an HTML error page when the deployment is stale,
      // unauthorized, or the script threw before respondJson() ran.
      return {
        ok: false,
        error: "BAD_GATEWAY",
        message:
          `Apps Script returned a non-JSON response (HTTP ${res.status}). ` +
          `This usually means the deployment URL is stale or the web app is not ` +
          `set to "Anyone". First 200 chars: ${text.slice(0, 200)}`,
      };
    }

    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error ?? "UNKNOWN_ERROR",
        message: parsed.message ?? "Apps Script rejected the request.",
      };
    }

    return { ok: true, data: parsed.data };
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    return {
      ok: false,
      error: isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
      message: isTimeout
        ? "The backend did not respond in time. The write may still have landed -- check the sheet before retrying."
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }
}
