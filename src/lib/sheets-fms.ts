/**
 * Direct Google Sheets integration for the "Retail & Sale FMS" tracker -- a
 * SEPARATE spreadsheet (GOOGLE_FMS_SHEET_ID) from the main AHL Flow sheet, with
 * its own service-account auth. This is the external "Inventory_FMS" sheet used
 * for salon handover/billing reconciliation (toppers, strands, wigs): product
 * handed to a technician -> applied to a client -> bill tallied (with a proof
 * photo) -> investigated if short -> excess returned to inventory -> closed.
 *
 * Columns K, M, O, R, S, T, X, Y, Z, AA ("Handover Timestamp", "Applied
 * Timestamp", "Bill Tally", "Bill Proof Status", "Bill Tally Timestamp",
 * "Investigation Needed?", "Investigation/Return Timestamp", "Qty
 * Outstanding", "FINAL STATUS", "Closed Timestamp") are LIVE FORMULAS already
 * built into that sheet -- this file only ever writes the raw input columns
 * (Handover ID..Handover Check, Applied to Client?, Qty on Bill, Bill No./Proof
 * Link, Bill Proof Photo, Investigation Status, Investigation Notes, Qty
 * Returned to Inventory) with a targeted per-cell write, NEVER a full-row
 * overwrite, so those formulas are never clobbered. The sheet is pre-filled
 * with one formula per row for rows 5-1004, so a new handover fills the next
 * BLANK existing row rather than appending a fresh one (which would have no
 * formulas at all).
 *
 * SERVER ONLY. GOOGLE_SERVICE_ACCOUNT_KEY must never reach the client.
 */
import { createSign, randomUUID } from "node:crypto";
import { loadContext, getUser, appRole, isTruthy, serialToIso, type Ctx } from "./sheets-direct";
import { saveBillPhoto, type BillPhotoInput } from "./drive-write";
import { recordFmsRetailDeduction } from "./sheets-write";

const FMS_TAB = "FMS Tracker";
const FMS_DATA_START_ROW = 5;
// The sheet used to carry live formulas (including several NOW()-based volatile timestamp
// formulas) pre-filled across 1,000 rows, so Google Sheets had to recalculate roughly 10,000
// formula cells on every single edit -- real overhead on every fms.create, even though only a
// handful of rows were ever actually used. Rows 155-1004 have had their formulas cleared to
// stop that, leaving 150 formula-backed rows (30x today's real usage) to grow into.
const FMS_DATA_END_ROW = 154;
const FMS_ROLES = ["PurchaseCoordinator", "ProductDistributor", "Admin"];
/** The Technician dropdown's validation range (Lists!$A$2:$A$TECHNICIAN_LIST_BOUND) is sized once,
 * generously, so a growing technician roster never needs the validation rule touched again --
 * only the cell contents (see syncFmsTechnicianList) change as PEOPLE changes. */
const TECHNICIAN_LIST_BOUND = 200;

function requireFmsEnv(name: "GOOGLE_SERVICE_ACCOUNT_KEY" | "GOOGLE_FMS_SHEET_ID"): string {
  const v = process.env[name];
  if (!v) throw new Error(`FMS_UNAVAILABLE: Missing ${name}.`);
  return v;
}

function colLetter(n: number): string {
  let s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const IST_OFFSET_MS = 330 * 60 * 1000;
function dateToSerial(date: Date): number {
  return (date.getTime() + IST_OFFSET_MS) / 86400000 + 25569;
}
function resolveTxnDate(data: Record<string, unknown>): Date {
  if (!data.date) return new Date();
  const d = new Date(`${data.date}T12:00:00+05:30`);
  return isNaN(d.getTime()) ? new Date() : d;
}

// ---------------------------------------------------------------- auth (own cache, separate spreadsheet)

let cachedFmsToken: { token: string; exp: number } | null = null;

async function getFmsToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedFmsToken && cachedFmsToken.exp > now + 60) return cachedFmsToken.token;

  const key = JSON.parse(Buffer.from(requireFmsEnv("GOOGLE_SERVICE_ACCOUNT_KEY"), "base64").toString("utf8"));
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
  if (!json.access_token) throw new Error("FMS_AUTH_FAILED: Service account auth failed for the FMS sheet.");
  cachedFmsToken = { token: json.access_token, exp: now + (Number(json.expires_in) || 3000) };
  return cachedFmsToken.token;
}

