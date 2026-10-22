// In-memory Sheet adapter: validates entry corrections without production access.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

function fixture({issued=0,reserved=0,role='PurchaseCoordinator',receipt=true}={}) {
  const headers={LEDGER:['TxnID','Date','Type','Direction','ProductID','Qty','UOM','QtyBase','LocationID','VendorID','PORef','InvoiceNo','Amount','GSTAmount','GSTPercent','ReceiptID','Actor','Status','Notes','BillPhotoURL'],PURCHASE_ORDERS:['OrderID','Date','ProductID','VendorID','QtyOrdered','UOM','RequestID','Status','Actor','Notes','DeliveryLocationID'],LISTS:['Type','Code','Active']};
  const dates='2026-10-20T06:30:00.000Z';
  const initial={LEDGER:receipt?[
    {TxnID:'R1',Date:dates,Type:'RECEIPT',Direction:1,ProductID:'A',Qty:5,UOM:'BOTTLE',QtyBase:500,LocationID:'LOC-01',VendorID:'V1',PORef:'PO1',InvoiceNo:'INV1',Amount:500,GSTAmount:90,ReceiptID:'BATCH1',Status:'RECEIVED',Notes:'Original'},
    {TxnID:'R2',Date:dates,Type:'RECEIPT',Direction:1,ProductID:'B',Qty:2,UOM:'PCS',QtyBase:2,LocationID:'LOC-01',VendorID:'V1',PORef:'PO2',InvoiceNo:'INV1',Amount:20,GSTAmount:0,ReceiptID:'BATCH1',Status:'RECEIVED'},
    ...(issued?[{TxnID:'ISSUE',Date:dates,Type:'ISSUE',Direction:-1,ProductID:'A',Qty:issued,UOM:'ML',QtyBase:issued,LocationID:'LOC-01',Status:'ISSUED',Notes:'Keep untouched'}]:[]),
  ]:[],PURCHASE_ORDERS:[{OrderID:'PO1',Date:dates,ProductID:'A',VendorID:'V1',QtyOrdered:10,UOM:'BOTTLE',Status:'ORDERED',DeliveryLocationID:'LOC-01'},{OrderID:'PO2',Date:dates,ProductID:'B',VendorID:'V1',QtyOrdered:4,UOM:'PCS',Status:'ORDERED',DeliveryLocationID:'LOC-01'}],LISTS:[{Type:'VENDOR',Code:'V1',Active:true},{Type:'VENDOR',Code:'V2',Active:true}]};
  const data=Object.fromEntries(Object.entries(initial).map(([name,rows])=>[name,rows.map(r=>headers[name].map(h=>r[h]??''))]));
  let writes=0,sequence=0;
  const readAll=name=>data[name].map(row=>Object.fromEntries(headers[name].map((h,i)=>[h,row[i]??''])));
  const sheet=name=>({
    getLastRow:()=>data[name].length+1,getMaxRows:()=>1000,insertRowsAfter:()=>{},
    getRange:(start,col,count=1,width=1)=>({
      getValues:()=>Array.from({length:count},(_,i)=>Array.from({length:width},(_,j)=>data[name][start-2+i]?.[col-1+j]??'')),
      getFormulas:()=>Array.from({length:count},()=>Array(width).fill('')),
      setValues:values=>{writes++;values.forEach((row,i)=>{data[name][start-2+i]??=Array(headers[name].length).fill('');row.forEach((v,j)=>{data[name][start-2+i][col-1+j]=v;});});},
    }),
  });
  const ctx=vm.createContext({readAll,table:name=>({sheet:sheet(name),headers:headers[name],idx:Object.fromEntries(headers[name].map((h,i)=>[h,i]))}),getConfig:(_k,f)=>f,getUser:()=>({Role:role}),appRole:x=>x,isTruthy:Boolean,getProduct:id=>({ProductID:id,Name:id,IssueUOM:id==='A'?'ML':'PCS',PurchaseUOM:id==='A'?'BOTTLE':'PCS'}),nextId:prefix=>`${prefix}-${++sequence}`,ensureColumn:()=>{},audit:()=>{},Utilities:{formatDate:d=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(d)},resolveTxnDate:r=>new Date(r.date+'T12:00:00Z'),findRecord:(name,key,id)=>readAll(name).find(r=>r[key]===id),console});
  ctx.computeAvailableBalance=(productId,locationId)=>readAll('LEDGER').reduce((sum,r)=>r.ProductID===productId&&r.LocationID===locationId&&r.Status!=='VOID'?sum+Number(r.QtyBase)*Number(r.Direction):sum,0)-(productId==='A'?reserved:0);
  for(const file of ['Operations.gs','EntryChanges.gs'])vm.runInContext(fs.readFileSync(new URL('../apps-script/'+file,import.meta.url),'utf8'),ctx);
  const base={txnIds:['R1','R2'],reason:'Correct delivery',date:'2026-10-20',vendorId:'V1',invoiceNo:'INV1',lines:[{txnId:'R1',qty:3,amount:300,gstAmount:54},{txnId:'R2',qty:2,amount:0,gstAmount:0}]};
  return {ctx,readAll,data,dates,base,writes:()=>writes,change:(deleting=false,extra={})=>ctx.processReceiptChange({actor:'purchase@example.com',data:{...base,...extra}},deleting)};
}

