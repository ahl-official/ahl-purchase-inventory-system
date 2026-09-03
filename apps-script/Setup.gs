/**
 * One-time migration: builds the AHL Flow schema in the target spreadsheet and
 * copies master data across from the original 21-tab "AHL" sheet.
 *
 * HOW TO RUN
 *   1. Open the Apps Script editor.
 *   2. Choose `setupDatabase` in the function dropdown and press Run.
 *   3. Approve the Drive/Sheets permission prompt the first time.
 *
 * Safe to run more than once. Tabs and headers are created only if missing, and
 * master data is re-synced by ID rather than appended, so a second run updates
 * rather than duplicating. Transactional tabs (LEDGER, REQUESTS, AUDIT) are
 * never touched once they hold rows.
 */

// Target: the sheet the app will actually use.
var TARGET_SHEET_ID = "16LFKuCYPOk46dWalYXHcoDYuqPf6mn213pfSp0ukEe4"; // AHL Flow DB

// Source: the original 21-tab sheet holding the seeded master data.
// Set to "" to build empty tabs without migrating anything.
var SOURCE_SHEET_ID = "1uXdnPiAvC5AH21jwCYVI6mEWQ7nyGXY8USdQky-RaKg"; // AHL

/**
 * The whole schema in one place. Every read and write in the app resolves
 * columns through these names, never by position.
 */
var SCHEMA = {
  PRODUCTS: [
    "ProductID", "Name", "CategoryID", "IssueUOM", "PurchaseUOM", "ConvFactor",
    "Cost", "GSTPercent", "VendorID", "ReorderLevel", "Active", "Notes",
    "ProductType"
  ],
  PEOPLE: [
    "UserID", "Email", "Name", "Role", "LocationID", "ApprovalLimit", "Active",
    "PasswordHash", "PasswordSalt"
  ],
  // Temporary simple login store. USER.UserID is the email entered at sign-in;
  // the role and location continue to come from PEOPLE.
  USER: ["UserID", "Password", "Active"],
  // Type is one of CATEGORY | VENDOR | LOCATION | UOM.
  LISTS: ["Type", "Code", "Name", "Extra", "Active"],
  LEDGER: [
    "TxnID", "Date", "Type", "Direction", "ProductID", "Qty", "UOM", "QtyBase",
    "LocationID", "CategoryID", "PersonID", "VendorID", "HandoverID",
    "PORef", "InvoiceNo", "Amount", "BillPhotoURL", "Actor", "Status", "Notes",
    "ProductPhotoURL", "ReceivedByUserId"
  ],
  REQUESTS: [
    "RequestID", "Date", "ProductID", "Qty", "RequestedBy", "Urgency",
    "EstValue", "Status", "ApprovedBy", "ApprovedAt", "Actor", "Notes",
    // Set only when ProductID is blank -- the floor asked for something that
    // is not in PRODUCTS yet. Status is NEW_PRODUCT for these rows, distinct
    // from OPEN, so they can't be accidentally treated as ready to order.
    "NewProductName", "Source"
  ],
  OPENING_COUNTS: [
    "CountID", "Date", "ProductID", "Qty", "LocationID", "CountedBy",
    "Status", "ReviewedBy", "ReviewedAt", "Notes"
  ],
  AUDIT: ["AuditID", "Timestamp", "Actor", "Action", "Ref", "Detail", "Result"],
  REPORT_CITY_TRANSFERS: [
    "Date", "Month", "Product Name", "Category", "From City", "To City",
    "Units Transferred", "Cost Per Unit", "Total Value", "Reason", "Approved By"
  ],
  REPORT_INVENTORY: [
    "Month", "City", "Business Unit", "Category", "Product Name", "Tracking Type",
    "Batch/Serial No.", "Opening Stock", "Purchases (Units)", "Transfer In",
    "Transfer Out", "Total Available (Auto)", "Units Consumed in Service (AHL)",
    "Units Consumed in Service (ALC)", "Units Consumed in Service (Shared)",
    "Units Sold as Retail (Auto from Revenue)", "Total Out (Auto)", "Closing Stock (Auto)",
    "Cost Per Unit (INR)", "Closing Stock Value (Auto)"
  ]
};

// Fallback config, written only when the source sheet has none.
var DEFAULT_CONFIG = [
  ["ApprovalThreshold", 5000, "Requests at or above this need management approval"],
  ["MatchToleranceAbs", 50, "Absolute tolerance when matching a bill to a receipt"],
  ["MatchTolerancePct", 2, "Percentage tolerance for the same"],
  ["BaseCurrency", "INR", ""],
  ["FYStart", "2026-04-01", "Financial year start"],
  ["FYEnd", "2027-03-31", "Financial year end"],
  ["AllowedEmailDomain", "americanhairline.com", "Login domain restriction"],
  ["HeadOfficeLocationID", "LOC-01", "Satvik's Head Office stock"],
  ["SalonFloorLocationID", "LOC-02", "Hitesh's Salon Floor stock"],
  ["DefaultLocationID", "LOC-02", "Salon Floor stock issued by Hitesh"]
];

