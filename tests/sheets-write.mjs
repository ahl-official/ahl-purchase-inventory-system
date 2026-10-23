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

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const FAKE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });

// An in-memory spreadsheet: { TAB: { headers: string[], rows: unknown[][] } }.
function sheetsMock(tabs) {
  const calls = { append: [], update: [] };
  function tabName(url) { return decodeURIComponent(url.match(/\/values\/([^!]+)!/)[1]); }
  async function fetchImpl(url, init) {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'TEST_TOKEN', expires_in: 3600 }) };
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
      rows: [['PRD-0001', 'Shampoo', 'CAT-1', 'ML', 'BOTTLE', 500, 2, 0.18, 'VND-1', 5, true, '', 'Consumable']],
    },
    PEOPLE: { headers: ['UserID', 'Email', 'Name', 'Role', 'LocationID', 'Active'], rows: [['U1', 'purchase@ahl.com', 'Satvik', role, 'LOC-01', active]] },
    LISTS: { headers: ['Type', 'Code', 'Name', 'Extra', 'Active'], rows: [['VENDOR', 'VND-1', 'Vela (Well Vibes)', '', true], ['CATEGORY', 'CAT-1', 'Hair Care', '', true]] },
    LEDGER: { headers: ['ProductID'], rows: [] },
    PURCHASE_ORDERS: { headers: ['OrderID'], rows: [] },
    REQUESTS: { headers: ['RequestID'], rows: [] },
    OPENING_COUNTS: { headers: ['CountID'], rows: [] },
    OPERATIONS: { headers: ['OperationID', 'Date', 'Actor', 'Action', 'Status', 'Result'], rows: [] },
    AUDIT: { headers: ['AuditID', 'Timestamp', 'Actor', 'Action', 'Ref', 'Detail', 'Result'], rows: [] },
  };
  const mock = sheetsMock(tabs);

  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = Buffer.from(JSON.stringify({ client_email: 'test@test.iam.gserviceaccount.com', private_key: FAKE_PRIVATE_KEY })).toString('base64');
  process.env.GOOGLE_SHEET_ID = 'TEST_SHEET';

  const baseRequire = (path) => (path === './movement-history' ? { recentHistory: () => [] } : require(path));
  const sheetsDirectExports = loadModule(sheetsDirectCompiled, baseRequire, mock.fetchImpl, 'sheets-direct.js');
  // sheets-write.ts does `require("./sheets-direct")` -- intercept that one specifier
  // and hand back the already-loaded module compiled above, without touching disk.
  const writeRequire = (path) => (path === './sheets-direct' ? sheetsDirectExports : require(path));
  const sheetsWrite = loadModule(sheetsWriteCompiled, writeRequire, mock.fetchImpl, 'sheets-write.js');

  return { mock, tabs, writeDirect: sheetsWrite.writeDirect };
}

const opId = () => 'op-' + crypto.randomBytes(8).toString('hex');

await (async () => {
  const { writeDirect, tabs, mock } = fixture();
  const id1 = opId();
  const result = await writeDirect('list.add', 'purchase@ahl.com', { type: 'VENDOR', name: 'New Vendor', operationId: id1 });
  assert.match(result.id, /^VND-/);
  assert.equal(result.name, 'New Vendor');
  assert.equal(tabs.LISTS.rows.length, 3); // 2 baseline (vendor + category) + 1 new
  assert.equal(tabs.OPERATIONS.rows.find(r => r[0] === id1)[4], 'COMPLETED');
  assert.equal(mock.calls.append.some(c => c.tab === 'AUDIT'), true);
})();

await (async () => {
  // Case-insensitive dedupe against an existing active entry returns the existing row, no new write.
  const { writeDirect, tabs } = fixture();
  const result = await writeDirect('list.add', 'purchase@ahl.com', { type: 'VENDOR', name: 'vela (well vibes)', operationId: opId() });
  assert.equal(result.id, 'VND-1');
  assert.equal(tabs.LISTS.rows.length, 2); // baseline only, no new write
})();

await (async () => {
  // Replaying the same operationId returns the cached result instead of writing again.
  const { writeDirect, tabs } = fixture();
  const id = opId();
  const first = await writeDirect('list.add', 'purchase@ahl.com', { type: 'VENDOR', name: 'Repeat Co', operationId: id });
  const second = await writeDirect('list.add', 'purchase@ahl.com', { type: 'VENDOR', name: 'Repeat Co', operationId: id });
  assert.deepEqual(first, second);
  assert.equal(tabs.LISTS.rows.length, 3); // only the first call actually wrote
})();

for (const data of [{ type: 'VENDOR', name: 'X' }, { type: 'NOT_A_TYPE', name: 'Valid Name' }]) {
  const { writeDirect, tabs } = fixture();
  await assert.rejects(() => writeDirect('list.add', 'purchase@ahl.com', { ...data, operationId: opId() }), /VALIDATION/);
  assert.equal(tabs.LISTS.rows.length, 2); // nothing written on a rejected validation
}

await (async () => {
  // An inactive/wrong-role actor is refused before anything is read or written.
  const { writeDirect, tabs } = fixture({ role: 'Technician' });
  await assert.rejects(() => writeDirect('list.add', 'purchase@ahl.com', { type: 'VENDOR', name: 'Nope', operationId: opId() }), /FORBIDDEN/);
  assert.equal(tabs.LISTS.rows.length, 2);
})();

await (async () => {
  const { writeDirect } = fixture();
  await assert.rejects(() => writeDirect('stock.receive', 'purchase@ahl.com', { operationId: opId() }), /DIRECT_WRITE_UNAVAILABLE/);
})();

// ---- product.create ----
await (async () => {
  const { writeDirect, tabs, mock } = fixture();
  const result = await writeDirect('product.create', 'purchase@ahl.com', {
    name: 'Conditioner', productType: 'Consumable', purchaseUom: 'BOTTLE', issueUom: 'ML', convFactor: '250',
    categoryId: 'CAT-1', vendorId: 'VND-1', cost: '10', gstPercent: '18', reorderLevel: '2', operationId: opId(),
  });
  assert.equal(result.productId, 'PRD-0002'); // sequential, after the fixture's PRD-0001
  assert.equal(tabs.PRODUCTS.rows.length, 2);
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

console.log('sheets-write.mjs checks passed: idempotent writes, dedupe, role check, validation, unported-action fallback, and the product-management batch (create/setVendor/editUnit/delete/restore).');
