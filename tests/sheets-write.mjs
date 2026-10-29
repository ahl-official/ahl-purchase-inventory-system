// Isolated checks for the service-account write path (src/lib/sheets-write.ts): no
// real network, no credentials, no production data. Mocks the Sheets API + OAuth token
// endpoint with an in-memory store, then exercises writeDirect exactly like the
// apps-script tests exercise the .gs handlers directly. A throwaway RSA keypair
// generated per run stands in for the service-account key -- the mocked fetch
// intercepts the token exchange before any signature is ever checked.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ts from 'typescript';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function compile(relPath) {
  return ts.transpileModule(
    fs.readFileSync(new URL(relPath, import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }
  ).outputText;
}
const sheetsDirectCompiled = compile('../src/lib/sheets-direct.ts');
const sheetsWriteCompiled = compile('../src/lib/sheets-write.ts');
const movementHistoryCompiled = compile('../src/lib/movement-history.ts');
const driveWriteCompiled = compile('../src/lib/drive-write.ts');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const FAKE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });

// An in-memory spreadsheet: { TAB: { headers: string[], rows: unknown[][] } }, plus a tiny
// in-memory Drive (folders + uploaded files) for drive-write.ts's calls.
function sheetsMock(tabs) {
  const calls = { append: [], update: [], driveUpload: [], drivePermission: [] };
  const drive = { folders: {}, nextId: 1 };
  function tabName(url) { return decodeURIComponent(url.match(/\/values\/([^!]+)!/)[1]); }
  async function fetchImpl(url, init) {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'TEST_TOKEN', expires_in: 3600 }) };
    }
    if (u.includes('/upload/drive/v3/files')) {
      const id = `FILE-${drive.nextId++}`;
      calls.driveUpload.push({ id, contentType: (init.headers || {})['Content-Type'] || init.headers.get?.('Content-Type') });
      return { ok: true, status: 200, json: async () => ({ id, webViewLink: `https://drive.google.com/file/d/${id}/view` }) };
    }
    if (u.includes('/drive/v3/files') && u.includes('/permissions')) {
      calls.drivePermission.push({ url: u, body: init.body });
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (u.includes('/drive/v3/files')) {
      const method = (init && init.method) || 'GET';
      if (method === 'GET') {
        const q = decodeURIComponent(new URL(u).searchParams.get('q') || '');
        const nameMatch = q.match(/name = '([^']*)'/);
        const parentMatch = q.match(/'([^']+)' in parents/);
        const name = nameMatch ? nameMatch[1] : null;
        const parent = parentMatch ? parentMatch[1] : null;
        const match = Object.values(drive.folders).find((f) => f.name === name && (f.parent || null) === parent);
        return { ok: true, status: 200, json: async () => ({ files: match ? [{ id: match.id, name: match.name }] : [] }) };
      }
      if (method === 'POST') {
        const body = JSON.parse(init.body);
        const id = `FOLDER-${drive.nextId++}`;
        drive.folders[id] = { id, name: body.name, parent: (body.parents || [])[0] || null };
        return { ok: true, status: 200, json: async () => ({ id }) };
      }
    }
    // sheets-direct.ts's loadContext() reads every tab in one batchGet call, unlike
    // sheets-write.ts's per-tab reads -- the mock has to answer both shapes.
    if (u.includes(':batchGet')) {
      const ranges = [...new URL(u).searchParams.getAll('ranges')];
      const valueRanges = ranges.map((r) => { const t = tabs[r.split('!')[0]]; return { values: t ? [t.headers, ...t.rows] : [] }; });
      return { ok: true, status: 200, json: async () => ({ valueRanges }) };
    }
    const method = (init && init.method) || 'GET';
    const name = tabName(u);
    const tab = tabs[name];
    if (!tab) return { ok: false, status: 404, json: async () => ({ error: { message: `No tab ${name}` } }) };
    if (method === 'GET') return { ok: true, status: 200, json: async () => ({ values: [tab.headers, ...tab.rows] }) };
    if (method === 'POST' && u.includes(':append')) {
      const body = JSON.parse(init.body);
      calls.append.push({ tab: name, values: body.values });
      tab.rows.push(...body.values);
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (method === 'PUT') {
      const body = JSON.parse(init.body);
      const headerRange = u.match(/!([A-Z]+)1\?/);
      if (headerRange) { tab.headers.push(body.values[0][0]); return { ok: true, status: 200, json: async () => ({}) }; }
      const rowMatch = u.match(/!A(\d+):/);
      const row = Number(rowMatch[1]);
      calls.update.push({ tab: name, row, values: body.values[0] });
      tab.rows[row - 2] = body.values[0];
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: false, status: 400, json: async () => ({ error: { message: `Unhandled ${method} ${u}` } }) };
  }
  return { fetchImpl, tabs, calls };
}

// Each compiled module runs in its own function wrapper (like Node's CJS loader does)
// instead of sharing one vm context's top-level scope -- otherwise two modules that
// both `require("node:crypto")` collide on the transpiled `const node_crypto_1 = ...`.
function loadModule(compiled, requireImpl, fetchImpl, filename) {
  const sandboxModule = { exports: {} };
  const script = new vm.Script(`(function(module,exports,require,process,console,fetch,Buffer,URL,URLSearchParams){\n${compiled}\n})`, { filename });
  const wrapped = script.runInThisContext();
  wrapped(sandboxModule, sandboxModule.exports, requireImpl, process, console, fetchImpl, Buffer, URL, URLSearchParams);
  return sandboxModule.exports;
}

function fixture({ role = 'PurchaseCoordinator', active = true } = {}) {
  const tabs = {
    PRODUCTS: {
      headers: ['ProductID', 'Name', 'CategoryID', 'IssueUOM', 'PurchaseUOM', 'ConvFactor', 'Cost', 'GSTPercent', 'VendorID', 'ReorderLevel', 'Active', 'Notes', 'ProductType'],
      rows: [
        ['PRD-0001', 'Shampoo', 'CAT-1', 'ML', 'BOTTLE', 500, 2, 0.18, 'VND-1', 5, true, '', 'Consumable'],
        ['PRD-0002', 'Hair Oil', 'CAT-1', 'ML', 'BOTTLE', 200, 1, 0.18, 'VND-1', 2, true, '', 'Retail'],
      ],
    },
    PEOPLE: {
      headers: ['UserID', 'Email', 'Name', 'Role', 'LocationID', 'Active'],
      rows: [
        ['U1', 'purchase@ahl.com', 'Satvik', role, 'LOC-01', active],
        ['U2', 'tech@ahl.com', 'Tech One', 'Technician', 'LOC-01', true],
        ['U3', 'hitesh@ahl.com', 'Hitesh', 'ProductDistributor', 'LOC-02', true],
      ],
    },
    LISTS: {
      headers: ['Type', 'Code', 'Name', 'Extra', 'Active'],
      rows: [
        ['VENDOR', 'VND-1', 'Vela (Well Vibes)', '', true], ['CATEGORY', 'CAT-1', 'Hair Care', '', true],
        ['LOCATION', 'LOC-02', 'Salon Floor', 'Mumbai', true], ['LOCATION', 'LOC-03', 'Delhi Studio', 'Delhi', true],
      ],
    },
    LEDGER: {
      headers: ['TxnID', 'Date', 'Type', 'Direction', 'ProductID', 'Qty', 'UOM', 'QtyBase', 'LocationID', 'VendorID', 'PORef', 'InvoiceNo', 'Amount', 'GSTAmount', 'GSTPercent', 'ReceiptID', 'Actor', 'Status', 'Notes', 'BillPhotoURL', 'ProductPhotoURL', 'PersonID', 'HandoverID', 'CategoryID', 'BusinessUnit', 'ReceivedByUserId'],
      rows: [],
    },
    PURCHASE_ORDERS: { headers: ['OrderID', 'Date', 'ProductID', 'VendorID', 'QtyOrdered', 'UOM', 'RequestID', 'Status', 'Actor', 'Notes', 'DeliveryLocationID', 'UnitPrice', 'BatchID'], rows: [] },
    REQUESTS: {
      headers: ['RequestID', 'Date', 'ProductID', 'NewProductName', 'Qty', 'RequestedBy', 'Urgency', 'EstValue', 'Status', 'ApprovedBy', 'ApprovedAt', 'Actor', 'Notes', 'Source'],
      rows: [
        ['REQ-1', 0, 'PRD-0001', '', 1, 'U1', 'Normal', 2, 'OPEN', '', '', 'purchase@ahl.com', '', 'APP'],
        ['REQ-2', 0, 'PRD-0001', '', 3, 'U1', 'Normal', 6, 'PENDING_APPROVAL', '', '', 'purchase@ahl.com', '', 'APP'],
      ],
    },
    OPENING_COUNTS: {
      headers: ['CountID', 'Date', 'ProductID', 'Qty', 'LocationID', 'CountedBy', 'Status', 'Notes', 'QtyOrdered', 'QtyReceived', 'CountUOM', 'ReviewedBy', 'ReviewedAt'],
      rows: [],
    },
    OPERATIONS: { headers: ['OperationID', 'Date', 'Actor', 'Action', 'Status', 'Result'], rows: [] },
    AUDIT: { headers: ['AuditID', 'Timestamp', 'Actor', 'Action', 'Ref', 'Detail', 'Result'], rows: [] },
  };
  const mock = sheetsMock(tabs);

  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = Buffer.from(JSON.stringify({ client_email: 'test@test.iam.gserviceaccount.com', private_key: FAKE_PRIVATE_KEY })).toString('base64');
  process.env.GOOGLE_SHEET_ID = 'TEST_SHEET';

  // The real movement-history.ts (pure functions, no external deps) -- both sheets-direct.ts
  // (recentHistory) and sheets-write.ts (historyKey, for receipt.edit/delete's invoice grouping)
  // need the actual logic here, not a stub, so it's compiled and shared like the other two.
  const movementHistoryExports = loadModule(movementHistoryCompiled, require, mock.fetchImpl, 'movement-history.js');
  const baseRequire = (path) => (path === './movement-history' ? movementHistoryExports : require(path));
  const sheetsDirectExports = loadModule(sheetsDirectCompiled, baseRequire, mock.fetchImpl, 'sheets-direct.js');
  // drive-write.ts does `require("./sheets-direct")` too, for requireEnv -- same interception.
  const driveRequire = (path) => (path === './sheets-direct' ? sheetsDirectExports : require(path));
  const driveWriteExports = loadModule(driveWriteCompiled, driveRequire, mock.fetchImpl, 'drive-write.js');
  // sheets-write.ts does `require("./sheets-direct")` / `require("./movement-history")` /
  // `require("./drive-write")` -- intercept those specifiers and hand back the already-loaded
  // modules, without touching disk.
  const writeRequire = (path) => (
    path === './sheets-direct' ? sheetsDirectExports :
    path === './movement-history' ? movementHistoryExports :
    path === './drive-write' ? driveWriteExports : require(path)
  );
  const sheetsWrite = loadModule(sheetsWriteCompiled, writeRequire, mock.fetchImpl, 'sheets-write.js');

  return { mock, tabs, writeDirect: sheetsWrite.writeDirect, sheetsDirect: sheetsDirectExports };
}