async function fmsFetch(token: string, path: string, init?: RequestInit) {
  const sheetId = requireFmsEnv("GOOGLE_FMS_SHEET_ID");
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers || {}) },
    cache: "no-store",
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`FMS_SHEETS_API_ERROR: ${json.error?.message || res.status}`);
  return json;
}

// ---------------------------------------------------------------- row I/O

type FmsCell = string | number;
interface FmsRow { rowNumber: number; data: Record<string, FmsCell>; }

async function readHeaders(token: string): Promise<string[]> {
  const json = await fmsFetch(token, `/values/${encodeURIComponent(FMS_TAB)}!A4:AA4?valueRenderOption=UNFORMATTED_VALUE`);
  return ((json.values?.[0] as unknown[]) || []).map((h) => String(h ?? "").trim());
}

async function readRows(token: string, headers: string[]): Promise<FmsRow[]> {
  const json = await fmsFetch(token, `/values/${encodeURIComponent(FMS_TAB)}!A${FMS_DATA_START_ROW}:AA${FMS_DATA_END_ROW}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`);
  const values: unknown[][] = json.values || [];
  return values.map((r, i) => {
    const data: Record<string, FmsCell> = {};
    headers.forEach((h, ci) => { if (h) data[h] = ((r as unknown[])[ci] as FmsCell) ?? ""; });
    return { rowNumber: FMS_DATA_START_ROW + i, data };
  });
}

function colFor(headers: string[], name: string): string {
  const idx = headers.indexOf(name);
  if (idx < 0) throw new Error(`FMS_SCHEMA_ERROR: FMS Tracker has no column '${name}'.`);
  return colLetter(idx + 1);
}

/**
 * The Sheets API trims trailing fully-blank rows off the end of a values.get response -- a
 * sheet pre-filled with ~1000 formula rows but only a handful of real handovers comes back as
 * just those handful of rows, not 1000. So an empty Handover ID inside the returned rows means
 * a genuine gap (rare), but otherwise the next free row is simply right after the last one
 * returned, not "nowhere" just because the array is short.
 */
function findEmptyRow(rows: FmsRow[]): number {
  const gap = rows.find((r) => !String(r.data["Handover ID"] || "").trim());
  if (gap) return gap.rowNumber;
  const next = FMS_DATA_START_ROW + rows.length;
  if (next > FMS_DATA_END_ROW) throw new Error("FMS_FULL: No free row left in the FMS tracker. Ask an admin to extend it.");
  return next;
}

function findRowByHandoverId(rows: FmsRow[], handoverId: string): FmsRow {
  const target = String(handoverId).trim().toLowerCase();
  const row = rows.find((r) => String(r.data["Handover ID"] || "").trim().toLowerCase() === target);
  if (!row) throw new Error("NOT_FOUND: Handover not found.");
  return row;
}

/** Targeted per-cell writes only -- never a full-row overwrite, so the sheet's own formula cells are never touched. */
async function writeCells(token: string, headers: string[], rowNumber: number, values: Record<string, unknown>): Promise<void> {
  const data = Object.entries(values).map(([column, value]) => ({ range: `${FMS_TAB}!${colFor(headers, column)}${rowNumber}`, values: [[value]] }));
  if (!data.length) return;
  await fmsFetch(token, "/values:batchUpdate", { method: "POST", body: JSON.stringify({ valueInputOption: "RAW", data }) });
}

// ---------------------------------------------------------------- shape returned to the UI

