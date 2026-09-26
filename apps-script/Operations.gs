/** Live masters, purchase tracking and recorded stock corrections. */
function requireAppRole(actor, roles) {
  var role = appRole((getUser(actor) || {}).Role);
  if (roles.indexOf(role) < 0) throw new Error('FORBIDDEN: This action is not available to your role.');
  return role;
}

function positiveQuantity(value, product, allowZero) {
  var qty = Number(value);
  if (!isFinite(qty) || (allowZero ? qty < 0 : qty <= 0)) throw new Error('VALIDATION: Enter a valid quantity.');
  if (product && product.IssueUOM === 'PCS' && Math.floor(qty) !== qty) throw new Error('VALIDATION: Pieces must be whole numbers.');
  return qty;
}

function getCatalogue() {
  var lists = readAll('LISTS').filter(function (r) { return isTruthy(r.Active); });
  function list(type) { return lists.filter(function (r) { return r.Type === type; }).map(function (r) { return { id:r.Code, name:r.Name, unit:r.Extra || '', dot:'bg-chart-1' }; }); }
  return {
    products: readAll('PRODUCTS').filter(function (r) { return isTruthy(r.Active); }).map(function (r) {
      return { id:r.ProductID, name:r.Name, categoryId:r.CategoryID, productType:r.ProductType || 'Consumable', uom:r.IssueUOM, purchaseUom:r.PurchaseUOM, vendorId:r.VendorID || '', conversion:Number(r.ConvFactor) || 1, cost:Number(r.Cost) || 0, reorderLevel:Number(r.ReorderLevel) || 0, balance:null };
    }),
    // Explicit whitelist: never expose login or password fields.
    people: readAll('PEOPLE').filter(function (r) { return isTruthy(r.Active); }).map(function (r) { return { id:r.UserID, name:r.Name, role:appRole(r.Role) || r.Role, locationId:r.LocationID }; }),
    categories:list('CATEGORY'), vendors:list('VENDOR'), locations:list('LOCATION'),
    headOfficeLocationId:getConfig('HeadOfficeLocationID','LOC-01'), salonFloorLocationId:getConfig('SalonFloorLocationID','LOC-02'),
    approvalThreshold:getConfigNumber('ApprovalThreshold',5000)
  };
}

function listPurchaseOrders() {
  var ledger = readAll('LEDGER');
  return readAll('PURCHASE_ORDERS').map(function (r) {
    var received = ledger.reduce(function (sum,l) { return l.Type === 'RECEIPT' && l.Status !== 'VOID' && l.PORef === r.OrderID ? sum + Number(l.Qty) : sum; },0);
    var p = getProduct(r.ProductID);
    return { orderId:r.OrderID, date:r.Date, productId:r.ProductID, productName:p ? p.Name:r.ProductID, vendorId:r.VendorID, qty:Number(r.QtyOrdered), uom:r.UOM, received:received, remaining:Math.max(0,Number(r.QtyOrdered)-received), requestId:r.RequestID || '', status:r.Status === 'CANCELLED' ? 'CANCELLED' : received >= Number(r.QtyOrdered) ? 'RECEIVED' : received > 0 ? 'PARTIAL' : 'ORDERED', notes:r.Notes || '' };
  }).reverse();
}