const opId = () => 'op-' + crypto.randomBytes(8).toString('hex');

// Builds a tab row from a { Header: value } object instead of a positional array, so tests
// don't have to keep counting column indices whenever a tab's header list changes.
function rowFor(tabs, name, obj) {
  return tabs[name].headers.map((h) => (h in obj ? obj[h] : ''));
}

const IST_OFFSET_MS = 330 * 60 * 1000;
function dateToSerialTest(d) { return (d.getTime() + IST_OFFSET_MS) / 86400000 + 25569; }

// Two purchase orders (PO-A / PO-B) each with one already-received RECEIPT line, both on the
// same invoice (shared InvoiceNo + VendorID + date) so they group as one editable receipt --
// mirrors the PO1/PO2 + R1/R2 fixture in tests/entry-changes.mjs for the Apps Script version.
function seedReceiptPair(tabs) {
  const dateSerial = dateToSerialTest(new Date('2026-10-20T06:30:00.000Z'));
  tabs.PURCHASE_ORDERS.rows.push(rowFor(tabs, 'PURCHASE_ORDERS', { OrderID: 'PO-A', Date: dateSerial, ProductID: 'PRD-0001', VendorID: 'VND-1', QtyOrdered: 10, UOM: 'BOTTLE', Status: 'ORDERED', Actor: 'purchase@ahl.com', DeliveryLocationID: 'LOC-01', BatchID: 'PO-A' }));
  tabs.PURCHASE_ORDERS.rows.push(rowFor(tabs, 'PURCHASE_ORDERS', { OrderID: 'PO-B', Date: dateSerial, ProductID: 'PRD-0002', VendorID: 'VND-1', QtyOrdered: 10, UOM: 'BOTTLE', Status: 'ORDERED', Actor: 'purchase@ahl.com', DeliveryLocationID: 'LOC-01', BatchID: 'PO-B' }));
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'R1', Date: dateSerial, Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0001', Qty: 5, UOM: 'BOTTLE', QtyBase: 2500, LocationID: 'LOC-01', VendorID: 'VND-1', PORef: 'PO-A', InvoiceNo: 'INV1', Amount: 500, GSTAmount: 90, ReceiptID: 'BATCH1', Actor: 'purchase@ahl.com', Status: 'RECEIVED', Notes: 'Original' }));
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'R2', Date: dateSerial, Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0002', Qty: 2, UOM: 'BOTTLE', QtyBase: 400, LocationID: 'LOC-01', VendorID: 'VND-1', PORef: 'PO-B', InvoiceNo: 'INV1', Amount: 20, GSTAmount: 0, ReceiptID: 'BATCH1', Actor: 'purchase@ahl.com', Status: 'RECEIVED', Notes: '' }));
  return { dateSerial };
}

await (async () => {
  const { writeDirect, tabs, mock } = fixture();
  const id1 = opId();
  const result = await writeDirect('list.add', 'purchase@ahl.com', { type: 'VENDOR', name: 'New Vendor', operationId: id1 });
  assert.match(result.id, /^VND-/);
  assert.equal(result.name, 'New Vendor');
  assert.equal(tabs.LISTS.rows.length, 5); // 4 baseline (vendor + category + 2 locations) + 1 new
  assert.equal(tabs.OPERATIONS.rows.find(r => r[0] === id1)[4], 'COMPLETED');
  assert.equal(mock.calls.append.some(c => c.tab === 'AUDIT'), true);
})();

await (async () => {
  // Case-insensitive dedupe against an existing active entry returns the existing row, no new write.
  const { writeDirect, tabs } = fixture();
  const result = await writeDirect('list.add', 'purchase@ahl.com', { type: 'VENDOR', name: 'vela (well vibes)', operationId: opId() });
  assert.equal(result.id, 'VND-1');
  assert.equal(tabs.LISTS.rows.length, 4); // baseline only, no new write
})();

await (async () => {
  // Replaying the same operationId returns the cached result instead of writing again.
  const { writeDirect, tabs } = fixture();
  const id = opId();
  const first = await writeDirect('list.add', 'purchase@ahl.com', { type: 'VENDOR', name: 'Repeat Co', operationId: id });
  const second = await writeDirect('list.add', 'purchase@ahl.com', { type: 'VENDOR', name: 'Repeat Co', operationId: id });
  assert.deepEqual(first, second);
  assert.equal(tabs.LISTS.rows.length, 5); // only the first call actually wrote
})();

for (const data of [{ type: 'VENDOR', name: 'X' }, { type: 'NOT_A_TYPE', name: 'Valid Name' }]) {
  const { writeDirect, tabs } = fixture();
  await assert.rejects(() => writeDirect('list.add', 'purchase@ahl.com', { ...data, operationId: opId() }), /VALIDATION/);
  assert.equal(tabs.LISTS.rows.length, 4); // nothing written on a rejected validation
}

await (async () => {
  // An inactive/wrong-role actor is refused before anything is read or written.
  const { writeDirect, tabs } = fixture({ role: 'Technician' });
  await assert.rejects(() => writeDirect('list.add', 'purchase@ahl.com', { type: 'VENDOR', name: 'Nope', operationId: opId() }), /FORBIDDEN/);
  assert.equal(tabs.LISTS.rows.length, 4);
})();

// (The "action not yet ported" fallback is now exercised by stock.receive's photo-attached
// case further down -- every other action in this file is ported, so there's no longer a
// whole action left to demonstrate the generic case with.)

// ---- product.create ----
await (async () => {
  const { writeDirect, tabs, mock } = fixture();
  const result = await writeDirect('product.create', 'purchase@ahl.com', {
    name: 'Conditioner', productType: 'Consumable', purchaseUom: 'BOTTLE', issueUom: 'ML', convFactor: '250',
    categoryId: 'CAT-1', vendorId: 'VND-1', cost: '10', gstPercent: '18', reorderLevel: '2', operationId: opId(),
  });
  assert.equal(result.productId, 'PRD-0003'); // sequential, after the fixture's PRD-0001/PRD-0002
  assert.equal(tabs.PRODUCTS.rows.length, 3);
  assert.equal(mock.calls.append.some(c => c.tab === 'AUDIT' && c.values[0].includes('product.create')), true);
})();
await (async () => {
  const { writeDirect } = fixture();
  await assert.rejects(() => writeDirect('product.create', 'purchase@ahl.com', { name: 'Shampoo', productType: 'Consumable', purchaseUom: 'BOTTLE', issueUom: 'ML', convFactor: '1', categoryId: 'CAT-1', operationId: opId() }), /DUPLICATE/);
})();
await (async () => {
  const { writeDirect } = fixture();
  await assert.rejects(() => writeDirect('product.create', 'purchase@ahl.com', { name: 'New One', productType: 'Consumable', purchaseUom: 'BOTTLE', issueUom: 'ML', convFactor: '1', categoryId: 'NOPE', operationId: opId() }), /VALIDATION/);
})();

