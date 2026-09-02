/**
 * Web app entry point.
 *
 * Order matters: verify the signature, confirm the actor is real staff, take the
 * lock, then write. Anything that fails does so before touching the spreadsheet.
 */
function doPost(e) {
  var payload = null;

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return respondJson(
        { success: false, error: "INVALID_REQUEST", message: "No payload received" },
        400
      );
    }

    var contents = e.postData.contents;

    if (!verifyHmac(contents, e.parameter.ts, e.parameter.sig)) {
      return respondJson(
        {
          success: false,
          error: "FORBIDDEN",
          message: "Invalid signature or the request expired. Check HMAC_SECRET matches .env and that the server clock is correct."
        },
        403
      );
    }

    payload = JSON.parse(contents);

    if (!isActiveUser(payload.actor)) {
      return respondJson(
        {
          success: false,
          error: "NOT_IN_DIRECTORY",
          message: payload.actor + " is not an active user in PEOPLE."
        },
        403
      );
    }

    // Serialise every write. Hitesh issuing while Satvik receives must not
    // interleave, or the balance recomputed inside each handler is meaningless.
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) {
      return respondJson(
        { success: false, error: "BUSY", message: "System busy, please try again." },
        429
      );
    }

    try {
      var result;

      switch (payload.action) {
        case "stock.issue":
          result = processStockIssue(payload);
          break;
        case "stock.receive":
          result = processStockReceive(payload);
          break;
        case "purchase.request":
          result = processPurchaseRequest(payload);
          break;
        case "purchase.approve":
          result = processDecidePurchaseRequest(payload);
          break;
        case "stock.handover":
          result = processStockHandover(payload);
          break;
        case "stock.confirmHandover":
          result = processConfirmHandover(payload);
          break;
        case "handover.list":
          result = listPendingHandovers();
          break;
        case "dashboard.read":
          result = getDashboard();
          break;
        default:
          return respondJson(
            {
              success: false,
              error: "UNKNOWN_ACTION",
              message: "Action " + payload.action + " is not supported."
            },
            400
          );
      }

      return respondJson({ success: true, data: result }, 200);
    } catch (handlerErr) {
      // Handlers throw "CODE: human message" so the client can tell a business
      // rejection (INSUFFICIENT_STOCK) from a genuine fault.
      console.error(handlerErr);

      var raw = handlerErr && handlerErr.message ? handlerErr.message : String(handlerErr);
      var split = raw.indexOf(":");
      var coded = split > 0 && /^[A-Z_]+$/.test(raw.substring(0, split));

      audit(payload.actor, payload.action, "", raw, "FAILED");

      return respondJson(
        {
          success: false,
          error: coded ? raw.substring(0, split) : "HANDLER_ERROR",
          message: coded ? raw.substring(split + 1).trim() : raw
        },
        422
      );
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    console.error(err);
    return respondJson(
      { success: false, error: "INTERNAL_ERROR", message: err.toString() },
      500
    );
  }
}

/**
 * ContentService cannot set an HTTP status code -- every response leaves as
 * HTTP 200. The intended status travels in the body for logging; clients must
 * branch on `success`, never on the transport status.
 */
function respondJson(data, statusCode) {
  data.status = statusCode;
  var output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

/**
 * Health check. Visiting the /exec URL in a browser confirms the deployment is
 * reachable and the database is wired up, without writing anything.
 */
function doGet() {
  var status = { success: true, service: "AHL Flow", time: new Date().toISOString() };

  try {
    status.sheetId = getDbId();
    status.products = readAll("PRODUCTS").length;
    status.people = readAll("PEOPLE").length;
    status.ledgerRows = readAll("LEDGER").length;
    status.secretConfigured = SECRET_KEY !== "DEV_SECRET_DO_NOT_USE_IN_PROD";
  } catch (err) {
    status.success = false;
    status.error = String(err);
  }

  return respondJson(status, status.success ? 200 : 500);
}
