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
  requireEnv, loadContext, isTruthy, appRole, getUser, getProduct, getConfig, getConfigNumber,
  findRecord, listPurchaseOrders, serialToDate, serialToIso, openingLocationForActor, actorLocation,
  computeBalanceFromRows, computePendingHandoverOutFromRows,
  type Ctx, type Row,
} from "./sheets-direct";
import { historyKey, type MovementHistory } from "./movement-history";

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

/** Ported 1:1 from Operations.gs positiveQuantity. */
function positiveQuantity(value: unknown, product: Row | null, allowZero: boolean): number {
  const qty = Number(value);
  if (!isFinite(qty) || (allowZero ? qty < 0 : qty <= 0)) throw new Error("VALIDATION: Enter a valid quantity.");
  if (product && product.IssueUOM === "PCS" && Math.floor(qty) !== qty) throw new Error("VALIDATION: Pieces must be whole numbers.");
  return qty;
}

/** Ported 1:1 from EntryChanges.gs entryChangeReason. */
function entryChangeReason(req: Record<string, unknown>): string {
  const reason = String(req.reason || "").trim();
  if (reason.length < 3) throw new Error("VALIDATION: Explain the edit or deletion.");
  return reason;
}

/** Ported 1:1 from Validation.gs resolveTxnDate. */
function resolveTxnDate(req: Record<string, unknown>): Date {
  if (!req || !req.date) return new Date();
  const d = new Date(`${req.date}T12:00:00`);
  if (isNaN(d.getTime())) throw new Error("VALIDATION: Enter a valid date.");
  const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
  if (d.getTime() > endOfToday.getTime()) throw new Error("VALIDATION: The date cannot be in the future.");
  return d;
}

/** Ported 1:1 from Operations.gs processOrderCreate / processOrderCreateLines. */
async function handleOrderCreate(token: string, actor: string, ctx: Ctx, data: Record<string, unknown>): Promise<unknown> {
  if (data.lines) return handleOrderCreateLines(token, actor, ctx, data);
  const p = getProduct(ctx, data.productId);
  if (!p || !isTruthy(p.Active)) throw new Error("UNKNOWN_PRODUCT: Select an active product.");
  const qty = positiveQuantity(data.qty, p, false);
  if (!ctx.lists.some((v) => v.Type === "VENDOR" && v.Code === data.vendorId && isTruthy(v.Active))) throw new Error("VALIDATION: Select a vendor.");
  const headOfficeId = getConfig(ctx, "HeadOfficeLocationID", "LOC-01");
  const deliveryLocationId = String(data.locationId || headOfficeId);
  if (deliveryLocationId === getConfig(ctx, "DispatchLocationID", "LOC-05")) throw new Error("VALIDATION: Dispatch is not a delivery destination.");
  if (deliveryLocationId !== headOfficeId && !ctx.lists.some((v) => v.Type === "LOCATION" && v.Code === deliveryLocationId && isTruthy(v.Active) && v.Extra)) {
    throw new Error("VALIDATION: Choose Head Office or an active studio to deliver to.");
  }
  if (data.requestId) {
    const request = findRecord(ctx.requests, "RequestID", data.requestId);
    if (!request || request.ProductID !== data.productId || !["OPEN", "ORDERED"].includes(String(request.Status))) throw new Error("VALIDATION: Select an approved request for this product.");
    if (listPurchaseOrders(ctx).some((o) => o.requestId === data.requestId && o.status !== "CANCELLED")) throw new Error("DUPLICATE: This request already has an order.");
  }
  const id = nextId("PO");
  await appendRow(token, "PURCHASE_ORDERS", {
    OrderID: id, Date: dateToSerial(resolveTxnDate(data)), ProductID: data.productId, VendorID: data.vendorId,
    QtyOrdered: qty, UOM: p.PurchaseUOM || p.IssueUOM, RequestID: data.requestId || "", Status: "ORDERED",
    Actor: actor, Notes: data.notes || "", DeliveryLocationID: deliveryLocationId, BatchID: id,
  });
  if (data.requestId) await updateRow(token, "REQUESTS", "RequestID", String(data.requestId), { Status: "ORDERED" });
  await auditWrite(token, actor, "order.create", id, data);
  return { orderId: id, deliveryLocationId };
}

