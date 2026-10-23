/**
 * Write path: service-account writes to Google Sheets, replacing the Apps Script web
 * app's mutation handlers one action at a time. Ported 1:1 from Code.gs / Db.gs /
 * Validation.gs / Operations.gs etc. -- same roles, same validation, same idempotency
 * contract, same AUDIT/OPERATIONS bookkeeping. Only the transport changes.
 *
 * Concurrency: Apps Script's write path ran inside a script-wide lock (LockService),
 * so two concurrent writers could never interleave. The Sheets API has no equivalent
 * primitive. This file is optimistic instead:
 *   - Appends are inherently race-safe -- Google serializes concurrent appends to the
 *     same sheet into separate rows, nothing is ever overwritten.
 *   - A targeted row update (updateRow) re-reads that exact row immediately before
 *     writing, narrowing the race window from "since the page loaded" to "within this
 *     one request" -- the closest a lock-free design gets to the old guarantee.
 *   - The OPERATIONS tab's idempotency check is itself the safety net for failures
 *     mid-write: if this path fails after marking an operation STARTED, a retry (even
 *     one that falls back to Apps Script, since both read the same sheet) correctly
 *     refuses with OUTCOME_UNKNOWN instead of writing the stock movement twice.
 *
 * Only action not yet ported here must throw DIRECT_WRITE_UNAVAILABLE before touching
 * OPERATIONS, so the caller can fall back to Apps Script. Once an operation has been
 * marked STARTED, every further failure is a real answer, not a reason to retry blindly.
 *
 * SERVER ONLY. GOOGLE_SERVICE_ACCOUNT_KEY must never reach the client.
 */
import { createSign, randomUUID } from "node:crypto";
import {
  requireEnv, loadContext, isTruthy, appRole, getUser, getProduct,
  type Ctx, type Row,
} from "./sheets-direct";

// ---------------------------------------------------------------- auth (write scope, own cache)

let cachedWriteToken: { token: string; exp: number } | null = null;

async function getWriteAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedWriteToken && cachedWriteToken.exp > now + 60) return cachedWriteToken.token;

  const key = JSON.parse(Buffer.from(requireEnv("GOOGLE_SERVICE_ACCOUNT_KEY"), "base64").toString("utf8"));
  const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
    iss: key.client_email, scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000,
  })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error("WRITE_AUTH_FAILED: Service account auth failed for writes.");
  cachedWriteToken = { token: json.access_token, exp: now + (Number(json.expires_in) || 3000) };
  return cachedWriteToken.token;
}

// ---------------------------------------------------------------- raw Sheets API I/O

async function sheetsFetch(token: string, path: string, init?: RequestInit) {
  const sheetId = requireEnv("GOOGLE_SHEET_ID");
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers || {}) },
    cache: "no-store",
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`SHEETS_API_ERROR: ${json.error?.message || res.status}`);
  return json;
}