{
  const f=fixture();f.change();const ledger=f.readAll('LEDGER');
  assert.equal(f.writes(),1);assert.equal(ledger.length,4);
  assert.equal(ledger[0].Status,'VOID');assert.equal(ledger[0].Qty,5);assert.equal(ledger[0].Amount,500);
  assert.equal(ledger[2].QtyBase,300);assert.equal(ledger[3].Amount,0);
  assert.equal(ledger[2].ReceiptID,ledger[3].ReceiptID);assert.equal(ledger[2].PORef,'PO1');
  assert.equal(f.ctx.listPurchaseOrders().find(o=>o.orderId==='PO1').received,3);
  assert.throws(()=>f.change(),/STALE_ENTRY/);assert.equal(f.writes(),1);
}
{
  const f=fixture();f.change(true);assert.equal(f.readAll('LEDGER').length,2);assert(f.readAll('LEDGER').every(r=>r.Status==='VOID'));assert.equal(f.ctx.listPurchaseOrders().find(o=>o.orderId==='PO1').received,0);
}
{
  const f=fixture({issued:100});const original={...f.readAll('LEDGER')[2]};f.change();assert.deepEqual(f.readAll('LEDGER')[2],original);
}
for(const options of [{issued:400},{reserved:400}]) {
  const f=fixture(options);assert.throws(()=>f.change(),/INSUFFICIENT_STOCK/);assert.equal(f.writes(),0);
}
{
  const f=fixture({issued:1});assert.throws(()=>f.change(true),/INSUFFICIENT_STOCK/);assert.equal(f.writes(),0);
}
for(const extra of [
  {txnIds:['R1']},{txnIds:['R1','R1']},{reason:''},{vendorId:'V2'},
  {lines:[{txnId:'R1',qty:11,amount:1},{txnId:'R2',qty:2,amount:1}]},
  {lines:[{txnId:'R1',qty:1,amount:-1},{txnId:'R2',qty:2,amount:1}]},
  {lines:[{txnId:'R1',qty:1,amount:1},{txnId:'R2',qty:1.5,amount:1}]},
  {lines:[{txnId:'R1',qty:0},{txnId:'R2',qty:0}]},
  {lines:[{txnId:'R1',qty:1},{txnId:'R1',qty:1}]},
]) {const f=fixture();assert.throws(()=>f.change(false,extra),/VALIDATION/);assert.equal(f.writes(),0);}
{
  const f=fixture({role:'ProductDistributor'});assert.throws(()=>f.change(),/FORBIDDEN/);assert.equal(f.writes(),0);
}
{
  const f=fixture();assert.throws(()=>f.ctx.processOrderDelete({actor:'test',data:{orderId:'PO1',reason:'Wrong purchase'}}),/VALIDATION/);assert.equal(f.writes(),0);
}
{
  const f=fixture({receipt:false});f.ctx.processOrderDelete({actor:'test',data:{orderId:'PO1',reason:'Wrong purchase'}});assert.equal(f.readAll('PURCHASE_ORDERS')[0].Status,'CANCELLED');
}
{
  const f=fixture(),req={orderId:'PO1',reason:'Wrong quantity',qty:6,vendorId:'V1',date:'2026-10-20',expected:{qty:10,vendorId:'V1',date:f.dates}};
  f.ctx.processOrderEdit({actor:'test',data:req});assert.equal(f.readAll('PURCHASE_ORDERS')[0].QtyOrdered,6);
  assert.throws(()=>f.ctx.processOrderEdit({actor:'test',data:req}),/STALE_ENTRY/);
}
for(const extra of [{qty:4},{vendorId:'V2'}]) {
  const f=fixture();assert.throws(()=>f.ctx.processOrderEdit({actor:'test',data:{orderId:'PO1',reason:'Correct order',qty:6,vendorId:'V1',date:'2026-10-20',expected:{qty:10,vendorId:'V1',date:f.dates},...extra}}),/VALIDATION/);assert.equal(f.writes(),0);
}
{
  const f=fixture({receipt:false});
  f.ctx.processOrderEdit({actor:'test',data:{orderId:'PO1',reason:'Fix price',qty:10,vendorId:'V1',date:'2026-10-20',expected:{qty:10,vendorId:'V1',date:f.dates},unitPrice:0,notes:'Replacement note'}});
  assert.equal(f.readAll('PURCHASE_ORDERS')[0].Notes,'Replacement note | Unit price ₹0');
}
console.log('Purchase/receipt edit and delete checks passed; no live data used.');