/** One vendor, several products. Does not change stock. Ported 1:1 from Operations.gs processOrderCreateLines. */
async function handleOrderCreateLines(token: string, actor: string, ctx: Ctx, data: Record<string, unknown>) {
  if (data.requestId) throw new Error("VALIDATION: An order from a request is one product.");
  const lines = data.lines as Array<Record<string, unknown>> | undefined;
  if (!lines || !lines.length) throw new Error("VALIDATION: Add at least one product.");
  if (!ctx.lists.some((v) => v.Type === "VENDOR" && v.Code === data.vendorId && isTruthy(v.Active))) throw new Error("VALIDATION: Select a vendor.");
  const headOfficeId = getConfig(ctx, "HeadOfficeLocationID", "LOC-01");
  const deliveryLocationId = String(data.locationId || headOfficeId);
  if (deliveryLocationId !== headOfficeId && !ctx.lists.some((v) => v.Type === "LOCATION" && v.Code === deliveryLocationId && isTruthy(v.Active) && v.Extra)) {
    throw new Error("VALIDATION: Choose Head Office or an active studio to deliver to.");
  }
  const dispatchId = getConfig(ctx, "DispatchLocationID", "LOC-05");
  if (deliveryLocationId === dispatchId) throw new Error("VALIDATION: Dispatch is not a delivery destination.");
  const prepared = lines.map((line) => {
    const p = getProduct(ctx, line.productId);
    if (!p || !isTruthy(p.Active)) throw new Error("UNKNOWN_PRODUCT: Select an active product.");
    const qty = positiveQuantity(line.qty, p, false);
    const price = line.unitPrice === "" || line.unitPrice === undefined || line.unitPrice === null ? "" : Number(line.unitPrice);
    if (price !== "" && (!isFinite(price as number) || (price as number) < 0)) throw new Error("VALIDATION: Enter a valid unit price.");
    return { product: p, productId: line.productId, qty, notes: String(data.notes || "").trim(), unitPrice: price };
  });
  const date = dateToSerial(resolveTxnDate(data));
  let batchId = "";
  const ids: string[] = [];
  for (const line of prepared) {
    const id = nextId("PO");
    if (!batchId) batchId = id;
    await appendRow(token, "PURCHASE_ORDERS", {
      OrderID: id, Date: date, ProductID: line.productId, VendorID: data.vendorId, QtyOrdered: line.qty,
      UOM: line.product!.PurchaseUOM || line.product!.IssueUOM, RequestID: "", Status: "ORDERED", Actor: actor,
      Notes: line.notes, DeliveryLocationID: deliveryLocationId, UnitPrice: line.unitPrice, BatchID: batchId,
    });
    ids.push(id);
  }
  await auditWrite(token, actor, "order.create", ids[0], { count: ids.length, vendorId: data.vendorId });
  return { orderIds: ids, deliveryLocationId };
}

/** Ported 1:1 from Operations.gs processOrderCancel. */
async function handleOrderCancel(token: string, actor: string, ctx: Ctx, data: Record<string, unknown>) {
  if (!String(data.notes || "").trim()) throw new Error("VALIDATION: Give a cancellation reason.");
  const order = findRecord(ctx.purchaseOrders, "OrderID", data.orderId);
  if (!order || order.Status === "CANCELLED") throw new Error("VALIDATION: Order is not open.");
  const checkStale = (fresh: Row) => { if (fresh.Status === "CANCELLED") throw new Error("VALIDATION: Order is not open."); };
  await updateRow(token, "PURCHASE_ORDERS", "OrderID", String(data.orderId), { Status: "CANCELLED", Notes: `${order.Notes || ""} | Cancelled: ${data.notes}` }, checkStale);
  await auditWrite(token, actor, "order.cancel", String(data.orderId), data);
  return { status: "CANCELLED" };
}

/** Ported 1:1 from EntryChanges.gs processOrderEdit. */
async function handleOrderEdit(token: string, actor: string, ctx: Ctx, data: Record<string, unknown>) {
  entryChangeReason(data);
  const order = listPurchaseOrders(ctx).find((o) => o.orderId === data.orderId);
  if (!order || order.status === "CANCELLED") throw new Error("VALIDATION: Select an active purchase order.");
  const expected = data.expected as Record<string, unknown> | undefined;
  const staleAgainst = (qty: unknown, vendorId: unknown, notes: unknown, date: unknown, unitPrice: unknown) => {
    if (!expected) return true;
    return Number(expected.qty) !== Number(qty) || expected.vendorId !== vendorId ||
      String(expected.notes || "") !== String(notes || "") ||
      new Date(String(expected.date)).getTime() !== new Date(date as string | number).getTime() ||
      (expected.unitPrice !== undefined && Number(expected.unitPrice || 0) !== Number(unitPrice || 0));
  };
  if (staleAgainst(order.qty, order.vendorId, order.notes, order.date, order.unitPrice)) throw new Error("STALE_ENTRY: This order changed. Refresh before editing.");
  const product = getProduct(ctx, order.productId);
  const qty = positiveQuantity(data.qty, product, false);
  if (qty < order.received) throw new Error("VALIDATION: Ordered quantity cannot be less than the quantity already received. Edit the receipt first.");
  const vendor = String(data.vendorId || "");
  if (!ctx.lists.some((v) => v.Type === "VENDOR" && v.Code === vendor && isTruthy(v.Active))) throw new Error("VALIDATION: Select an active vendor.");
  if (order.received > 0 && vendor !== order.vendorId) throw new Error("VALIDATION: A received order must keep its vendor. Correct its receipts first.");
  const date = resolveTxnDate(data);
  const notes = data.notes == null ? String(order.notes || "") : String(data.notes).trim();
  const changes: Record<string, unknown> = { QtyOrdered: qty, VendorID: vendor, Date: dateToSerial(date), Notes: notes };
  if (Object.prototype.hasOwnProperty.call(data, "unitPrice")) {
    const price = data.unitPrice === "" ? "" : Number(data.unitPrice);
    if (price !== "" && (!isFinite(price) || price < 0)) throw new Error("VALIDATION: Enter a valid unit price.");
    changes.UnitPrice = price;
  }
  const checkStale = (fresh: Row) => {
    if (staleAgainst(fresh.QtyOrdered, fresh.VendorID, fresh.Notes, serialToDate(fresh.Date).toISOString(), fresh.UnitPrice)) {
      throw new Error("STALE_ENTRY: This order changed. Refresh before editing.");
    }
  };
  await updateRow(token, "PURCHASE_ORDERS", "OrderID", String(order.orderId), changes, checkStale);
  await auditWrite(token, actor, "order.edit", String(order.orderId), { before: order, qty, vendorId: vendor, date, reason: data.reason });
  return { orderId: order.orderId };
}

