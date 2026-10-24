/**
 * Bill/product photo storage: service-account writes to Google Drive, replacing
 * Apps Script's saveBillPhoto() (apps-script/Drive.gs). Same folder ("AHL Flow Bills",
 * shared with the service account as Editor so old and new photos land in one place),
 * same yyyy-MM subfolder layout, same filename scheme, same description, same optional
 * link-sharing opt-in -- only the transport and where the opt-in setting is read from
 * (a LISTS SETTING row via getConfig, since this code has no access to Apps Script's
 * PropertiesService) change.
 *
 * SERVER ONLY. GOOGLE_SERVICE_ACCOUNT_KEY must never reach the client.
 */
import { createSign } from "node:crypto";
import { requireEnv } from "./sheets-direct";

const BILLS_ROOT_FOLDER_NAME = "AHL Flow Bills";
const MAX_BILL_BYTES = 8 * 1024 * 1024;
const ALLOWED_BILL_MIME: Record<string, string> = {
  "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp",
};

// ---------------------------------------------------------------- auth (Drive scope, own cache)

let cachedDriveToken: { token: string; exp: number } | null = null;

async function getDriveAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedDriveToken && cachedDriveToken.exp > now + 60) return cachedDriveToken.token;

  const key = JSON.parse(Buffer.from(requireEnv("GOOGLE_SERVICE_ACCOUNT_KEY"), "base64").toString("utf8"));
  const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
    iss: key.client_email, scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000,
  })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error("DRIVE_AUTH_FAILED: Service account auth failed for Drive.");
  cachedDriveToken = { token: json.access_token, exp: now + (Number(json.expires_in) || 3000) };
  return cachedDriveToken.token;
}

// ---------------------------------------------------------------- raw Drive API I/O

async function driveFetch(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`https://www.googleapis.com/drive/v3${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers || {}) },
    cache: "no-store",
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`DRIVE_API_ERROR: ${json.error?.message || res.status}`);
  return json;
}

/** Finds a non-trashed folder by exact name (and optionally parent), the same lookup DriveApp.getFoldersByName()/getFoldersByName() does. */
async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  const clauses = [`name = '${name.replace(/'/g, "\\'")}'`, "mimeType = 'application/vnd.google-apps.folder'", "trashed = false"];
  if (parentId) clauses.push(`'${parentId}' in parents`);
  const json = await driveFetch(token, `/files?q=${encodeURIComponent(clauses.join(" and "))}&fields=files(id,name)`);
  return json.files?.[0]?.id || null;
}

async function createFolder(token: string, name: string, parentId?: string): Promise<string> {
  const json = await driveFetch(token, "/files?fields=id", {
    method: "POST",
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: parentId ? [parentId] : undefined }),
  });
  return json.id;
}

let cachedRootFolderId: string | null = null;

/** Returns (creating if needed) the "AHL Flow Bills" root folder, the same one Apps Script uploads into. */
async function getBillsRootFolder(token: string): Promise<string> {
  if (cachedRootFolderId) return cachedRootFolderId;
  const found = await findFolder(token, BILLS_ROOT_FOLDER_NAME);
  cachedRootFolderId = found || (await createFolder(token, BILLS_ROOT_FOLDER_NAME));
  return cachedRootFolderId;
}

/** Returns (creating if needed) the yyyy-MM subfolder under the bills root, in Asia/Kolkata (matches appsscript.json's script timezone). */
async function getMonthFolder(token: string, rootId: string, when: Date): Promise<string> {
  const name = istStamp(when, "yyyy-MM");
  const found = await findFolder(token, name, rootId);
  return found || (await createFolder(token, name, rootId));
}

function istStamp(date: Date, pattern: "yyyy-MM" | "yyyyMMdd-HHmmss"): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  if (pattern === "yyyy-MM") return `${get("year")}-${get("month")}`;
  return `${get("year")}${get("month")}${get("day")}-${get("hour")}${get("minute")}${get("second")}`;
}