function processOrderCreate(payload) {
  requireAppRole(payload.actor,['PurchaseCoordinator','Admin']);
  var r = payload.data || {}, p = getProduct(r.productId);
  if (!p || !isTruthy(p.Active)) throw new Error('UNKNOWN_PRODUCT: Select an active product.');
  var qty = positiveQuantity(r.qty,p,false);
  if (!readAll('LISTS').some(function (v) { return v.Type === 'VENDOR' && v.Code === r.vendorId && isTruthy(v.Active); })) throw new Error('VALIDATION: Select a vendor.');
  if (r.requestId) {
    var request = findRecord('REQUESTS','RequestID',r.requestId);
    if (!request || request.ProductID !== r.productId || ['OPEN','ORDERED'].indexOf(request.Status) < 0) throw new Error('VALIDATION: Select an approved request for this product.');
    if (listPurchaseOrders().some(function (o) { return o.requestId === r.requestId && o.status !== 'CANCELLED'; })) throw new Error('DUPLICATE: This request already has an order.');
  }
  var id=nextId('PO');
  appendRecord('PURCHASE_ORDERS',{OrderID:id,Date:new Date(),ProductID:r.productId,VendorID:r.vendorId,QtyOrdered:qty,UOM:p.PurchaseUOM || p.IssueUOM,RequestID:r.requestId || '',Status:'ORDERED',Actor:payload.actor,Notes:r.notes || ''});
  if(r.requestId) updateRecordFields('REQUESTS','RequestID',r.requestId,{Status:'ORDERED'});
  audit(payload.actor,'order.create',id,r);
  return {orderId:id};
}

function updateRecordFields(name, key, id, changes) {
  var t=table(name), rows=readAll(name), index=rows.findIndex(function(r){return String(r[key])===String(id);});
  if(index<0) throw new Error('NOT_FOUND: Record not found.');
  var range=t.sheet.getRange(index+2,1,1,t.headers.length), values=range.getValues()[0];
  Object.keys(changes).forEach(function(k){if(!(k in t.idx)) throw new Error('SCHEMA_ERROR: Missing '+k);values[t.idx[k]]=changes[k];});
  range.setValues([values]);
}

function processOrderCancel(payload) {
  requireAppRole(payload.actor,['PurchaseCoordinator','Admin']);
  var r=payload.data || {};
  if(!String(r.notes || '').trim()) throw new Error('VALIDATION: Give a cancellation reason.');
  var order=findRecord('PURCHASE_ORDERS','OrderID',r.orderId);
  if(!order || order.Status==='CANCELLED') throw new Error('VALIDATION: Order is not open.');
  updateRecordFields('PURCHASE_ORDERS','OrderID',r.orderId,{Status:'CANCELLED',Notes:(order.Notes || '')+' | Cancelled: '+r.notes});
  audit(payload.actor,'order.cancel',r.orderId,r);
  return {status:'CANCELLED'};
}

/** Only the sender can withdraw a still-unconfirmed handover. Receiver stock is unchanged. */
function processHandoverCancel(payload) {
  var role=requireAppRole(payload.actor,['PurchaseCoordinator','Admin']), r=payload.data || {};
  if(!String(r.notes || '').trim()) throw new Error('VALIDATION: Explain the cancellation.');
  var t=table('LEDGER'), all=t.sheet.getDataRange().getValues(), matching=[];
  for(var i=1;i<all.length;i++) if(all[i][t.idx.HandoverID]===r.handoverId && all[i][t.idx.Type]==='HANDOVER') matching.push(i);
  if(matching.length!==2 || matching.some(function(i){return all[i][t.idx.Status]!=='PENDING_CONFIRM';})) throw new Error('VALIDATION: Only an unconfirmed handover can be cancelled.');
  if(role!=='Admin' && matching.some(function(i){return all[i][t.idx.Actor]!==payload.actor;})) throw new Error('FORBIDDEN: Only the sender can cancel.');
  matching.forEach(function(i){all[i][t.idx.Status]='VOID';all[i][t.idx.Notes]+=' | Cancelled: '+r.notes;});
  // The pair is contiguous; one write avoids confirming only half a transfer.
  if(matching[1]!==matching[0]+1) throw new Error('VALIDATION: Handover needs administrator repair.');
  t.sheet.getRange(matching[0]+1,1,2,t.headers.length).setValues(matching.map(function(i){return all[i];}));
  audit(payload.actor,'handover.cancel',r.handoverId,r);
  return {status:'CANCELLED'};
}