/** Ported 1:1 from EntryChanges.gs processOrderDelete -- delegates to order.cancel, same as the source (no separate audit entry). */
async function handleOrderDelete(token: string, actor: string, ctx: Ctx, data: Record<string, unknown>) {
  const reason = entryChangeReason(data);
  const order = listPurchaseOrders(ctx).find((o) => o.orderId === data.orderId);
  if (!order || order.status === "CANCELLED") throw new Error("VALIDATION: This order is already deleted or cancelled.");
  if (order.received > 0) throw new Error("VALIDATION: Delete or correct the receipts before deleting a received order.");
  return handleOrderCancel(token, actor, ctx, { orderId: data.orderId, notes: `Deleted: ${reason}` });
}

/** Row -> the shared MovementHistory shape, just enough for historyKey() to group an invoice. */
function toHistoryRow(r: Row): MovementHistory {
  return {
    txnId: String(r.TxnID), date: serialToIso(r.Date), productId: String(r.ProductID), qty: Number(r.Qty), uom: String(r.UOM),
    type: String(r.Type), locationId: String(r.LocationID), personId: String(r.PersonID || ""), status: String(r.Status),
    notes: String(r.Notes || ""), vendorId: String(r.VendorID || ""), invoiceNo: String(r.InvoiceNo || ""), receiptId: String(r.ReceiptID || ""),
    poRef: String(r.PORef || ""), billPhotoUrl: String(r.BillPhotoURL || ""),
    amount: r.Amount === "" || r.Amount == null ? null : Number(r.Amount), gstAmount: r.GSTAmount === "" || r.GSTAmount == null ? null : Number(r.GSTAmount),
  };
}

function availableBalance(ctx: Ctx, productId: unknown, locationId: unknown): number {
  return computeBalanceFromRows(ctx.ledger, productId, String(locationId)) - computePendingHandoverOutFromRows(ctx.ledger, productId, String(locationId));
}

/**
 * Ported from EntryChanges.gs processReceiptChange, with one deliberate ordering change:
 * Apps Script voids the originals and appends the replacements in a single atomic range
 * write (impossible here -- the Sheets API has no multi-row transaction). This version
 * appends the replacements FIRST and voids the originals LAST, so a mid-sequence failure
 * leaves temporarily-duplicated stock (safe to spot and void by hand) instead of silently
 * missing stock. Each void re-verifies the row isn't already VOID immediately before
 * writing, so a half-finished retry fails loudly (STALE_ENTRY) rather than double-voiding.
 */
async function handleReceiptChange(token: string, actor: string, ctx: Ctx, data: Record<string, unknown>, deleting: boolean) {
  const reason = entryChangeReason(data);
  const txnIds = data.txnIds as string[] | undefined;
  if (!Array.isArray(txnIds) || !txnIds.length || new Set(txnIds).size !== txnIds.length) throw new Error("VALIDATION: Select a receipt.");
  const selected = ctx.ledger.filter((r) => txnIds.includes(String(r.TxnID)));
  if (selected.length !== txnIds.length || selected.some((r) => r.Type !== "RECEIPT" || r.Status === "VOID" || Number(r.Direction) !== 1)) {
    throw new Error("STALE_ENTRY: This receipt changed or was deleted. Refresh history.");
  }
  const groupKey = historyKey(toHistoryRow(selected[0]));
  if (selected.some((r) => historyKey(toHistoryRow(r)) !== groupKey) || ctx.ledger.filter((r) => historyKey(toHistoryRow(r)) === groupKey).length !== selected.length) {
    throw new Error("VALIDATION: Select the complete invoice. Refresh history.");
  }
  const date = deleting ? null : dateToSerial(resolveTxnDate(data));
  const vendor = String(data.vendorId || "");
  if (!deleting && !ctx.lists.some((v) => v.Type === "VENDOR" && v.Code === vendor && isTruthy(v.Active))) throw new Error("VALIDATION: Select an active vendor.");
  const lines = data.lines as Array<Record<string, unknown>> | undefined;
  if (!deleting && (!Array.isArray(lines) || lines.length !== selected.length || new Set(lines.map((l) => l.txnId)).size !== selected.length)) {
    throw new Error("VALIDATION: Include each original receipt line exactly once.");
  }

  const deltas: Record<string, { productId: unknown; locationId: unknown; qty: number }> = {};
  const oldByOrder: Record<string, number> = {}, newByOrder: Record<string, number> = {};
  const replacements: Record<string, unknown>[] = [];
  const receiptId = nextId("RCPT");

  for (const row of selected) {
    const stockKey = JSON.stringify([row.ProductID, row.LocationID]);
    if (!deltas[stockKey]) deltas[stockKey] = { productId: row.ProductID, locationId: row.LocationID, qty: 0 };
    deltas[stockKey].qty -= Number(row.QtyBase);
    if (row.PORef) oldByOrder[String(row.PORef)] = (oldByOrder[String(row.PORef)] || 0) + Number(row.Qty);
    if (deleting) continue;
    const line = lines!.find((l) => l.txnId === row.TxnID);
    if (!line) throw new Error("VALIDATION: Original receipt line is missing.");
    const qty = Number(line.qty);
    const amount = line.amount === "" || line.amount == null ? "" : Number(line.amount);
    const gst = line.gstAmount === "" || line.gstAmount == null ? "" : Number(line.gstAmount);
    if (!isFinite(qty) || qty < 0 || (row.UOM === "PCS" && Math.floor(qty) !== qty)) throw new Error("VALIDATION: Enter a valid received quantity.");
    if ((amount !== "" && (!isFinite(amount) || amount < 0)) || (gst !== "" && (!isFinite(gst) || gst < 0))) throw new Error("VALIDATION: Amount and GST must be zero or greater.");
    if (qty === 0) continue;
    if (!(Number(row.Qty) > 0) || !(Number(row.QtyBase) > 0)) throw new Error("VALIDATION: Historical units need administrator review.");
    const qtyBase = (qty * Number(row.QtyBase)) / Number(row.Qty);
    deltas[stockKey].qty += qtyBase;
    if (row.PORef) newByOrder[String(row.PORef)] = (newByOrder[String(row.PORef)] || 0) + qty;
    replacements.push({
      ...row, TxnID: nextId("TXN"), ReceiptID: receiptId, Date: date, VendorID: vendor,
      InvoiceNo: String(data.invoiceNo || "").trim(), Qty: qty, QtyBase: qtyBase, Amount: amount, GSTAmount: gst,
      GSTPercent: amount !== "" && Number(amount) > 0 && gst !== "" ? (Number(gst) / Number(amount)) * 100 : "",
      Actor: actor, Status: "RECEIVED", Notes: `${String(data.notes || "").trim()} | Edited from ${row.TxnID}: ${reason}`,
    });
  }
  if (!deleting && !replacements.length) throw new Error("VALIDATION: Keep at least one received product, or use Delete receipt.");
  for (const delta of Object.values(deltas)) {
    if (availableBalance(ctx, delta.productId, delta.locationId) + delta.qty < -0.000001) {
      throw new Error("INSUFFICIENT_STOCK: This stock has been issued or reserved. Return or correct those movements before reducing this receipt.");
    }
  }
  if (!deleting) {
    const orders = listPurchaseOrders(ctx);
    for (const id of Object.keys(newByOrder)) {
      const order = orders.find((o) => o.orderId === id);
      if (!order || order.vendorId !== vendor) throw new Error("VALIDATION: The receipt vendor must match its purchase order.");
      if (order.received - (oldByOrder[id] || 0) + newByOrder[id] > order.qty + 0.000001) throw new Error("VALIDATION: Received quantity exceeds the purchase order. Edit the order first.");
    }
  }

  // Replacements first, voids last (see function doc) -- a mid-sequence failure over-counts stock, never under-counts it.
  for (const replacement of replacements) await appendRow(token, "LEDGER", replacement);
  for (const row of selected) {
    const suffix = ` | ${deleting ? "Deleted" : "Replaced"} by ${actor}: ${reason}`;
    await updateRow(token, "LEDGER", "TxnID", String(row.TxnID), { Status: "VOID", Notes: `${String(row.Notes || "")}${suffix}` }, (fresh) => {
      if (String(fresh.Status) === "VOID") throw new Error("STALE_ENTRY: This receipt changed or was deleted. Refresh history.");
    });
  }

  await auditWrite(token, actor, deleting ? "receipt.delete" : "receipt.edit", String(selected[0].TxnID), { originalTxnIds: txnIds, replacementTxnIds: replacements.map((r) => r.TxnID), reason });
  return { deleted: deleting, receiptId, txnIds: replacements.map((r) => r.TxnID) };
}