// ---- product.setVendor ----
await (async () => {
  const { writeDirect, tabs } = fixture();
  const result = await writeDirect('product.setVendor', 'purchase@ahl.com', { productId: 'PRD-0001', vendorId: 'VND-1', operationId: opId() });
  assert.equal(result.vendorId, 'VND-1');
  assert.equal(tabs.PRODUCTS.rows[0][8], 'VND-1'); // VendorID column
})();
await (async () => {
  const { writeDirect } = fixture();
  await assert.rejects(() => writeDirect('product.setVendor', 'purchase@ahl.com', { productId: 'PRD-9999', vendorId: 'VND-1', operationId: opId() }), /VALIDATION/);
})();

// ---- product.editUnit ----
await (async () => {
  // Type-only change: no unit fields sent, conversion/units untouched.
  const { writeDirect, tabs } = fixture();
  const result = await writeDirect('product.editUnit', 'purchase@ahl.com', { productId: 'PRD-0001', productType: 'Both', operationId: opId() });
  assert.equal(result.changed, true);
  assert.equal(tabs.PRODUCTS.rows[0][12], 'Both'); // ProductType column
  assert.equal(tabs.PRODUCTS.rows[0][4], 'BOTTLE'); // PurchaseUOM untouched
})();
await (async () => {
  // Unit change with a matching `expected` snapshot succeeds -- no ledger-history guard (deliberately removed).
  const { writeDirect, tabs } = fixture();
  const result = await writeDirect('product.editUnit', 'purchase@ahl.com', {
    productId: 'PRD-0001', purchaseUom: 'BOTTLE', issueUom: 'ML', convFactor: '450',
    expected: { productType: 'Consumable', purchaseUom: 'BOTTLE', issueUom: 'ML', convFactor: 500 }, operationId: opId(),
  });
  assert.equal(result.changed, true);
  assert.equal(tabs.PRODUCTS.rows[0][5], 450); // ConvFactor column
})();
await (async () => {
  // A stale `expected` (someone else already changed the product) is refused.
  const { writeDirect, tabs } = fixture();
  await assert.rejects(() => writeDirect('product.editUnit', 'purchase@ahl.com', {
    productId: 'PRD-0001', purchaseUom: 'BOTTLE', issueUom: 'ML', convFactor: '450',
    expected: { productType: 'Consumable', purchaseUom: 'BOTTLE', issueUom: 'ML', convFactor: 999 }, operationId: opId(),
  }), /STALE_ENTRY/);
  assert.equal(tabs.PRODUCTS.rows[0][5], 500); // unchanged
})();
await (async () => {
  // Nothing actually different -> no-op, no write.
  const { writeDirect, mock } = fixture();
  const result = await writeDirect('product.editUnit', 'purchase@ahl.com', { productId: 'PRD-0001', purchaseUom: 'BOTTLE', issueUom: 'ML', convFactor: '500', operationId: opId() });
  assert.equal(result.changed, false);
  assert.equal(mock.calls.update.some(c => c.tab === 'PRODUCTS'), false);
})();

// ---- product.delete / product.restore ----
await (async () => {
  const { writeDirect, tabs } = fixture();
  const result = await writeDirect('product.delete', 'purchase@ahl.com', { productId: 'PRD-0001', notes: 'Discontinued', operationId: opId() });
  assert.equal(result.changed, true);
  assert.equal(tabs.PRODUCTS.rows[0][10], false); // Active column
})();
await (async () => {
  // Already inactive -> no-op.
  const { writeDirect, tabs } = fixture();
  tabs.PRODUCTS.rows[0][10] = false;
  const result = await writeDirect('product.delete', 'purchase@ahl.com', { productId: 'PRD-0001', notes: '', operationId: opId() });
  assert.equal(result.changed, false);
})();
await (async () => {
  const { writeDirect, tabs } = fixture();
  tabs.PRODUCTS.rows[0][10] = false;
  const result = await writeDirect('product.restore', 'purchase@ahl.com', { productId: 'PRD-0001', operationId: opId() });
  assert.equal(result.changed, true);
  assert.equal(tabs.PRODUCTS.rows[0][10], true);
})();

// ---- order.create ----
await (async () => {
  const { writeDirect, tabs } = fixture();
  const result = await writeDirect('order.create', 'purchase@ahl.com', { productId: 'PRD-0001', vendorId: 'VND-1', qty: 10, operationId: opId() });
  assert.match(result.orderId, /^PO-/);
  assert.equal(result.deliveryLocationId, 'LOC-01'); // default head office, no SETTING override in the fixture
  assert.equal(tabs.PURCHASE_ORDERS.rows.length, 1);
  const headers = tabs.PURCHASE_ORDERS.headers, row = tabs.PURCHASE_ORDERS.rows[0];
  assert.equal(row[headers.indexOf('Status')], 'ORDERED');
  assert.equal(row[headers.indexOf('BatchID')], result.orderId); // single order's own id is its batch id
})();
await (async () => {
  const { writeDirect } = fixture();
  await assert.rejects(() => writeDirect('order.create', 'purchase@ahl.com', { productId: 'PRD-9999', vendorId: 'VND-1', qty: 10, operationId: opId() }), /UNKNOWN_PRODUCT/);
})();
await (async () => {
  const { writeDirect } = fixture();
  await assert.rejects(() => writeDirect('order.create', 'purchase@ahl.com', { productId: 'PRD-0001', vendorId: 'VND-NOPE', qty: 10, operationId: opId() }), /VALIDATION/);
})();
await (async () => {
  // Wrong role (order actions are PurchaseCoordinator/Admin only, unlike product actions).
  const { writeDirect } = fixture({ role: 'ProductDistributor' });
  await assert.rejects(() => writeDirect('order.create', 'purchase@ahl.com', { productId: 'PRD-0001', vendorId: 'VND-1', qty: 10, operationId: opId() }), /FORBIDDEN/);
})();
await (async () => {
  // Ordering against an approved request flips it to ORDERED; a second order against the same request is refused.
  const { writeDirect, tabs } = fixture();
  const result = await writeDirect('order.create', 'purchase@ahl.com', { productId: 'PRD-0001', vendorId: 'VND-1', qty: 4, requestId: 'REQ-1', operationId: opId() });
  assert.equal(tabs.REQUESTS.rows[0][tabs.REQUESTS.headers.indexOf('Status')], 'ORDERED');
  await assert.rejects(() => writeDirect('order.create', 'purchase@ahl.com', { productId: 'PRD-0001', vendorId: 'VND-1', qty: 2, requestId: 'REQ-1', operationId: opId() }), /DUPLICATE/);
  void result;
})();

// ---- order.create (multi-product lines, one invoice-style batch) ----
await (async () => {
  const { writeDirect, tabs } = fixture();
  const result = await writeDirect('order.create', 'purchase@ahl.com', {
    vendorId: 'VND-1', lines: [{ productId: 'PRD-0001', qty: 5 }, { productId: 'PRD-0002', qty: 3, unitPrice: 12.5 }], operationId: opId(),
  });
  assert.equal(result.orderIds.length, 2);
  assert.equal(tabs.PURCHASE_ORDERS.rows.length, 2);
  const headers = tabs.PURCHASE_ORDERS.headers;
  assert.equal(tabs.PURCHASE_ORDERS.rows[0][headers.indexOf('BatchID')], result.orderIds[0]);
  assert.equal(tabs.PURCHASE_ORDERS.rows[1][headers.indexOf('BatchID')], result.orderIds[0]); // both lines share the first id as batch id
  assert.equal(tabs.PURCHASE_ORDERS.rows[0][headers.indexOf('UnitPrice')], ''); // no price given for this line
  assert.equal(tabs.PURCHASE_ORDERS.rows[1][headers.indexOf('UnitPrice')], 12.5);
})();

