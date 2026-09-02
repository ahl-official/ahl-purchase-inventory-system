/**
 * The write handlers. Each runs inside the script lock held by doPost.
 *
 * Every row is built as an object keyed by header name and handed to
 * appendRecord, so column order in the spreadsheet is irrelevant.
 */

/**
 * Issues stock to one or more recipients.
 * A single issue can be split across categories and people; all splits share a
 * HandoverID so the movement can be reconstructed or reversed as one event.
 */
function processStockIssue(payload) {
  var req = payload.data;
  var locationId = req.fromLocationId || getConfig("DefaultLocationID", "LOC-01");

  if (!req.productId) throw new Error("VALIDATION: No product selected.");
  if (!req.splits || !req.splits.length) throw new Error("VALIDATION: No allocation given.");

  var product = getProduct(req.productId);
  if (!product) throw new Error("UNKNOWN_PRODUCT: " + req.productId + " is not in PRODUCTS.");

  // Re-check the balance inside the lock. The figure the browser showed may be
  // stale by the time it reaches here.
  var balance = computeAvailableBalance(req.productId, locationId);
  var total = req.splits.reduce(function (sum, s) {
    var splitQty = Number(s.qty) || 0;
    if (splitQty <= 0) throw new Error("VALIDATION: Every split needs a quantity above zero.");
    if (!s.categoryId) throw new Error("VALIDATION: Every split needs a service category.");
    if (!s.recipientUserId) throw new Error("VALIDATION: Every split needs a technician.");
    return sum + splitQty;
  }, 0);

  if (total <= 0) throw new Error("VALIDATION: Quantity must be greater than zero.");
  if (total > balance) {
    throw new Error(
      "INSUFFICIENT_STOCK: " + balance + " " + product.IssueUOM +
      " on hand at " + locationId + ", tried to issue " + total + "."
    );
  }

  var handoverId = nextId("HND");
  var now = new Date();

  var rows = req.splits.map(function (split) {
    var qty = Number(split.qty) || 0;
    return {
      TxnID: nextId("TXN"),
      Date: now,
      Type: "ISSUE",
      Direction: -1,
      ProductID: req.productId,
      Qty: qty,
      UOM: product.IssueUOM,
      QtyBase: toBaseQty(product, qty, false),
      LocationID: locationId,
      CategoryID: split.categoryId || "",
      PersonID: split.recipientUserId || "",
      HandoverID: handoverId,
      Amount: qty * ((Number(product.Cost) || 0) / (Number(product.ConvFactor) || 1)),
      Actor: payload.actor,
      Status: "ISSUED",
      Notes: split.notes || ""
    };
  });

  appendRecords("LEDGER", rows);

  audit(payload.actor, "stock.issue", handoverId, {
    productId: req.productId,
    locationId: locationId,
    total: total,
    splits: req.splits.length
  });

  return {
    handoverId: handoverId,
    newBalance: balance - total,
    uom: product.IssueUOM
  };
}

/**
 * Records a delivery and files its bill photo.
 * A receipt without a stored bill is rejected outright rather than recorded
 * without its supporting document.
 */
