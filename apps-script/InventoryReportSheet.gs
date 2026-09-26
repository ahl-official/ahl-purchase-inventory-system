/**
 * Keeps "AHL Flow - Inventory Report (Finance format)" up to date: one row per month x city x product,
 * in the column order of finance's Inventory tab. Run from the editor (never from the web app):
 *
 *   setupInventoryReportSheet()      once: fills the sheet now and starts the hourly refresh
 *   refreshInventoryReportSheet()    any time: rebuilds the sheet from the ledger
 *
 * The sheet is rebuilt from scratch each time, so it never drifts and nobody should type in it.
 */
var REPORT_SHEET_ID = "1J8rXFj01n5kIj-dBAjttkNlIv-KcJekSnM3Un-55JFU";
var REPORT_FIRST_ROW = 4;
var REPORT_HEADERS = ["Month", "City", "Business Unit", "Category", "Product Name", "Tracking Type", "Batch/Serial No.", "Opening Stock", "Purchases (Units)", "Transfer In", "Transfer Out", "Total Available (Auto)", "Units Consumed in Service (AHL)", "Units Consumed in Service (ALC)", "Units Consumed in Service (Shared)", "Units Sold as Retail (Auto from Revenue)", "Total Out (Auto)", "Closing Stock (Auto)", "Cost Per Unit (INR)", "Closing Stock Value (Auto)", "Retail Mapping Required?", "Revenue Product Mapping (Exact)", "Mapping Status (Auto)", "Mapping Note", "Revenue Product Options (Auto)", "Damaged / adjusted (info)", "Closing in app (check)"];

function setupInventoryReportSheet() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "refreshInventoryReportSheet") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("refreshInventoryReportSheet").timeBased().everyHours(1).create();
  return "Hourly refresh started. " + refreshInventoryReportSheet();
}

function refreshInventoryReportSheet() {
  // ponytail: read each tab once and reuse it for every month; nothing in this run writes those tabs.
  REQUEST_MEMO = true;
  MEMO_ROWS = {};
  var tz = Session.getScriptTimeZone(), first = "";
  readAll("LEDGER").forEach(function (l) {
    if (!l.Date || l.Status === "VOID") return;
    var m = Utilities.formatDate(new Date(l.Date), tz, "yyyy-MM");
    if (!first || m < first) first = m;
  });
  var now = Utilities.formatDate(new Date(), tz, "yyyy-MM"), values = [];
  for (var m = first || now; m <= now; m = nextMonth_(m)) {
    getInventoryReport({ data: { month: m } }).rows.forEach(function (x) {
      var r = REPORT_FIRST_ROW + values.length, retail = x.type === "Retail" || x.type === "Both";
      values.push([
        new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 1), x.city, x.businessUnit, x.category, x.product, "Bulk", "",
        x.opening, x.purchases, x.transferIn || "", x.transferOut || "",
        "=H" + r + "+N(I" + r + ")+N(J" + r + ")-N(K" + r + ")",
        x.consumedAHL || "", x.consumedALC || "", x.consumedShared || "", "",
        "=N(M" + r + ")+N(N" + r + ")+N(O" + r + ")+N(P" + r + ")",
        "=L" + r + "-Q" + r + "+N(Z" + r + ")",
        x.costPerUnit, "=R" + r + "*N(S" + r + ")",
        retail ? "Yes" : "No", "",
        '=IF(U' + r + '<>"Yes","Service consumption only",IF(V' + r + '="","Mapping required (connect to Revenue Tracker)","Mapped"))',
        retail ? "Retail units sold come from the Revenue Tracker once connected." : "Tracked through service-consumption columns M:O; retail matching is disabled.",
        "", x.adjustments || "", x.closing
      ]);
    });
  }
  var book = SpreadsheetApp.openById(REPORT_SHEET_ID), cols = REPORT_HEADERS.length;
  book.setSpreadsheetTimeZone(tz); // otherwise 1 Sep 00:00 India time shows as 31 Aug in a sheet set to another zone
  var sheet = book.getSheets()[0];
  sheet.setName("Inventory");
  sheet.clear();
  if (sheet.getMaxColumns() < cols) sheet.insertColumnsAfter(sheet.getMaxColumns(), cols - sheet.getMaxColumns());
  var need = REPORT_FIRST_ROW + values.length;
  if (sheet.getMaxRows() < need) sheet.insertRowsAfter(sheet.getMaxRows(), need - sheet.getMaxRows());
  sheet.getRange(1, 1).setValue("AHL Flow - Inventory (finance format). Filled automatically from the app every hour. Please do not type in this sheet.").setFontWeight("bold");
  sheet.getRange(2, 1).setValue("Last refreshed " + Utilities.formatDate(new Date(), tz, "dd MMM yyyy HH:mm") + ". Retail units sold, batch/serial and revenue mapping are filled by finance later. Closing = Total Available - Total Out + damaged/adjusted.");
  sheet.getRange(3, 1, 1, cols).setValues([REPORT_HEADERS]).setFontWeight("bold").setBackground("#0f766e").setFontColor("#ffffff").setWrap(true).setVerticalAlignment("middle");
  sheet.setFrozenRows(3);
  sheet.setColumnWidths(1, cols, 120);
  sheet.setColumnWidth(5, 260);
  if (values.length) {
    sheet.getRange(REPORT_FIRST_ROW, 1, values.length, cols).setValues(values);
    sheet.getRange(REPORT_FIRST_ROW, 1, values.length, 1).setNumberFormat("mmm-yy");
  }
  return "Inventory report refreshed: " + values.length + " rows.";
}

function nextMonth_(m) {
  var y = Number(m.slice(0, 4)), mo = Number(m.slice(5));
  return mo === 12 ? (y + 1) + "-01" : y + "-" + ("0" + (mo + 1)).slice(-2);
}
