/** Pure definitions shared by the Apps Script migration and the connector migration. */
function inventoryViewDefinitions(headers) {
  function col(n) { var s='';for(n++;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s; }
  function ref(tab,key) {var i=headers[tab].indexOf(key);if(i<0)throw new Error('Missing '+tab+'.'+key);var c=col(i);return tab+'!'+c+'2:'+c;}
  function l(k){return ref('LEDGER',k);}function p(k){return ref('PRODUCTS',k);}function o(k){return ref('OPENING_COUNTS',k);}function po(k){return ref('PURCHASE_ORDERS',k);}
  function lookup(ids,tab,key,val){return 'IFNA(XLOOKUP('+ids+','+ref(tab,key)+','+ref(tab,val)+'),'+ids+')';}
  function array(expr){return '=ARRAYFORMULA('+expr+')';}
  function filter(parts,conditions){return array('IFNA(FILTER({'+parts.join(',')+'},'+conditions.join(',')+'),"")');}
  function sum(direction,location,pending){return 'SUMIFS('+l('QtyBase')+','+l('ProductID')+',id,'+l('LocationID')+',"'+location+'",'+l('Direction')+','+direction+','+l('Status')+',"<>VOID",'+l('Status')+',"'+(pending?'PENDING_CONFIRM':'<>PENDING_CONFIRM')+'")';}
  var defs={};
  ['SATVIK','HITESH'].forEach(function(person){
    var loc=person==='SATVIK'?'LOC-01':'LOC-02';
    defs['OPENING_'+person]={headers:['Product Name','Qty Ordered (reference)','Opening Qty','Unit','Short Qty (reference)','Status','Count Date','Count ID','Notes'],formulas:[filter([lookup(o('ProductID'),'PRODUCTS','ProductID','Name'),o('QtyOrdered'),o('Qty'),lookup(o('ProductID'),'PRODUCTS','ProductID','IssueUOM'),'IF('+o('QtyOrdered')+'="","",'+o('QtyOrdered')+'-'+o('QtyReceived')+')',o('Status'),o('Date'),o('CountID'),o('Notes')],[o('LocationID')+'="'+loc+'"'])],dateColumns:[6]};
    defs['STOCK_'+person]={headers:['Product ID','Product Name','Unit','On Hand','Reserved','Available'],formulas:[
      '=IFNA(FILTER('+p('ProductID')+','+p('Active')+'=TRUE),"")',
      array('IF(A2:A="","",'+lookup('A2:A','PRODUCTS','ProductID','Name')+')'),
      array('IF(A2:A="","",'+lookup('A2:A','PRODUCTS','ProductID','IssueUOM')+')'),
      '=MAP(A2:A,LAMBDA(id,IF(id="","",'+sum(1,loc,false)+'-'+sum(-1,loc,false)+')))',
      '=MAP(A2:A,LAMBDA(id,IF(id="","",'+sum(-1,loc,true)+')))',
      array('IF(A2:A="","",D2:D-E2:E)')
    ],dateColumns:[]};
  });
  var movement=[l('Date'),lookup(l('ProductID'),'PRODUCTS','ProductID','Name'),l('Qty'),l('UOM'),lookup(l('LocationID'),'LISTS','Code','Name'),l('PersonID'),l('Type'),l('Status'),l('HandoverID'),l('Notes')];
  defs.HANDOVER_TRACKER={headers:['Date','Product Name','Qty','Unit','Destination','Receiver','Type','Status','Handover ID','Notes'],formulas:[filter(movement,[l('Type')+'="HANDOVER"',l('Direction')+'=1'])],dateColumns:[0]};
  defs.ISSUE_HISTORY={headers:['Date','Product Name','Qty','Unit','Location','Person','Type','Status','Reference','Notes'],formulas:[filter(movement,['('+l('Type')+'="ISSUE")+('+l('Type')+'="RETURN")+('+l('Type')+'="DAMAGE")'])],dateColumns:[0]};
  defs.IN_USE={headers:['Date','Product Name','Qty','Unit','Location','Assigned To','Type','Status','Assignment ID','Notes'],formulas:[filter(movement,[l('Type')+'="ASSET_IN_USE"'])],dateColumns:[0]};
  defs.REPORTS={headers:['Date','Product Name','Qty','Unit','Location','Person','Type','Status','Reference','Notes'],formulas:[filter(movement,[l('TxnID')+'<>""'])],dateColumns:[0]};
  defs.PURCHASE_TRACKER={headers:['Order ID','Product Name','Vendor','Ordered','Received','Outstanding','Unit','Status','Date','Request ID'],formulas:[
    '=IFNA(FILTER('+po('OrderID')+','+po('OrderID')+'<>""),"")',
    array('IF(A2:A="","",'+lookup(lookup('A2:A','PURCHASE_ORDERS','OrderID','ProductID'),'PRODUCTS','ProductID','Name')+')'),
    array('IF(A2:A="","",'+lookup(lookup('A2:A','PURCHASE_ORDERS','OrderID','VendorID'),'LISTS','Code','Name')+')'),
    array('IF(A2:A="","",'+lookup('A2:A','PURCHASE_ORDERS','OrderID','QtyOrdered')+')'),
    '=MAP(A2:A,LAMBDA(id,IF(id="","",SUMIFS('+l('Qty')+','+l('PORef')+',id,'+l('Type')+',"RECEIPT",'+l('Status')+',"<>VOID"))))',
    array('IF(A2:A="","",IF('+lookup('A2:A','PURCHASE_ORDERS','OrderID','Status')+'="CANCELLED",0,IF(D2:D>E2:E,D2:D-E2:E,0)))'),
    array('IF(A2:A="","",'+lookup('A2:A','PURCHASE_ORDERS','OrderID','UOM')+')'),
    array('IF(A2:A="","",IF('+lookup('A2:A','PURCHASE_ORDERS','OrderID','Status')+'="CANCELLED","CANCELLED",IF(E2:E>=D2:D,"RECEIVED",IF(E2:E>0,"PARTIAL","ORDERED")))))'),
    array('IF(A2:A="","",'+lookup('A2:A','PURCHASE_ORDERS','OrderID','Date')+')'),
    array('IF(A2:A="","",'+lookup('A2:A','PURCHASE_ORDERS','OrderID','RequestID')+')')
  ],dateColumns:[8]};
  return defs;
}

/** Additive migration: never import the old seed workbook over live master data. */
function upgradeInventoryDatabase() {
  var ss=db();
  Object.keys(SCHEMA).forEach(function(name){if(name.indexOf('OPENING_')!==0 || name==='OPENING_COUNTS')ensureTab(ss,name,SCHEMA[name]);});
  var headers={};['PRODUCTS','LEDGER','OPENING_COUNTS','PURCHASE_ORDERS','LISTS'].forEach(function(n){headers[n]=table(n).headers;});
  var views=inventoryViewDefinitions(headers);
  Object.keys(views).forEach(function(name){
    var v=views[name];ensureTab(ss,name,v.headers);var sheet=ss.getSheetByName(name);
    sheet.getDataRange().clearContent();sheet.getRange(1,1,1,v.headers.length).setValues([v.headers]);
    sheet.getRange(2,1,1,v.formulas.length).setFormulas([v.formulas]);
    sheet.setFrozenRows(1);sheet.setColumnWidths(1,v.headers.length,145);sheet.setColumnWidth(name.indexOf('OPENING_')===0?1:2,250);
    v.dateColumns.forEach(function(i){sheet.getRange(2,i+1,sheet.getMaxRows()-1,1).setNumberFormat('dd mmm yyyy hh:mm');});
  });
  return 'Schema and inventory views updated. Existing ledger and masters preserved.';
}