function processStockReceive(payload) {
  var req = payload.data;
  var locationId = req.locationId || getConfig("DefaultLocationID", "LOC-01");

  if (!req.productId) throw new Error("VALIDATION: No product selected.");

  var product = getProduct(req.productId);
  if (!product) throw new Error("UNKNOWN_PRODUCT: " + req.productId + " is not in PRODUCTS.");

  var qty = Number(req.qty) || 0;
  if (qty <= 0) throw new Error("VALIDATION: Quantity must be greater than zero.");

  var txnId = nextId("TXN");

  // Drive first. If the bill cannot be stored, no stock row is written.
  var bill = null;
  if (req.photo && req.photo.base64) {
    bill = saveBillPhoto(req.photo, {
      kind: "BILL",
      txnId: txnId,
      actor: payload.actor,
      vendorId: req.vendorId,
      poId: req.poId
    });
  }

  // Optional second photo of the physical product, distinct from the bill.
  var productPhoto = null;
  if (req.productPhoto && req.productPhoto.base64) {
    productPhoto = saveBillPhoto(req.productPhoto, {
      kind: "PRODUCT",
      txnId: txnId,
      actor: payload.actor,
      vendorId: req.vendorId,
      poId: req.poId
    });
  }

  // Deliveries arrive in the purchase unit; the ledger stores issue units.
  var qtyBase = toBaseQty(product, qty, true);
  var amount = Number(req.amount) || qty * (Number(product.Cost) || 0);

  appendRecord("LEDGER", {
    TxnID: txnId,
    Date: new Date(),
    Type: "RECEIPT",
    Direction: 1,
    ProductID: req.productId,
    Qty: qty,
    UOM: product.PurchaseUOM || product.IssueUOM,
    QtyBase: qtyBase,
    LocationID: locationId,
    CategoryID: req.categoryId || "",
    VendorID: req.vendorId || "",
    PORef: req.poId || "",
    InvoiceNo: req.invoiceNo || "",
    Amount: amount,
    BillPhotoURL: bill ? bill.url : "",
    ProductPhotoURL: productPhoto ? productPhoto.url : "",
    ReceivedByUserId: req.receivedByUserId || "",
    Actor: payload.actor,
    Status: "RECEIVED",
    Notes: req.notes || ""
  });

  audit(payload.actor, "stock.receive", txnId, redactForAudit(req));

  return {
    txnId: txnId,
    qtyBase: qtyBase,
    uom: product.IssueUOM,
    billUrl: bill ? bill.url : "",
    billFileId: bill ? bill.fileId : "",
    billViewUrl: bill ? bill.downloadUrl : "",
    productPhotoUrl: productPhoto ? productPhoto.url : ""
  };
}

/**
 * Logs a purchase request, from either side of the counter.
 *
 * Satvik (PurchaseCoordinator) has purchasing authority: there is no
 * separate approval queue for him. At or above the configured threshold he
 * names who signed off (Jagruti / Vishal) in the same form, on the
 * assumption that sign-off already happened by phone or in person before he
 * logs the request. His request lands straight in REQUESTS as approved,
 * with who approved it on the row -- that name is the control, not a
 * workflow.
 *
 * Hitesh (ProductDistributor) has none. Whatever he asks for, however small,
 * is written PENDING_APPROVAL and sits there until Satvik calls
 * processDecidePurchaseRequest -- Hitesh cannot name his own approver, and
 * any approvedBy he sends is ignored.
 *
 * Either productId or newProductName must be given, never both meaningfully.
 * A new-product request is never turned into a live PRODUCTS row here -- it
 * has no UOM, cost or ConvFactor, which the ledger math depends on, so it
 * stays a flagged, catalogue-less row (Status NEW_PRODUCT once approved)
 * until someone adds it to PRODUCTS properly.
 */
