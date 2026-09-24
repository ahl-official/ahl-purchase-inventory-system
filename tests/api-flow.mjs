// End-to-end API test for AHL Flow. Runs the real workflow against the LIVE Apps Script backend
// as Satvik (purchase) and Hitesh (salon floor), with signed requests exactly like /api/gas does.
//
//   node tests/api-flow.mjs
//
// It WRITES data: three products named "TEST-<runid> ..." plus their ledger rows. That is the dummy
// data for demos. Before go-live, delete those rows (PRODUCTS, LEDGER, PURCHASE_ORDERS, AUDIT, OPERATIONS).
import fs from "node:fs";
import crypto from "node:crypto";

const env = {};
for (const l of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  if (!l || l.startsWith("#") || !l.includes("=")) continue;
  const i = l.indexOf("=");
  env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const URL_ = env.NEXT_PUBLIC_APPS_SCRIPT_URL, SECRET = env.HMAC_SECRET;
const SATVIK = process.env.SATVIK_EMAIL || "satvik@ahl.com";
const HITESH = process.env.HITESH_EMAIL || "hitesh@ahl.com";
const RUN = crypto.randomBytes(2).toString("hex");
const TINY_JPEG = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

async function raw(body, sigOverride) {
  const ts = Date.now();
  const sig = sigOverride ?? crypto.createHmac("sha256", SECRET).update(`${ts}.${body}`, "utf8").digest("base64");
  const u = new URL(URL_); u.searchParams.set("ts", ts); u.searchParams.set("sig", sig);
  const t0 = Date.now();
  // Google sometimes answers with an HTML error page (right after a deploy). The script never ran in
  // that case, so retrying is safe, exactly as src/lib/api.ts explains.
  let j, text, attempt;
  for (attempt = 1; ; attempt++) {
    const r = await fetch(u, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body, redirect: "follow", signal: AbortSignal.timeout(90_000) });
    text = await r.text();
    try { j = JSON.parse(text); break; }
    catch { if (attempt >= 3) throw new Error("Apps Script returned a non-JSON page 3 times"); await new Promise((res) => setTimeout(res, 3000)); }
  }
  return { ok: j.success === true, error: j.error, message: j.message, data: j.data, secs: (Date.now() - t0) / 1000, attempts: attempt, raw: text.slice(0, 300) };
}
const READ = /\.(read|list)$/;
async function call(actor, action, data = {}, opId) {
  const d = READ.test(action) ? data : { ...data, operationId: opId || crypto.randomUUID() };
  const body = JSON.stringify({ action, actor, data: d });
  const r = await raw(body);
  // Rarely, on a slow call, Google returns success without the result body (seen ~1 in 60 calls).
  // The write itself is safe: resending the same operation id returns the stored result, never a second write.
  return r.ok && r.data === undefined ? raw(body) : r;
}

let pass = 0, fail = 0;
const failures = [];
const slow = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log("PASS", name); }
  catch (e) { fail++; failures.push(name); console.log("FAIL", name, "->", e.message); }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); };
const okRes = (r, what = "call") => {
  if (!r.ok) throw new Error(`${what} failed: ${r.error} ${r.message}`);
  if (r.data === undefined) throw new Error(`${what} succeeded but returned no data: ${JSON.stringify(r)}`);
  return r.data;
};
const rejected = (r, code, what = "call") => { if (r.ok) throw new Error(`${what} should have been rejected with ${code}`); eq(r.error, code, what + " error code"); };
const timed = (r) => { if (r.secs > 20) slow.push(r.secs.toFixed(1) + "s"); return r; };

const state = {};
const stock = async (productId, loc) => {
  const ops = okRes(timed(await call(SATVIK, "operations.read")), "operations.read");
  state.ops = ops;
  const s = ops.dashboard.stock.find((x) => x.productId === productId);
  return s ? s.locationBalances[loc] : undefined;
};

console.log(`AHL Flow API test, run ${RUN}\n`);

await t("setup: both test users are in the directory", async () => {
  const cat = okRes(await call(SATVIK, "catalogue.read"), "satvik catalogue.read");
  state.cat = cat;
  okRes(await call(HITESH, "catalogue.read"), `hitesh catalogue.read (is ${HITESH} the right email? set HITESH_EMAIL)`);
  state.HO = cat.headOfficeLocationId; state.SALON = cat.salonFloorLocationId;
  state.hiteshId = cat.people.find((p) => p.role === "ProductDistributor" && p.locationId === state.SALON)?.id;
  state.vendor = cat.vendors[0]?.id;
  if (!state.hiteshId || !state.vendor) throw new Error("need a Salon Floor distributor and a vendor in the sheet");
});
if (state.hiteshId === undefined) { console.log("\nCannot continue without setup."); process.exit(1); }

