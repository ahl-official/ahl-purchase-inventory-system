/** Entry corrections run only inside doPost's role checks, lock and operation-ID flow. */
function entryChangeReason(req) {
  var reason=String(req.reason || '').trim();
  if (reason.length < 3) throw new Error('VALIDATION: Explain the edit or deletion.');
  return reason;
}

function processOrderEdit(payload) {
  requireAppRole(payload.actor,['PurchaseCoordinator','Admin']);
  var req=payload.data || {}, reason=entryChangeReason(req);
  var order=listPurchaseOrders().find(function(o){return o.orderId === req.orderId;});
  if (!order || order.status === 'CANCELLED') throw new Error('VALIDATION: Select an active purchase order.');
  if (!req.expected || Number(req.expected.qty) !== order.qty || req.expected.vendorId !== order.vendorId || String(req.expected.notes || '') !== String(order.notes || '') || new Date(req.expected.date).getTime() !== new Date(order.date).getTime() || (req.expected.unitPrice !== undefined && Number(req.expected.unitPrice || 0) !== Number(order.unitPrice || 0))) throw new Error('STALE_ENTRY: This order changed. Refresh before editing.');
  var product=getProduct(order.productId), qty=positiveQuantity(req.qty,product,false);
  if (qty < order.received) throw new Error('VALIDATION: Ordered quantity cannot be less than the quantity already received. Edit the receipt first.');
  var vendor=String(req.vendorId || '');
  if (!readAll('LISTS').some(function(v){return v.Type === 'VENDOR' && v.Code === vendor && isTruthy(v.Active);})) throw new Error('VALIDATION: Select an active vendor.');
  if (order.received > 0 && vendor !== order.vendorId) throw new Error('VALIDATION: A received order must keep its vendor. Correct its receipts first.');
  var date=resolveTxnDate(req);
  var notes=req.notes == null ? String(order.notes || '') : String(req.notes).trim();
  var changes={QtyOrdered:qty,VendorID:vendor,Date:date,Notes:notes};
  if (Object.prototype.hasOwnProperty.call(req,'unitPrice')) {
    var price=req.unitPrice === '' ? '' : Number(req.unitPrice);
    if (price !== '' && (!isFinite(price) || price < 0)) throw new Error('VALIDATION: Enter a valid unit price.');
    ensureColumn('PURCHASE_ORDERS','UnitPrice');
    changes.UnitPrice=price;
  }
  updateRecordFields('PURCHASE_ORDERS','OrderID',order.orderId,changes);
  audit(payload.actor,'order.edit',order.orderId,{before:order,qty:qty,vendorId:vendor,date:date,reason:reason});
  return {orderId:order.orderId};
}

function processOrderDelete(payload) {
  requireAppRole(payload.actor,['PurchaseCoordinator','Admin']);
  var req=payload.data || {}, reason=entryChangeReason(req);
  var order=listPurchaseOrders().find(function(o){return o.orderId === req.orderId;});
  if (!order || order.status === 'CANCELLED') throw new Error('VALIDATION: This order is already deleted or cancelled.');
  if (order.received > 0) throw new Error('VALIDATION: Delete or correct the receipts before deleting a received order.');
  return processOrderCancel({actor:payload.actor,data:{orderId:req.orderId,notes:'Deleted: '+reason}});
}

