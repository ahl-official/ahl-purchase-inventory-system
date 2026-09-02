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

// Which roles may invoke which action. Mirrors the middleware's route gating so
// a PurchaseCoordinator cannot issue stock by hand-crafting a fetch.
type SessionAction = Exclude<AppsScriptAction, "auth.login">;

const ACTION_ROLES: Record<SessionAction, string[]> = {
  "stock.issue": ["ProductDistributor", "Admin"],
  "stock.receive": ["PurchaseCoordinator", "Admin"],
  // Hitesh can raise his own requests here; processPurchaseRequest on the
  // Apps Script side is what actually forces his rows to PENDING_APPROVAL
  // rather than letting him self-approve like Satvik can.
  "purchase.request": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "purchase.approve": ["PurchaseCoordinator", "Admin"],
  "stock.handover": ["PurchaseCoordinator", "Admin"],
  "stock.confirmHandover": ["ProductDistributor", "Admin"],
  "handover.list": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
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
  const result = await callAppsScript({
    action,
    actor: session.user.email,
    data: data ?? {},
  });

  // Always HTTP 200 for a business-level rejection; the client reads result.ok.
  // Reserved 4xx/5xx above are transport/authz failures the client cannot retry.
  return NextResponse.json(result, { status: 200 });
}