/** Drive API v3's "multipart/related" upload body: a JSON metadata part, then the raw bytes. */
function buildMultipartBody(boundary: string, metadata: object, mimeType: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
}

async function uploadFile(token: string, args: { name: string; mimeType: string; bytes: Buffer; parentId: string; description: string }): Promise<{ id: string; webViewLink: string }> {
  const boundary = `ahlflow_${Date.now()}`;
  const body = buildMultipartBody(boundary, { name: args.name, parents: [args.parentId], description: args.description }, args.mimeType, args.bytes);
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body: body as unknown as BodyInit,
    cache: "no-store",
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`DRIVE_API_ERROR: ${json.error?.message || res.status}`);
  return { id: json.id, webViewLink: json.webViewLink };
}

async function setAnyoneReader(token: string, fileId: string): Promise<void> {
  try {
    await driveFetch(token, `/files/${fileId}/permissions`, { method: "POST", body: JSON.stringify({ role: "reader", type: "anyone" }) });
  } catch (err) {
    console.warn(`Could not set link sharing on ${fileId}:`, err);
  }
}

// ---------------------------------------------------------------- public entry point

export interface BillPhotoInput { base64: string; mimeType?: string; fileName?: string }
export interface BillPhotoContext { kind?: "BILL" | "PRODUCT"; txnId?: string; actor?: string; vendorId?: string; poId?: string }
export interface SavedBillPhoto { fileId: string; url: string; downloadUrl: string; name: string; sizeBytes: number }

/** Ported 1:1 from Drive.gs saveBillPhoto. `publicLink` is the caller-resolved BillPublicLink SETTING. */
export async function saveBillPhoto(photo: BillPhotoInput, context: BillPhotoContext, publicLink: boolean): Promise<SavedBillPhoto> {
  if (!photo || !photo.base64) throw new Error("BILL_PHOTO_MISSING: No image data in payload.");
  const mimeType = String(photo.mimeType || "image/jpeg").toLowerCase();
  const ext = ALLOWED_BILL_MIME[mimeType];
  if (!ext) throw new Error(`BILL_PHOTO_TYPE: Unsupported image type ${mimeType}`);

  let raw = String(photo.base64);
  const comma = raw.indexOf(",");
  if (raw.startsWith("data:") && comma > -1) raw = raw.slice(comma + 1);
  raw = raw.replace(/\s/g, "");

  let bytes: Buffer;
  try {
    bytes = Buffer.from(raw, "base64");
  } catch {
    throw new Error("BILL_PHOTO_DECODE: Image data is not valid base64.");
  }
  if (!bytes.length) throw new Error("BILL_PHOTO_EMPTY: Decoded image is empty.");
  if (bytes.length > MAX_BILL_BYTES) throw new Error(`BILL_PHOTO_TOO_LARGE: ${bytes.length} bytes exceeds the ${MAX_BILL_BYTES} byte limit.`);

  const now = new Date();
  const stamp = istStamp(now, "yyyyMMdd-HHmmss");
  const kind = context.kind || "BILL";
  const name = `${kind}_${stamp}${context.txnId ? `_${context.txnId}` : ""}${context.vendorId ? `_${context.vendorId}` : ""}${ext}`;
  const description = [
    `AHL Flow GRN ${kind.toLowerCase()} photo`, `TxnID: ${context.txnId || "-"}`,
    `PO: ${context.poId || "-"}`, `Vendor: ${context.vendorId || "-"}`, `Actor: ${context.actor || "-"}`,
  ].join(" | ");

  const token = await getDriveAccessToken();
  const rootId = await getBillsRootFolder(token);
  const monthId = await getMonthFolder(token, rootId, now);
  const { id, webViewLink } = await uploadFile(token, { name, mimeType, bytes, parentId: monthId, description });
  if (publicLink) await setAnyoneReader(token, id);

  return { fileId: id, url: webViewLink, downloadUrl: `https://drive.google.com/uc?export=view&id=${id}`, name, sizeBytes: bytes.length };
}