export interface FmsHandover {
  handoverId: string; date: string; category: string; investmentLevel: string; productName: string; qtyGiven: number;
  technician: string; clientName: string; service: string; handoverCheck: string; handoverTimestamp: string;
  appliedToClient: string; appliedTimestamp: string; qtyOnBill: number | null; billTally: string;
  billNo: string; billProofPhoto: string; billProofStatus: string; billTallyTimestamp: string;
  investigationNeeded: string; investigationStatus: string; investigationNotes: string;
  qtyReturned: number | null; investigationReturnTimestamp: string; qtyOutstanding: number | null;
  finalStatus: string; closedTimestamp: string;
}

function mapRow(row: FmsRow): FmsHandover {
  const d = row.data;
  const num = (v: FmsCell) => (v === "" || v == null ? null : Number(v));
  return {
    handoverId: String(d["Handover ID"] || ""), date: serialToIso(d["Date"]), category: String(d["Category"] || ""),
    investmentLevel: String(d["Investment Level"] || ""), productName: String(d["Product Name"] || ""),
    qtyGiven: Number(d["Qty Given"]) || 0, technician: String(d["Technician"] || ""), clientName: String(d["Client Name"] || ""),
    service: String(d["Service"] || ""), handoverCheck: String(d["Handover Check"] || ""), handoverTimestamp: serialToIso(d["Handover Timestamp"]),
    appliedToClient: String(d["Applied to Client?"] || ""), appliedTimestamp: serialToIso(d["Applied Timestamp"]),
    qtyOnBill: num(d["Qty on Bill"]), billTally: String(d["Bill Tally"] || ""), billNo: String(d["Bill No. / Proof Link"] || ""),
    billProofPhoto: String(d["Bill Proof Photo"] || ""), billProofStatus: String(d["Bill Proof Status"] || ""),
    billTallyTimestamp: serialToIso(d["Bill Tally Timestamp"]), investigationNeeded: String(d["Investigation Needed?"] || ""),
    investigationStatus: String(d["Investigation Status"] || ""), investigationNotes: String(d["Investigation Notes (who took it / where)"] || ""),
    qtyReturned: num(d["Qty Returned to Inventory"]), investigationReturnTimestamp: serialToIso(d["Investigation/Return Timestamp"]),
    qtyOutstanding: num(d["Qty Outstanding"]), finalStatus: String(d["FINAL STATUS"] || ""), closedTimestamp: serialToIso(d["Closed Timestamp"]),
  };
}

// ---------------------------------------------------------------- handlers

async function handleFmsCreate(token: string, headers: string[], rows: FmsRow[], actor: string, ctx: Ctx, data: Record<string, unknown>) {
  const productId = String(data.productId || "").trim();
  const productName = String(data.productName || "").trim();
  const technician = String(data.technician || "").trim();
  const clientName = String(data.clientName || "").trim();
  const qtyGiven = Number(data.qtyGiven);
  if (!productId || productName.length < 2) throw new Error("VALIDATION: Select a product.");
  if (!technician) throw new Error("VALIDATION: Select a technician.");
  if (!clientName) throw new Error("VALIDATION: Record who this was handed over for.");
  if (!isFinite(qtyGiven) || qtyGiven <= 0) throw new Error("VALIDATION: Quantity must be greater than zero.");

  const rowNumber = findEmptyRow(rows);
  const handoverId = `FMS-${randomUUID().slice(0, 8).toUpperCase()}`;

  // Write the FMS row FIRST, with "Handover Check" still blank (so the row is visible but
  // not yet "complete" -- its Handover Timestamp formula only fires once Handover Check =
  // "Handover OK"). Deducting stock SECOND, and only marking Handover OK after that succeeds,
  // means a failure partway through always leaves a visible, traceable row instead of a
  // silent stock deduction with no record anywhere -- the opposite order once let a deduction
  // succeed while the row write failed after it, losing 50ML of real stock with no trace.
  await writeCells(token, headers, rowNumber, {
    "Handover ID": handoverId, Date: dateToSerial(resolveTxnDate(data)), Category: String(data.category || "").trim(),
    "Investment Level": String(data.investmentLevel || "").trim(), "Product Name": productName, "Qty Given": qtyGiven,
    Technician: technician, "Client Name": clientName, Service: String(data.service || "").trim(),
  });

  const deduction = await recordFmsRetailDeduction(actor, ctx, { productId, qty: qtyGiven, notes: `FMS handover for ${clientName}`, handoverId, date: data.date as string | undefined });

  await writeCells(token, headers, rowNumber, { "Handover Check": "Handover OK" });
  return { handoverId, rowNumber, newBalance: deduction.newBalance, uom: deduction.uom, locationId: deduction.locationId };
}