// ---- order.cancel ----
await (async () => {
  const { writeDirect, tabs } = fixture();
  const created = await writeDirect('order.create', 'purchase@ahl.com', { productId: 'PRD-0001', vendorId: 'VND-1', qty: 10, operationId: opId() });
  const result = await writeDirect('order.cancel', 'purchase@ahl.com', { orderId: created.orderId, notes: 'Vendor out of stock', operationId: opId() });
  assert.equal(result.status, 'CANCELLED');
  const headers = tabs.PURCHASE_ORDERS.headers, row = tabs.PURCHASE_ORDERS.rows[0];
  assert.equal(row[headers.indexOf('Status')], 'CANCELLED');
  assert.match(String(row[headers.indexOf('Notes')]), /Cancelled: Vendor out of stock/);
})();
await (async () => {
  const { writeDirect } = fixture();
  await assert.rejects(() => writeDirect('order.cancel', 'purchase@ahl.com', { orderId: 'PO-NOPE', notes: 'x', operationId: opId() }), /VALIDATION/);
})();
await (async () => {
  // No reason given -> refused before the sheet is touched.
  const { writeDirect } = fixture();
  const created = await writeDirect('order.create', 'purchase@ahl.com', { productId: 'PRD-0001', vendorId: 'VND-1', qty: 10, operationId: opId() });
  await assert.rejects(() => writeDirect('order.cancel', 'purchase@ahl.com', { orderId: created.orderId, notes: '', operationId: opId() }), /VALIDATION/);
})();

// ---- order.edit ----
await (async () => {
  const { writeDirect, tabs, sheetsDirect } = fixture();
  const created = await writeDirect('order.create', 'purchase@ahl.com', { productId: 'PRD-0001', vendorId: 'VND-1', qty: 10, operationId: opId() });
  const headers = tabs.PURCHASE_ORDERS.headers, raw = tabs.PURCHASE_ORDERS.rows[0];
  const expected = { qty: 10, vendorId: 'VND-1', notes: '', date: sheetsDirect.serialToDate(raw[headers.indexOf('Date')]).toISOString() };
  const result = await writeDirect('order.edit', 'purchase@ahl.com', {
    orderId: created.orderId, reason: 'Vendor corrected the quantity', qty: 12, vendorId: 'VND-1', expected, operationId: opId(),
  });
  assert.equal(result.orderId, created.orderId);
  assert.equal(tabs.PURCHASE_ORDERS.rows[0][headers.indexOf('QtyOrdered')], 12);
})();
await (async () => {
  // A stale `expected` (order changed since the form loaded) is refused, and nothing is written.
  const { writeDirect, tabs } = fixture();
  const created = await writeDirect('order.create', 'purchase@ahl.com', { productId: 'PRD-0001', vendorId: 'VND-1', qty: 10, operationId: opId() });
  const headers = tabs.PURCHASE_ORDERS.headers;
  const staleExpected = { qty: 999, vendorId: 'VND-1', notes: '', date: new Date().toISOString() };
  await assert.rejects(() => writeDirect('order.edit', 'purchase@ahl.com', {
    orderId: created.orderId, reason: 'Trying to edit', qty: 12, vendorId: 'VND-1', expected: staleExpected, operationId: opId(),
  }), /STALE_ENTRY/);
  assert.equal(tabs.PURCHASE_ORDERS.rows[0][headers.indexOf('QtyOrdered')], 10); // unchanged
})();

// ---- order.delete ----
await (async () => {
  // Delegates to order.cancel exactly like EntryChanges.gs -- same CANCELLED status, no separate audit entry.
  const { writeDirect, mock } = fixture();
  const created = await writeDirect('order.create', 'purchase@ahl.com', { productId: 'PRD-0001', vendorId: 'VND-1', qty: 10, operationId: opId() });
  const result = await writeDirect('order.delete', 'purchase@ahl.com', { orderId: created.orderId, reason: 'Entered by mistake', operationId: opId() });
  assert.equal(result.status, 'CANCELLED');
  assert.equal(mock.calls.append.some(c => c.tab === 'AUDIT' && c.values[0].includes('order.delete')), false);
  assert.equal(mock.calls.append.some(c => c.tab === 'AUDIT' && c.values[0].includes('order.cancel')), true);
})();
await (async () => {
  // A partially received order cannot be deleted -- the receipts must be corrected first.
  const { writeDirect, tabs } = fixture();
  const created = await writeDirect('order.create', 'purchase@ahl.com', { productId: 'PRD-0001', vendorId: 'VND-1', qty: 10, operationId: opId() });
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { Type: 'RECEIPT', Status: 'POSTED', PORef: created.orderId, Qty: 5, QtyBase: 5, ProductID: 'PRD-0001', LocationID: 'LOC-01', Direction: 1 }));
  await assert.rejects(() => writeDirect('order.delete', 'purchase@ahl.com', { orderId: created.orderId, reason: 'Entered by mistake', operationId: opId() }), /VALIDATION/);
})();

// ---- receipt.edit ----
await (async () => {
  const { writeDirect, tabs, sheetsDirect } = fixture();
  seedReceiptPair(tabs);
  const result = await writeDirect('receipt.edit', 'purchase@ahl.com', {
    txnIds: ['R1', 'R2'], reason: 'Correct delivery', date: '2026-10-20', vendorId: 'VND-1', invoiceNo: 'INV1',
    lines: [{ txnId: 'R1', qty: 3, amount: 300, gstAmount: 54 }, { txnId: 'R2', qty: 2, amount: 0, gstAmount: 0 }], operationId: opId(),
  });
  assert.equal(result.deleted, false);
  assert.equal(result.txnIds.length, 2);
  assert.equal(tabs.LEDGER.rows.length, 4); // 2 originals (now VOID) + 2 replacements
  const h = tabs.LEDGER.headers, statusIdx = h.indexOf('Status'), txnIdx = h.indexOf('TxnID'), poRefIdx = h.indexOf('PORef'), qtyBaseIdx = h.indexOf('QtyBase'), amountIdx = h.indexOf('Amount');
  assert.equal(tabs.LEDGER.rows.find((r) => r[txnIdx] === 'R1')[statusIdx], 'VOID');
  assert.equal(tabs.LEDGER.rows.find((r) => r[txnIdx] === 'R2')[statusIdx], 'VOID');
  const replacementA = tabs.LEDGER.rows.find((r) => r[statusIdx] === 'RECEIVED' && r[poRefIdx] === 'PO-A');
  assert.equal(replacementA[qtyBaseIdx], 1500); // 3 * 2500/5
  assert.equal(replacementA[amountIdx], 300);
  const ops = await sheetsDirect.readDirect('operations.read', 'purchase@ahl.com', {});
  assert.equal(ops.orders.find((o) => o.orderId === 'PO-A').received, 3);
  // Replaying against the now-voided original lines refuses instead of silently voiding twice.
  await assert.rejects(() => writeDirect('receipt.edit', 'purchase@ahl.com', {
    txnIds: ['R1', 'R2'], reason: 'Retry', date: '2026-10-20', vendorId: 'VND-1', invoiceNo: 'INV1',
    lines: [{ txnId: 'R1', qty: 1, amount: 100 }, { txnId: 'R2', qty: 1, amount: 1 }], operationId: opId(),
  }), /STALE_ENTRY/);
})();
await (async () => {
  // Reducing a receipt below what's already been issued out is refused before anything is written.
  const { writeDirect, tabs } = fixture();
  seedReceiptPair(tabs);
  const dateSerial = tabs.LEDGER.rows[0][tabs.LEDGER.headers.indexOf('Date')];
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'ISSUE1', Date: dateSerial, Type: 'ISSUE', Direction: -1, ProductID: 'PRD-0001', Qty: 2400, UOM: 'ML', QtyBase: 2400, LocationID: 'LOC-01', Status: 'ISSUED' }));
  await assert.rejects(() => writeDirect('receipt.edit', 'purchase@ahl.com', {
    txnIds: ['R1', 'R2'], reason: 'Reduce quantity', date: '2026-10-20', vendorId: 'VND-1', invoiceNo: 'INV1',
    lines: [{ txnId: 'R1', qty: 0, amount: 0 }, { txnId: 'R2', qty: 2, amount: 20 }], operationId: opId(),
  }), /INSUFFICIENT_STOCK/);
  assert.equal(tabs.LEDGER.rows.length, 3); // nothing written on the rejected edit
})();
await (async () => {
  // Selecting only one line of a two-line invoice is refused -- must edit the complete invoice.
  const { writeDirect, tabs } = fixture();
  seedReceiptPair(tabs);
  await assert.rejects(() => writeDirect('receipt.edit', 'purchase@ahl.com', {
    txnIds: ['R1'], reason: 'Partial edit', date: '2026-10-20', vendorId: 'VND-1', invoiceNo: 'INV1',
    lines: [{ txnId: 'R1', qty: 1, amount: 1 }], operationId: opId(),
  }), /VALIDATION/);
})();
await (async () => {
  // Wrong role (same PurchaseCoordinator/Admin-only gate as the order actions).
  const { writeDirect, tabs } = fixture({ role: 'ProductDistributor' });
  seedReceiptPair(tabs);
  await assert.rejects(() => writeDirect('receipt.edit', 'purchase@ahl.com', {
    txnIds: ['R1', 'R2'], reason: 'x', date: '2026-10-20', vendorId: 'VND-1', invoiceNo: 'INV1',
    lines: [{ txnId: 'R1', qty: 1, amount: 1 }, { txnId: 'R2', qty: 1, amount: 1 }], operationId: opId(),
  }), /FORBIDDEN/);
})();

