/**
 * Lets a hand-typed edit in PURCHASE_TRACKER (Unit Price or GST %) flow back into the real
 * LEDGER receipt it came from, instead of being a display-only correction that LEDGER never
 * sees. This is a simple onEdit trigger -- Apps Script calls it automatically for every edit
 * made in the Sheets UI, with no install step beyond the normal clasp push/deploy.
 *
 * Only ever writes back when the order has EXACTLY ONE live RECEIPT row in LEDGER. An order
 * split across several receipts has no single row an aggregate edit could mean, so those are
 * left alone and the editor is told to fix LEDGER directly.
 */
function onEdit(e) {
  try {
    var range = e.range;
    var sheet = range.getSheet();
    if (sheet.getName() !== 'PURCHASE_TRACKER' || range.getRow() < 2 || range.getNumRows() > 1 || range.getNumColumns() > 1) return;
    var col = range.getColumn();
    if (col !== 11 && col !== 14) return; // K = Unit Price (Rs), N = GST %
    if (e.value === undefined || e.value === '') return; // a clear is left alone, not pushed back

    var orderId = sheet.getRange(range.getRow(), 1).getValue();
    if (!orderId) return;

    var ss = e.source;
    var ledger = ss.getSheetByName('LEDGER');
    var headers = ledger.getRange(1, 1, 1, ledger.getLastColumn()).getValues()[0];
    var idx = {};
    headers.forEach(function (h, i) { idx[h] = i; });
    var lastRow = ledger.getLastRow();
    if (lastRow < 2) return;
    var data = ledger.getRange(2, 1, lastRow - 1, ledger.getLastColumn()).getValues();

    var matches = [];
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][idx.PORef]) === String(orderId) && data[i][idx.Type] === 'RECEIPT' && data[i][idx.Status] !== 'VOID') matches.push(i);
    }
    if (matches.length !== 1) {
      sheet.getRange(range.getRow(), col).setNote(matches.length + ' ledger receipts match ' + orderId + ' -- edit LEDGER directly, this cell will not update it.');
      return;
    }
    var ledgerRow = matches[0] + 2;
    var newVal = Number(e.value);
    if (!isFinite(newVal) || newVal < 0) return;

    var amount = Number(data[matches[0]][idx.Amount]) || 0;
    var gstPercent = Number(data[matches[0]][idx.GSTPercent]) || 0;

    if (col === 14) {
      if (newVal > 28) { sheet.getRange(range.getRow(), col).setNote('GST % must be 0-28 -- not written to LEDGER.'); return; }
      gstPercent = newVal;
    } else {
      var qty = Number(data[matches[0]][idx.Qty]) || 0;
      if (qty <= 0) return;
      amount = Math.round(newVal * qty * 100) / 100;
      ledger.getRange(ledgerRow, idx.Amount + 1).setValue(amount);
    }
    var gstAmount = Math.round(amount * gstPercent) / 100;
    if (col === 14) ledger.getRange(ledgerRow, idx.GSTPercent + 1).setValue(gstPercent);
    ledger.getRange(ledgerRow, idx.GSTAmount + 1).setValue(gstAmount);
    ledger.getRange(ledgerRow, idx.TotalAmount + 1).setValue(amount + gstAmount);
    sheet.getRange(range.getRow(), col).clearNote();

    try {
      var audit = ss.getSheetByName('AUDIT');
      if (audit) audit.appendRow(['AUD-' + Date.now(), new Date(), (e.user && e.user.getEmail && e.user.getEmail()) || Session.getActiveUser().getEmail() || 'sheet-edit',
        'tracker.edit', String(data[matches[0]][idx.TxnID]), 'PURCHASE_TRACKER ' + (col === 14 ? 'GST %' : 'Unit Price') + ' edited to ' + newVal + ' for ' + orderId, 'SUCCESS']);
    } catch (auditErr) { /* never let audit logging break the edit */ }
  } catch (err) {
    /* a simple trigger must never throw back into the UI */
  }
}