async function handleFmsApplied(token: string, headers: string[], rows: FmsRow[], data: Record<string, unknown>) {
  const applied = String(data.applied || "");
  if (!["Yes", "No"].includes(applied)) throw new Error("VALIDATION: Choose Yes or No.");
  const row = findRowByHandoverId(rows, String(data.handoverId || ""));
  await writeCells(token, headers, row.rowNumber, { "Applied to Client?": applied });
  return { handoverId: row.data["Handover ID"] };
}

async function handleFmsBillTally(token: string, headers: string[], rows: FmsRow[], actor: string, data: Record<string, unknown>) {
  const row = findRowByHandoverId(rows, String(data.handoverId || ""));
  const qtyOnBill = Number(data.qtyOnBill);
  if (!isFinite(qtyOnBill) || qtyOnBill < 0) throw new Error("VALIDATION: Enter the quantity actually billed.");
  const photo = data.photo as BillPhotoInput | undefined;
  if (!photo?.base64) throw new Error("VALIDATION: Attach a photo of the bill proof.");
  const saved = await saveBillPhoto(photo, { kind: "FMS_PROOF", txnId: String(row.data["Handover ID"]), actor }, false);
  await writeCells(token, headers, row.rowNumber, {
    "Qty on Bill": qtyOnBill, "Bill No. / Proof Link": String(data.billNo || "").trim(), "Bill Proof Photo": saved.url,
  });
  return { handoverId: row.data["Handover ID"], photoUrl: saved.url };
}

async function handleFmsInvestigate(token: string, headers: string[], rows: FmsRow[], data: Record<string, unknown>) {
  const status = String(data.status || "");
  if (!["In Progress", "Found", "Not Found"].includes(status)) throw new Error("VALIDATION: Choose an investigation status.");
  const row = findRowByHandoverId(rows, String(data.handoverId || ""));
  await writeCells(token, headers, row.rowNumber, { "Investigation Status": status, "Investigation Notes (who took it / where)": String(data.notes || "").trim() });
  return { handoverId: row.data["Handover ID"] };
}

async function handleFmsReturn(token: string, headers: string[], rows: FmsRow[], data: Record<string, unknown>) {
  const row = findRowByHandoverId(rows, String(data.handoverId || ""));
  const qtyReturned = Number(data.qtyReturned);
  if (!isFinite(qtyReturned) || qtyReturned < 0) throw new Error("VALIDATION: Enter the quantity returned.");
  await writeCells(token, headers, row.rowNumber, { "Qty Returned to Inventory": qtyReturned });
  return { handoverId: row.data["Handover ID"] };
}

/**
 * Keeps the FMS sheet's Technician dropdown (the "Lists" tab, referenced by the Technician
 * column's data validation) in step with the app's own PEOPLE tab -- the two used to drift
 * apart since the sheet had its own separately-edited placeholder names. Safe to call every
 * time: it's a plain-text helper tab, not part of the formula-sensitive FMS Tracker grid, so
 * overwriting it has no effect on any row's timestamps or status formulas.
 */