// ---- receipt.delete ----
await (async () => {
  const { writeDirect, tabs, sheetsDirect, mock } = fixture();
  seedReceiptPair(tabs);
  const result = await writeDirect('receipt.delete', 'purchase@ahl.com', { txnIds: ['R1', 'R2'], reason: 'Wrong invoice entirely', operationId: opId() });
  assert.equal(result.deleted, true);
  assert.equal(result.txnIds.length, 0); // nothing replaces a deleted receipt
  const h = tabs.LEDGER.headers, statusIdx = h.indexOf('Status');
  assert.equal(tabs.LEDGER.rows.every((r) => r[statusIdx] === 'VOID'), true);
  assert.equal(tabs.LEDGER.rows.length, 2); // voided in place, nothing appended
  const ops = await sheetsDirect.readDirect('operations.read', 'purchase@ahl.com', {});
  assert.equal(ops.orders.find((o) => o.orderId === 'PO-A').received, 0);
  assert.equal(mock.calls.append.some((c) => c.tab === 'AUDIT' && c.values[0].includes('receipt.delete')), true);
})();

// ---- purchase.request ----
await (async () => {
  // Under the (default) threshold, PurchaseCoordinator's own request lands straight as OPEN -- no approval step.
  const { writeDirect, tabs } = fixture();
  const result = await writeDirect('purchase.request', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 10, requestedByUserId: 'U1', notes: 'Running low', operationId: opId() });
  assert.equal(result.status, 'OPEN');
  assert.equal(result.estValue, 20); // 10 * Cost(2)
  assert.equal(tabs.REQUESTS.rows.length, 3); // 2 baseline + 1 new
})();
await (async () => {
  // Hitesh (ProductDistributor) has no self-approval authority, threshold or not.
  const { writeDirect } = fixture({ role: 'ProductDistributor' });
  const result = await writeDirect('purchase.request', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 1, requestedByUserId: 'U1', notes: 'Need more', operationId: opId() });
  assert.equal(result.status, 'PENDING_APPROVAL');
})();
await (async () => {
  // Over the threshold without recording who approved it is refused.
  const { writeDirect, tabs } = fixture();
  await assert.rejects(() => writeDirect('purchase.request', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 1, estimatedValue: 6000, requestedByUserId: 'U1', notes: 'Big order', operationId: opId() }), /VALIDATION/);
  assert.equal(tabs.REQUESTS.rows.length, 2);
})();
await (async () => {
  // A product not yet in the catalogue is its own flagged, catalogue-less row.
  const { writeDirect, tabs } = fixture();
  const result = await writeDirect('purchase.request', 'purchase@ahl.com', { newProductName: 'New Shampoo Brand', qty: 5, requestedByUserId: 'U1', notes: 'Found a new brand', operationId: opId() });
  assert.equal(result.status, 'NEW_PRODUCT');
  const h = tabs.REQUESTS.headers;
  const row = tabs.REQUESTS.rows.find((r) => r[h.indexOf('NewProductName')] === 'New Shampoo Brand');
  assert.equal(row[h.indexOf('ProductID')], '');
})();
await (async () => {
  // Multi-product request, one row per product, same reason.
  const { writeDirect, tabs } = fixture();
  const result = await writeDirect('purchase.request', 'purchase@ahl.com', {
    lines: [{ productId: 'PRD-0001', qty: 2 }, { productId: 'PRD-0002', qty: 1 }], requestedByUserId: 'U1', notes: 'Bulk request', operationId: opId(),
  });
  assert.equal(result.requestIds.length, 2);
  assert.equal(result.status, 'OPEN');
  assert.equal(tabs.REQUESTS.rows.length, 4); // 2 baseline + 2 new
})();

// ---- purchase.approve ----
await (async () => {
  const { writeDirect, tabs } = fixture();
  const result = await writeDirect('purchase.approve', 'purchase@ahl.com', { requestId: 'REQ-2', decision: 'APPROVE', operationId: opId() });
  assert.equal(result.status, 'OPEN'); // has a ProductID, so approval opens it rather than flagging NEW_PRODUCT
  const h = tabs.REQUESTS.headers, row = tabs.REQUESTS.rows.find((r) => r[h.indexOf('RequestID')] === 'REQ-2');
  assert.equal(row[h.indexOf('ApprovedBy')], 'purchase@ahl.com');
  // Deciding it again (no longer PENDING_APPROVAL) is refused.
  await assert.rejects(() => writeDirect('purchase.approve', 'purchase@ahl.com', { requestId: 'REQ-2', decision: 'APPROVE', operationId: opId() }), /VALIDATION/);
})();
await (async () => {
  const { writeDirect, tabs } = fixture();
  const result = await writeDirect('purchase.approve', 'purchase@ahl.com', { requestId: 'REQ-2', decision: 'REJECT', notes: 'Already in stock', operationId: opId() });
  assert.equal(result.status, 'REJECTED');
  const h = tabs.REQUESTS.headers, row = tabs.REQUESTS.rows.find((r) => r[h.indexOf('RequestID')] === 'REQ-2');
  assert.match(String(row[h.indexOf('Notes')]), /Satvik: Already in stock/);
})();
await (async () => {
  const { writeDirect } = fixture({ role: 'ProductDistributor' });
  await assert.rejects(() => writeDirect('purchase.approve', 'purchase@ahl.com', { requestId: 'REQ-2', decision: 'APPROVE', operationId: opId() }), /FORBIDDEN/);
})();

// ---- purchase.approveMany ----
await (async () => {
  const { writeDirect, tabs } = fixture();
  tabs.REQUESTS.rows.push(rowFor(tabs, 'REQUESTS', { RequestID: 'REQ-3', ProductID: 'PRD-0002', Qty: 2, RequestedBy: 'U1', EstValue: 2, Status: 'PENDING_APPROVAL', Actor: 'purchase@ahl.com', Source: 'APP' }));
  const result = await writeDirect('purchase.approveMany', 'purchase@ahl.com', { requestIds: ['REQ-2', 'REQ-3'], decision: 'APPROVE', operationId: opId() });
  assert.equal(result.results.length, 2);
  const h = tabs.REQUESTS.headers, statusIdx = h.indexOf('Status');
  assert.equal(tabs.REQUESTS.rows.find((r) => r[h.indexOf('RequestID')] === 'REQ-2')[statusIdx], 'OPEN');
  assert.equal(tabs.REQUESTS.rows.find((r) => r[h.indexOf('RequestID')] === 'REQ-3')[statusIdx], 'OPEN');
})();
await (async () => {
  // One id in the batch isn't awaiting approval -- the whole batch is refused, nothing decided.
  const { writeDirect, tabs } = fixture();
  await assert.rejects(() => writeDirect('purchase.approveMany', 'purchase@ahl.com', { requestIds: ['REQ-2', 'REQ-1'], decision: 'APPROVE', operationId: opId() }), /VALIDATION/);
  const h = tabs.REQUESTS.headers;
  assert.equal(tabs.REQUESTS.rows.find((r) => r[h.indexOf('RequestID')] === 'REQ-2')[h.indexOf('Status')], 'PENDING_APPROVAL'); // untouched
})();

// ---- opening.submit ----
await (async () => {
  const { writeDirect, tabs } = fixture();
  const result = await writeDirect('opening.submit', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 25, operationId: opId() });
  assert.match(result.countId, /^OPN-/);
  assert.equal(result.status, 'PENDING');
  assert.equal(result.locationId, 'LOC-01'); // PurchaseCoordinator always submits for Head Office
  assert.equal(tabs.OPENING_COUNTS.rows.length, 1);
})();
await (async () => {
  // A second submission for the same product + location while one is still pending is refused.
  const { writeDirect, tabs } = fixture();
  await writeDirect('opening.submit', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 25, operationId: opId() });
  await assert.rejects(() => writeDirect('opening.submit', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 30, operationId: opId() }), /DUPLICATE/);
  assert.equal(tabs.OPENING_COUNTS.rows.length, 1);
})();
await (async () => {
  // A product that already has a real stock movement at this location needs a count correction, not an opening count.
  const { writeDirect, tabs } = fixture();
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'T1', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0001', Qty: 1, QtyBase: 500, LocationID: 'LOC-01', Status: 'RECEIVED' }));
  await assert.rejects(() => writeDirect('opening.submit', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 25, operationId: opId() }), /VALIDATION/);
  assert.equal(tabs.OPENING_COUNTS.rows.length, 0);
})();
await (async () => {
  const { writeDirect } = fixture({ role: 'Technician' });
  await assert.rejects(() => writeDirect('opening.submit', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 25, operationId: opId() }), /FORBIDDEN/);
})();

