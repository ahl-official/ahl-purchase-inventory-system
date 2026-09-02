/**
 * Bill photo storage.
 *
 * <PhotoCapture /> compresses a JPEG on the device and sends it inside the
 * stock.receive payload as raw base64. This file decodes it, writes it to Drive
 * under a year/month folder, and hands back a URL for the sheet.
 *
 * Script Properties honoured here:
 *   DRIVE_FOLDER_BILLS - folder ID for bill storage. Created on first use if absent.
 *   BILL_PUBLIC_LINK   - "Yes" makes each bill readable by anyone with the link.
 *                        Left unset, bills stay private to the deploying account.
 */

// Reject anything larger than this once decoded. Client-side compression targets
// ~600 KB, so hitting this ceiling means the payload did not come from our UI.
var MAX_BILL_BYTES = 8 * 1024 * 1024;

var ALLOWED_BILL_MIME = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp"
};

/**
 * Returns the root folder for bill storage, creating and remembering it once.
 */
function getBillsRootFolder() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty("DRIVE_FOLDER_BILLS");

  if (folderId) {
    try {
      return DriveApp.getFolderById(folderId);
    } catch (err) {
      // Property points at a deleted or inaccessible folder. Fall through and
      // rebuild rather than failing the whole GRN write.
      console.warn("DRIVE_FOLDER_BILLS unusable, recreating: " + err);
    }
  }

  var existing = DriveApp.getFoldersByName("AHL Flow Bills");
  var folder = existing.hasNext() ? existing.next() : DriveApp.createFolder("AHL Flow Bills");
  props.setProperty("DRIVE_FOLDER_BILLS", folder.getId());
  return folder;
}

/** Returns (creating if needed) the yyyy-MM subfolder under the bills root. */
function getMonthFolder(root, when) {
  var name = Utilities.formatDate(when, Session.getScriptTimeZone(), "yyyy-MM");
  var found = root.getFoldersByName(name);
  return found.hasNext() ? found.next() : root.createFolder(name);
}

/**
 * Decodes a base64 bill photo and saves it to Drive.
 *
 * @param {Object} photo    { base64, mimeType, fileName }
 * @param {Object} context  { kind, txnId, actor, vendorId, poId } used for naming/description.
 *                          kind defaults to "BILL"; pass "PRODUCT" for the
 *                          product photo so the two never collide by filename.
 * @return {Object} { fileId, url, downloadUrl, name, sizeBytes }
 */
function saveBillPhoto(photo, context) {
  if (!photo || !photo.base64) {
    throw new Error("BILL_PHOTO_MISSING: No image data in payload.");
  }

  var mimeType = String(photo.mimeType || "image/jpeg").toLowerCase();
  if (!ALLOWED_BILL_MIME[mimeType]) {
    throw new Error("BILL_PHOTO_TYPE: Unsupported image type " + mimeType);
  }

  // Tolerate a full data: URL even though the client strips the prefix.
  var raw = String(photo.base64);
  var comma = raw.indexOf(",");
  if (raw.lastIndexOf("data:", 0) === 0 && comma > -1) {
    raw = raw.substring(comma + 1);
  }
  raw = raw.replace(/\s/g, "");

  var bytes;
  try {
    bytes = Utilities.base64Decode(raw);
  } catch (err) {
    throw new Error("BILL_PHOTO_DECODE: Image data is not valid base64.");
  }

  if (!bytes.length) {
    throw new Error("BILL_PHOTO_EMPTY: Decoded image is empty.");
  }
  if (bytes.length > MAX_BILL_BYTES) {
    throw new Error(
      "BILL_PHOTO_TOO_LARGE: " + bytes.length + " bytes exceeds the " + MAX_BILL_BYTES + " byte limit."
    );
  }

  var now = new Date();
  var stamp = Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyyMMdd-HHmmss");
  var ctx = context || {};
  var kind = ctx.kind || "BILL";
  var name =
    kind + "_" +
    stamp +
    (ctx.txnId ? "_" + ctx.txnId : "") +
    (ctx.vendorId ? "_" + ctx.vendorId : "") +
    ALLOWED_BILL_MIME[mimeType];

  var blob = Utilities.newBlob(bytes, mimeType, name);
  var folder = getMonthFolder(getBillsRootFolder(), now);
  var file = folder.createFile(blob);

  file.setDescription(
    [
      "AHL Flow GRN " + kind.toLowerCase() + " photo",
      "TxnID: " + (ctx.txnId || "-"),
      "PO: " + (ctx.poId || "-"),
      "Vendor: " + (ctx.vendorId || "-"),
      "Actor: " + (ctx.actor || "-")
    ].join(" | ")
  );

  // Opt-in only: link sharing makes the bill readable by anyone holding the URL.
  if (PropertiesService.getScriptProperties().getProperty("BILL_PUBLIC_LINK") === "Yes") {
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (err) {
      console.warn("Could not set link sharing on " + file.getId() + ": " + err);
    }
  }

  var fileId = file.getId();
  return {
    fileId: fileId,
    url: file.getUrl(),
    // Direct-render URL, useful for the <img> in the three-way match screen.
    downloadUrl: "https://drive.google.com/uc?export=view&id=" + fileId,
    name: name,
    sizeBytes: bytes.length
  };
}

/**
 * Strips heavy or sensitive fields before a payload is written to AUDIT_LOG.
 * A base64 image is ~800 KB of text and would blow the 50,000 character cell
 * limit, failing the whole append. Matched by shape (a `base64` property)
 * rather than a fixed field name, so a second photo field (e.g. productPhoto)
 * is redacted without this needing to know its name in advance.
 */
function redactForAudit(req) {
  var copy = {};
  for (var key in req) {
    if (!Object.prototype.hasOwnProperty.call(req, key)) continue;
    var value = req[key];
    if (value && typeof value === "object" && value.base64) {
      copy[key] = {
        fileName: value.fileName || "",
        mimeType: value.mimeType || "",
        sizeBytes: value.sizeBytes || 0,
        omitted: "base64 stripped for audit"
      };
    } else {
      copy[key] = value;
    }
  }
  return copy;
}