function setupDatabase() {
  var target = SpreadsheetApp.openById(TARGET_SHEET_ID);
  var report = [];

  var TAB_COLORS = {
    PRODUCTS: "#1A73E8",
    PEOPLE: "#E37400",
    USER: "#0F9D58",
    LISTS: "#5F6368",
    LEDGER: "#0F9D58",
    REQUESTS: "#F4B400",
    OPENING_COUNTS: "#00897B",
    AUDIT: "#A142F4",
    REPORT_CITY_TRANSFERS: "#673AB7",
    REPORT_INVENTORY: "#3F51B5"
  };

  // 1. Create every tab with its header row and premium color.
  Object.keys(SCHEMA).forEach(function (name) {
    var created = ensureTab(target, name, SCHEMA[name], TAB_COLORS[name]);
    report.push(name + ": " + (created ? "created" : "already present"));
  });

  // 2. Migrate master data if a source is configured.
  if (SOURCE_SHEET_ID) {
    var source = SpreadsheetApp.openById(SOURCE_SHEET_ID);
    report.push("PRODUCTS rows: " + migrateProducts(source, target));
    report.push("PEOPLE rows: " + migratePeople(source, target));
    report.push("LISTS rows: " + migrateLists(source, target));
  } else {
    report.push("No SOURCE_SHEET_ID set - master tabs left empty.");
  }

  // 3. Remove the default empty Sheet1 if it is still untouched.
  var stray = target.getSheetByName("Sheet1");
  if (stray && stray.getLastRow() === 0 && target.getSheets().length > 1) {
    target.deleteSheet(stray);
    report.push("Removed empty Sheet1.");
  }

  var summary = report.join("\n");
  console.log(summary);
  return summary;
}

/** Creates a tab with a frozen, styled header row. Returns true if it was new. */
function ensureTab(ss, name, headers, bgColor) {
  var sheet = ss.getSheetByName(name);
  var isNew = false;

  if (!sheet) {
    sheet = ss.insertSheet(name);
    isNew = true;
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    // Tab exists: add any header this version of the schema introduced,
    // without disturbing the columns already there.
    var existing = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    headers.forEach(function (h) {
      if (existing.indexOf(h) === -1) {
        sheet.getRange(1, sheet.getLastColumn() + 1).setValue(h);
      }
    });
  }

  var headerRange = sheet.getRange(1, 1, 1, sheet.getLastColumn());
  headerRange
    .setFontWeight("bold")
    .setBackground(bgColor || "#1F4E56")
    .setFontColor("#FFFFFF")
    .setFontFamily("Montserrat")
    .setVerticalAlignment("middle")
    .setHorizontalAlignment("center");
    
  sheet.setRowHeight(1, 36);
  sheet.setFrozenRows(1);
  sheet.setTabColor(bgColor || "#1F4E56");

  // Optional: Auto-resize columns for better UX, but only for newly added columns
  // For safety, we just set a decent default width for headers if new
  if (isNew) {
    for (var i = 1; i <= headers.length; i++) {
      sheet.setColumnWidth(i, 160);
    }
  }

  return isNew;
}

/** Header name -> 0-based index, for reading a source tab safely. */
function headerMap(values) {
  var map = {};
  (values[0] || []).forEach(function (h, i) {
    map[String(h).trim()] = i;
  });
  return map;
}

/** Replaces a tab's data rows, keeping the header. */
function writeRows(ss, tabName, rows) {
  var sheet = ss.getSheetByName(tabName);
  var width = sheet.getLastColumn();

  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, width).clearContent();
  }
  if (!rows.length) return 0;

  // Pad every row to the sheet width so setValues does not throw.
  var padded = rows.map(function (r) {
    var copy = r.slice(0, width);
    while (copy.length < width) copy.push("");
    return copy;
  });

  sheet.getRange(2, 1, padded.length, width).setValues(padded);
  return padded.length;
}

function migrateProducts(source, target) {
  var sheet = source.getSheetByName("MASTER_PRODUCT");
  if (!sheet) return 0;

  var data = sheet.getDataRange().getValues();
  var h = headerMap(data);
  var rows = [];

  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!r[h["ProductID"]]) continue;
    rows.push([
      r[h["ProductID"]],
      r[h["ProductName"]],
      r[h["CategoryID"]],
      r[h["IssueUOM"]],
      r[h["PurchaseUOM"]],
      r[h["ConversionFactor"]] || 1,
      r[h["CurrentAvgCost"]] || r[h["StandardCost"]] || 0,
      r[h["GSTPercent"]] || 0,
      r[h["DefaultVendorID"]],
      r[h["ReorderLevel"]] || 0,
      normaliseBool(r[h["Active"]]),
      r[h["Notes"]] || "",
      h["ProductType"] !== undefined ? r[h["ProductType"]] : "Consumable"
    ]);
  }

  return writeRows(target, "PRODUCTS", rows);
}