/** Ported 1:1 from Ledger.gs processPurchaseRequest / processPurchaseRequestLines. */
async function handlePurchaseRequest(token: string, actor: string, ctx: Ctx, data: Record<string, unknown>): Promise<unknown> {
  if (data.lines) return handlePurchaseRequestLines(token, actor, ctx, data);
  const newProductName = String(data.newProductName || "").trim();
  const requestSource = String(data.source || "APP").trim().toUpperCase();
  if (!["APP", "WHATSAPP", "CALL"].includes(requestSource)) throw new Error("VALIDATION: Request source must be App, WhatsApp or Call.");
  if (!String(data.requestedByUserId || "").trim()) throw new Error("VALIDATION: Record who requested the product.");
  if (String(data.notes || "").trim().length < 3) throw new Error("VALIDATION: Add a short reason for the request.");
  const qty = Number(data.qty) || 0;
  if (qty <= 0) throw new Error("VALIDATION: Quantity must be greater than zero.");
  let product: Row | null = null;
  if (data.productId) {
    product = getProduct(ctx, data.productId);
    if (!product) throw new Error(`UNKNOWN_PRODUCT: ${data.productId} is not in PRODUCTS.`);
  } else if (!newProductName) {
    throw new Error("VALIDATION: No product selected.");
  }
  const estValue = Number(data.estimatedValue) || (product ? qty * (Number(product.Cost) || 0) : 0);
  const threshold = getConfigNumber(ctx, "ApprovalThreshold", 5000);
  const terminalStatus = product ? "OPEN" : "NEW_PRODUCT";
  const requesterRole = appRole((getUser(ctx, actor) || {}).Role);
  let status: string, approvedBy: string;
  if (requesterRole === "ProductDistributor") {
    status = "PENDING_APPROVAL"; approvedBy = "";
  } else {
    const needsApproval = estValue >= threshold;
    approvedBy = String(data.approvedBy || "").trim();
    if (needsApproval && !approvedBy) throw new Error(`VALIDATION: This is over the ₹${threshold} threshold — record who approved it before logging.`);
    status = terminalStatus;
  }
  const requestId = nextId("PR");
  const now = new Date();
  await appendRow(token, "REQUESTS", {
    RequestID: requestId, Date: dateToSerial(now), ProductID: data.productId || "", NewProductName: newProductName,
    Qty: qty, RequestedBy: data.requestedByUserId || "", Urgency: data.urgency || "Normal", EstValue: estValue,
    Status: status, ApprovedBy: approvedBy, ApprovedAt: approvedBy ? dateToSerial(now) : "", Actor: actor,
    Notes: data.notes || "", Source: requestSource,
  });
  await auditWrite(token, actor, "purchase.request", requestId, { productId: data.productId || "", newProductName, qty, estValue, approvedBy, status, source: requestSource });
  return { requestId, status, estValue, threshold, approvedBy };
}

