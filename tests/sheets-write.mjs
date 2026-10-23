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
    PRODUCTS: { headers: ['ProductID'], rows: [] },
    PEOPLE: { headers: ['UserID', 'Email', 'Name', 'Role', 'LocationID', 'Active'], rows: [['U1', 'purchase@ahl.com', 'Satvik', role, 'LOC-01', active]] },
    LISTS: { headers: ['Type', 'Code', 'Name', 'Extra', 'Active'], rows: [['VENDOR', 'VND-1', 'Vela (Well Vibes)', '', true]] },
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
  assert.equal(tabs.LISTS.rows.length, 2);
  assert.equal(tabs.OPERATIONS.rows.find(r => r[0] === id1)[4], 'COMPLETED');
  assert.equal(mock.calls.append.some(c => c.tab === 'AUDIT'), true);
})();

await (async () => {
  // Case-insensitive dedupe against an existing active entry returns the existing row, no new write.
  const { writeDirect, tabs } = fixture();
  const result = await writeDirect('list.add', 'purchase@ahl.com', { type: 'VENDOR', name: 'vela (well vibes)', operationId: opId() });
  assert.equal(result.id, 'VND-1');
  assert.equal(tabs.LISTS.rows.length, 1);
})();

await (async () => {
  // Replaying the same operationId returns the cached result instead of writing again.
  const { writeDirect, tabs } = fixture();
  const id = opId();
  const first = await writeDirect('list.add', 'purchase@ahl.com', { type: 'VENDOR', name: 'Repeat Co', operationId: id });
  const second = await writeDirect('list.add', 'purchase@ahl.com', { type: 'VENDOR', name: 'Repeat Co', operationId: id });
  assert.deepEqual(first, second);
  assert.equal(tabs.LISTS.rows.length, 2); // only the first call actually wrote
})();

for (const data of [{ type: 'VENDOR', name: 'X' }, { type: 'NOT_A_TYPE', name: 'Valid Name' }]) {
  const { writeDirect, tabs } = fixture();
  await assert.rejects(() => writeDirect('list.add', 'purchase@ahl.com', { ...data, operationId: opId() }), /VALIDATION/);
  assert.equal(tabs.LISTS.rows.length, 1); // nothing written on a rejected validation
}

await (async () => {
  // An inactive/wrong-role actor is refused before anything is read or written.
  const { writeDirect, tabs } = fixture({ role: 'Technician' });
  await assert.rejects(() => writeDirect('list.add', 'purchase@ahl.com', { type: 'VENDOR', name: 'Nope', operationId: opId() }), /FORBIDDEN/);
  assert.equal(tabs.LISTS.rows.length, 1);
})();

await (async () => {
  const { writeDirect } = fixture();
  await assert.rejects(() => writeDirect('stock.receive', 'purchase@ahl.com', { operationId: opId() }), /DIRECT_WRITE_UNAVAILABLE/);
})();

console.log('sheets-write.mjs checks passed: idempotent writes, dedupe, role check, validation, and unported-action fallback.');