// ---- opening.approve ----
await (async () => {
  const { writeDirect, tabs } = fixture({ role: 'Admin' });
  tabs.OPENING_COUNTS.rows.push(rowFor(tabs, 'OPENING_COUNTS', { CountID: 'OPN-1', ProductID: 'PRD-0001', Qty: 25, LocationID: 'LOC-01', CountedBy: 'purchase@ahl.com', Status: 'PENDING' }));
  const result = await writeDirect('opening.approve', 'purchase@ahl.com', { countId: 'OPN-1', decision: 'APPROVE', operationId: opId() });
  assert.equal(result.status, 'APPROVED');
  assert.equal(tabs.LEDGER.rows.length, 1);
  const h = tabs.LEDGER.headers, row = tabs.LEDGER.rows[0];
  assert.equal(row[h.indexOf('Type')], 'OPENING');
  assert.equal(row[h.indexOf('Qty')], 25);
  assert.equal(row[h.indexOf('HandoverID')], 'OPN-1');
  // Re-deciding an already-approved count is refused, and does not post a second ledger row.
  await assert.rejects(() => writeDirect('opening.approve', 'purchase@ahl.com', { countId: 'OPN-1', decision: 'APPROVE', operationId: opId() }), /VALIDATION/);
  assert.equal(tabs.LEDGER.rows.length, 1);
})();
await (async () => {
  // Rejecting posts nothing to the ledger.
  const { writeDirect, tabs } = fixture({ role: 'Admin' });
  tabs.OPENING_COUNTS.rows.push(rowFor(tabs, 'OPENING_COUNTS', { CountID: 'OPN-2', ProductID: 'PRD-0001', Qty: 10, LocationID: 'LOC-01', CountedBy: 'purchase@ahl.com', Status: 'PENDING' }));
  const result = await writeDirect('opening.approve', 'purchase@ahl.com', { countId: 'OPN-2', decision: 'REJECT', operationId: opId() });
  assert.equal(result.status, 'REJECTED');
  assert.equal(tabs.LEDGER.rows.length, 0);
})();
await (async () => {
  // Only an administrator may decide -- gated both by role and inside the handler itself (matches Ledger.gs's double check).
  const { writeDirect, tabs } = fixture({ role: 'PurchaseCoordinator' });
  tabs.OPENING_COUNTS.rows.push(rowFor(tabs, 'OPENING_COUNTS', { CountID: 'OPN-3', ProductID: 'PRD-0001', Qty: 10, LocationID: 'LOC-01', CountedBy: 'purchase@ahl.com', Status: 'PENDING' }));
  await assert.rejects(() => writeDirect('opening.approve', 'purchase@ahl.com', { countId: 'OPN-3', decision: 'APPROVE', operationId: opId() }), /FORBIDDEN/);
})();

// ---- stock.issue ----
await (async () => {
  const { writeDirect, tabs } = fixture(); // PurchaseCoordinator -> issues from Head Office (LOC-01)
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'SEED1', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0001', QtyBase: 1000, LocationID: 'LOC-01', Status: 'RECEIVED' }));
  const result = await writeDirect('stock.issue', 'purchase@ahl.com', {
    productId: 'PRD-0001', splits: [{ qty: 2, categoryId: 'CAT-1', recipientUserId: 'U2' }], operationId: opId(),
  });
  assert.match(result.handoverId, /^HND-/);
  assert.equal(result.newBalance, 998);
  assert.equal(tabs.LEDGER.rows.length, 2);
  const h = tabs.LEDGER.headers, issueRow = tabs.LEDGER.rows.find((r) => r[h.indexOf('Type')] === 'ISSUE');
  assert.equal(issueRow[h.indexOf('Direction')], -1);
  assert.equal(issueRow[h.indexOf('HandoverID')], result.handoverId);
})();
await (async () => {
  const { writeDirect, tabs } = fixture();
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'SEED1', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0001', QtyBase: 1, LocationID: 'LOC-01', Status: 'RECEIVED' }));
  await assert.rejects(() => writeDirect('stock.issue', 'purchase@ahl.com', { productId: 'PRD-0001', splits: [{ qty: 5, categoryId: 'CAT-1', recipientUserId: 'U2' }], operationId: opId() }), /INSUFFICIENT_STOCK/);
})();
await (async () => {
  // ProductDistributor's expected location (no matching LOCATION row in this fixture) is Salon Floor, not Head Office.
  const { writeDirect } = fixture({ role: 'ProductDistributor' });
  await assert.rejects(() => writeDirect('stock.issue', 'purchase@ahl.com', {
    productId: 'PRD-0001', fromLocationId: 'LOC-01', splits: [{ qty: 1, categoryId: 'CAT-1', recipientUserId: 'U2' }], operationId: opId(),
  }), /FORBIDDEN/);
})();
await (async () => {
  // Admin can issue from any location, bypassing the own-location restriction.
  const { writeDirect, tabs } = fixture({ role: 'Admin' });
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'SEED1', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0001', QtyBase: 10, LocationID: 'LOC-03', Status: 'RECEIVED' }));
  const result = await writeDirect('stock.issue', 'purchase@ahl.com', {
    productId: 'PRD-0001', fromLocationId: 'LOC-03', splits: [{ qty: 1, categoryId: 'CAT-1', recipientUserId: 'U2' }], operationId: opId(),
  });
  assert.equal(result.newBalance, 9);
})();

// ---- stock.retailSale ----
await (async () => {
  const { writeDirect, tabs } = fixture();
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'SEED1', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0002', QtyBase: 1000, LocationID: 'LOC-01', Status: 'RECEIVED' }));
  const result = await writeDirect('stock.retailSale', 'purchase@ahl.com', { productId: 'PRD-0002', qty: 2, clientName: 'Jane Doe', recipientUserId: 'U2', operationId: opId() });
  assert.match(result.txnId, /^TXN-/);
  assert.equal(result.newBalance, 600); // 1000 - (2 * ConvFactor 200)
  const h = tabs.LEDGER.headers, row = tabs.LEDGER.rows.find((r) => r[h.indexOf('Type')] === 'RETAIL_SALE');
  assert.match(String(row[h.indexOf('Notes')]), /Client: Jane Doe/);
})();
await (async () => {
  // PRD-0001 is Consumable, not Retail/Both.
  const { writeDirect } = fixture();
  await assert.rejects(() => writeDirect('stock.retailSale', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 1, clientName: 'Jane Doe', recipientUserId: 'U2', operationId: opId() }), /VALIDATION/);
})();
await (async () => {
  const { writeDirect } = fixture();
  await assert.rejects(() => writeDirect('stock.retailSale', 'purchase@ahl.com', { productId: 'PRD-0002', qty: 1, recipientUserId: 'U2', operationId: opId() }), /VALIDATION/);
})();
await (async () => {
  const { writeDirect, tabs } = fixture();
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'SEED1', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0002', QtyBase: 1, LocationID: 'LOC-01', Status: 'RECEIVED' }));
  await assert.rejects(() => writeDirect('stock.retailSale', 'purchase@ahl.com', { productId: 'PRD-0002', qty: 5, clientName: 'Jane Doe', recipientUserId: 'U2', operationId: opId() }), /INSUFFICIENT_STOCK/);
})();

// ---- stock.adjust ----
await (async () => {
  const { writeDirect, tabs } = fixture();
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'SEED1', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0001', QtyBase: 10, LocationID: 'LOC-01', Status: 'RECEIVED' }));
  const result = await writeDirect('stock.adjust', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 2, kind: 'DAMAGE', notes: 'Bottle cracked in storage', operationId: opId() });
  assert.match(result.txnId, /^TXN-/);
  const h = tabs.LEDGER.headers, row = tabs.LEDGER.rows.find((r) => r[h.indexOf('Type')] === 'DAMAGE');
  assert.equal(row[h.indexOf('Direction')], -1);
})();
await (async () => {
  // COUNT_* corrections are Admin-only.
  const { writeDirect, tabs } = fixture();
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'SEED1', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0001', QtyBase: 10, LocationID: 'LOC-01', Status: 'RECEIVED' }));
  await assert.rejects(() => writeDirect('stock.adjust', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 1, kind: 'COUNT_OUT', notes: 'Recount', operationId: opId() }), /FORBIDDEN/);
})();
await (async () => {
  const { writeDirect, tabs } = fixture({ role: 'Admin' });
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'SEED1', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0001', QtyBase: 10, LocationID: 'LOC-01', Status: 'RECEIVED' }));
  const result = await writeDirect('stock.adjust', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 1, kind: 'COUNT_OUT', notes: 'Recount', locationId: 'LOC-01', operationId: opId() });
  assert.match(result.txnId, /^TXN-/);
})();
await (async () => {
  // A RETURN must reference the original issue, and cannot exceed what was actually issued.
  const { writeDirect, tabs } = fixture();
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'SEED1', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0001', QtyBase: 10, LocationID: 'LOC-01', Status: 'RECEIVED' }));
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'ISSUE1', Type: 'ISSUE', Direction: -1, ProductID: 'PRD-0001', QtyBase: 5, LocationID: 'LOC-01', Status: 'ISSUED' }));
  const result = await writeDirect('stock.adjust', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 3, kind: 'RETURN', sourceTxnId: 'ISSUE1', notes: 'Technician returned unused stock', operationId: opId() });
  assert.match(result.txnId, /^TXN-/);
  await assert.rejects(() => writeDirect('stock.adjust', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 3, kind: 'RETURN', sourceTxnId: 'ISSUE1', notes: 'Too much', operationId: opId() }), /VALIDATION/);
})();
await (async () => {
  const { writeDirect } = fixture();
  await assert.rejects(() => writeDirect('stock.adjust', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 1, kind: 'DAMAGE', operationId: opId() }), /VALIDATION/); // no reason given
})();