/** Several catalogue products, one reason. Does not change stock. Ported 1:1 from Ledger.gs processPurchaseRequestLines. */
async function handlePurchaseRequestLines(token: string, actor: string, ctx: Ctx, data: Record<string, unknown>) {
  if (String(data.newProductName || "").trim()) throw new Error("VALIDATION: A product that is not in the list yet is its own request.");
  const lines = data.lines as Array<Record<string, unknown>> | undefined;
  if (!lines || !lines.length) throw new Error("VALIDATION: Add at least one product.");
  if (!String(data.requestedByUserId || "").trim()) throw new Error("VALIDATION: Record who requested the product.");
  if (String(data.notes || "").trim().length < 3) throw new Error("VALIDATION: Add a short reason for the request.");
  const requestSource = String(data.source || "APP").trim().toUpperCase();
  if (!["APP", "WHATSAPP", "CALL"].includes(requestSource)) throw new Error("VALIDATION: Request source must be App, WhatsApp or Call.");

  const seen: Record<string, boolean> = {};
  const prepared = lines.map((line) => {
    if (!line.productId) throw new Error("VALIDATION: No product selected.");
    if (seen[String(line.productId)]) throw new Error("VALIDATION: That product is already on this request. Increase its quantity.");
    seen[String(line.productId)] = true;
    const product = getProduct(ctx, line.productId);
    if (!product || !isTruthy(product.Active)) throw new Error("UNKNOWN_PRODUCT: Select an active product.");
    const qty = positiveQuantity(line.qty, product, false);
    const est = qty * (Number(product.Cost) || 0);
    return { productId: line.productId, qty, est };
  });
  const totalEst = Number(data.estimatedValue) || prepared.reduce((sum, line) => sum + line.est, 0);
  const threshold = getConfigNumber(ctx, "ApprovalThreshold", 5000);
  const requesterRole = appRole((getUser(ctx, actor) || {}).Role);
  let approvedBy = "";
  let status: string;
  if (requesterRole === "ProductDistributor") {
    status = "PENDING_APPROVAL";
  } else {
    approvedBy = String(data.approvedBy || "").trim();
    if (totalEst >= threshold && !approvedBy) throw new Error(`VALIDATION: This is over the ₹${threshold} threshold — record who approved it before logging.`);
    status = "OPEN";
  }
  const now = new Date();
  const ids: string[] = [];
  for (const line of prepared) {
    const requestId = nextId("PR");
    await appendRow(token, "REQUESTS", {
      RequestID: requestId, Date: dateToSerial(now), ProductID: line.productId, NewProductName: "",
      Qty: line.qty, RequestedBy: data.requestedByUserId || "", Urgency: data.urgency || "Normal",
      EstValue: line.est, Status: status, ApprovedBy: approvedBy, ApprovedAt: approvedBy ? dateToSerial(now) : "",
      Actor: actor, Notes: data.notes || "", Source: requestSource,
    });
    ids.push(requestId);
  }
  await auditWrite(token, actor, "purchase.request", ids[0], { count: ids.length, estValue: totalEst, status });
  return { requestIds: ids, status, estValue: totalEst, threshold, approvedBy };
}

/** Ported 1:1 from Ledger.gs processDecidePurchaseRequest. */
async function handleDecidePurchaseRequest(token: string, actor: string, ctx: Ctx, data: Record<string, unknown>) {
  const requestId = String(data.requestId || "").trim();
  const decision = String(data.decision || "").trim().toUpperCase();
  if (!requestId) throw new Error("VALIDATION: No request selected.");
  if (decision !== "APPROVE" && decision !== "REJECT") throw new Error("VALIDATION: Decision must be Approve or Reject.");
  const current = findRecord(ctx.requests, "RequestID", requestId);
  if (!current) throw new Error(`NOT_FOUND: No request ${requestId}.`);
  if (String(current.Status).trim() !== "PENDING_APPROVAL") throw new Error(`VALIDATION: ${requestId} is ${current.Status}, not awaiting approval.`);
  const newStatus = decision === "APPROVE" ? (current.ProductID ? "OPEN" : "NEW_PRODUCT") : "REJECTED";
  const changes: Record<string, unknown> = { Status: newStatus, ApprovedBy: actor, ApprovedAt: dateToSerial(new Date()) };
  if (data.notes) {
    const prefix = current.Notes ? `${current.Notes} | ` : "";
    changes.Notes = `${prefix}Satvik: ${data.notes}`;
  }
  const checkPending = (fresh: Row) => {
    if (String(fresh.Status).trim() !== "PENDING_APPROVAL") throw new Error(`VALIDATION: ${requestId} is ${fresh.Status}, not awaiting approval.`);
  };
  await updateRow(token, "REQUESTS", "RequestID", requestId, changes, checkPending);
  await auditWrite(token, actor, `purchase.request.${decision.toLowerCase()}`, requestId, { decision, notes: data.notes || "" });
  return { requestId, status: newStatus };
}