const P = (suffix, over) => ({ name: `TEST-${RUN} ${suffix}`, brand: "Test", productType: "Consumable", purchaseUom: "BTL", issueUom: "ML", convFactor: 100, categoryId: "CAT-09", cost: 1, gstPercent: 0, vendorId: "", reorderLevel: 0, ...over });

await t("product.create rejects a missing category", async () => rejected(await call(SATVIK, "product.create", P("bad", { categoryId: "" })), "VALIDATION"));
await t("product.create rejects a missing cost", async () => rejected(await call(SATVIK, "product.create", P("bad", { cost: "" })), "VALIDATION"));
await t("product.create rejects same unit with conversion not 1", async () => rejected(await call(SATVIK, "product.create", P("bad", { purchaseUom: "ML", issueUom: "ML", convFactor: 5 })), "VALIDATION"));
await t("product.create is forbidden for the salon-floor role", async () => rejected(await call(HITESH, "product.create", P("bad")), "FORBIDDEN"));

const products = {
  A: P("Colour Tube", { productType: "Consumable", purchaseUom: "TUBE", issueUom: "GM", convFactor: 60, categoryId: "CAT-09", cost: 3 }),
  B: P("Retail Shampoo", { productType: "Retail", purchaseUom: "BTL", issueUom: "ML", convFactor: 250, categoryId: "CAT-08", cost: 4 }),
  C: P("Both Serum", { productType: "Both", purchaseUom: "BTL", issueUom: "ML", convFactor: 100, categoryId: "CAT-02", cost: 12.5 }),
};
await t("product.create adds three products (Consumable, Retail, Both)", async () => {
  for (const k of Object.keys(products)) {
    const d = okRes(await call(SATVIK, "product.create", products[k]), `create ${k}`);
    products[k].id = d.productId;
    if (!/^PRD-\d{4}$/.test(d.productId)) throw new Error("bad id " + d.productId);
  }
});
await t("product.create blocks a duplicate name", async () => rejected(await call(SATVIK, "product.create", products.A), "DUPLICATE"));
await t("catalogue shows the new products with category and cost", async () => {
  const cat = okRes(await call(SATVIK, "catalogue.read"), "catalogue.read");
  for (const k of ["A", "B", "C"]) {
    const p = cat.products.find((x) => x.id === products[k].id);
    if (!p) throw new Error(k + " missing");
    eq(p.categoryId, products[k].categoryId, k + " category"); eq(p.cost, products[k].cost, k + " cost");
    eq(p.productType, products[k].productType, k + " type");
  }
});

const A = () => products.A.id, B = () => products.B.id, C = () => products.C.id;

await t("purchase order for A (10 tubes), then receive in two parts", async () => {
  const po = okRes(await call(SATVIK, "order.create", { productId: A(), qty: 10, vendorId: state.vendor, notes: "test" }), "order.create");
  state.po = po.orderId;
  const r1 = okRes(await call(SATVIK, "stock.receive", { productId: A(), qty: 5, vendorId: state.vendor, poId: state.po, invoiceNo: "T-1", amount: 900, locationId: state.HO }), "receive 1");
  eq(r1.qtyBase, 300, "5 tubes x 60 GM");
  rejected(await call(SATVIK, "stock.receive", { productId: A(), qty: 6, vendorId: state.vendor, poId: state.po, invoiceNo: "T-2", locationId: state.HO }), "VALIDATION", "over-receipt");
  okRes(await call(SATVIK, "stock.receive", { productId: A(), qty: 5, vendorId: state.vendor, poId: state.po, invoiceNo: "T-3", amount: 900, locationId: state.HO }), "receive 2");
  const ops = okRes(await call(SATVIK, "operations.read"), "operations.read");
  eq(ops.orders.find((o) => o.orderId === state.po)?.status, "RECEIVED", "PO status");
});
await t("delivery without an order, with a bill photo (B: 4 bottles)", async () => {
  const r = okRes(await call(SATVIK, "stock.receive", { productId: B(), qty: 4, vendorId: state.vendor, invoiceNo: "T-4", amount: 0, locationId: state.HO, photo: { base64: TINY_JPEG, mimeType: "image/jpeg", fileName: "test-bill.jpg", sizeBytes: 100 } }), "receive B");
  eq(r.qtyBase, 1000, "4 x 250 ML");
  if (!r.billUrl) throw new Error("bill photo was not stored in Drive");
});
await t("duplicate submit is not applied twice (same operation id)", async () => {
  const op = crypto.randomUUID(), body = { productId: C(), qty: 3, vendorId: state.vendor, invoiceNo: "T-5", locationId: state.HO };
  const a = okRes(await call(SATVIK, "stock.receive", body, op), "first");
  const b = okRes(await call(SATVIK, "stock.receive", body, op), "repeat");
  eq(b.txnId, a.txnId, "same result returned");
  eq(await stock(C(), state.HO), 300, "C at Head Office (3 x 100, not 600)");
});
await t("Head Office balances are right (A 600 GM, B 1000 ML, C 300 ML)", async () => {
  eq(await stock(A(), state.HO), 600, "A"); eq(await stock(B(), state.HO), 1000, "B"); eq(await stock(C(), state.HO), 300, "C");
});