function colLetter(n: number): string {
  let s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Days since 1899-12-30, the same serial Sheets stores and sheets-direct.ts's serialToDate expects back. */
const IST_OFFSET_MS = 330 * 60 * 1000;
function dateToSerial(date: Date): number {
  return (date.getTime() + IST_OFFSET_MS) / 86400000 + 25569;
}

interface TabRow { rowNumber: number; data: Row; }

/** Always re-reads live from Sheets -- this freshness is what stands in for the old lock. */
async function readTabRaw(token: string, sheetName: string): Promise<{ headers: string[]; rows: TabRow[] }> {
  const json = await sheetsFetch(token, `/values/${encodeURIComponent(sheetName)}!A1:AZ20000?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`);
  const values: unknown[][] = json.values || [];
  const headers = ((values[0] as unknown[]) || []).map((h) => String(h ?? "").trim());
  const rows = values.slice(1).map((r, i) => {
    const data: Row = {};
    headers.forEach((h, ci) => { if (h) data[h] = ((r as unknown[])[ci] as string | number) ?? ""; });
    return { rowNumber: i + 2, data };
  });
  return { headers, rows };
}

/** Ported 1:1 from Db.gs appendRecord: unknown key is a hard error, missing key is left blank. */
async function appendRow(token: string, sheetName: string, record: Record<string, unknown>): Promise<void> {
  const { headers } = await readTabRaw(token, sheetName);
  for (const key of Object.keys(record)) {
    if (!headers.includes(key)) throw new Error(`SCHEMA_ERROR: '${sheetName}' has no column '${key}'. Columns are: ${headers.filter(Boolean).join(", ")}`);
  }
  const row = headers.map((h) => (h && h in record ? (record[h] ?? "") : ""));
  await sheetsFetch(token, `/values/${encodeURIComponent(sheetName)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST", body: JSON.stringify({ values: [row] }),
  });
}

/**
 * Ported 1:1 from Db.gs updateRecordFields, but re-reads the tab fresh first (see file
 * header). `verify`, when given, runs against that fresh row before writing -- a
 * handler's STALE_ENTRY check re-armed against live data instead of just the ctx
 * snapshot taken at the top of the request, shrinking the race window to this call.
 */
async function updateRow(token: string, sheetName: string, keyColumn: string, keyValue: string, changes: Record<string, unknown>, verify?: (fresh: Row) => void): Promise<number> {
  const { headers, rows } = await readTabRaw(token, sheetName);
  const target = rows.find((r) => String(r.data[keyColumn]).trim().toLowerCase() === String(keyValue).trim().toLowerCase());
  if (!target) throw new Error("NOT_FOUND: Record not found.");
  if (verify) verify(target.data);
  for (const key of Object.keys(changes)) if (!headers.includes(key)) throw new Error(`SCHEMA_ERROR: Missing ${key}`);
  const merged = headers.map((h) => (h in changes ? changes[h] : (target.data[h] ?? "")));
  await sheetsFetch(token, `/values/${encodeURIComponent(sheetName)}!A${target.rowNumber}:${colLetter(headers.length)}${target.rowNumber}?valueInputOption=RAW`, {
    method: "PUT", body: JSON.stringify({ values: [merged] }),
  });
  return target.rowNumber;
}

/** Matches Apps Script's nextId: `${prefix}-${first 8 hex chars of a UUID, uppercased}`. */
function nextId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

/** Ported 1:1 from Validation.gs audit: never throws -- a failed audit must not fail the write. */
async function auditWrite(token: string, actor: string, action: string, ref: string, detail: unknown, result = "SUCCESS"): Promise<void> {
  try {
    await appendRow(token, "AUDIT", {
      AuditID: nextId("AUD"), Timestamp: dateToSerial(new Date()), Actor: actor || "unknown",
      Action: action || "unknown", Ref: ref || "",
      Detail: typeof detail === "string" ? detail : JSON.stringify(detail || {}), Result: result,
    });
  } catch (err) {
    console.error("Could not write audit row:", err);
  }
}

// ---------------------------------------------------------------- idempotency (OPERATIONS), ported 1:1 from Code.gs

async function beginOperation(token: string, operationId: string, actor: string, action: string): Promise<{ cached?: unknown }> {
  if (!operationId || !/^[a-zA-Z0-9-]{16,80}$/.test(operationId)) throw new Error("VALIDATION: Refresh the application before submitting.");
  const { rows } = await readTabRaw(token, "OPERATIONS");
  const prior = rows.find((r) => String(r.data.OperationID) === operationId);
  if (prior) {
    if (prior.data.Actor !== actor || prior.data.Action !== action) throw new Error("FORBIDDEN: Invalid operation reference.");
    if (prior.data.Status === "COMPLETED") return { cached: JSON.parse(String(prior.data.Result || "{}")) };
    if (prior.data.Status === "STARTED") throw new Error("OUTCOME_UNKNOWN: This submission was already started. Refresh and ask management to check it before making another submission.");
    await updateRow(token, "OPERATIONS", "OperationID", operationId, { Status: "STARTED", Result: "" });
  } else {
    await appendRow(token, "OPERATIONS", { OperationID: operationId, Date: dateToSerial(new Date()), Actor: actor, Action: action, Status: "STARTED", Result: "" });
  }
  return {};
}
async function completeOperation(token: string, operationId: string, result: unknown): Promise<void> {
  await updateRow(token, "OPERATIONS", "OperationID", operationId, { Status: "COMPLETED", Result: JSON.stringify(result) });
}
async function failOperation(token: string, operationId: string, error: { error: string; message: string }): Promise<void> {
  try { await updateRow(token, "OPERATIONS", "OperationID", operationId, { Status: "FAILED", Result: JSON.stringify(error) }); } catch { /* best effort, matches Code.gs */ }
}

// ---------------------------------------------------------------- ported handlers
//
// Each handler calls auditWrite itself, exactly where its .gs counterpart calls
// audit() -- ref and detail vary per action, so this stays per-handler rather than
// one generic call in the dispatcher. Failure audit is centralized in writeDirect's
// catch block, matching Code.gs's doPost (success audit lives in the handler, failure
// audit lives in the wrapper).

/** Ported 1:1 from Operations.gs processListAdd. */
async function handleListAdd(token: string, actor: string, ctx: Ctx, data: Record<string, unknown>) {
  const type = String(data.type || "");
  if (type !== "VENDOR" && type !== "RECEIVER") throw new Error("VALIDATION: Unsupported list.");
  const name = String(data.name || "").trim();
  if (name.length < 2) throw new Error("VALIDATION: Enter a name.");
  const existing = ctx.lists.find((v) => v.Type === type && isTruthy(v.Active) && String(v.Name || "").trim().toLowerCase() === name.toLowerCase());
  if (existing) return { id: existing.Code, name: existing.Name };
  const id = nextId(type === "VENDOR" ? "VND" : "RCV");
  await appendRow(token, "LISTS", { Type: type, Code: id, Name: name, Extra: "", Active: true });
  await auditWrite(token, actor, "list.add", id, { type, name });
  return { id, name };
}

/**
 * Ported 1:1 from Operations.gs processProductCreate, except: ProductID is a
 * sequential counter (PRD-0001, PRD-0002, ...), not a random id like every other
 * entity here. A lock made that collision-proof; this re-reads PRODUCTS immediately
 * before minting the id to shrink (not eliminate) the race, per the accepted
 * optimistic-concurrency trade-off -- two product creations within the same instant
 * are the one scenario in this batch that isn't fully safe. Also drops
 * allowBothProductType() (a spreadsheet dropdown-validation convenience, cosmetic
 * only, not yet ported).
 */
async function handleProductCreate(token: string, actor: string, ctx: Ctx, data: Record<string, unknown>) {
  const name = String(data.name || "").replace(/\s+/g, " ").trim();
  const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const uom = (v: unknown, label: string) => { const u = String(v || "").trim().toUpperCase(); if (!/^[A-Z]{1,10}$/.test(u)) throw new Error(`VALIDATION: Choose the ${label}.`); return u; };
  if (name.length < 3 || name.length > 120) throw new Error("VALIDATION: Enter the product name (3-120 characters).");
  const productType = String(data.productType || "");
  if (!["Consumable", "Retail", "Both"].includes(productType)) throw new Error("VALIDATION: Choose Consumable, Retail or Both.");
  const purchaseUom = uom(data.purchaseUom, "purchase unit");
  const issueUom = uom(data.issueUom, "stock unit");
  const conv = Number(data.convFactor);
  if (!isFinite(conv) || conv <= 0) throw new Error("VALIDATION: Enter how much stock one purchase unit contains.");
  if (purchaseUom === issueUom && conv !== 1) throw new Error("VALIDATION: Same purchase and stock unit must contain exactly 1.");
  const has = (type: string, code: unknown) => ctx.lists.some((v) => v.Type === type && v.Code === code && isTruthy(v.Active));
  if (!has("CATEGORY", data.categoryId)) throw new Error("VALIDATION: Choose the product category.");
  const cost = data.cost === "" || data.cost == null ? 0 : Number(data.cost);
  if (!isFinite(cost) || cost < 0) throw new Error("VALIDATION: Cost cannot be negative.");
  const gst = Number(data.gstPercent || 0), reorder = Number(data.reorderLevel || 0);
  if (!isFinite(gst) || gst < 0 || gst > 28) throw new Error("VALIDATION: GST must be between 0 and 28.");
  if (!isFinite(reorder) || reorder < 0) throw new Error("VALIDATION: Reorder level cannot be negative.");
  if (data.vendorId && !has("VENDOR", data.vendorId)) throw new Error("VALIDATION: Choose a listed supplier.");
  if (ctx.products.some((p) => normName(String(p.Name)) === normName(name))) throw new Error("DUPLICATE: This product already exists.");

  const { rows: liveProducts } = await readTabRaw(token, "PRODUCTS");
  if (liveProducts.some((r) => normName(String(r.data.Name)) === normName(name))) throw new Error("DUPLICATE: This product already exists.");
  const max = liveProducts.reduce((m, r) => { const n = /^PRD-(\d+)$/.exec(String(r.data.ProductID)); return n ? Math.max(m, Number(n[1])) : m; }, 0);
  const id = `PRD-${String(max + 1).padStart(4, "0")}`;
  await appendRow(token, "PRODUCTS", {
    ProductID: id, Name: name, CategoryID: data.categoryId, IssueUOM: issueUom, PurchaseUOM: purchaseUom, ConvFactor: conv,
    Cost: cost, GSTPercent: gst / 100, VendorID: data.vendorId || "", ReorderLevel: reorder, Active: true,
    Notes: [String(data.brand || "").trim() ? `Brand: ${String(data.brand).trim()}` : "", String(data.notes || "").trim().slice(0, 300)].filter(Boolean).join(" | "),
    ProductType: productType,
  });
  await auditWrite(token, actor, "product.create", id, data);
  return { productId: id, name };
}

/** Ported 1:1 from Operations.gs processProductSetVendor. */
async function handleProductSetVendor(token: string, actor: string, ctx: Ctx, data: Record<string, unknown>) {
  if (!ctx.lists.some((v) => v.Type === "VENDOR" && v.Code === data.vendorId && isTruthy(v.Active))) throw new Error("VALIDATION: Choose a listed vendor.");
  if (!ctx.products.some((p) => p.ProductID === data.productId)) throw new Error("VALIDATION: Product not found.");
  await updateRow(token, "PRODUCTS", "ProductID", String(data.productId), { VendorID: data.vendorId });
  await auditWrite(token, actor, "product.setVendor", String(data.productId), data);
  return { productId: data.productId, vendorId: data.vendorId };
}

/** Ported 1:1 from Operations.gs processProductEditUnit (the ledger-history guard was deliberately removed there). */
async function handleProductEditUnit(token: string, actor: string, ctx: Ctx, data: Record<string, unknown>) {
  const productId = String(data.productId || "");
  const p = getProduct(ctx, productId);
  if (!p) throw new Error("UNKNOWN_PRODUCT: Product not found.");
  const expected = data.expected as Record<string, unknown> | undefined;
  const checkStale = (fresh: Row) => {
    if (!expected) return;
    if (String(expected.productType) !== String(fresh.ProductType || "Consumable") ||
        String(expected.purchaseUom) !== String(fresh.PurchaseUOM) ||
        String(expected.issueUom) !== String(fresh.IssueUOM) ||
        Number(expected.convFactor) !== (Number(fresh.ConvFactor) || 1)) {
      throw new Error("STALE_ENTRY: This product changed after the form was loaded. Refresh and review the current product settings before saving.");
    }
  };
  checkStale(p);
  const changes: Record<string, unknown> = {};
  const productType = data.productType ? String(data.productType) : "";
  if (productType) {
    if (!["Consumable", "Retail", "Both"].includes(productType)) throw new Error("VALIDATION: Choose Consumable, Retail or Both.");
    if (productType !== p.ProductType) changes.ProductType = productType;
  }
  if (data.purchaseUom || data.issueUom || data.convFactor != null) {
    const uom = (v: unknown, label: string) => { const u = String(v || "").trim().toUpperCase(); if (!/^[A-Z]{1,10}$/.test(u)) throw new Error(`VALIDATION: Choose the ${label}.`); return u; };
    const purchaseUom = uom(data.purchaseUom || p.PurchaseUOM, "purchase unit");
    const issueUom = uom(data.issueUom || p.IssueUOM, "stock unit");
    const conv = Number(data.convFactor != null ? data.convFactor : p.ConvFactor);
    if (!isFinite(conv) || conv <= 0) throw new Error("VALIDATION: Enter how much stock one purchase unit contains.");
    if (purchaseUom === issueUom && conv !== 1) throw new Error("VALIDATION: Same purchase and stock unit must contain exactly 1.");
    const unitChanged = purchaseUom !== p.PurchaseUOM || issueUom !== p.IssueUOM || conv !== Number(p.ConvFactor);
    if (unitChanged) { changes.PurchaseUOM = purchaseUom; changes.IssueUOM = issueUom; changes.ConvFactor = conv; }
  }
  if (!Object.keys(changes).length) return { productId, changed: false };
  await updateRow(token, "PRODUCTS", "ProductID", productId, changes, checkStale);
  await auditWrite(token, actor, "product.editUnit", productId, { before: { productType: p.ProductType, purchaseUom: p.PurchaseUOM, issueUom: p.IssueUOM, convFactor: p.ConvFactor }, changes, notes: data.notes || "" });
  return { productId, changed: true };
}

/** Ported 1:1 from Operations.gs processProductDelete (soft delete via Active flag). */
async function handleProductDelete(token: string, actor: string, ctx: Ctx, data: Record<string, unknown>) {
  const productId = String(data.productId || "");
  const p = getProduct(ctx, productId);
  if (!p) throw new Error("UNKNOWN_PRODUCT: Product not found.");
  if (!isTruthy(p.Active)) return { productId, changed: false };
  await updateRow(token, "PRODUCTS", "ProductID", productId, { Active: false });
  await auditWrite(token, actor, "product.delete", productId, { name: p.Name, notes: data.notes || "" });
  return { productId, changed: true };
}

/** Ported 1:1 from Operations.gs processProductRestore. */
async function handleProductRestore(token: string, actor: string, ctx: Ctx, data: Record<string, unknown>) {
  const productId = String(data.productId || "");
  const p = getProduct(ctx, productId);
  if (!p) throw new Error("UNKNOWN_PRODUCT: Product not found.");
  if (isTruthy(p.Active)) return { productId, changed: false };
  await updateRow(token, "PRODUCTS", "ProductID", productId, { Active: true });
  await auditWrite(token, actor, "product.restore", productId, { name: p.Name, notes: data.notes || "" });
  return { productId, changed: true };
}

// ---------------------------------------------------------------- entry point

export const DIRECT_WRITE_ACTIONS = ["list.add", "product.create", "product.setVendor", "product.editUnit", "product.delete", "product.restore"] as const;
export type DirectWriteAction = (typeof DIRECT_WRITE_ACTIONS)[number];

const WRITE_ROLES: Record<DirectWriteAction, string[]> = {
  "list.add": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "product.create": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "product.setVendor": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "product.editUnit": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "product.delete": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "product.restore": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
};

export async function writeDirect(action: DirectWriteAction, actor: string, data: Record<string, unknown>): Promise<unknown> {
  const roles = WRITE_ROLES[action];
  if (!roles) throw new Error("DIRECT_WRITE_UNAVAILABLE: Action not yet ported.");

  const token = await getWriteAccessToken();
  const ctx = await loadContext();
  const user = getUser(ctx, actor);
  if (!user || !isTruthy(user.Active)) throw new Error("FORBIDDEN: Your account could not be found or is inactive.");
  if (!roles.includes(appRole(user.Role))) throw new Error("FORBIDDEN: This action is not available to your role.");

  const operationId = String(data.operationId || "");
  const begun = await beginOperation(token, operationId, actor, action);
  if (begun.cached !== undefined) return begun.cached;

  try {
    let result: unknown;
    switch (action) {
      case "list.add": result = await handleListAdd(token, actor, ctx, data); break;
      case "product.create": result = await handleProductCreate(token, actor, ctx, data); break;
      case "product.setVendor": result = await handleProductSetVendor(token, actor, ctx, data); break;
      case "product.editUnit": result = await handleProductEditUnit(token, actor, ctx, data); break;
      case "product.delete": result = await handleProductDelete(token, actor, ctx, data); break;
      case "product.restore": result = await handleProductRestore(token, actor, ctx, data); break;
    }
    await completeOperation(token, operationId, result);
    return result;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const split = raw.indexOf(":");
    const coded = split > 0 && /^[A-Z_]+$/.test(raw.slice(0, split));
    await auditWrite(token, actor, action, "", raw, "FAILED");
    await failOperation(token, operationId, { error: coded ? raw.slice(0, split) : "HANDLER_ERROR", message: coded ? raw.slice(split + 1).trim() : raw });
    throw err;
  }
}
