/**
 * Signed proxy to the Apps Script backend.
 *
 * Why this exists instead of signing in the browser:
 *   1. HMAC_SECRET is a shared secret. Anything shipped to the client is public,
 *      so signing client-side would hand every visitor the ability to forge writes.
 *   2. `actor` is the identity Apps Script trusts (isActiveUser gates on it). It is
 *      read from the NextAuth session here, so the client cannot impersonate anyone.
 *   3. A browser POST straight to script.google.com fails CORS preflight anyway.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { callAppsScript, type AppsScriptAction } from "@/lib/api";
import { readDirect, DIRECT_READ_ACTIONS, type DirectReadAction } from "@/lib/sheets-direct";

function isDirectReadAction(action: AppsScriptAction): action is DirectReadAction {
  return (DIRECT_READ_ACTIONS as readonly string[]).includes(action);
}

/** `CODE: message` -> {error, message}, the same split Code.gs does for a thrown handler error. */
function splitError(raw: string) {
  const i = raw.indexOf(":");
  const coded = i > 0 && /^[A-Z_]+$/.test(raw.slice(0, i));
  return coded ? { error: raw.slice(0, i), message: raw.slice(i + 1).trim() } : { error: "HANDLER_ERROR", message: raw };
}

// Which roles may invoke which action. Mirrors the middleware's route gating so
// a PurchaseCoordinator cannot issue stock by hand-crafting a fetch.
type SessionAction = Exclude<AppsScriptAction, "auth.login">;

// Keep this in sync with the `roles` map in apps-script/Code.gs -- a role granted there but not
// here never reaches the backend at all (rejected here first), which is easy to miss since the
// automated tests call Apps Script directly and skip this route entirely.
const ACTION_ROLES: Record<SessionAction, string[]> = {
  "operations.read": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "catalogue.read": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "order.create": ["PurchaseCoordinator", "Admin"],
  "order.cancel": ["PurchaseCoordinator", "Admin"],
  "handover.cancel": ["PurchaseCoordinator", "Admin"],
  "stock.adjust": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "product.create": ["PurchaseCoordinator", "Admin"],
  "product.setVendor": ["PurchaseCoordinator", "Admin"],
  "inventoryReport.read": ["PurchaseCoordinator", "Admin"],
  "stock.issue": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "stock.retailSale": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "stock.receive": ["PurchaseCoordinator", "Admin"],
  // Hitesh can raise his own requests here; processPurchaseRequest on the
  // Apps Script side is what actually forces his rows to PENDING_APPROVAL
  // rather than letting him self-approve like Satvik can.
  "purchase.request": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "purchase.approve": ["PurchaseCoordinator", "Admin"],
  "stock.handover": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "stock.confirmHandover": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "handover.list": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "opening.submit": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "opening.list": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "opening.approve": ["Admin"],
  "dashboard.read": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
};

function isKnownAction(value: unknown): value is SessionAction {
  return typeof value === "string" && value in ACTION_ROLES;
}

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user?.email) {
    return NextResponse.json(
      { ok: false, error: "UNAUTHENTICATED", message: "Sign in to continue." },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "BAD_REQUEST", message: "Body must be JSON." },
      { status: 400 }
    );
  }

  const { action, data } = (body ?? {}) as { action?: unknown; data?: unknown };

  if (!isKnownAction(action)) {
    return NextResponse.json(
      { ok: false, error: "UNKNOWN_ACTION", message: `Action "${String(action)}" is not supported.` },
      { status: 400 }
    );
  }

  const role = session.user.role;
  if (!ACTION_ROLES[action].includes(role)) {
    return NextResponse.json(
      { ok: false, error: "FORBIDDEN", message: `Role ${role} may not perform ${action}.` },
      { status: 403 }
    );
  }

  // actor comes from the session, never from the request body.
  const actor = session.user.email;

  // Reads only: try Sheets directly first (no Apps Script round trip -- the slow part).
  // Any failure here (missing env, quota, a bug) falls straight back to the proven
  // Apps Script path below, so this can only make reads faster, never less reliable.
  if (isDirectReadAction(action)) {
    try {
      const data_ = await readDirect(action, actor, (data as Record<string, unknown>) ?? {});
      return NextResponse.json({ ok: true, data: data_ }, { status: 200 });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (!raw.startsWith("DIRECT_READ_UNAVAILABLE")) {
        // A real business rejection (e.g. FORBIDDEN, VALIDATION) -- report it as-is,
        // same as Apps Script would, rather than silently retrying against Apps Script.
        return NextResponse.json({ ok: false, ...splitError(raw) }, { status: 200 });
      }
      // else: infra problem with the direct path itself -- fall through to Apps Script.
    }
  }

  const result = await callAppsScript({
    action,
    actor,
    data: data ?? {},
  });

  // Always HTTP 200 for a business-level rejection; the client reads result.ok.
  // Reserved 4xx/5xx above are transport/authz failures the client cannot retry.
  return NextResponse.json(result, { status: 200 });
}