/** Several requests at once. Ported 1:1 from Ledger.gs processDecidePurchaseRequestMany. */
async function handleDecidePurchaseRequestMany(token: string, actor: string, ctx: Ctx, data: Record<string, unknown>) {
  const ids = data.requestIds as string[] | undefined;
  if (!ids || !ids.length) throw new Error("VALIDATION: Select at least one request.");
  const decision = String(data.decision || "").trim().toUpperCase();
  if (decision !== "APPROVE" && decision !== "REJECT") throw new Error("VALIDATION: Decision must be Approve or Reject.");
  for (const requestId of ids) {
    const r = findRecord(ctx.requests, "RequestID", requestId);
    if (!r) throw new Error(`NOT_FOUND: No request ${requestId}.`);
    if (String(r.Status).trim() !== "PENDING_APPROVAL") throw new Error(`VALIDATION: ${requestId} is ${r.Status}, not awaiting approval -- someone may have just decided it. Refresh and try again.`);
  }
  const results = [];
  for (const requestId of ids) {
    results.push(await handleDecidePurchaseRequest(token, actor, ctx, { requestId, decision, notes: data.notes }));
  }
  await auditWrite(token, actor, `purchase.request.${decision.toLowerCase()}Many`, ids.join(","), { count: ids.length });
  return { results };
}

/** Records one physical opening count. Approval is deliberately separate. Ported 1:1 from Ledger.gs processOpeningStockSubmit. */
async function handleOpeningStockSubmit(token: string, actor: string, ctx: Ctx, data: Record<string, unknown>) {
  const product = getProduct(ctx, data.productId);
  if (!product) throw new Error("UNKNOWN_PRODUCT: Select a valid product.");
  const qty = positiveQuantity(data.qty, product, true);
  if (isNaN(qty) || qty < 0) throw new Error("VALIDATION: Opening quantity cannot be negative.");
  const locationId = openingLocationForActor(ctx, actor, data.locationId);
  if (ctx.ledger.some((r) => r.ProductID === data.productId && r.LocationID === locationId && r.Status !== "VOID")) {
    throw new Error("VALIDATION: Stock movement already exists. Use a recorded count correction.");
  }
  const existing = ctx.openingCounts.filter((row) => String(row.ProductID) === String(data.productId) && String(row.LocationID) === locationId && ["PENDING", "APPROVED"].includes(String(row.Status).toUpperCase()));
  if (existing.length) throw new Error("DUPLICATE: Opening stock for this product and location is already submitted.");
  const countId = nextId("OPN");
  await appendRow(token, "OPENING_COUNTS", {
    CountID: countId, Date: dateToSerial(new Date()), ProductID: data.productId, Qty: qty, LocationID: locationId,
    CountedBy: actor, Status: "PENDING", Notes: data.notes || "", QtyOrdered: data.qtyOrdered || "",
    QtyReceived: data.qtyReceived == null ? qty : Number(data.qtyReceived), CountUOM: data.countUom || product.IssueUOM || "",
  });
  await auditWrite(token, actor, "opening.submit", countId, { productId: data.productId, qty, locationId });
  return { countId, status: "PENDING", locationId };
}

/**
 * Admin approval posts exactly one OPENING row into the ledger. Ported from Ledger.gs
 * processOpeningStockApprove, with one ordering change like receipt.edit/delete: the LEDGER
 * append happens BEFORE the OPENING_COUNTS row is marked APPROVED, so a mid-sequence failure
 * leaves the count still PENDING (safely re-approvable -- the alreadyPosted check below is
 * exactly what makes a retry not double-post) rather than APPROVED with no ledger entry.
 */
async function handleOpeningStockApprove(token: string, actor: string, ctx: Ctx, data: Record<string, unknown>) {
  if (appRole((getUser(ctx, actor) || {}).Role) !== "Admin") throw new Error("FORBIDDEN: Only an administrator can approve opening stock.");
  const decision = String(data.decision || "").toUpperCase();
  if (decision !== "APPROVE" && decision !== "REJECT") throw new Error("VALIDATION: Decision must be APPROVE or REJECT.");
  const countId = String(data.countId || "");
  const row = findRecord(ctx.openingCounts, "CountID", countId);
  if (!row) throw new Error("NOT_FOUND: Opening count not found.");
  if (String(row.Status).toUpperCase() !== "PENDING") throw new Error("VALIDATION: This opening count has already been decided.");

  const status = decision === "APPROVE" ? "APPROVED" : "REJECTED";
  if (decision === "APPROVE") {
    const product = getProduct(ctx, row.ProductID);
    const alreadyPosted = ctx.ledger.some((l) => String(l.Type).toUpperCase() === "OPENING" && String(l.HandoverID) === countId);
    if (!alreadyPosted) {
      await appendRow(token, "LEDGER", {
        TxnID: nextId("TXN"), Date: dateToSerial(new Date()), Type: "OPENING", Direction: 1, ProductID: row.ProductID,
        Qty: Number(row.Qty) || 0, UOM: product ? product.IssueUOM : "", QtyBase: Number(row.Qty) || 0,
        LocationID: row.LocationID, HandoverID: countId, Actor: actor, Status: "POSTED", Notes: `Opening count ${countId}`,
      });
    }
  }
  const checkPending = (fresh: Row) => {
    if (String(fresh.Status).toUpperCase() !== "PENDING") throw new Error("VALIDATION: This opening count has already been decided.");
  };
  await updateRow(token, "OPENING_COUNTS", "CountID", countId, { Status: status, ReviewedBy: actor, ReviewedAt: dateToSerial(new Date()) }, checkPending);
  await auditWrite(token, actor, `opening.${decision.toLowerCase()}`, countId, { status });
  return { countId, status };
}

const BUSINESS_UNITS = ["AHL", "Alchemane", "Shared", "Hair Patch at Home"];

/** The business unit a category belongs to (LISTS.Extra); Shared when it has none. Ported 1:1 from Ledger.gs businessUnitOf. */
function businessUnitOf(ctx: Ctx, categoryId: unknown): string {
  const row = ctx.lists.find((v) => v.Type === "CATEGORY" && v.Code === categoryId);
  return row && BUSINESS_UNITS.includes(String(row.Extra)) ? String(row.Extra) : "Shared";
}