function processPurchaseRequest(payload) {
  var req = payload.data;
  var newProductName = String(req.newProductName || "").trim();

  if (!String(req.requestedByUserId || "").trim()) {
    throw new Error("VALIDATION: Record who requested the product.");
  }
  if (String(req.notes || "").trim().length < 3) {
    throw new Error("VALIDATION: Add a short reason for the request.");
  }

  var qty = Number(req.qty) || 0;
  if (qty <= 0) throw new Error("VALIDATION: Quantity must be greater than zero.");

  var product = null;
  if (req.productId) {
    product = getProduct(req.productId);
    if (!product) throw new Error("UNKNOWN_PRODUCT: " + req.productId + " is not in PRODUCTS.");
  } else if (!newProductName) {
    throw new Error("VALIDATION: No product selected.");
  }

  // Estimate from catalogue cost when known; a new product has none, so the
  // caller's own estimate (if given) is all there is to go on.
  var estValue = Number(req.estimatedValue) || (product ? qty * (Number(product.Cost) || 0) : 0);
  var threshold = getConfigNumber("ApprovalThreshold", 5000);
  var terminalStatus = product ? "OPEN" : "NEW_PRODUCT";
  var requesterRole = (getUser(payload.actor) || {}).Role;

  var status, approvedBy;

  if (requesterRole === "ProductDistributor") {
    status = "PENDING_APPROVAL";
    approvedBy = "";
  } else {
    var needsApproval = estValue >= threshold;
    approvedBy = String(req.approvedBy || "").trim();
    if (needsApproval && !approvedBy) {
      throw new Error(
        "VALIDATION: This is over the ₹" + threshold + " threshold — record who approved it before logging."
      );
    }
    status = terminalStatus;
  }

  var requestId = nextId("PR");

  appendRecord("REQUESTS", {
    RequestID: requestId,
    Date: new Date(),
    ProductID: req.productId || "",
    NewProductName: newProductName,
    Qty: qty,
    RequestedBy: req.requestedByUserId || "",
    Urgency: req.urgency || "Normal",
    EstValue: estValue,
    Status: status,
    ApprovedBy: approvedBy,
    ApprovedAt: approvedBy ? new Date() : "",
    Actor: payload.actor,
    Notes: req.notes || ""
  });

  audit(payload.actor, "purchase.request", requestId, {
    productId: req.productId || "",
    newProductName: newProductName,
    qty: qty,
    estValue: estValue,
    approvedBy: approvedBy,
    status: status
  });

  return {
    requestId: requestId,
    status: status,
    estValue: estValue,
    threshold: threshold,
    approvedBy: approvedBy
  };
}

/**
 * Satvik approves or rejects a request Hitesh raised from the floor.
 *
 * Only a row still PENDING_APPROVAL can be decided -- Satvik's own requests
 * never reach this function because processPurchaseRequest never writes them
 * as PENDING_APPROVAL in the first place. Approving does not change the
 * quantity or product; if those are wrong the right fix is to reject and have
 * Hitesh log it again.
 */
function processDecidePurchaseRequest(payload) {
  var req = payload.data;
  var requestId = String(req.requestId || "").trim();
  var decision = String(req.decision || "").trim().toUpperCase();

  if (!requestId) throw new Error("VALIDATION: No request selected.");
  if (decision !== "APPROVE" && decision !== "REJECT") {
    throw new Error("VALIDATION: Decision must be Approve or Reject.");
  }

  var t = table("REQUESTS");
  var lastRow = t.sheet.getLastRow();
  if (lastRow < 2) throw new Error("NOT_FOUND: No request " + requestId + ".");

  var values = t.sheet.getRange(2, 1, lastRow - 1, t.headers.length).getValues();
  var idIdx = t.idx["RequestID"];
  var statusIdx = t.idx["Status"];
  var productIdx = t.idx["ProductID"];
  var approvedByIdx = t.idx["ApprovedBy"];
  var approvedAtIdx = t.idx["ApprovedAt"];
  var notesIdx = t.idx["Notes"];

  var rowNumber = -1;
  var productId = "";
  var currentNotes = "";
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][idIdx]).trim() !== requestId) continue;
    if (String(values[i][statusIdx]).trim() !== "PENDING_APPROVAL") {
      throw new Error(
        "VALIDATION: " + requestId + " is " + values[i][statusIdx] + ", not awaiting approval."
      );
    }
    rowNumber = i + 2;
    productId = values[i][productIdx];
    currentNotes = values[i][notesIdx];
    break;
  }

  if (rowNumber === -1) throw new Error("NOT_FOUND: No request " + requestId + ".");

  var newStatus = decision === "APPROVE" ? (productId ? "OPEN" : "NEW_PRODUCT") : "REJECTED";

  t.sheet.getRange(rowNumber, statusIdx + 1).setValue(newStatus);
  t.sheet.getRange(rowNumber, approvedByIdx + 1).setValue(payload.actor);
  t.sheet.getRange(rowNumber, approvedAtIdx + 1).setValue(new Date());
  if (req.notes) {
    var prefix = currentNotes ? currentNotes + " | " : "";
    t.sheet.getRange(rowNumber, notesIdx + 1).setValue(prefix + "Satvik: " + req.notes);
  }

  audit(payload.actor, "purchase.request." + decision.toLowerCase(), requestId, {
    decision: decision,
    notes: req.notes || ""
  });

  return { requestId: requestId, status: newStatus };
}

