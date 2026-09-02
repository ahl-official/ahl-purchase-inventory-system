/**
 * Request signing, identity, configuration and stock balances.
 */

var SECRET_KEY =
  PropertiesService.getScriptProperties().getProperty("HMAC_SECRET") ||
  "DEV_SECRET_DO_NOT_USE_IN_PROD";

/**
 * Verifies the Next.js signature.
 *
 * Contract, byte-identical to signPayload() in src/lib/api.ts:
 *   message   = `${timestamp}.${body}`
 *   signature = base64(HMAC_SHA256(message, HMAC_SECRET))
 *
 * The 5-minute window means a badly skewed server clock reads as FORBIDDEN.
 */
function verifyHmac(payloadStr, timestampStr, providedSignature) {
  if (!payloadStr || !timestampStr || !providedSignature) return false;

  var now = Date.now();
  var ts = parseInt(timestampStr, 10);
  if (isNaN(ts) || Math.abs(now - ts) > 5 * 60 * 1000) return false;

  var message = timestampStr + "." + payloadStr;
  var signatureBytes = Utilities.computeHmacSha256Signature(message, SECRET_KEY);

  return Utilities.base64Encode(signatureBytes) === providedSignature;
}

// ---------------------------------------------------------------- identity

/** The PEOPLE record for an email, or null. */
function getUser(email) {
  if (!email) return null;
  return findRecord("PEOPLE", "Email", email);
}

/**
 * Whether an email belongs to an active member of staff.
 *
 * Active is read through isTruthy() because the sheet stores a real boolean
 * TRUE. The previous version compared against the string "Yes" and so rejected
 * every user in the directory.
 */
function isActiveUser(email) {
  var user = getUser(email);
  return !!user && isTruthy(user.Active);
}

// ----------------------------------------------------------------- config

/**
 * A CONFIG value, cached for the life of the execution so a handler that reads
 * three settings does not re-read the tab three times.
 */
var CONFIG_CACHE = null;

function getConfig(key, fallback) {
  if (!CONFIG_CACHE) {
    CONFIG_CACHE = {};
    try {
      readAll("LISTS").forEach(function (row) {
        if (row.Type === "SETTING" && row.Code) {
          CONFIG_CACHE[String(row.Code).trim()] = row.Name;
        }
      });
    } catch (err) {
      console.warn("LISTS unreadable for configs, using fallbacks: " + err);
    }
  }

  var value = CONFIG_CACHE[key];
  return value === undefined || value === "" ? fallback : value;
}

function getConfigNumber(key, fallback) {
  var n = Number(getConfig(key, fallback));
  return isNaN(n) ? fallback : n;
}

// --------------------------------------------------------------- products

/** The PRODUCTS record for an id, or null. */
function getProduct(productId) {
  return findRecord("PRODUCTS", "ProductID", productId);
}

/**
 * Converts a quantity into base units.
 *
 * Products are bought in one unit and issued in another -- C-22 Solvent arrives
 * as a 5000ml can and leaves in millilitres. Balances are only comparable once
 * both sides are expressed in the issue unit, so a receipt is multiplied by
 * ConvFactor and an issue is already in base units.
 */
function toBaseQty(product, qty, isPurchaseUnit) {
  var quantity = Number(qty) || 0;
  if (!isPurchaseUnit) return quantity;

  var factor = Number(product && product.ConvFactor) || 1;
  return quantity * factor;
}

// --------------------------------------------------------------- balances

/**
 * Current stock for a product, computed from the ledger inside the caller's lock.
 *
 * Sums QtyBase * Direction. Direction is +1 for receipts and -1 for issues, so
 * the ledger is the single source of truth and no running total can drift.
 * Pass "ALL" to ignore location.
 */
function computeBalance(productId, locationId) {
  return computeBalanceFromRows(readAll("LEDGER"), productId, locationId);
}

/** Same calculation over an already-read ledger, used by dashboard bulk reads. */
function computeBalanceFromRows(rows, productId, locationId) {
  var wantAll = String(locationId) === "ALL";
  var balance = 0;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (String(row.ProductID).trim() !== String(productId).trim()) continue;
    if (!wantAll && String(row.LocationID).trim() !== String(locationId).trim()) continue;
    if (String(row.Status).trim().toUpperCase() === "VOID") continue;
    // An unconfirmed custody transfer is still in the recount queue. It must
    // not become usable stock for Hitesh (or disappear from Satvik) until the
    // receiver confirms the physical quantity.
    if (
      String(row.Type).trim().toUpperCase() === "HANDOVER" &&
      String(row.Status).trim().toUpperCase() === "PENDING_CONFIRM"
    ) continue;

    var qty = Number(row.QtyBase);
    if (isNaN(qty) || qty === 0) qty = Number(row.Qty) || 0;

    balance += qty * (Number(row.Direction) || 0);
  }

  return balance;
}

/** Quantity reserved by pending outgoing handovers at a location. */
function computePendingHandoverOut(productId, locationId) {
  return computePendingHandoverOutFromRows(readAll("LEDGER"), productId, locationId);
}

function computePendingHandoverOutFromRows(rows, productId, locationId) {
  return rows.reduce(function (sum, row) {
    if (String(row.ProductID).trim() !== String(productId).trim()) return sum;
    if (String(row.LocationID).trim() !== String(locationId).trim()) return sum;
    if (String(row.Type).trim().toUpperCase() !== "HANDOVER") return sum;
    if (String(row.Status).trim().toUpperCase() !== "PENDING_CONFIRM") return sum;
    if (Number(row.Direction) !== -1) return sum;

    var qty = Number(row.QtyBase);
    if (isNaN(qty) || qty === 0) qty = Number(row.Qty) || 0;
    return sum + qty;
  }, 0);
}

/** Confirmed balance minus stock already promised in a pending handover. */
function computeAvailableBalance(productId, locationId) {
  return computeBalance(productId, locationId) - computePendingHandoverOut(productId, locationId);
}

/** Appends an audit row. Never throws -- a failed audit must not fail the write. */
function audit(actor, action, ref, detail, result) {
  try {
    appendRecord("AUDIT", {
      AuditID: nextId("AUD"),
      Timestamp: new Date(),
      Actor: actor || "unknown",
      Action: action || "unknown",
      Ref: ref || "",
      Detail: typeof detail === "string" ? detail : JSON.stringify(detail || {}),
      Result: result || "SUCCESS"
    });
  } catch (err) {
    // Auditing must never make the business transaction fail, but the
    // execution log still needs to show that the audit write was missed.
    console.error("Could not write audit row: " + err);
  }
}
