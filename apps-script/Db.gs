/**
 * Sheet access by header name.
 *
 * Every read and write in this project goes through here. Nothing addresses a
 * column by position, because that is exactly what corrupted the previous
 * version: an 11-value row written positionally into a 30-column table put
 * ProductID under TxnDate and quantities under Direction.
 *
 * With name resolution you can reorder or insert columns in the spreadsheet and
 * the app keeps working. A renamed or missing column fails loudly instead.
 */

/** The spreadsheet the app reads and writes. Property wins; constant is the fallback. */
function getDbId() {
  var fromProps = PropertiesService.getScriptProperties().getProperty("SHEET_ID_DB");
  return (fromProps && fromProps.trim()) || TARGET_SHEET_ID;
}

/**
 * Per-request memo, switched on only by doPost. Opening the spreadsheet and
 * reading headers on every readAll made a single request take 5-25 seconds.
 * Admin functions run from the editor (setup, upgrades) stay uncached because
 * they change tabs and headers mid-run.
 */
var REQUEST_MEMO = false;
var MEMO_DB = null;
var MEMO_TABLES = {};
/** Row cache, enabled by doPost for read-only requests only (no writes can make it stale). */
var MEMO_ROWS = null;

function db() {
  if (!REQUEST_MEMO) return SpreadsheetApp.openById(getDbId());
  return MEMO_DB || (MEMO_DB = SpreadsheetApp.openById(getDbId()));
}

/**
 * Resolves a tab and its header positions.
 * @return {{sheet: Sheet, headers: string[], idx: Object}}
 */
function table(name) {
  if (REQUEST_MEMO && MEMO_TABLES[name]) return MEMO_TABLES[name];
  var sheet = db().getSheetByName(name);
  if (!sheet) {
    throw new Error(
      "SCHEMA_ERROR: Tab '" + name + "' not found. Run setupDatabase() once to build it."
    );
  }

  var lastCol = sheet.getLastColumn();
  if (!lastCol) {
    throw new Error("SCHEMA_ERROR: Tab '" + name + "' has no header row.");
  }

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
    return String(h).trim();
  });

  var idx = {};
  headers.forEach(function (h, i) {
    if (h) idx[h] = i;
  });

  var resolved = { sheet: sheet, headers: headers, idx: idx };
  if (REQUEST_MEMO) MEMO_TABLES[name] = resolved;
  return resolved;
}

/** Every data row of a tab as plain objects keyed by header name. */
function readAll(name) {
  if (MEMO_ROWS && MEMO_ROWS[name]) return MEMO_ROWS[name];
  var t = table(name);
  if (t.sheet.getLastRow() < 2) return [];

  var values = t.sheet
    .getRange(2, 1, t.sheet.getLastRow() - 1, t.headers.length)
    .getValues();

  var rows = values.map(function (row) {
    var record = {};
    t.headers.forEach(function (h, i) {
      if (h) record[h] = row[i];
    });
    return record;
  });
  if (MEMO_ROWS) MEMO_ROWS[name] = rows;
  return rows;
}

/**
 * Appends one record. Keys are header names; anything absent is left blank,
 * and an unknown key is a hard error rather than data silently vanishing.
 */
function appendRecord(name, record) {
  return appendRecords(name, [record])[0];
}

/** Appends several records in a single write, which also keeps them contiguous. */
function appendRecords(name, records) {
  if (!records.length) return [];

  var t = table(name);

  var rows = records.map(function (record) {
    var row = new Array(t.headers.length).fill("");
    Object.keys(record).forEach(function (key) {
      if (!(key in t.idx)) {
        throw new Error(
          "SCHEMA_ERROR: '" + name + "' has no column '" + key +
          "'. Columns are: " + t.headers.filter(String).join(", ")
        );
      }
      var value = record[key];
      row[t.idx[key]] = value === undefined || value === null ? "" : value;
    });
    return row;
  });

  t.sheet
    .getRange(t.sheet.getLastRow() + 1, 1, rows.length, t.headers.length)
    .setValues(rows);

  return records;
}

/** First record whose column equals value, or null. Case-insensitive on strings. */
function findRecord(name, column, value) {
  var target = String(value).trim().toLowerCase();
  var rows = readAll(name);

  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][column]).trim().toLowerCase() === target) return rows[i];
  }
  return null;
}

/** Accepts TRUE, "TRUE", "Yes", "y", 1 — the spreadsheet is inconsistent by nature. */
function isTruthy(value) {
  if (value === true) return true;
  if (value === false || value === "" || value === null || value === undefined) return false;
  var s = String(value).trim().toLowerCase();
  return s === "true" || s === "yes" || s === "y" || s === "1";
}

/** Short unique id with a domain prefix, e.g. TXN-4F2A9C31. */
function nextId(prefix) {
  return prefix + "-" + Utilities.getUuid().substring(0, 8).toUpperCase();
}