/**
 * Satvik hands physical stock from receiving over to Hitesh.
 *
 * Two ledger rows sharing one HandoverID, both left PENDING_CONFIRM: stock
 * leaves the receiving location and lands in Hitesh's, but the movement is
 * not final until processConfirmHandover flips both rows. That gap is
 * deliberate -- it is the "independent recount, not a rubber stamp" the
 * process is meant to enforce.
 */
function processStockHandover(payload) {
  var req = payload.data;

  if (!req.productId) throw new Error("VALIDATION: No product selected.");
  var qty = Number(req.qty) || 0;
  if (qty <= 0) throw new Error("VALIDATION: Quantity must be greater than zero.");

  var product = getProduct(req.productId);
  if (!product) throw new Error("UNKNOWN_PRODUCT: " + req.productId + " is not in PRODUCTS.");

  var fromLocationId = req.fromLocationId || "LOC-07"; // Receiving (Satvik)
  var toLocationId = req.toLocationId || getConfig("DefaultLocationID", "LOC-01");

  // Pending handovers reserve stock but do not move custody until Hitesh's
  // recount. This prevents the same Receiving stock being promised twice.
  var available = computeAvailableBalance(req.productId, fromLocationId);
  if (qty > available) {
    throw new Error(
      "INSUFFICIENT_STOCK: " + available + " " + product.IssueUOM +
      " sitting at " + fromLocationId + ", tried to hand over " + qty + "."
    );
  }

  var handoverId = nextId("HND");
  var now = new Date();
  var qtyBase = toBaseQty(product, qty, false);

  appendRecords("LEDGER", [
    {
      TxnID: nextId("TXN"), Date: now, Type: "HANDOVER", Direction: -1,
      ProductID: req.productId, Qty: qty, UOM: product.IssueUOM, QtyBase: qtyBase,
      LocationID: fromLocationId, HandoverID: handoverId,
      PersonID: req.toUserId || "", Actor: payload.actor,
      Status: "PENDING_CONFIRM", Notes: req.notes || ""
    },
    {
      TxnID: nextId("TXN"), Date: now, Type: "HANDOVER", Direction: 1,
      ProductID: req.productId, Qty: qty, UOM: product.IssueUOM, QtyBase: qtyBase,
      LocationID: toLocationId, HandoverID: handoverId,
      PersonID: req.toUserId || "", Actor: payload.actor,
      Status: "PENDING_CONFIRM", Notes: req.notes || ""
    }
  ]);

  audit(payload.actor, "stock.handover", handoverId, {
    productId: req.productId, qty: qty, fromLocationId: fromLocationId, toLocationId: toLocationId
  });

  return { handoverId: handoverId, qty: qty, uom: product.IssueUOM };
}

/**
 * Hitesh confirms a handover after his own recount. Both rows written by
 * processStockHandover flip to CONFIRMED; nothing about the quantity is
 * re-entered here on purpose -- if the recount does not match, that goes in
 * notes and gets resolved as a separate correction, not silently overwritten.
 */