// ---- stock.handover ----
await (async () => {
  const { writeDirect, tabs } = fixture();
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'SEED1', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0001', QtyBase: 10, LocationID: 'LOC-01', Status: 'RECEIVED' }));
  const result = await writeDirect('stock.handover', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 3, toUserId: 'U3', operationId: opId() });
  assert.match(result.handoverId, /^HND-/);
  assert.equal(result.qty, 3);
  const h = tabs.LEDGER.headers;
  const pair = tabs.LEDGER.rows.filter((r) => r[h.indexOf('HandoverID')] === result.handoverId);
  assert.equal(pair.length, 2);
  assert.equal(pair.every((r) => r[h.indexOf('Status')] === 'PENDING_CONFIRM'), true);
  assert.equal(pair.find((r) => r[h.indexOf('Direction')] === -1)[h.indexOf('LocationID')], 'LOC-01');
  assert.equal(pair.find((r) => r[h.indexOf('Direction')] === 1)[h.indexOf('LocationID')], 'LOC-02'); // default Salon Floor
})();
await (async () => {
  const { writeDirect, tabs } = fixture();
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'SEED1', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0001', QtyBase: 1, LocationID: 'LOC-01', Status: 'RECEIVED' }));
  await assert.rejects(() => writeDirect('stock.handover', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 5, toUserId: 'U3', operationId: opId() }), /INSUFFICIENT_STOCK/);
})();
await (async () => {
  // Same location as the sender's own is not a valid destination.
  const { writeDirect, tabs } = fixture();
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'SEED1', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0001', QtyBase: 10, LocationID: 'LOC-01', Status: 'RECEIVED' }));
  await assert.rejects(() => writeDirect('stock.handover', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 1, toLocationId: 'LOC-01', toUserId: 'U3', operationId: opId() }), /VALIDATION/);
})();
await (async () => {
  // A technician is neither a ProductDistributor nor the sender themself.
  const { writeDirect, tabs } = fixture();
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'SEED1', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0001', QtyBase: 10, LocationID: 'LOC-01', Status: 'RECEIVED' }));
  await assert.rejects(() => writeDirect('stock.handover', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 1, toUserId: 'U2', operationId: opId() }), /VALIDATION/);
})();
await (async () => {
  // Supplying from stock closes the request it fulfils.
  const { writeDirect, tabs } = fixture();
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'SEED1', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0001', QtyBase: 10, LocationID: 'LOC-01', Status: 'RECEIVED' }));
  tabs.REQUESTS.rows.push(rowFor(tabs, 'REQUESTS', { RequestID: 'REQ-10', ProductID: 'PRD-0001', Status: 'OPEN' }));
  await writeDirect('stock.handover', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 1, toUserId: 'U3', requestId: 'REQ-10', operationId: opId() });
  const h = tabs.REQUESTS.headers;
  assert.equal(tabs.REQUESTS.rows.find((r) => r[h.indexOf('RequestID')] === 'REQ-10')[h.indexOf('Status')], 'SUPPLIED');
})();
await (async () => {
  // Multi-product handover: one handoverId per line.
  const { writeDirect, tabs } = fixture();
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'SEED1', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0001', QtyBase: 10, LocationID: 'LOC-01', Status: 'RECEIVED' }));
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'SEED2', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0002', QtyBase: 10, LocationID: 'LOC-01', Status: 'RECEIVED' }));
  const result = await writeDirect('stock.handover', 'purchase@ahl.com', { lines: [{ productId: 'PRD-0001', qty: 1 }, { productId: 'PRD-0002', qty: 1 }], toUserId: 'U3', operationId: opId() });
  assert.equal(result.handoverIds.length, 2);
  assert.notEqual(result.handoverIds[0], result.handoverIds[1]);
})();

// ---- stock.confirmHandover ----
await (async () => {
  const { writeDirect, tabs } = fixture();
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'SEED1', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0001', QtyBase: 10, LocationID: 'LOC-01', Status: 'RECEIVED' }));
  const created = await writeDirect('stock.handover', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 3, toUserId: 'U3', operationId: opId() });
  const result = await writeDirect('stock.confirmHandover', 'hitesh@ahl.com', { handoverId: created.handoverId, countedQty: 3, operationId: opId() });
  assert.equal(result.rowsConfirmed, 2);
  const h = tabs.LEDGER.headers;
  assert.equal(tabs.LEDGER.rows.filter((r) => r[h.indexOf('HandoverID')] === created.handoverId).every((r) => r[h.indexOf('Status')] === 'CONFIRMED'), true);
  // Re-confirming an already-decided handover is refused.
  await assert.rejects(() => writeDirect('stock.confirmHandover', 'hitesh@ahl.com', { handoverId: created.handoverId, countedQty: 3, operationId: opId() }), /VALIDATION/);
})();
await (async () => {
  // A count mismatch leaves both rows pending, records the note, and reports COUNT_MISMATCH.
  const { writeDirect, tabs } = fixture();
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'SEED1', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0001', QtyBase: 10, LocationID: 'LOC-01', Status: 'RECEIVED' }));
  const created = await writeDirect('stock.handover', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 3, toUserId: 'U3', operationId: opId() });
  await assert.rejects(() => writeDirect('stock.confirmHandover', 'hitesh@ahl.com', { handoverId: created.handoverId, countedQty: 2, notes: 'Short by one', operationId: opId() }), /COUNT_MISMATCH/);
  const h = tabs.LEDGER.headers;
  const pair = tabs.LEDGER.rows.filter((r) => r[h.indexOf('HandoverID')] === created.handoverId);
  assert.equal(pair.every((r) => r[h.indexOf('Status')] === 'PENDING_CONFIRM'), true); // still pending
  assert.equal(pair.every((r) => String(r[h.indexOf('Notes')]).includes('Receiver counted 2: Short by one')), true);
})();
await (async () => {
  // Only the named receiver (or an admin) may confirm.
  const { writeDirect, tabs } = fixture();
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'SEED1', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0001', QtyBase: 10, LocationID: 'LOC-01', Status: 'RECEIVED' }));
  const created = await writeDirect('stock.handover', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 3, toUserId: 'U3', operationId: opId() });
  await assert.rejects(() => writeDirect('stock.confirmHandover', 'tech@ahl.com', { handoverId: created.handoverId, countedQty: 3, operationId: opId() }), /FORBIDDEN/);
})();

// ---- handover.cancel ----
await (async () => {
  const { writeDirect, tabs } = fixture();
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'SEED1', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0001', QtyBase: 10, LocationID: 'LOC-01', Status: 'RECEIVED' }));
  const created = await writeDirect('stock.handover', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 3, toUserId: 'U3', operationId: opId() });
  const result = await writeDirect('handover.cancel', 'purchase@ahl.com', { handoverId: created.handoverId, notes: 'Wrong recipient', operationId: opId() });
  assert.equal(result.status, 'CANCELLED');
  const h = tabs.LEDGER.headers;
  assert.equal(tabs.LEDGER.rows.filter((r) => r[h.indexOf('HandoverID')] === created.handoverId).every((r) => r[h.indexOf('Status')] === 'VOID'), true);
  // Cancelling an already-cancelled handover is refused.
  await assert.rejects(() => writeDirect('handover.cancel', 'purchase@ahl.com', { handoverId: created.handoverId, notes: 'Again', operationId: opId() }), /VALIDATION/);
})();
await (async () => {
  // Only the sender (or an admin) can cancel.
  const { writeDirect, tabs } = fixture();
  tabs.LEDGER.rows.push(rowFor(tabs, 'LEDGER', { TxnID: 'SEED1', Type: 'RECEIPT', Direction: 1, ProductID: 'PRD-0001', QtyBase: 10, LocationID: 'LOC-01', Status: 'RECEIVED' }));
  const created = await writeDirect('stock.handover', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 3, toUserId: 'U3', operationId: opId() });
  await assert.rejects(() => writeDirect('handover.cancel', 'hitesh@ahl.com', { handoverId: created.handoverId, notes: 'Trying to cancel someone else\'s handover', operationId: opId() }), /FORBIDDEN/);
})();