function processReceiptChange(payload, deleting) {
  requireAppRole(payload.actor,['PurchaseCoordinator','Admin']);
  var req=payload.data || {}, reason=entryChangeReason(req), all=readAll('LEDGER');
  if (!Array.isArray(req.txnIds) || !req.txnIds.length || new Set(req.txnIds).size !== req.txnIds.length) throw new Error('VALIDATION: Select a receipt.');
  var selected=all.filter(function(r){return req.txnIds.indexOf(r.TxnID) >= 0;});
  if (selected.length !== req.txnIds.length || selected.some(function(r){return r.Type !== 'RECEIPT' || r.Status === 'VOID' || Number(r.Direction) !== 1;})) throw new Error('STALE_ENTRY: This receipt changed or was deleted. Refresh history.');
  var groupKey=movementHistoryKey(selected[0]);
  if (selected.some(function(r){return movementHistoryKey(r) !== groupKey;}) || all.filter(function(r){return movementHistoryKey(r) === groupKey;}).length !== selected.length) throw new Error('VALIDATION: Select the complete invoice. Refresh history.');
  var date=deleting ? null : resolveTxnDate(req), vendor=String(req.vendorId || '');
  if (!deleting && !readAll('LISTS').some(function(v){return v.Type === 'VENDOR' && v.Code === vendor && isTruthy(v.Active);})) throw new Error('VALIDATION: Select an active vendor.');
  if (!deleting && (!Array.isArray(req.lines) || req.lines.length !== selected.length || new Set(req.lines.map(function(l){return l.txnId;})).size !== selected.length)) throw new Error('VALIDATION: Include each original receipt line exactly once.');
  var deltas={}, oldByOrder={}, newByOrder={}, replacements=[], receiptId=nextId('RCPT');
  selected.forEach(function(row){
    var stockKey=JSON.stringify([row.ProductID,row.LocationID]);
    if (!deltas[stockKey]) deltas[stockKey]={productId:row.ProductID,locationId:row.LocationID,qty:0};
    deltas[stockKey].qty -= Number(row.QtyBase);
    if (row.PORef) oldByOrder[row.PORef]=(oldByOrder[row.PORef] || 0)+Number(row.Qty);
    if (deleting) return;
    var line=req.lines.find(function(l){return l.txnId === row.TxnID;});
    if (!line) throw new Error('VALIDATION: Original receipt line is missing.');
    var qty=Number(line.qty), amount=line.amount === '' || line.amount == null ? '' : Number(line.amount), gst=line.gstAmount === '' || line.gstAmount == null ? '' : Number(line.gstAmount);
    if (!isFinite(qty) || qty < 0 || (row.UOM === 'PCS' && Math.floor(qty) !== qty)) throw new Error('VALIDATION: Enter a valid received quantity.');
    if ((amount !== '' && (!isFinite(amount) || amount < 0)) || (gst !== '' && (!isFinite(gst) || gst < 0))) throw new Error('VALIDATION: Amount and GST must be zero or greater.');
    if (qty === 0) return;
    if (!(Number(row.Qty) > 0) || !(Number(row.QtyBase) > 0)) throw new Error('VALIDATION: Historical units need administrator review.');
    var qtyBase=qty*Number(row.QtyBase)/Number(row.Qty);
    deltas[stockKey].qty += qtyBase;
    if (row.PORef) newByOrder[row.PORef]=(newByOrder[row.PORef] || 0)+qty;
    var replacement={}; Object.keys(row).forEach(function(k){replacement[k]=row[k];});
    replacement.TxnID=nextId('TXN'); replacement.ReceiptID=receiptId; replacement.Date=date;
    replacement.VendorID=vendor; replacement.InvoiceNo=String(req.invoiceNo || '').trim();
    replacement.Qty=qty; replacement.QtyBase=qtyBase; replacement.Amount=amount;
    replacement.GSTAmount=gst; replacement.GSTPercent=amount > 0 && gst !== '' ? gst/amount*100 : '';
    replacement.Actor=payload.actor; replacement.Status='RECEIVED';
    replacement.Notes=String(req.notes || '').trim()+' | Edited from '+row.TxnID+': '+reason;
    replacements.push(replacement);
  });
  if (!deleting && !replacements.length) throw new Error('VALIDATION: Keep at least one received product, or use Delete receipt.');
  Object.keys(deltas).forEach(function(k){var d=deltas[k];if (computeAvailableBalance(d.productId,d.locationId)+d.qty < -0.000001) throw new Error('INSUFFICIENT_STOCK: This stock has been issued or reserved. Return or correct those movements before reducing this receipt.');});
  if (!deleting) {
    var orders=listPurchaseOrders();
    Object.keys(newByOrder).forEach(function(id){
      var order=orders.find(function(o){return o.orderId === id;});
      if (!order || order.vendorId !== vendor) throw new Error('VALIDATION: The receipt vendor must match its purchase order.');
      if (order.received-(oldByOrder[id] || 0)+newByOrder[id] > order.qty+0.000001) throw new Error('VALIDATION: Received quantity exceeds the purchase order. Edit the order first.');
    });
  }
  ensureColumn('LEDGER','ReceiptID'); ensureColumn('LEDGER','GSTPercent'); ensureColumn('LEDGER','GSTAmount');
  // One range write voids the originals and appends replacements together. The original
  // quantities, dates and amounts remain available for review. Unrelated rows are preserved.
  var t=table('LEDGER'), last=t.sheet.getLastRow();
  if (last+replacements.length > t.sheet.getMaxRows()) t.sheet.insertRowsAfter(t.sheet.getMaxRows(),last+replacements.length-t.sheet.getMaxRows());
  var ids=t.sheet.getRange(2,t.idx.TxnID+1,last-1,1).getValues();
  var first=ids.findIndex(function(r){return req.txnIds.indexOf(r[0]) >= 0;})+2;
  if (first < 2) throw new Error('STALE_ENTRY: Receipt no longer exists.');
  var count=last-first+1, range=t.sheet.getRange(first,1,count,t.headers.length), values=range.getValues(), formulas=range.getFormulas();
  values.forEach(function(row,i){
    if (req.txnIds.indexOf(row[t.idx.TxnID]) >= 0) {row[t.idx.Status]='VOID';row[t.idx.Notes]=String(row[t.idx.Notes] || '')+' | '+(deleting?'Deleted':'Replaced')+' by '+payload.actor+': '+reason;}
    formulas[i].forEach(function(formula,col){if (formula) row[col]=formula;});
  });
  replacements.forEach(function(record){values.push(t.headers.map(function(header){return record[header] == null ? '' : record[header];}));});
  t.sheet.getRange(first,1,values.length,t.headers.length).setValues(values);
  audit(payload.actor,deleting?'receipt.delete':'receipt.edit',selected[0].TxnID,{originalTxnIds:req.txnIds,replacementTxnIds:replacements.map(function(r){return r.TxnID;}),reason:reason});
  return {deleted:deleting,receiptId:receiptId,txnIds:replacements.map(function(r){return r.TxnID;})};
}