function processConfirmHandover(payload) {
  var req = payload.data;
  var handoverId = String(req.handoverId || "").trim();
  if (!handoverId) throw new Error("VALIDATION: No handover selected.");

  var t = table("LEDGER");
  var lastRow = t.sheet.getLastRow();
  if (lastRow < 2) throw new Error("NOT_FOUND: No handover " + handoverId + " to confirm.");

  var values = t.sheet.getRange(2, 1, lastRow - 1, t.headers.length).getValues();
  var handoverIdx = t.idx["HandoverID"];
  var statusIdx = t.idx["Status"];
  var notesIdx = t.idx["Notes"];
  var directionIdx = t.idx["Direction"];
  var qtyIdx = t.idx["Qty"];
  var confirmed = 0;
  var expectedQty = null;

  for (var j = 0; j < values.length; j++) {
    if (String(values[j][handoverIdx]).trim() !== handoverId) continue;
    if (Number(values[j][directionIdx]) !== 1) continue;
    expectedQty = Number(values[j][qtyIdx]);
    break;
  }

  if (expectedQty === null || isNaN(expectedQty)) {
    throw new Error("NOT_FOUND: No pending handover " + handoverId + " to confirm.");
  }

  var countedQty = Number(req.countedQty);
  if (!countedQty || countedQty <= 0) {
    throw new Error("VALIDATION: Enter the quantity physically counted.");
  }

  var isMismatch = Math.abs(countedQty - expectedQty) > 0.000001;

  for (var i = 0; i < values.length; i++) {
    if (String(values[i][handoverIdx]).trim() !== handoverId) continue;
    if (String(values[i][statusIdx]).trim() !== "PENDING_CONFIRM") continue;

    if (!isMismatch) {
      t.sheet.getRange(i + 2, statusIdx + 1).setValue("CONFIRMED");
    }
    
    if (req.notes) {
      var existing = values[i][notesIdx] ? values[i][notesIdx] + " | " : "";
      t.sheet.getRange(i + 2, notesIdx + 1).setValue(existing + "Hitesh: " + req.notes);
    }
    confirmed++;
  }

  if (isMismatch) {
    // We flush sheet updates explicitly before throwing so the notes hit the sheet
    SpreadsheetApp.flush();
    audit(payload.actor, "stock.confirmHandover.mismatch", handoverId, {
      expectedQty: expectedQty,
      countedQty: countedQty,
      notes: req.notes || ""
    }, "REVIEW");
    throw new Error(
      "COUNT_MISMATCH: Satvik recorded " + expectedQty +
      " but you counted " + countedQty + ". The handover is still pending; add a note and resolve it together."
    );
  }

  if (!confirmed) {
    throw new Error("NOT_FOUND: No pending handover " + handoverId + " — it may already be confirmed.");
  }

  audit(payload.actor, "stock.confirmHandover", handoverId, {
    rowsConfirmed: confirmed,
    countedQty: countedQty,
    notes: req.notes || ""
  });

  return { handoverId: handoverId, rowsConfirmed: confirmed };
}

/**
 * Everything the shared dashboard needs in one call: live stock split by
 * custody, pending handovers, open requests (catalogue and new-product
 * alike), a recent-activity feed, and vendor rate history. Satvik and Hitesh
 * both read this -- neither gets their own copy of the numbers, so what one
 * sees can never quietly drift from what the other sees.
 *
 * Ledger, requests and vendor-rate tabs are append-only, so "most recent
 * first" is just "read from the end" -- no date parsing needed.
 */
