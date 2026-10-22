// Isolated product-master correction checks; no live data or network.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
const compiled=ts.transpileModule(fs.readFileSync(new URL('../src/lib/product-correction.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
const {productCorrection}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const product={id:'P1',productType:'Consumable',purchaseUom:'TUBE',uom:'ML',conversion:150};
const base={productType:'Both',purchaseUom:'',issueUom:'',conversion:'',notes:'Used for both purposes'};
const typeOnly=productCorrection(product,base);
assert(!Object.hasOwn(typeOnly,'convFactor'));assert.equal(typeOnly.productType,'Both');
assert.equal(typeOnly.notes,base.notes);
const changed=productCorrection(product,{...base,conversion:'145'});
assert.equal(changed.convFactor,145);assert.equal(changed.issueUom,'ML');
assert.equal(productCorrection(product,{...base,purchaseUom:'PCS',issueUom:'PCS',conversion:''}).convFactor,1);

function fixture(history=true){
  let writes=[],validationUpdates=0;
  const p={ProductID:'P1',ProductType:'Consumable',PurchaseUOM:'TUBE',IssueUOM:'ML',ConvFactor:150};
  const ctx=vm.createContext({getUser:()=>({Role:'Admin'}),appRole:r=>r,getProduct:()=>p,readAll:()=>history?[{ProductID:'P1'}]:[],updateRecordFields:(_table,_key,_id,changes)=>writes.push(changes),audit:()=>{}});
  vm.runInContext(fs.readFileSync(new URL('../apps-script/Operations.gs',import.meta.url),'utf8'),ctx);
  ctx.updateRecordFields=(_table,_key,_id,changes)=>writes.push(changes);
  ctx.allowBothProductType=()=>validationUpdates++;
  return {ctx,p,writes,validationUpdates:()=>validationUpdates,save:data=>ctx.processProductEditUnit({actor:'test',data})};
}
{
  const f=fixture();f.save(typeOnly);assert.equal(f.writes.length,1);assert.deepEqual(Object.keys(f.writes[0]),['ProductType']);assert.equal(f.writes[0].ProductType,'Both');
}
{
  const f=fixture();f.p.ProductType='Both';const result=f.save(productCorrection({...product,productType:'Both'},base));assert.equal(result.changed,false);assert.equal(f.writes.length,0);
}
{
  const f=fixture();assert.throws(()=>f.save(changed),/reviewed stock conversion/);assert.equal(f.writes.length,0);assert.equal(f.validationUpdates(),0);
}
{
  const f=fixture();f.p.ConvFactor=145;assert.throws(()=>f.save(typeOnly),/STALE_ENTRY/);assert.equal(f.writes.length,0);
}
{
  const f=fixture(false);f.save(changed);assert.equal(f.writes[0].ConvFactor,145);assert.equal(f.writes[0].ProductType,'Both');
}
for(const conversion of ['0','-1','invalid']){
  const f=fixture(false);assert.throws(()=>f.save(productCorrection(product,{...base,conversion})),/VALIDATION/);assert.equal(f.writes.length,0);
}
console.log('Product correction checks passed: type-only updates, unchanged values, stale forms, unit validation, and protected stock history.');