function migratePeople(source, target) {
  var sheet = source.getSheetByName("MASTER_USER");
  if (!sheet) return 0;

  var data = sheet.getDataRange().getValues();
  var h = headerMap(data);
  var rows = [];
  var existingPasswordsById = {};
  var existingPasswordsByEmail = {};
  var targetSheet = target.getSheetByName("PEOPLE");

  // setupDatabase() is intentionally rerunnable. Preserve credentials that
  // were provisioned after the first migration instead of blanking them when
  // the PEOPLE master data is refreshed from the source workbook.
  if (targetSheet && targetSheet.getLastRow() > 1) {
    var targetData = targetSheet.getDataRange().getValues();
    var targetHeaders = headerMap(targetData);
    for (var existingIndex = 1; existingIndex < targetData.length; existingIndex++) {
      var existingRow = targetData[existingIndex];
      var existingCredentials = {
        hash: targetHeaders.PasswordHash === undefined ? "" : existingRow[targetHeaders.PasswordHash],
        salt: targetHeaders.PasswordSalt === undefined ? "" : existingRow[targetHeaders.PasswordSalt],
        location: targetHeaders.LocationID === undefined ? "" : existingRow[targetHeaders.LocationID]
      };
      var existingId = String(existingRow[targetHeaders.UserID] || "").trim();
      var existingEmail = String(existingRow[targetHeaders.Email] || "").trim().toLowerCase();
      if (existingId) existingPasswordsById[existingId] = existingCredentials;
      if (existingEmail) existingPasswordsByEmail[existingEmail] = existingCredentials;
    }
  }

  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!r[h["UserID"]]) continue;

    // Several source rows have a blank Email, which would make every login for
    // that person fail. Derive a placeholder so the gap is visible, not silent.
    var email = String(r[h["Email"]] || "").trim();
    var name = String(r[h["DisplayName"]] || "").trim();
    if (!email && name) {
      email = "MISSING-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    }

    var locations = String(r[h["AllowedLocations"]] || "").trim();
    var userId = String(r[h["UserID"]] || "").trim();
    var savedCredentials = existingPasswordsById[userId] ||
      existingPasswordsByEmail[email.toLowerCase()] || { hash: "", salt: "", location: "" };

    rows.push([
      userId,
      email,
      name,
      r[h["Roles"]],
      savedCredentials.location || (locations === "ALL" ? "ALL" : locations.split(",")[0] || ""),
      r[h["ApprovalLimit"]] || 0,
      normaliseBool(r[h["Active"]]),
      savedCredentials.hash,
      savedCredentials.salt
    ]);
  }

  return writeRows(target, "PEOPLE", rows);
}

/** Folds the four small master tabs into a single LISTS tab. */
function migrateLists(source, target) {
  var rows = [];

  collectList(source, "MASTER_CATEGORY", "CATEGORY", "CategoryID", "CategoryName", "BusinessUnit", rows);
  collectList(source, "MASTER_VENDOR", "VENDOR", "VendorID", "VendorName", "City", rows);
  collectList(source, "MASTER_LOCATION", "LOCATION", "LocationID", "LocationName", "City", rows);
  collectList(source, "MASTER_UOM", "UOM", "UOMCode", "UOMName", "UOMType", rows);

  // Migrate Configs into LISTS
  var configSheet = source.getSheetByName("MASTER_CONFIG");
  if (configSheet) {
    var data = configSheet.getDataRange().getValues();
    var h = headerMap(data);
    for (var i = 1; i < data.length; i++) {
      var r = data[i];
      if (!r[h["Key"]]) continue;
      rows.push(["SETTING", r[h["Key"]], r[h["Value"]], r[h["Description"]] || "", true]);
    }
  } else {
    DEFAULT_CONFIG.forEach(function(c) {
      rows.push(["SETTING", c[0], c[1], c[2], true]);
    });
  }

  return writeRows(target, "LISTS", rows);
}

function collectList(source, tabName, type, idCol, nameCol, extraCol, out) {
  var sheet = source.getSheetByName(tabName);
  if (!sheet) return;

  var data = sheet.getDataRange().getValues();
  var h = headerMap(data);

  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!r[h[idCol]]) continue;
    out.push([
      type,
      r[h[idCol]],
      r[h[nameCol]],
      h[extraCol] !== undefined ? r[h[extraCol]] : "",
      h["Active"] !== undefined ? normaliseBool(r[h["Active"]]) : true
    ]);
  }
}

/**
 * Now that CONFIG tab is deleted, we merge config rows into the unified LISTS tab.
 */
function migrateConfig(source, target) {
  // Configs are merged into LISTS tab inside migrateLists now, so this is unused.
}

/**
 * The source sheet stores Active as a real boolean TRUE, while the original
 * validation code compared against the string "Yes". Normalising here means the
 * app only ever has to understand one representation.
 */
function normaliseBool(value) {
  if (value === true) return true;
  if (value === false) return false;
  var s = String(value).trim().toLowerCase();
  return s === "true" || s === "yes" || s === "y" || s === "1";
}
