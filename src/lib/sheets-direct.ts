/**
 * Fast path for READ-ONLY actions: talks to Google Sheets directly with the service
 * account, skipping the Apps Script web app entirely. Every write still goes through
 * Apps Script (apps-script/*.gs) for its locking and validation -- this file only
 * reads, and its output must stay byte-identical in shape to what Apps Script already
 * returns for the same action (ported from Operations.gs / Ledger.gs / Validation.gs).
 *
 * SERVER ONLY. GOOGLE_SERVICE_ACCOUNT_KEY must never reach the client.
 */
import { createSign } from "node:crypto";

type Row = Record<string, string | number>;
interface Ctx {
  products: Row[]; people: Row[]; lists: Row[]; ledger: Row[];
  purchaseOrders: Row[]; requests: Row[]; openingCounts: Row[];
  configCache: Record<string, string> | null;
}

function requireEnv(name: "GOOGLE_SERVICE_ACCOUNT_KEY" | "GOOGLE_SHEET_ID"): string {
  const v = process.env[name];
  if (!v) throw new Error(`DIRECT_READ_UNAVAILABLE: Missing ${name}.`);
  return v;
}

// ---------------------------------------------------------------- auth

let cachedToken: { token: string; exp: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp > now + 60) return cachedToken.token;

  const key = JSON.parse(Buffer.from(requireEnv("GOOGLE_SERVICE_ACCOUNT_KEY"), "base64").toString("utf8"));
  const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
    iss: key.client_email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000,
  })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error("DIRECT_READ_UNAVAILABLE: Service account auth failed.");
  cachedToken = { token: json.access_token, exp: now + (Number(json.expires_in) || 3000) };
  return cachedToken.token;
}

// ---------------------------------------------------------------- sheet I/O

const TABS = ["PRODUCTS", "PEOPLE", "LISTS", "LEDGER", "PURCHASE_ORDERS", "REQUESTS", "OPENING_COUNTS"] as const;

function parseTable(values: unknown[][]): Row[] {
  if (!values.length) return [];
  const headers = (values[0] as unknown[]).map((h) => String(h ?? "").trim());
  return values.slice(1).map((r) => {
    const rec: Row = {};
    headers.forEach((h, i) => { if (h) rec[h] = (r[i] as string | number) ?? ""; });
    return rec;
  });
}