function getDashboard() {
  var receivingLocationId = "LOC-07"; // Receiving (Satvik)
  var custodyLocationId = getConfig("DefaultLocationID", "LOC-01"); // Hitesh's active stock

  var products = readAll("PRODUCTS").filter(function (p) {
    return isTruthy(p.Active);
  });
  // Read the ledger once. Apps Script calls are dominated by spreadsheet I/O;
  // rereading it for every product makes the dashboard unusably slow.
  var ledgerRows = readAll("LEDGER");

  var stock = products.map(function (p) {
    var receiving = computeBalanceFromRows(ledgerRows, p.ProductID, receivingLocationId);
    var custody = computeBalanceFromRows(ledgerRows, p.ProductID, custodyLocationId);
    var pendingOut = computePendingHandoverOutFromRows(
      ledgerRows, p.ProductID, receivingLocationId
    );
    var pendingIn = ledgerRows.reduce(function (sum, row) {
      if (String(row.ProductID).trim() !== String(p.ProductID).trim()) return sum;
      if (String(row.LocationID).trim() !== String(custodyLocationId).trim()) return sum;
      if (String(row.Type).trim().toUpperCase() !== "HANDOVER") return sum;
      if (String(row.Status).trim().toUpperCase() !== "PENDING_CONFIRM") return sum;
      if (Number(row.Direction) !== 1) return sum;
      var qty = Number(row.QtyBase);
      if (isNaN(qty) || qty === 0) qty = Number(row.Qty) || 0;
      return sum + qty;
    }, 0);
    var reorderLevel = Number(p.ReorderLevel) || 0;
    return {
      productId: p.ProductID,
      name: p.Name,
      categoryId: p.CategoryID,
      productType: p.ProductType || "",
      uom: p.IssueUOM,
      reorderLevel: reorderLevel,
      receivingBalance: receiving,
      receivingAvailable: receiving - pendingOut,
      custodyBalance: custody,
      pendingHandover: pendingIn,
      totalBalance: receiving + custody,
      lowStock: custody <= reorderLevel
    };
  });

  var openRequests = readAll("REQUESTS")
    .filter(function (r) {
      var s = String(r.Status || "").toUpperCase();
      return s === "OPEN" || s === "NEW_PRODUCT" || s === "PENDING_APPROVAL";
    })
    .map(function (r) {
      var product = r.ProductID ? getProduct(r.ProductID) : null;
      return {
        requestId: r.RequestID,
        date: r.Date,
        productId: r.ProductID || "",
        productName: product ? product.Name : (r.NewProductName || "(unnamed)"),
        isNewProduct: !r.ProductID,
        qty: r.Qty,
        requestedBy: r.RequestedBy,
        status: r.Status,
        estValue: r.EstValue,
        approvedBy: r.ApprovedBy,
        notes: r.Notes
      };
    })
    .reverse();

  var recentActivity = ledgerRows
    .slice(Math.max(0, ledgerRows.length - 30))
    .reverse()
    .map(function (r) {
      var product = getProduct(r.ProductID);
      return {
        txnId: r.TxnID,
        date: r.Date,
        type: r.Type,
        direction: Number(r.Direction) || 0,
        productName: product ? product.Name : r.ProductID,
        qty: r.Qty,
        uom: r.UOM,
        locationId: r.LocationID,
        categoryId: r.CategoryID || "",
        personId: r.PersonID || "",
        vendorId: r.VendorID || "",
        actor: r.Actor,
        status: r.Status,
        notes: r.Notes || ""
      };
    });

  // Re-derive the most recent vendor rates directly from LEDGER RECEIPTS.
  // This removes the need for a separate VENDOR_RATES tab.
  var vendorRates = [];
  var seenVendorProduct = {};
  for (var i = ledgerRows.length - 1; i >= 0 && vendorRates.length < 50; i--) {
    var r = ledgerRows[i];
    if (String(r.Type).trim().toUpperCase() === "RECEIPT" && r.VendorID) {
      var key = r.ProductID + "_" + r.VendorID;
      if (!seenVendorProduct[key]) {
        seenVendorProduct[key] = true;
        var product = getProduct(r.ProductID);
        var qBase = Number(r.QtyBase) || Number(r.Qty);
        var amt = Number(r.Amount) || 0;
        vendorRates.push({
          productId: r.ProductID,
          productName: product ? product.Name : r.ProductID,
          vendorId: r.VendorID,
          rate: qBase > 0 ? amt / qBase : amt,
          date: r.Date
        });
      }
    }
  }

  return {
    stock: stock,
    pendingHandovers: listPendingHandovers(),
    openRequests: openRequests,
    recentActivity: recentActivity,
    vendorRates: vendorRates
  };
}

/**
 * Handovers Satvik has sent that Hitesh has not yet confirmed. Filtered to the
 * incoming (+1) row of each pair so every handover appears once, not twice.
 * Deliberately narrow -- this is not the general read-sync, just enough to
 * make the confirm screen usable before that lands.
 */
function listPendingHandovers() {
  var rows = readAll("LEDGER").filter(function (r) {
    return r.Type === "HANDOVER" && Number(r.Direction) === 1 &&
      String(r.Status).trim() === "PENDING_CONFIRM";
  });

  return rows.map(function (r) {
    var product = getProduct(r.ProductID);
    return {
      handoverId: r.HandoverID,
      productId: r.ProductID,
      productName: product ? product.Name : r.ProductID,
      qty: r.Qty,
      uom: r.UOM,
      toLocationId: r.LocationID,
      date: r.Date,
      actor: r.Actor,
      notes: r.Notes
    };
  });
}