/**
 * Issues stock to one or more recipients. Ported 1:1 from Ledger.gs processStockIssue.
 * One append per split -- each is independently race-safe (appends never collide), and the
 * shared handoverId lets the splits be reconstructed as one event the same way the .gs version's
 * single appendRecords call did.
 */
async function handleStockIssue(token: string, actor: string, ctx: Ctx, data: Record<string, unknown>) {
  const actorRole = appRole((getUser(ctx, actor) || {}).Role);
  const expectedLocation = actorLocation(ctx, actor);
  const locationId = String(data.fromLocationId || expectedLocation);
  if (actorRole !== "Admin" && locationId !== expectedLocation) throw new Error("FORBIDDEN: You can issue only from your own stock location.");
  if (!data.productId) throw new Error("VALIDATION: No product selected.");
  const splits = data.splits as Array<Record<string, unknown>> | undefined;
  if (!splits || !splits.length) throw new Error("VALIDATION: No allocation given.");
  const product = getProduct(ctx, data.productId);
  if (!product) throw new Error(`UNKNOWN_PRODUCT: ${data.productId} is not in PRODUCTS.`);

  const balance = availableBalance(ctx, data.productId, locationId);
  let total = 0;
  for (const s of splits) {
    const splitQty = positiveQuantity(s.qty, product, false);
    if (splitQty <= 0) throw new Error("VALIDATION: Every split needs a quantity above zero.");
    if (!s.categoryId) throw new Error("VALIDATION: Every split needs a service category.");
    if (s.businessUnit && !BUSINESS_UNITS.includes(String(s.businessUnit))) throw new Error("VALIDATION: Choose AHL, Alchemane, Shared or Hair Patch at Home.");
    if (!s.recipientUserId) throw new Error("VALIDATION: Every split needs a technician.");
    if (!ctx.people.some((r) => r.UserID === s.recipientUserId && isTruthy(r.Active))) throw new Error("VALIDATION: Select an active recipient.");
    total += splitQty;
  }
  if (total <= 0) throw new Error("VALIDATION: Quantity must be greater than zero.");
  if (total > balance) throw new Error(`INSUFFICIENT_STOCK: ${balance} ${product.IssueUOM} on hand at ${locationId}, tried to issue ${total}.`);

  const handoverId = nextId("HND");
  const now = dateToSerial(resolveTxnDate(data));
  for (const split of splits) {
    const qty = Number(split.qty) || 0;
    await appendRow(token, "LEDGER", {
      TxnID: nextId("TXN"), Date: now, Type: "ISSUE", Direction: -1, ProductID: data.productId, Qty: qty,
      UOM: product.IssueUOM, QtyBase: qty, LocationID: locationId, CategoryID: split.categoryId || "",
      BusinessUnit: split.businessUnit || businessUnitOf(ctx, split.categoryId), PersonID: split.recipientUserId || "",
      HandoverID: handoverId, Amount: qty * (Number(product.Cost) || 0), Actor: actor, Status: "ISSUED", Notes: split.notes || "",
    });
  }
  await auditWrite(token, actor, "stock.issue", handoverId, { productId: data.productId, locationId, total, splits: splits.length });
  return { handoverId, newBalance: balance - total, uom: product.IssueUOM };
}

/** Ported 1:1 from Ledger.gs processRetailSale. */
async function handleRetailSale(token: string, actor: string, ctx: Ctx, data: Record<string, unknown>) {
  const actorRole = appRole((getUser(ctx, actor) || {}).Role);
  const expectedLocation = actorLocation(ctx, actor);
  const locationId = String(data.fromLocationId || expectedLocation);
  if (actorRole !== "Admin" && locationId !== expectedLocation) throw new Error("FORBIDDEN: You can sell only from your own stock location.");
  if (!data.productId) throw new Error("VALIDATION: No product selected.");
  const product = getProduct(ctx, data.productId);
  if (!product) throw new Error(`UNKNOWN_PRODUCT: ${data.productId} is not in PRODUCTS.`);
  if (!["Retail", "Both"].includes(String(product.ProductType))) throw new Error("VALIDATION: This product is not marked for retail sale.");

  const qty = positiveQuantity(data.qty, product, false);
  const qtyBase = qty * (Number(product.ConvFactor) || 1);
  const clientName = String(data.clientName || "").trim();
  const clientPhone = String(data.clientPhone || "").trim();
  const techId = String(data.recipientUserId || "").trim();
  if (!clientName) throw new Error("VALIDATION: Record who bought this.");
  if (!techId || !ctx.people.some((r) => r.UserID === techId && isTruthy(r.Active))) throw new Error("VALIDATION: Select a technician.");

  const balance = availableBalance(ctx, data.productId, locationId);
  if (qtyBase > balance) throw new Error(`INSUFFICIENT_STOCK: ${balance} ${product.IssueUOM} on hand at ${locationId}, tried to sell ${qtyBase}.`);

  const txnId = nextId("TXN");
  const notesParts = [`Client: ${clientName}`];
  if (clientPhone) notesParts.push(`Phone: ${clientPhone}`);
  if (data.refNo) notesParts.push(`Ref: ${String(data.refNo).trim()}`);
  if (data.notes) notesParts.push(String(data.notes).trim());
  await appendRow(token, "LEDGER", {
    TxnID: txnId, Date: dateToSerial(new Date()), Type: "RETAIL_SALE", Direction: -1, ProductID: data.productId, Qty: qty,
    UOM: product.PurchaseUOM || product.IssueUOM, QtyBase: qtyBase, LocationID: locationId, PersonID: techId,
    Amount: qtyBase * (Number(product.Cost) || 0), Actor: actor, Status: "SOLD", Notes: notesParts.join(" | "),
  });
  await auditWrite(token, actor, "stock.retailSale", txnId, { productId: data.productId, qty, clientName });
  return { txnId, newBalance: balance - qtyBase, uom: product.IssueUOM };
}