function processStockAdjustment(payload) {
  var role=requireAppRole(payload.actor,['PurchaseCoordinator','ProductDistributor','Admin']),r=payload.data || {},p=getProduct(r.productId);
  if(!p || !isTruthy(p.Active)) throw new Error('UNKNOWN_PRODUCT: Select an active product.');
  var loc=openingLocationForActor(payload.actor,r.locationId),qty=positiveQuantity(r.qty,p,false);
  if(!String(r.notes || '').trim()) throw new Error('VALIDATION: Record the reason.');
  if(['RETURN','DAMAGE','COUNT_IN','COUNT_OUT'].indexOf(r.kind)<0) throw new Error('VALIDATION: Select a correction type.');
  if(/^COUNT_/.test(r.kind) && role!=='Admin') throw new Error('FORBIDDEN: Only management can adjust a physical count.');
  var direction=r.kind==='RETURN' || r.kind==='COUNT_IN' ? 1:-1;
  if(direction<0 && qty>computeAvailableBalance(r.productId,loc)) throw new Error('INSUFFICIENT_STOCK: Correction exceeds available stock.');
  if(r.kind==='RETURN') {
    var source=findRecord('LEDGER','TxnID',r.sourceTxnId);
    if(!source || source.Type!=='ISSUE' || source.Status==='VOID' || source.ProductID!==r.productId || source.LocationID!==loc) throw new Error('VALIDATION: Select the original issue from this location.');
    var returned=readAll('LEDGER').filter(function(l){return l.Type==='RETURN' && l.PORef===r.sourceTxnId && l.Status!=='VOID';}).reduce(function(s,l){return s+Number(l.QtyBase);},0);
    if(returned+qty>Number(source.QtyBase)) throw new Error('VALIDATION: Return exceeds the quantity originally issued.');
  }
  var id=nextId('TXN');
  appendRecord('LEDGER',{TxnID:id,Date:new Date(),Type:r.kind,Direction:direction,ProductID:r.productId,Qty:qty,UOM:p.IssueUOM,QtyBase:qty,LocationID:loc,PORef:r.sourceTxnId || '',Actor:payload.actor,Status:'POSTED',Notes:r.notes});
  audit(payload.actor,'stock.adjust',id,r);
  return {txnId:id};
}

/**
 * PRODUCTS.ProductType has a strict dropdown that predates "Both"; a script write of a value it
 * does not list is silently dropped. Widen it once so new Both products keep their type.
 */
function allowBothProductType() {
  var t = table('PRODUCTS'), col = t.idx.ProductType + 1, sheet = t.sheet;
  var range = sheet.getRange(2, col, Math.max(sheet.getMaxRows() - 1, 1), 1);
  var rule = range.getCell(1, 1).getDataValidation();
  if (!rule) return;
  var list = rule.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST ? rule.getCriteriaValues()[0] : [];
  if (list.indexOf('Both') >= 0) return;
  range.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Consumable', 'Retail', 'Both'], true).setAllowInvalid(false).build());
}

