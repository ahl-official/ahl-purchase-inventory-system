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
      return { id:r.ProductID, name:r.Name, categoryId:r.CategoryID, productType:r.ProductType || 'Consumable', uom:r.IssueUOM, purchaseUom:r.PurchaseUOM, conversion:Number(r.ConvFactor) || 1, cost:Number(r.Cost) || 0, reorderLevel:Number(r.ReorderLevel) || 0, balance:null };
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

function getOperations(payload) {
  var dashboard=getDashboard();
  return { catalogue:getCatalogue(), dashboard:dashboard, orders:listPurchaseOrders(), opening:listOpeningCounts(payload), history:readAll('LEDGER').slice(-500).reverse().map(function(r){return {txnId:r.TxnID,date:r.Date,productId:r.ProductID,qty:Number(r.Qty),uom:r.UOM,type:r.Type,locationId:r.LocationID,personId:r.PersonID,status:r.Status,notes:r.Notes || ''};}) };
}