// ---- stock.receive ----
await (async () => {
  const { writeDirect, tabs } = fixture();
  const result = await writeDirect('stock.receive', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 5, amount: 1000, vendorId: 'VND-1', operationId: opId() });
  assert.match(result.txnId, /^TXN-/);
  assert.equal(result.qtyBase, 2500); // 5 * ConvFactor 500
  const h = tabs.LEDGER.headers, row = tabs.LEDGER.rows[0];
  assert.equal(row[h.indexOf('Type')], 'RECEIPT');
  assert.equal(row[h.indexOf('LocationID')], 'LOC-01'); // defaults to Head Office
  // The price actually paid becomes the catalogue cost.
  const ph = tabs.PRODUCTS.headers;
  assert.equal(tabs.PRODUCTS.rows[0][ph.indexOf('Cost')], 1000 / 2500);
})();
await (async () => {
  // Tied to an open order: the order's own delivery location wins, and quantity/units are checked against it.
  const { writeDirect, tabs } = fixture();
  tabs.PURCHASE_ORDERS.rows.push(rowFor(tabs, 'PURCHASE_ORDERS', { OrderID: 'PO-X', ProductID: 'PRD-0001', VendorID: 'VND-1', QtyOrdered: 10, UOM: 'BOTTLE', Status: 'ORDERED', DeliveryLocationID: 'LOC-01' }));
  const result = await writeDirect('stock.receive', 'purchase@ahl.com', { productId: 'PRD-0001', vendorId: 'VND-1', poId: 'PO-X', qty: 4, operationId: opId() });
  assert.match(result.txnId, /^TXN-/);
  const h = tabs.LEDGER.headers;
  assert.equal(tabs.LEDGER.rows[0][h.indexOf('PORef')], 'PO-X');
})();
await (async () => {
  const { writeDirect, tabs } = fixture();
  tabs.PURCHASE_ORDERS.rows.push(rowFor(tabs, 'PURCHASE_ORDERS', { OrderID: 'PO-X', ProductID: 'PRD-0001', VendorID: 'VND-1', QtyOrdered: 2, UOM: 'BOTTLE', Status: 'ORDERED', DeliveryLocationID: 'LOC-01' }));
  await assert.rejects(() => writeDirect('stock.receive', 'purchase@ahl.com', { productId: 'PRD-0001', vendorId: 'VND-1', poId: 'PO-X', qty: 5, operationId: opId() }), /VALIDATION/);
})();
await (async () => {
  // Receiving directly into a studio needs purchasing/management authority.
  const { writeDirect } = fixture({ role: 'ProductDistributor' });
  await assert.rejects(() => writeDirect('stock.receive', 'purchase@ahl.com', { productId: 'PRD-0001', qty: 1, vendorId: 'VND-1', locationId: 'LOC-03', operationId: opId() }), /FORBIDDEN/);
})();
await (async () => {
  // A request that attaches a bill or product photo falls back to Apps Script -- Drive uploads
  // from the service account hit a real "no storage quota" error in production (2026-10-29),
  // so this was reverted from an earlier attempt at porting the photo path too.
  const { writeDirect } = fixture();
  await assert.rejects(() => writeDirect('stock.receive', 'purchase@ahl.com', {
    productId: 'PRD-0001', qty: 1, vendorId: 'VND-1', photo: { base64: 'abc123' }, operationId: opId(),
  }), /DIRECT_WRITE_UNAVAILABLE/);
})();
await (async () => {
  const { writeDirect } = fixture();
  await assert.rejects(() => writeDirect('stock.receive', 'purchase@ahl.com', {
    vendorId: 'VND-1', lines: [{ productId: 'PRD-0001', qty: 1 }], productPhoto: { base64: 'abc123' }, operationId: opId(),
  }), /DIRECT_WRITE_UNAVAILABLE/);
})();

// ---- stock.receiveOrders / multi-line stock.receive ----
await (async () => {
  const { writeDirect, tabs } = fixture();
  tabs.PURCHASE_ORDERS.rows.push(rowFor(tabs, 'PURCHASE_ORDERS', { OrderID: 'PO-A', ProductID: 'PRD-0001', VendorID: 'VND-1', QtyOrdered: 10, UOM: 'BOTTLE', Status: 'ORDERED', DeliveryLocationID: 'LOC-01' }));
  tabs.PURCHASE_ORDERS.rows.push(rowFor(tabs, 'PURCHASE_ORDERS', { OrderID: 'PO-B', ProductID: 'PRD-0002', VendorID: 'VND-1', QtyOrdered: 10, UOM: 'BOTTLE', Status: 'ORDERED', DeliveryLocationID: 'LOC-01' }));
  const result = await writeDirect('stock.receiveOrders', 'purchase@ahl.com', {
    vendorId: 'VND-1', invoiceNo: 'INV-5', gstPercent: 18, discountedAmount: 900,
    lines: [{ productId: 'PRD-0001', poId: 'PO-A', qty: 3, amount: 600 }, { productId: 'PRD-0002', poId: 'PO-B', qty: 2 }],
    operationId: opId(),
  });
  assert.equal(result.txnIds.length, 2);
  const h = tabs.LEDGER.headers;
  const rowA = tabs.LEDGER.rows.find((r) => r[h.indexOf('PORef')] === 'PO-A');
  const rowB = tabs.LEDGER.rows.find((r) => r[h.indexOf('PORef')] === 'PO-B');
  assert.equal(rowA[h.indexOf('ReceiptID')], rowB[h.indexOf('ReceiptID')]); // one shared receipt
  assert.equal(rowA[h.indexOf('Amount')], 600);
  assert.equal(rowB[h.indexOf('Amount')], 2 * 200 * 1); // no amount given -> QtyBase * product cost
  assert.match(String(rowA[h.indexOf('Notes')]), /GST 18% ₹/);
  assert.match(String(rowA[h.indexOf('Notes')]), /Discounted price ₹900/);
})();
await (async () => {
  // stock.receiveOrders requires every line to reference an order.
  const { writeDirect } = fixture();
  await assert.rejects(() => writeDirect('stock.receiveOrders', 'purchase@ahl.com', { vendorId: 'VND-1', lines: [{ productId: 'PRD-0001', qty: 1 }], operationId: opId() }), /VALIDATION/);
})();
await (async () => {
  // Mixing ordered and unordered products in one multi-product bill is refused.
  const { writeDirect, tabs } = fixture();
  tabs.PURCHASE_ORDERS.rows.push(rowFor(tabs, 'PURCHASE_ORDERS', { OrderID: 'PO-A', ProductID: 'PRD-0001', VendorID: 'VND-1', QtyOrdered: 10, UOM: 'BOTTLE', Status: 'ORDERED', DeliveryLocationID: 'LOC-01' }));
  await assert.rejects(() => writeDirect('stock.receive', 'purchase@ahl.com', { vendorId: 'VND-1', lines: [{ productId: 'PRD-0001', poId: 'PO-A', qty: 1 }, { productId: 'PRD-0002', qty: 1 }], operationId: opId() }), /VALIDATION/);
})();
await (async () => {
  // Unordered multi-product bill (walk-in purchase, no PO): each line's own amount sets that product's cost.
  const { writeDirect, tabs } = fixture();
  const result = await writeDirect('stock.receive', 'purchase@ahl.com', { vendorId: 'VND-1', lines: [{ productId: 'PRD-0001', qty: 1, amount: 450 }], operationId: opId() });
  assert.equal(result.txnIds.length, 1);
  const ph = tabs.PRODUCTS.headers;
  assert.equal(tabs.PRODUCTS.rows[0][ph.indexOf('Cost')], 450 / 500); // qtyBase = 1 * ConvFactor 500
})();

console.log('sheets-write.mjs checks passed: idempotent writes, dedupe, role check, validation, unported-action fallback, the product-management batch (create/setVendor/editUnit/delete/restore), the order-lifecycle batch (create incl. multi-line + request linking/cancel/edit/delete), the receipt edit/delete batch (invoice grouping, re-voided-line refusal, stock/PO guards), the purchase request/approval batch (single + multi-line request, approve/reject, approveMany all-or-nothing), the opening-stock batch (submit dedupe/stock guard, approve/reject with the single-ledger-post guard), stock.issue/stock.retailSale/stock.adjust (balance guards, own-location gate, Admin-only COUNT_*, RETURN-against-issue guard), the handover batch (handover/confirm/cancel, mismatch handling, receiver/sender-only guards, no-adjacency-required pair matching), stock.receive/stock.receiveOrders (order-linked + unordered + multi-line, GST/discount notes), and the photo-attached fallback (Drive uploads from the service account are reverted to Apps Script pending a storage-quota fix).');