/** Ported 1:1 from Operations.gs processStockAdjustment. */
async function handleStockAdjustment(token: string, actor: string, ctx: Ctx, data: Record<string, unknown>) {
  const role = appRole((getUser(ctx, actor) || {}).Role);
  const product = getProduct(ctx, data.productId);
  if (!product || !isTruthy(product.Active)) throw new Error("UNKNOWN_PRODUCT: Select an active product.");
  const loc = openingLocationForActor(ctx, actor, data.locationId);
  const qty = positiveQuantity(data.qty, product, false);
  if (!String(data.notes || "").trim()) throw new Error("VALIDATION: Record the reason.");
  const kind = String(data.kind || "");
  if (!["RETURN", "DAMAGE", "COUNT_IN", "COUNT_OUT"].includes(kind)) throw new Error("VALIDATION: Select a correction type.");
  if (/^COUNT_/.test(kind) && role !== "Admin") throw new Error("FORBIDDEN: Only management can adjust a physical count.");
  const direction = kind === "RETURN" || kind === "COUNT_IN" ? 1 : -1;
  if (direction < 0 && qty > availableBalance(ctx, data.productId, loc)) throw new Error("INSUFFICIENT_STOCK: Correction exceeds available stock.");
  if (kind === "RETURN") {
    const source = findRecord(ctx.ledger, "TxnID", data.sourceTxnId);
    if (!source || source.Type !== "ISSUE" || source.Status === "VOID" || source.ProductID !== data.productId || source.LocationID !== loc) {
      throw new Error("VALIDATION: Select the original issue from this location.");
    }
    const returned = ctx.ledger.filter((l) => l.Type === "RETURN" && l.PORef === data.sourceTxnId && l.Status !== "VOID").reduce((s, l) => s + Number(l.QtyBase), 0);
    if (returned + qty > Number(source.QtyBase)) throw new Error("VALIDATION: Return exceeds the quantity originally issued.");
  }
  const id = nextId("TXN");
  await appendRow(token, "LEDGER", {
    TxnID: id, Date: dateToSerial(resolveTxnDate(data)), Type: kind, Direction: direction, ProductID: data.productId,
    Qty: qty, UOM: product.IssueUOM, QtyBase: qty, LocationID: loc, PORef: data.sourceTxnId || "", Actor: actor, Status: "POSTED", Notes: data.notes,
  });
  await auditWrite(token, actor, "stock.adjust", id, data);
  return { txnId: id };
}

// ---------------------------------------------------------------- entry point

export const DIRECT_WRITE_ACTIONS = ["list.add", "product.create", "product.setVendor", "product.editUnit", "product.delete", "product.restore", "order.create", "order.cancel", "order.edit", "order.delete", "receipt.edit", "receipt.delete", "purchase.request", "purchase.approve", "purchase.approveMany", "opening.submit", "opening.approve", "stock.issue", "stock.retailSale", "stock.adjust"] as const;
export type DirectWriteAction = (typeof DIRECT_WRITE_ACTIONS)[number];

const WRITE_ROLES: Record<DirectWriteAction, string[]> = {
  "list.add": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "product.create": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "product.setVendor": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "product.editUnit": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "product.delete": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "product.restore": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "order.create": ["PurchaseCoordinator", "Admin"],
  "order.cancel": ["PurchaseCoordinator", "Admin"],
  "order.edit": ["PurchaseCoordinator", "Admin"],
  "order.delete": ["PurchaseCoordinator", "Admin"],
  "receipt.edit": ["PurchaseCoordinator", "Admin"],
  "receipt.delete": ["PurchaseCoordinator", "Admin"],
  "purchase.request": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "purchase.approve": ["PurchaseCoordinator", "Admin"],
  "purchase.approveMany": ["PurchaseCoordinator", "Admin"],
  "opening.submit": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "opening.approve": ["Admin"],
  "stock.issue": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "stock.retailSale": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  "stock.adjust": ["PurchaseCoordinator", "ProductDistributor", "Admin"],
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
      case "order.create": result = await handleOrderCreate(token, actor, ctx, data); break;
      case "order.cancel": result = await handleOrderCancel(token, actor, ctx, data); break;
      case "order.edit": result = await handleOrderEdit(token, actor, ctx, data); break;
      case "order.delete": result = await handleOrderDelete(token, actor, ctx, data); break;
      case "receipt.edit": result = await handleReceiptChange(token, actor, ctx, data, false); break;
      case "receipt.delete": result = await handleReceiptChange(token, actor, ctx, data, true); break;
      case "purchase.request": result = await handlePurchaseRequest(token, actor, ctx, data); break;
      case "purchase.approve": result = await handleDecidePurchaseRequest(token, actor, ctx, data); break;
      case "purchase.approveMany": result = await handleDecidePurchaseRequestMany(token, actor, ctx, data); break;
      case "opening.submit": result = await handleOpeningStockSubmit(token, actor, ctx, data); break;
      case "opening.approve": result = await handleOpeningStockApprove(token, actor, ctx, data); break;
      case "stock.issue": result = await handleStockIssue(token, actor, ctx, data); break;
      case "stock.retailSale": result = await handleRetailSale(token, actor, ctx, data); break;
      case "stock.adjust": result = await handleStockAdjustment(token, actor, ctx, data); break;
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