let h1;
await t("handover A 200 GM to Hitesh reserves stock and is not usable yet", async () => {
  h1 = okRes(await call(SATVIK, "stock.handover", { productId: A(), qty: 200, toUserId: state.hiteshId, toLocationId: state.SALON }), "handover").handoverId;
  eq(await stock(A(), state.HO), 400, "HO available after reserve"); eq(await stock(A(), state.SALON), 0, "Salon before confirm");
});
await t("handover more than available is rejected", async () => rejected(await call(SATVIK, "stock.handover", { productId: A(), qty: 999, toUserId: state.hiteshId, toLocationId: state.SALON }), "INSUFFICIENT_STOCK"));
await t("Satvik cannot confirm his own handover", async () => rejected(await call(SATVIK, "stock.confirmHandover", { handoverId: h1, countedQty: 200 }), "FORBIDDEN"));
await t("wrong recount keeps it pending (COUNT_MISMATCH)", async () => {
  rejected(await call(HITESH, "stock.confirmHandover", { handoverId: h1, countedQty: 150, notes: "short" }), "COUNT_MISMATCH");
  eq(await stock(A(), state.SALON), 0, "Salon still 0");
});
await t("correct recount moves the stock to the Salon Floor", async () => {
  okRes(await call(HITESH, "stock.confirmHandover", { handoverId: h1, countedQty: 200 }), "confirm");
  eq(await stock(A(), state.SALON), 200, "Salon A"); eq(await stock(A(), state.HO), 400, "HO A");
});
await t("Hitesh sees only handovers addressed to him", async () => {
  const d = okRes(await call(SATVIK, "stock.handover", { productId: C(), qty: 50, toUserId: state.hiteshId, toLocationId: state.SALON }), "handover C");
  state.h3 = d.handoverId;
  const ops = okRes(await call(HITESH, "operations.read"), "hitesh operations.read");
  if (!ops.dashboard.pendingHandovers.some((h) => h.handoverId === state.h3)) throw new Error("his pending handover is missing");
  okRes(await call(HITESH, "stock.confirmHandover", { handoverId: state.h3, countedQty: 50 }), "confirm C");
  eq(ops.myLocationId, state.SALON, "Hitesh works from the Salon Floor");
});
await t("cancelling a pending handover releases the reservation (B 300)", async () => {
  const d = okRes(await call(SATVIK, "stock.handover", { productId: B(), qty: 300, toUserId: state.hiteshId, toLocationId: state.SALON }), "handover B");
  eq(await stock(B(), state.HO), 700, "reserved");
  okRes(await call(SATVIK, "handover.cancel", { handoverId: d.handoverId, notes: "test cancel" }), "cancel");
  eq(await stock(B(), state.HO), 1000, "released");
});
await t("city transfer to Delhi needs a receiver based in Delhi", async () => {
  const delhi = state.cat.locations.find((l) => l.unit === "Delhi");
  if (!delhi) throw new Error("no Delhi location in the sheet");
  rejected(await call(SATVIK, "stock.handover", { productId: A(), qty: 10, toUserId: state.hiteshId, toLocationId: delhi.id }), "VALIDATION");
  rejected(await call(SATVIK, "stock.handover", { productId: A(), qty: 10, toUserId: state.hiteshId, toLocationId: "LOC-99" }), "VALIDATION", "unknown destination");
});