/** Purchase coordinator adds a product; runs inside the doPost lock, so the next-ID and duplicate checks cannot race. */
function processProductCreate(payload) {
  requireAppRole(payload.actor,['PurchaseCoordinator','Admin']);
  var r=payload.data || {}, name=String(r.name || '').replace(/\s+/g,' ').trim();
  var norm=function(s){return String(s).toLowerCase().replace(/[^a-z0-9]+/g,'');};
  var uom=function(v,label){var u=String(v || '').trim().toUpperCase();if(!/^[A-Z]{1,10}$/.test(u)) throw new Error('VALIDATION: Choose the '+label+'.');return u;};
  if(name.length<3 || name.length>120) throw new Error('VALIDATION: Enter the product name (3-120 characters).');
  if(['Consumable','Retail','Both'].indexOf(r.productType)<0) throw new Error('VALIDATION: Choose Consumable, Retail or Both.');
  var purchaseUom=uom(r.purchaseUom,'purchase unit'), issueUom=uom(r.issueUom,'stock unit'), conv=Number(r.convFactor);
  if(!isFinite(conv) || conv<=0) throw new Error('VALIDATION: Enter how much stock one purchase unit contains.');
  if(purchaseUom===issueUom && conv!==1) throw new Error('VALIDATION: Same purchase and stock unit must contain exactly 1.');
  var lists=readAll('LISTS'), has=function(type,code){return lists.some(function(v){return v.Type===type && v.Code===code && isTruthy(v.Active);});};
  if(!has('CATEGORY',r.categoryId)) throw new Error('VALIDATION: Choose the product category.');
  var cost=Number(r.cost);
  if(r.cost==='' || r.cost==null || !isFinite(cost) || cost<0) throw new Error('VALIDATION: Enter the cost per '+issueUom+'.');
  var gst=Number(r.gstPercent || 0), reorder=Number(r.reorderLevel || 0);
  if(!isFinite(gst) || gst<0 || gst>28) throw new Error('VALIDATION: GST must be between 0 and 28.');
  if(!isFinite(reorder) || reorder<0) throw new Error('VALIDATION: Reorder level cannot be negative.');
  if(r.vendorId && !has('VENDOR',r.vendorId)) throw new Error('VALIDATION: Choose a listed supplier.');
  var rows=readAll('PRODUCTS');
  if(rows.some(function(p){return norm(p.Name)===norm(name);})) throw new Error('DUPLICATE: This product already exists.');
  allowBothProductType();
  var max=rows.reduce(function(m,p){var n=/^PRD-(\d+)$/.exec(String(p.ProductID));return n?Math.max(m,Number(n[1])):m;},0);
  var id='PRD-'+('0000'+(max+1)).slice(-4);
  appendRecord('PRODUCTS',{ProductID:id,Name:name,CategoryID:r.categoryId,IssueUOM:issueUom,PurchaseUOM:purchaseUom,ConvFactor:conv,Cost:cost,GSTPercent:gst/100,VendorID:r.vendorId || '',ReorderLevel:reorder,Active:true,Notes:[String(r.brand || '').trim() ? 'Brand: '+String(r.brand).trim() : '',String(r.notes || '').trim().slice(0,300)].filter(String).join(' | '),ProductType:r.productType});
  audit(payload.actor,'product.create',id,r);
  return {productId:id,name:name};
}

/**
 * Monthly rows for finance's Inventory tab: one row per city x product.
 * Ledger-derived; a city is the sum of its locations, so Head Office -> Salon
 * handovers inside a city net to zero. Cost is per stock unit.
 */
