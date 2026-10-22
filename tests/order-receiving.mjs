// Isolated backend checks: no network, credentials, or production data.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

function fixture() {
  const writes=[];
  const products={A:{Name:'Shampoo',IssueUOM:'ML',PurchaseUOM:'BOTTLE',ConvFactor:100,Cost:2},B:{Name:'Comb',IssueUOM:'PCS',PurchaseUOM:'PCS',Cost:10}};
  const orders=[{orderId:'PO-1',productId:'A',vendorId:'V1',remaining:5,status:'ORDERED',uom:'BOTTLE',deliveryLocationId:'LOC-01'},
    {orderId:'PO-2',productId:'B',vendorId:'V1',remaining:3,status:'PARTIAL',uom:'PCS',deliveryLocationId:'LOC-03'}];
  let id=0;
  const ctx=vm.createContext({
    getConfig:(_key,fallback)=>fallback,
    readAll:()=>[{Type:'VENDOR',Code:'V1',Active:true}],isTruthy:Boolean,
    getProduct:id=>products[id],listPurchaseOrders:()=>orders,
    toBaseQty:(p,q)=>q*(p.ConvFactor||1),ensureColumn:()=>{},
    nextId:()=>`TXN-${++id}`,resolveTxnDate:()=>new Date('2026-10-22'),
    appendRecords:(_tab,rows)=>writes.push(...rows),updateRecordFields:()=>{},
    audit:()=>{},redactForAudit:x=>x,
  });
  vm.runInContext(readFileSync(new URL('../apps-script/Ledger.gs',import.meta.url),'utf8'),ctx);
  // Match the real positiveQuantity validator without overriding the handler under test.
  vm.runInContext(readFileSync(new URL('../apps-script/Operations.gs',import.meta.url),'utf8').split('function getCatalogue()')[0],ctx);
  const receive=(lines,extra={})=>ctx.processStockReceiveLines({actor:'test@example.com',data:{vendorId:'V1',lines,...extra}});
  return {receive,writes,orders};
}

{
  const {receive,writes}=fixture();
  receive([{poId:'PO-1',productId:'A',qty:2},{poId:'PO-2',productId:'B',qty:3,amount:0}]);
  assert.equal(writes.length,2);
  assert.equal(writes[0].ReceiptID,writes[1].ReceiptID);
  assert.equal(writes[0].PORef,'PO-1'); assert.equal(writes[0].QtyBase,200);
  assert.equal(writes[0].Amount,400); assert.equal(writes[1].Amount,0);
  assert.equal(writes[1].LocationID,'LOC-03');
}
{
  const {receive,writes}=fixture();
  receive([{poId:'PO-1',productId:'A',qty:1}]);
  assert.equal(writes.length,1); // Missing second product is not received.
}
for(const lines of [
  [{poId:'PO-1',productId:'A',qty:6}],
  [{poId:'PO-1',productId:'B',qty:1}],
  [{poId:'PO-1',productId:'A',qty:1},{poId:'PO-1',productId:'A',qty:1}],
  [{poId:'PO-1',productId:'A',qty:1},{productId:'B',qty:1}],
  [{poId:'PO-1',productId:'A',qty:1},{poId:'PO-2',productId:'B',qty:4}],
  [{poId:'PO-2',productId:'B',qty:1.5}],
  [{poId:'PO-1',productId:'A',qty:0}],
]) {
  const {receive,writes}=fixture();
  assert.throws(()=>receive(lines),/VALIDATION/); assert.equal(writes.length,0);
}
for(const change of [{vendorId:'V2'},{status:'CANCELLED'},{status:'RECEIVED'},{uom:'PCS'}]) {
  const {receive,writes,orders}=fixture(); Object.assign(orders[0],change);
  assert.throws(()=>receive([{poId:'PO-1',productId:'A',qty:1}]),/VALIDATION/);
  assert.equal(writes.length,0);
}
{
  const {receive,writes}=fixture();
  receive([{productId:'B',qty:1,amount:10}]);
  assert.equal(writes[0].PORef,''); // Unordered delivery still works.
}
console.log('Order receiving checks passed (14 scenarios).');