let issueTxn;
await t("issue: the chosen business unit beats the category; a missing one falls back to the category; a bad one is rejected", async () => {
  const issue = (productId, qty, cat, from, bu) => call(HITESH, "stock.issue", { productId, fromLocationId: from || state.SALON, splits: [{ qty, recipientUserId: state.hiteshId, categoryId: cat, businessUnit: bu, notes: "test" }] });
  okRes(await issue(A(), 60, "CAT-09", null, "AHL"), "issue A to AHL (category says Shared)");
  okRes(await issue(C(), 20, "CAT-02", null, "Alchemane"), "issue C to Alchemane (category says AHL)");
  okRes(await issue(A(), 5, "CAT-09"), "issue A with no business unit -> falls back to Shared");
  rejected(await issue(A(), 1, "CAT-09", null, "Nobody"), "VALIDATION", "invalid business unit");
  rejected(await issue(A(), 9999, "CAT-09"), "INSUFFICIENT_STOCK");
  rejected(await issue(A(), 1, "CAT-09", state.HO), "FORBIDDEN", "issue from Head Office");
  eq(await stock(A(), state.SALON), 135, "Salon A"); eq(await stock(C(), state.SALON), 30, "Salon C");
  issueTxn = state.ops.history.find((h) => h.type === "ISSUE" && h.productId === A() && h.qty === 60)?.txnId;
  if (!issueTxn) throw new Error("issue not in history");
});
await t("return 10 GM of A, and Satvik records 5 GM damaged", async () => {
  okRes(await call(HITESH, "stock.adjust", { productId: A(), qty: 10, kind: "RETURN", sourceTxnId: issueTxn, notes: "unused" }), "return");
  rejected(await call(HITESH, "stock.adjust", { productId: A(), qty: 100, kind: "RETURN", sourceTxnId: issueTxn, notes: "too many" }), "VALIDATION", "return more than issued");
  okRes(await call(SATVIK, "stock.adjust", { productId: A(), qty: 5, kind: "DAMAGE", notes: "broken tube" }), "damage");
  eq(await stock(A(), state.SALON), 145, "Salon A after return"); eq(await stock(A(), state.HO), 395, "HO A after damage");
});

await t("monthly report matches the hand-calculated numbers", async () => {
  const rep = okRes(await call(SATVIK, "inventoryReport.read", {}), "report");
  const row = (id) => rep.rows.find((r) => r.productId === id && r.city === "Mumbai");
  const want = {
    A: { opening: 0, purchases: 600, transferIn: 0, transferOut: 0, consumedAHL: 50, consumedALC: 0, consumedShared: 5, adjustments: -5, closing: 540, closingValue: 1620, businessUnit: "Shared" },
    B: { opening: 0, purchases: 1000, consumedAHL: 0, consumedALC: 0, consumedShared: 0, closing: 1000, closingValue: 4000, businessUnit: "Alchemane" },
    C: { opening: 0, purchases: 300, consumedAHL: 0, consumedALC: 20, consumedShared: 0, closing: 280, closingValue: 3500, businessUnit: "AHL" },
  };
  for (const k of Object.keys(want)) for (const f of Object.keys(want[k])) eq(row(products[k].id)?.[f], want[k][f], `${k}.${f}`);
});

await t("role and signature checks", async () => {
  rejected(await call(HITESH, "inventoryReport.read", {}), "FORBIDDEN", "report for salon role");
  rejected(await call(SATVIK, "opening.approve", { countId: "x", decision: "APPROVE" }), "FORBIDDEN", "opening.approve as Satvik");
  rejected(await call(SATVIK, "no.such.action", {}), "UNKNOWN_ACTION");
  const body = JSON.stringify({ action: "catalogue.read", actor: SATVIK, data: {} });
  rejected(await raw(body, "AAAA"), "FORBIDDEN", "bad signature");
  rejected(await call("nobody@example.com", "catalogue.read"), "NOT_IN_DIRECTORY");
});

console.log(`\n${pass} passed, ${fail} failed.${slow.length ? ` Slow calls (>20s): ${slow.join(", ")}` : ""}`);
if (fail) console.log("Failed:\n - " + failures.join("\n - "));
console.log(`Dummy data left in the sheet: 3 products named "TEST-${RUN} ...".`);
process.exit(fail ? 1 : 0);
