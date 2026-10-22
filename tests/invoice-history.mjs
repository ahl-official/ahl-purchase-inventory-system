// Isolated invoice grouping/totals and Apps Script parity checks; no live writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source=fs.readFileSync(new URL('../src/lib/movement-history.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {groupHistory,receiptTotals,recentHistory,historyDay}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const row=(id,extra={})=>({txnId:id,date:'2026-10-21T20:00:00.000Z',type:'RECEIPT',vendorId:'V1',invoiceNo:'INV-1',productId:'A',qty:2,uom:'PCS',locationId:'LOC-01',personId:'',notes:'',status:'RECEIVED',amount:100,gstAmount:18,...extra});

assert.equal(historyDay('2026-10-21T20:00:00.000Z'),'2026-10-22');
assert.equal(groupHistory([row('a'),row('b')]).length,1);
assert.equal(groupHistory([row('a'),row('b',{vendorId:'V2'})]).length,2);
assert.equal(groupHistory([row('a'),row('b',{date:'2026-10-23T10:00:00Z'})]).length,2);
assert.equal(groupHistory([row('a'),row('b',{status:'VOID'})]).length,2);
assert.equal(groupHistory([row('a',{invoiceNo:'',receiptId:'R1'}),row('b',{invoiceNo:'',receiptId:'R1'})]).length,1);
assert.equal(groupHistory([row('a',{invoiceNo:'',billPhotoUrl:'https://drive.google.com/file/d/one/view'}),row('b',{invoiceNo:'',billPhotoUrl:'https://drive.google.com/file/d/one/view'})]).length,1);
assert.equal(groupHistory([row('a',{invoiceNo:''}),row('b',{invoiceNo:''})]).length,2);
assert.equal(groupHistory([row('a',{type:'ISSUE'}),row('b',{type:'ISSUE'})]).length,2);
assert.deepEqual(receiptTotals([row('a'),row('b',{amount:50,gstAmount:9})]),{subtotal:150,gst:27,total:177,complete:true,hasGst:true});
assert.equal(receiptTotals([row('a',{amount:null})]).complete,false);
assert.equal(receiptTotals([row('a',{amount:0,gstAmount:0})]).complete,true);
assert.equal(receiptTotals([row('a',{amount:0.1,gstAmount:0}),row('b',{amount:0.2,gstAmount:0})]).total,0.3);

// The recent 500-row window begins in the middle of an invoice. Preserve the earlier line.
const rows=[row('old'),...Array.from({length:500},(_,i)=>row(`issue-${i}`,{type:'ISSUE'})),row('new')];
assert.equal(recentHistory(rows).length,501);
assert.equal(groupHistory(recentHistory(rows)).find(g=>g.lines[0].type==='RECEIPT').lines.length,2);
const rawRows=rows.map(r=>({TxnID:r.txnId,Date:r.date,Type:r.type,VendorID:r.vendorId,InvoiceNo:r.invoiceNo,ProductID:r.productId,Qty:r.qty,UOM:r.uom,LocationID:r.locationId,PersonID:r.personId,Notes:r.notes,Status:r.status,Amount:r.amount,GSTAmount:r.gstAmount}));
const ctx=vm.createContext({readAll:()=>rawRows,Utilities:{formatDate:(d)=>historyDay(d.toISOString())}});
vm.runInContext(fs.readFileSync(new URL('../apps-script/Operations.gs',import.meta.url),'utf8'),ctx);
const gas=JSON.parse(JSON.stringify(ctx.getMovementHistory()));
assert.deepEqual(gas.map(r=>r.txnId),recentHistory(rows).map(r=>r.txnId));
assert.equal(groupHistory(gas).find(g=>g.lines[0].type==='RECEIPT').lines.length,2);
assert.equal(receiptTotals(groupHistory(gas).find(g=>g.lines[0].type==='RECEIPT').lines).total,236);
rawRows.push({TxnID:'blank',Type:'RECEIPT',Date:rows[0].date,Amount:'',GSTAmount:''});
assert.equal(ctx.getMovementHistory()[0].amount,null);
assert.equal(ctx.getMovementHistory()[0].gstAmount,null);
console.log('Invoice history grouping, totals, cutoff, and backend parity checks passed.');