async function loadContext(): Promise<Ctx> {
  const sheetId = requireEnv("GOOGLE_SHEET_ID");
  const token = await getAccessToken();
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchGet`);
  TABS.forEach((t) => url.searchParams.append("ranges", `${t}!A1:AZ20000`));
  url.searchParams.set("valueRenderOption", "UNFORMATTED_VALUE");
  url.searchParams.set("dateTimeRenderOption", "SERIAL_NUMBER");

  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  const json = await res.json();
  if (!res.ok) throw new Error(`DIRECT_READ_UNAVAILABLE: Sheets API error: ${json.error?.message || res.status}`);

  const byTab: Record<string, Row[]> = {};
  TABS.forEach((t, i) => { byTab[t] = parseTable(json.valueRanges[i]?.values || []); });
  return {
    products: byTab.PRODUCTS, people: byTab.PEOPLE, lists: byTab.LISTS, ledger: byTab.LEDGER,
    purchaseOrders: byTab.PURCHASE_ORDERS, requests: byTab.REQUESTS, openingCounts: byTab.OPENING_COUNTS,
    configCache: null,
  };
}

// ---------------------------------------------------------------- small helpers, ported 1:1 from Validation.gs / Db.gs

function isTruthy(value: unknown): boolean {
  if (value === true) return true;
  if (value === false || value === "" || value === null || value === undefined) return false;
  const s = String(value).trim().toLowerCase();
  return s === "true" || s === "yes" || s === "y" || s === "1";
}
function appRole(value: unknown): string {
  const role = String(value ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
  if (role === "admin" || role === "management" || role === "owner") return "Admin";
  if (role === "purchase" || role === "purchasecoordinator") return "PurchaseCoordinator";
  if (role === "distribution" || role === "productdistributor" || role === "distributor") return "ProductDistributor";
  return "";
}
function findRecord(rows: Row[], column: string, value: unknown): Row | null {
  const target = String(value).trim().toLowerCase();
  return rows.find((r) => String(r[column]).trim().toLowerCase() === target) || null;
}
function getUser(ctx: Ctx, actor: string): Row | null { return findRecord(ctx.people, "Email", actor); }
function getProduct(ctx: Ctx, productId: unknown): Row | null { return findRecord(ctx.products, "ProductID", productId); }
function getConfig(ctx: Ctx, key: string, fallback: string): string {
  if (!ctx.configCache) {
    ctx.configCache = {};
    ctx.lists.forEach((row) => { if (row.Type === "SETTING" && row.Code) ctx.configCache![String(row.Code).trim()] = String(row.Name); });
  }
  const v = ctx.configCache[key];
  return v === undefined || v === "" ? fallback : v;
}
function getConfigNumber(ctx: Ctx, key: string, fallback: number): number {
  const n = Number(getConfig(ctx, key, String(fallback)));
  return isNaN(n) ? fallback : n;
}

// Sheets' date serial (days since 1899-12-30) -> UTC ISO string. The spreadsheet's
// fixed Asia/Kolkata (+5:30, no DST) timezone is set in apps-script/appsscript.json.
const IST_OFFSET_MS = 330 * 60 * 1000;
function serialToDate(serial: unknown): Date {
  const n = Number(serial);
  return new Date(Math.round((n - 25569) * 86400000) - IST_OFFSET_MS);
}
function serialToIso(serial: unknown): string {
  if (serial === "" || serial === null || serial === undefined) return "";
  const n = Number(serial);
  return isFinite(n) ? serialToDate(n).toISOString() : "";
}
function istMonthString(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).formatToParts(d);
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
}

function actorLocation(ctx: Ctx, actor: string): string {
  const user = getUser(ctx, actor) || {};
  const ho = getConfig(ctx, "HeadOfficeLocationID", "LOC-01");
  if (appRole(user.Role) === "PurchaseCoordinator") return ho;
  const loc = String(user.LocationID || "").trim();
  const known = ctx.lists.some((v) => v.Type === "LOCATION" && v.Code === loc && isTruthy(v.Active) && v.Extra);
  return known && loc !== ho ? loc : getConfig(ctx, "SalonFloorLocationID", "LOC-02");
}
function openingLocationForActor(ctx: Ctx, actor: string): string {
  const role = appRole((getUser(ctx, actor) || {}).Role);
  if (role === "PurchaseCoordinator") return getConfig(ctx, "HeadOfficeLocationID", "LOC-01");
  if (role === "ProductDistributor") return actorLocation(ctx, actor);
  throw new Error("FORBIDDEN: Your account cannot submit an opening stock count.");
}

// ---------------------------------------------------------------- balances, ported 1:1 from Validation.gs

function computeBalanceFromRows(rows: Row[], productId: unknown, locationId: string): number {
  const wantAll = locationId === "ALL";
  let balance = 0;
  for (const row of rows) {
    if (String(row.ProductID).trim() !== String(productId).trim()) continue;
    if (!wantAll && String(row.LocationID).trim() !== String(locationId).trim()) continue;
    if (String(row.Status).trim().toUpperCase() === "VOID") continue;
    if (String(row.Type).trim().toUpperCase() === "HANDOVER" && String(row.Status).trim().toUpperCase() === "PENDING_CONFIRM") continue;
    let qty = Number(row.QtyBase);
    if (isNaN(qty) || qty === 0) qty = Number(row.Qty) || 0;
    balance += qty * (Number(row.Direction) || 0);
  }
  return balance;
}
function computePendingHandoverOutFromRows(rows: Row[], productId: unknown, locationId: string): number {
  return rows.reduce((sum, row) => {
    if (String(row.ProductID).trim() !== String(productId).trim()) return sum;
    if (String(row.LocationID).trim() !== String(locationId).trim()) return sum;
    if (String(row.Type).trim().toUpperCase() !== "HANDOVER") return sum;
    if (String(row.Status).trim().toUpperCase() !== "PENDING_CONFIRM") return sum;
    if (Number(row.Direction) !== -1) return sum;
    let qty = Number(row.QtyBase);
    if (isNaN(qty) || qty === 0) qty = Number(row.Qty) || 0;
    return sum + qty;
  }, 0);
}

// ---------------------------------------------------------------- read actions, ported 1:1 from Operations.gs / Ledger.gs

function getCatalogue(ctx: Ctx) {
  const lists = ctx.lists.filter((r) => isTruthy(r.Active));
  const list = (type: string) => lists.filter((r) => r.Type === type).map((r) => ({ id: r.Code, name: r.Name, unit: r.Extra || "", dot: "bg-chart-1" }));
  return {
    products: ctx.products.filter((r) => isTruthy(r.Active)).map((r) => ({
      id: r.ProductID, name: r.Name, categoryId: r.CategoryID, productType: r.ProductType || "Consumable",
      uom: r.IssueUOM, purchaseUom: r.PurchaseUOM, vendorId: r.VendorID || "", conversion: Number(r.ConvFactor) || 1,
      cost: Number(r.Cost) || 0, reorderLevel: Number(r.ReorderLevel) || 0, balance: null,
    })),
    people: ctx.people.filter((r) => isTruthy(r.Active)).map((r) => ({ id: r.UserID, name: r.Name, role: appRole(r.Role) || r.Role, locationId: r.LocationID })),
    categories: list("CATEGORY"), vendors: list("VENDOR"), locations: list("LOCATION"),
    headOfficeLocationId: getConfig(ctx, "HeadOfficeLocationID", "LOC-01"),
    salonFloorLocationId: getConfig(ctx, "SalonFloorLocationID", "LOC-02"),
    dispatchLocationId: getConfig(ctx, "DispatchLocationID", "LOC-05"),
    approvalThreshold: getConfigNumber(ctx, "ApprovalThreshold", 5000),
  };
}

function listPurchaseOrders(ctx: Ctx) {
  const ledger = ctx.ledger;
  return ctx.purchaseOrders.map((r) => {
    const received = ledger.reduce((sum, l) => (l.Type === "RECEIPT" && l.Status !== "VOID" && l.PORef === r.OrderID ? sum + Number(l.Qty) : sum), 0);
    const p = getProduct(ctx, r.ProductID);
    return {
      orderId: r.OrderID, date: serialToIso(r.Date), productId: r.ProductID, productName: p ? p.Name : r.ProductID,
      vendorId: r.VendorID, qty: Number(r.QtyOrdered), uom: r.UOM, received, remaining: Math.max(0, Number(r.QtyOrdered) - received),
      requestId: r.RequestID || "", status: r.Status === "CANCELLED" ? "CANCELLED" : received >= Number(r.QtyOrdered) ? "RECEIVED" : received > 0 ? "PARTIAL" : "ORDERED",
      notes: r.Notes || "",
    };
  }).reverse();
}

function listOpeningCounts(ctx: Ctx, actor: string) {
  const role = appRole((getUser(ctx, actor) || {}).Role);
  let rows = ctx.openingCounts;
  if (role !== "Admin") {
    const locationId = openingLocationForActor(ctx, actor);
    rows = rows.filter((row) => String(row.LocationID) === locationId);
  }
  return rows.map((row) => {
    const product = getProduct(ctx, row.ProductID);
    return {
      countId: row.CountID, date: serialToIso(row.Date), productId: row.ProductID,
      productName: product ? product.Name : row.ProductID, qty: Number(row.Qty) || 0,
      uom: product ? product.IssueUOM : "", locationId: row.LocationID,
      countedBy: row.CountedBy, status: row.Status, reviewedBy: row.ReviewedBy || "",
      notes: row.Notes || "", qtyOrdered: row.QtyOrdered === "" ? null : Number(row.QtyOrdered),
      qtyReceived: row.QtyReceived === "" ? Number(row.Qty) || 0 : Number(row.QtyReceived),
      countUom: row.CountUOM || (product ? product.IssueUOM : ""),
    };
  }).reverse();
}

function listPendingHandovers(ctx: Ctx, actor?: string) {
  let rows = ctx.ledger.filter((r) => r.Type === "HANDOVER" && Number(r.Direction) === 1 && String(r.Status).trim() === "PENDING_CONFIRM");
  const actorUser = actor ? getUser(ctx, actor) : null;
  if (actorUser && appRole(actorUser.Role) === "ProductDistributor") {
    rows = rows.filter((r) => !r.PersonID || String(r.PersonID) === String(actorUser.UserID));
  }
  return rows.map((r) => {
    const product = getProduct(ctx, r.ProductID);
    return { handoverId: r.HandoverID, productId: r.ProductID, productName: product ? product.Name : r.ProductID, qty: r.Qty, uom: r.UOM, toLocationId: r.LocationID, date: serialToIso(r.Date), actor: r.Actor, notes: r.Notes };
  });
}

function getDashboard(ctx: Ctx, actor: string) {
  const receivingLocationId = getConfig(ctx, "HeadOfficeLocationID", "LOC-01");
  const custodyLocationId = getConfig(ctx, "SalonFloorLocationID", "LOC-02");
  const products = ctx.products.filter((p) => isTruthy(p.Active));
  const ledgerRows = ctx.ledger;
  const stockLocations = ctx.lists.filter((v) => v.Type === "LOCATION" && isTruthy(v.Active) && v.Extra).map((v) => String(v.Code));

  const stock = products.map((p) => {
    const locationBalances: Record<string, number> = {};
    stockLocations.forEach((code) => {
      locationBalances[code] = computeBalanceFromRows(ledgerRows, p.ProductID, code) - computePendingHandoverOutFromRows(ledgerRows, p.ProductID, code);
    });
    const receiving = computeBalanceFromRows(ledgerRows, p.ProductID, receivingLocationId);
    const custody = computeBalanceFromRows(ledgerRows, p.ProductID, custodyLocationId);
    const pendingOut = computePendingHandoverOutFromRows(ledgerRows, p.ProductID, receivingLocationId);
    const pendingIn = ledgerRows.reduce((sum, row) => {
      if (String(row.ProductID).trim() !== String(p.ProductID).trim()) return sum;
      if (String(row.LocationID).trim() !== String(custodyLocationId).trim()) return sum;
      if (String(row.Type).trim().toUpperCase() !== "HANDOVER") return sum;
      if (String(row.Status).trim().toUpperCase() !== "PENDING_CONFIRM") return sum;
      if (Number(row.Direction) !== 1) return sum;
      let qty = Number(row.QtyBase); if (isNaN(qty) || qty === 0) qty = Number(row.Qty) || 0;
      return sum + qty;
    }, 0);
    const reorderLevel = Number(p.ReorderLevel) || 0;
    return {
      productId: p.ProductID, name: p.Name, categoryId: p.CategoryID, productType: p.ProductType || "", uom: p.IssueUOM,
      reorderLevel, receivingBalance: receiving, receivingAvailable: receiving - pendingOut, custodyBalance: custody,
      locationBalances, headOfficeBalance: receiving, headOfficeAvailable: receiving - pendingOut, salonFloorBalance: custody,
      pendingHandover: pendingIn, totalBalance: receiving + custody, lowStock: custody <= reorderLevel,
    };
  });

  const openRequests = ctx.requests
    .filter((r) => ["OPEN", "NEW_PRODUCT", "PENDING_APPROVAL"].includes(String(r.Status || "").toUpperCase()))
    .map((r) => {
      const product = r.ProductID ? getProduct(ctx, r.ProductID) : null;
      return { requestId: r.RequestID, date: serialToIso(r.Date), productId: r.ProductID || "", productName: product ? product.Name : (r.NewProductName || "(unnamed)"), isNewProduct: !r.ProductID, qty: r.Qty, requestedBy: r.RequestedBy, status: r.Status, estValue: r.EstValue, approvedBy: r.ApprovedBy, source: r.Source || "APP", notes: r.Notes };
    }).reverse();

  const recentActivity = ledgerRows.slice(Math.max(0, ledgerRows.length - 30)).reverse().map((r) => {
    const product = getProduct(ctx, r.ProductID);
    return { txnId: r.TxnID, date: serialToIso(r.Date), type: r.Type, direction: Number(r.Direction) || 0, productName: product ? product.Name : r.ProductID, qty: r.Qty, uom: r.UOM, locationId: r.LocationID, categoryId: r.CategoryID || "", personId: r.PersonID || "", vendorId: r.VendorID || "", actor: r.Actor, status: r.Status, notes: r.Notes || "" };
  });

  const vendorRates: Array<{ productId: unknown; productName: unknown; vendorId: unknown; rate: number; date: string }> = [];
  const seen: Record<string, boolean> = {};
  for (let i = ledgerRows.length - 1; i >= 0 && vendorRates.length < 50; i--) {
    const r = ledgerRows[i];
    if (String(r.Type).trim().toUpperCase() === "RECEIPT" && r.VendorID) {
      const key = r.ProductID + "_" + r.VendorID;
      if (!seen[key]) {
        seen[key] = true;
        const product = getProduct(ctx, r.ProductID);
        const qBase = Number(r.QtyBase) || Number(r.Qty);
        const amt = Number(r.Amount) || 0;
        vendorRates.push({ productId: r.ProductID, productName: product ? product.Name : r.ProductID, vendorId: r.VendorID, rate: qBase > 0 ? amt / qBase : amt, date: serialToIso(r.Date) });
      }
    }
  }

  return { stock, pendingHandovers: listPendingHandovers(ctx, actor), openRequests, recentActivity, vendorRates };
}

function getOperations(ctx: Ctx, actor: string) {
  return {
    myLocationId: actorLocation(ctx, actor),
    myUserId: (getUser(ctx, actor) || {}).UserID || "",
    catalogue: getCatalogue(ctx),
    dashboard: getDashboard(ctx, actor),
    orders: listPurchaseOrders(ctx),
    opening: listOpeningCounts(ctx, actor),
    history: ctx.ledger.slice(-500).reverse().map((r) => ({ txnId: r.TxnID, date: serialToIso(r.Date), productId: r.ProductID, qty: Number(r.Qty), uom: r.UOM, type: r.Type, locationId: r.LocationID, personId: r.PersonID, status: r.Status, notes: r.Notes || "" })),
  };
}

function getInventoryReport(ctx: Ctx, month?: string) {
  const m0 = month || istMonthString(new Date());
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m0)) throw new Error("VALIDATION: Choose a month.");
  const city: Record<string, string> = {}, cat: Record<string, { name: string; unit: string }> = {}, prod: Record<string, Row> = {}, issueUnit: Record<string, string> = {};
  ctx.lists.forEach((l) => { if (l.Type === "LOCATION" && l.Extra) city[String(l.Code)] = String(l.Extra); if (l.Type === "CATEGORY") cat[String(l.Code)] = { name: String(l.Name), unit: String(l.Extra || "") }; });
  ctx.products.forEach((p) => { prod[String(p.ProductID)] = p; });
  const ledger = ctx.ledger;
  const unitOf = (l: Row) => String(l.BusinessUnit || (cat[String(l.CategoryID)] || {}).unit || "");
  ledger.forEach((l) => { if (l.Type === "ISSUE") issueUnit[String(l.TxnID)] = unitOf(l); });
  const bucket = (u: string): "ahl" | "alc" | "hph" | "shared" => (u === "AHL" ? "ahl" : u === "Alchemane" || u === "ALC" ? "alc" : u === "Hair Patch at Home" ? "hph" : "shared");
  const handoverCities: Record<string, Record<string, boolean>> = {};
  ledger.forEach((l) => {
    if (l.Type !== "HANDOVER" || l.Status === "VOID" || l.Status === "PENDING_CONFIRM" || !city[String(l.LocationID)]) return;
    (handoverCities[String(l.HandoverID)] || (handoverCities[String(l.HandoverID)] = {}))[city[String(l.LocationID)]] = true;
  });
  const crossCity = (id: string) => Object.keys(handoverCities[id] || {}).length > 1;
  type Agg = { city: string; productId: unknown; opening: number; purchases: number; tin: number; tout: number; ahl: number; alc: number; shared: number; hph: number; retailSold: number; adjustments: number; closing: number };
  const out: Record<string, Agg> = {};
  ledger.forEach((l) => {
    if (l.Status === "VOID" || l.Status === "PENDING_CONFIRM" || !prod[String(l.ProductID)] || !city[String(l.LocationID)] || !l.Date) return;
    const m = istMonthString(serialToDate(l.Date));
    if (m > m0) return;
    const key = city[String(l.LocationID)] + "|" + l.ProductID;
    const r = out[key] || (out[key] = { city: city[String(l.LocationID)], productId: l.ProductID, opening: 0, purchases: 0, tin: 0, tout: 0, ahl: 0, alc: 0, shared: 0, hph: 0, retailSold: 0, adjustments: 0, closing: 0 });
    const q = (Number(l.QtyBase) || 0) * (Number(l.Direction) || 0);
    r.closing += q;
    if (m < m0 || l.Type === "OPENING") r.opening += q;
    else if (l.Type === "RECEIPT") r.purchases += q;
    else if (l.Type === "ISSUE") r[bucket(unitOf(l))] -= q;
    else if (l.Type === "RETURN") r[bucket(issueUnit[String(l.PORef)])] -= q;
    else if (l.Type === "HANDOVER") { if (crossCity(String(l.HandoverID))) { if (q > 0) r.tin += q; else r.tout -= q; } }
    else if (l.Type === "RETAIL_SALE") r.retailSold -= q;
    else r.adjustments += q;
  });
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const rows = Object.keys(out).map((k) => {
    const r = out[k], p = prod[String(r.productId)], c = cat[String(p.CategoryID)] || { name: "", unit: "" }, cost = Number(p.Cost) || 0;
    return { month: m0, type: p.ProductType || "Consumable", city: r.city, businessUnit: c.unit, category: c.name, productId: r.productId, product: p.Name, uom: p.IssueUOM, opening: round(r.opening), purchases: round(r.purchases), transferIn: round(r.tin), transferOut: round(r.tout), consumedAHL: round(r.ahl), consumedALC: round(r.alc), consumedShared: round(r.shared), consumedHairPatchHome: round(r.hph), retailSold: round(r.retailSold), adjustments: round(r.adjustments), closing: round(r.closing), costPerUnit: cost, closingValue: round(r.closing * cost) };
  }).filter((r) => r.opening || r.purchases || r.transferIn || r.transferOut || r.consumedAHL || r.consumedALC || r.consumedShared || r.consumedHairPatchHome || r.retailSold || r.adjustments || r.closing);
  rows.sort((a, b) => (a.city + a.category + a.product).localeCompare(b.city + b.category + b.product));
  return { month: m0, rows };
}

// ---------------------------------------------------------------- entry point

export const DIRECT_READ_ACTIONS = ["operations.read", "catalogue.read", "dashboard.read", "handover.list", "opening.list", "inventoryReport.read"] as const;
export type DirectReadAction = (typeof DIRECT_READ_ACTIONS)[number];

export async function readDirect(action: DirectReadAction, actor: string, data: Record<string, unknown>) {
  const ctx = await loadContext();
  const user = getUser(ctx, actor);
  if (!user || !isTruthy(user.Active)) throw new Error("FORBIDDEN: Your account could not be found or is inactive.");

  switch (action) {
    case "operations.read": return getOperations(ctx, actor);
    case "catalogue.read": return getCatalogue(ctx);
    case "dashboard.read": return getDashboard(ctx, actor);
    case "handover.list": return listPendingHandovers(ctx, actor);
    case "opening.list": return listOpeningCounts(ctx, actor);
    case "inventoryReport.read": return getInventoryReport(ctx, data?.month as string | undefined);
  }
}