function getInventoryReport(payload) {
  var tz=Session.getScriptTimeZone(), month=String((payload.data || {}).month || '') || Utilities.formatDate(new Date(),tz,'yyyy-MM');
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('VALIDATION: Choose a month.');
  var lists=readAll('LISTS'), city={}, cat={}, prod={}, issueUnit={};
  lists.forEach(function(l){if(l.Type==='LOCATION' && l.Extra) city[l.Code]=String(l.Extra); if(l.Type==='CATEGORY') cat[l.Code]={name:l.Name,unit:String(l.Extra || '')};});
  readAll('PRODUCTS').forEach(function(p){prod[p.ProductID]=p;});
  var ledger=readAll('LEDGER');
  // Older rows have no BusinessUnit; they fall back to their category's unit.
  var unitOf=function(l){return l.BusinessUnit || (cat[l.CategoryID] || {}).unit;};
  ledger.forEach(function(l){if(l.Type==='ISSUE') issueUnit[l.TxnID]=unitOf(l);});
  var bucket=function(u){return u==='AHL'?'ahl':u==='Alchemane'||u==='ALC'?'alc':'shared';};
  var handoverCities={};
  ledger.forEach(function(l){
    if(l.Type!=='HANDOVER' || l.Status==='VOID' || l.Status==='PENDING_CONFIRM' || !city[l.LocationID]) return;
    (handoverCities[l.HandoverID] || (handoverCities[l.HandoverID]={}))[city[l.LocationID]]=true;
  });
  var crossCity=function(id){return Object.keys(handoverCities[id] || {}).length>1;};
  var out={};
  ledger.forEach(function(l){
    if(l.Status==='VOID' || l.Status==='PENDING_CONFIRM' || !prod[l.ProductID] || !city[l.LocationID] || !l.Date) return;
    var m=Utilities.formatDate(new Date(l.Date),tz,'yyyy-MM');
    if(m>month) return;
    var key=city[l.LocationID]+'|'+l.ProductID;
    var r=out[key] || (out[key]={city:city[l.LocationID],productId:l.ProductID,opening:0,purchases:0,tin:0,tout:0,ahl:0,alc:0,shared:0,adjustments:0,closing:0});
    var q=(Number(l.QtyBase) || 0)*(Number(l.Direction) || 0);
    r.closing+=q;
    if(m<month || l.Type==='OPENING') r.opening+=q;
    else if(l.Type==='RECEIPT') r.purchases+=q;
    else if(l.Type==='ISSUE') r[bucket(unitOf(l))]-=q;
    else if(l.Type==='RETURN') r[bucket(issueUnit[l.PORef])]-=q;
    else if(l.Type==='HANDOVER'){if(crossCity(l.HandoverID)){if(q>0) r.tin+=q; else r.tout-=q;}}
    else r.adjustments+=q;
  });
  var round=function(n){return Math.round(n*1000)/1000;};
  var rows=Object.keys(out).map(function(k){
    var r=out[k], p=prod[r.productId], c=cat[p.CategoryID] || {name:'',unit:''}, cost=Number(p.Cost) || 0;
    return {month:month,type:p.ProductType || 'Consumable',city:r.city,businessUnit:c.unit,category:c.name,productId:r.productId,product:p.Name,uom:p.IssueUOM,opening:round(r.opening),purchases:round(r.purchases),transferIn:round(r.tin),transferOut:round(r.tout),consumedAHL:round(r.ahl),consumedALC:round(r.alc),consumedShared:round(r.shared),adjustments:round(r.adjustments),closing:round(r.closing),costPerUnit:cost,closingValue:round(r.closing*cost)};
  }).filter(function(r){return r.opening||r.purchases||r.transferIn||r.transferOut||r.consumedAHL||r.consumedALC||r.consumedShared||r.adjustments||r.closing;});
  rows.sort(function(a,b){return (a.city+a.category+a.product).localeCompare(b.city+b.category+b.product);});
  return {month:month,rows:rows};
}

function getOperations(payload) {
  var dashboard=getDashboard(payload);
  return { myLocationId:actorLocation(payload.actor), catalogue:getCatalogue(), dashboard:dashboard, orders:listPurchaseOrders(), opening:listOpeningCounts(payload), history:readAll('LEDGER').slice(-500).reverse().map(function(r){return {txnId:r.TxnID,date:r.Date,productId:r.ProductID,qty:Number(r.Qty),uom:r.UOM,type:r.Type,locationId:r.LocationID,personId:r.PersonID,status:r.Status,notes:r.Notes || ''};}) };
}

/** Sets a product's main vendor (the one the purchase screens list first). Past purchases keep the vendor they were bought from. */
function processProductSetVendor(payload) {
  var r=payload.data || {};
  if(!readAll('LISTS').some(function(v){return v.Type==='VENDOR' && v.Code===r.vendorId && isTruthy(v.Active);})) throw new Error('VALIDATION: Choose a listed vendor.');
  if(!findRecord('PRODUCTS','ProductID',r.productId)) throw new Error('VALIDATION: Product not found.');
  updateRecordFields('PRODUCTS','ProductID',r.productId,{VendorID:r.vendorId});
  audit(payload.actor,'product.setVendor',r.productId,r);
  return {productId:r.productId,vendorId:r.vendorId};
}