async function syncFmsTechnicianList(token: string, ctx: Ctx): Promise<void> {
  const technicians = ctx.people.filter((p) => String(p.Role).trim() === "Technician" && isTruthy(p.Active)).map((p) => String(p.Name));
  const values: unknown[][] = [["Technicians (synced from the app PEOPLE sheet)"], ...technicians.map((t) => [t])];
  while (values.length < TECHNICIAN_LIST_BOUND) values.push([""]);
  await fmsFetch(token, `/values/Lists!A1:A${TECHNICIAN_LIST_BOUND}?valueInputOption=RAW`, { method: "PUT", body: JSON.stringify({ values }) });

  const meta = await fmsFetch(token, "?fields=sheets.properties");
  const gid = (meta.sheets as { properties: { title: string; sheetId: number } }[]).find((s) => s.properties.title === FMS_TAB)?.properties.sheetId;
  if (gid == null) return;
  await fmsFetch(token, ":batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      requests: [{
        setDataValidation: {
          range: { sheetId: gid, startRowIndex: FMS_DATA_START_ROW - 1, endRowIndex: FMS_DATA_END_ROW, startColumnIndex: 6, endColumnIndex: 7 },
          rule: { condition: { type: "ONE_OF_RANGE", values: [{ userEnteredValue: `=Lists!$A$2:$A$${TECHNICIAN_LIST_BOUND}` }] }, strict: true, showCustomUi: true },
        },
      }],
    }),
  });
}

// ---------------------------------------------------------------- entry points

export const DIRECT_FMS_READ_ACTIONS = ["fms.list"] as const;
export type DirectFmsReadAction = (typeof DIRECT_FMS_READ_ACTIONS)[number];
export const DIRECT_FMS_WRITE_ACTIONS = ["fms.create", "fms.applied", "fms.billTally", "fms.investigate", "fms.return"] as const;
export type DirectFmsWriteAction = (typeof DIRECT_FMS_WRITE_ACTIONS)[number];

/** FMS has no PEOPLE/role concept of its own -- role comes from the main sheet's PEOPLE tab, same as every other action. */
async function requireFmsUser(actor: string): Promise<Ctx> {
  const ctx = await loadContext();
  const user = getUser(ctx, actor);
  if (!user || !isTruthy(user.Active)) throw new Error("FORBIDDEN: Your account could not be found or is inactive.");
  if (!FMS_ROLES.includes(appRole(user.Role))) throw new Error("FORBIDDEN: This action is not available to your role.");
  return ctx;
}

export async function readFms(action: DirectFmsReadAction, actor: string): Promise<FmsHandover[]> {
  await requireFmsUser(actor);
  const token = await getFmsToken();
  void action;
  const headers = await readHeaders(token);
  const rows = await readRows(token, headers);
  return rows.filter((r) => String(r.data["Handover ID"] || "").trim()).map(mapRow).reverse();
}

export async function writeFms(action: DirectFmsWriteAction, actor: string, data: Record<string, unknown>): Promise<unknown> {
  const ctx = await requireFmsUser(actor);
  const token = await getFmsToken();
  // Keeping the sheet's Technician dropdown in sync is cosmetic housekeeping, not part of
  // recording this handover -- it must never make the actor wait on it, and a failure here
  // (e.g. a transient Sheets API hiccup) must never block or fail the real write.
  if (action === "fms.create") void syncFmsTechnicianList(token, ctx).catch((err) => console.error("syncFmsTechnicianList failed:", err));
  const headers = await readHeaders(token);
  const rows = await readRows(token, headers);
  switch (action) {
    case "fms.create": return handleFmsCreate(token, headers, rows, actor, ctx, data);
    case "fms.applied": return handleFmsApplied(token, headers, rows, data);
    case "fms.billTally": return handleFmsBillTally(token, headers, rows, actor, data);
    case "fms.investigate": return handleFmsInvestigate(token, headers, rows, data);
    case "fms.return": return handleFmsReturn(token, headers, rows, data);
  }
}
