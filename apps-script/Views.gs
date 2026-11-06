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
    var ids='FILTER('+p('ProductID')+','+p('Active')+'=TRUE)';
    var stockHeaders=['Product','Unit','On Hand','Reserved','Available'];
    var stockFormulas=[
      '=MAP('+ids+',LAMBDA(id,IF(id="","",IFNA(XLOOKUP(id,'+p('ProductID')+','+p('Name')+'),id))))',
      '=MAP('+ids+',LAMBDA(id,IF(id="","",IFNA(XLOOKUP(id,'+p('ProductID')+','+p('IssueUOM')+'),""))))',
      '=MAP('+ids+',LAMBDA(id,IF(id="","",'+sum(1,loc,false)+'-'+sum(-1,loc,false)+')))',
      '=MAP('+ids+',LAMBDA(id,IF(id="","",'+sum(-1,loc,true)+')))',
      '=MAP('+ids+',LAMBDA(id,IF(id="","",('+sum(1,loc,false)+'-'+sum(-1,loc,false)+')-('+sum(-1,loc,true)+'))))'
    ];
    var stockDates=[];
    if(person==='HITESH'){
      stockHeaders=stockHeaders.concat(['','Date','Product','Movement','In / Out','Quantity','Unit','Technician','Category','Business unit','Note']);
      stockFormulas.push('=""');
      stockFormulas.push(array('IFERROR(SORT(FILTER({'+[
        l('Date'),
        lookup(l('ProductID'),'PRODUCTS','ProductID','Name'),
        'IF('+l('Type')+'="ISSUE","Issued",IF('+l('Type')+'="RECEIPT","Received",IF('+l('Type')+'="HANDOVER","Handover",IF('+l('Type')+'="RETAIL_SALE","Retail sale",IF('+l('Type')+'="COUNT_IN","Count in",IF('+l('Type')+'="COUNT_OUT","Count out",IF('+l('Type')+'="RETURN","Returned",IF('+l('Type')+'="DAMAGE","Damaged",'+l('Type')+'))))))))',
        'IF('+l('Direction')+'=1,"In","Out")',
        l('QtyBase'),
        lookup(l('ProductID'),'PRODUCTS','ProductID','IssueUOM'),
        'IF('+l('PersonID')+'="","",'+lookup(l('PersonID'),'PEOPLE','UserID','Name')+')',
        'IF('+l('CategoryID')+'="","",'+lookup(l('CategoryID'),'LISTS','Code','Name')+')',
        l('BusinessUnit'),
        l('Notes')
      ].join(',')+'},'+l('LocationID')+'="'+loc+'",'+l('Status')+'<>"VOID",'+l('TxnID')+'<>""),1,TRUE),"")'));
      stockDates=[6];
    }
    defs['STOCK_'+person]={headers:stockHeaders,formulas:stockFormulas,dateColumns:stockDates};
  });
  var movement=[l('Date'),lookup(l('ProductID'),'PRODUCTS','ProductID','Name'),l('Qty'),l('UOM'),lookup(l('LocationID'),'LISTS','Code','Name'),lookup(l('PersonID'),'PEOPLE','UserID','Name'),l('Type'),l('Status'),l('HandoverID'),l('Notes')];
  // Oldest first, by the actual Date column, so backfilled records sit in chronological order.
  function sortedFilter(parts,conditions){return array('IFERROR(SORT(FILTER({'+parts.join(',')+'},'+conditions.join(',')+'),1,TRUE),"")');}
  defs.HANDOVER_TRACKER={headers:['Date','Product Name','Qty','Unit','Destination','Receiver','Type','Status','Handover ID','Notes'],formulas:[sortedFilter(movement,[l('Type')+'="HANDOVER"',l('Direction')+'=1'])],dateColumns:[0]};
  defs.ISSUE_HISTORY={headers:['Date','Product Name','Qty','Unit','Location','Technician','Type','Status','Reference','Notes'],formulas:[filter(movement,['('+l('Type')+'="ISSUE")+('+l('Type')+'="RETURN")+('+l('Type')+'="DAMAGE")'])],dateColumns:[0]};
  defs.SALON_ISSUES={headers:['Date','Product','Quantity','Unit','Technician','Category','Business unit','Note'],formulas:[sortedFilter([
    l('Date'),
    lookup(l('ProductID'),'PRODUCTS','ProductID','Name'),
    l('Qty'),
    l('UOM'),
    lookup(l('PersonID'),'PEOPLE','UserID','Name'),
    lookup(l('CategoryID'),'LISTS','Code','Name'),
    l('BusinessUnit'),
    l('Notes')
  ],[l('Type')+'="ISSUE"',l('LocationID')+'="LOC-02"',l('Status')+'<>"VOID"'])],dateColumns:[0]};
  defs.REPORTS={headers:['Date','Product Name','Qty','Unit','Location','Person','Type','Status','Reference','Notes'],formulas:[filter(movement,[l('TxnID')+'<>""'])],dateColumns:[0]};
  // One row per order. Invoice number, bill and amounts come from the receipts
  // linked by PORef, so accounts and purchasing share this tab.
  var receivedQty='SUMIFS('+l('Qty')+','+l('PORef')+',id,'+l('Type')+',"RECEIPT",'+l('Status')+',"<>VOID")';
  var receivedAmt='SUMIFS('+l('Amount')+','+l('PORef')+',id,'+l('Type')+',"RECEIPT",'+l('Status')+',"<>VOID")';
  var receivedGst='SUMIFS('+l('GSTAmount')+','+l('PORef')+',id,'+l('Type')+',"RECEIPT",'+l('Status')+',"<>VOID")';
  // Goods handed back to the vendor (VENDOR_RETURN) reduce what's actually still owed, without
  // touching Received/Outstanding above -- a return doesn't mean the vendor owes more units.
  var returnedAmt='SUMIFS('+l('Amount')+','+l('PORef')+',id,'+l('Type')+',"VENDOR_RETURN",'+l('Status')+',"<>VOID")';
  var returnedGst='SUMIFS('+l('GSTAmount')+','+l('PORef')+',id,'+l('Type')+',"VENDOR_RETURN",'+l('Status')+',"<>VOID")';
  function orderField(col){return 'IFNA(XLOOKUP(id,'+po('OrderID')+','+po(col)+'),"")';}
  defs.PURCHASE_TRACKER={headers:['Order','Order date','Invoice date','Invoice number','Vendor','Product','Ordered','Received','Outstanding','Unit','Status','Amount (Rs)','GST %','GST (Rs)','Total (Rs)','Returned (Rs)','Payable (Rs)','Bill','Note'],formulas:[
    '=IFERROR(SORT(FILTER('+po('OrderID')+','+po('OrderID')+'<>""),FILTER('+po('Date')+','+po('OrderID')+'<>""),TRUE),"")',
    '=MAP(A2:A,LAMBDA(id,IF(id="","",'+orderField('Date')+')))',
    '=MAP(A2:A,LAMBDA(id,IF(id="","",IFERROR(MIN(FILTER('+l('Date')+','+l('PORef')+'=id,'+l('Type')+'="RECEIPT",'+l('Status')+'<>"VOID")),""))))',
    '=MAP(A2:A,LAMBDA(id,IF(id="","",IF('+receivedQty+'<=0,"",IFERROR(TEXTJOIN(", ",TRUE,UNIQUE(FILTER('+l('InvoiceNo')+','+l('PORef')+'=id,'+l('Type')+'="RECEIPT",'+l('Status')+'<>"VOID",'+l('InvoiceNo')+'<>""))),"Not entered")))))',
    '=MAP(A2:A,LAMBDA(id,IF(id="","",IFNA(XLOOKUP(XLOOKUP(id,'+po('OrderID')+','+po('VendorID')+'),'+ref('LISTS','Code')+','+ref('LISTS','Name')+'),""))))',
    '=MAP(A2:A,LAMBDA(id,IF(id="","",IFNA(XLOOKUP(XLOOKUP(id,'+po('OrderID')+','+po('ProductID')+'),'+ref('PRODUCTS','ProductID')+','+ref('PRODUCTS','Name')+'),'+orderField('ProductName')+'))))',
    '=MAP(A2:A,LAMBDA(id,IF(id="","",IFNA(XLOOKUP(id,'+po('OrderID')+','+po('QtyOrdered')+'),0))))',
    '=MAP(A2:A,LAMBDA(id,IF(id="","",'+receivedQty+')))',
    '=MAP(A2:A,LAMBDA(id,IF(id="","",IF(OR('+orderField('Status')+'="CANCELLED",'+orderField('Status')+'="DRAFT"),0,IF('+orderField('QtyOrdered')+'>'+receivedQty+','+orderField('QtyOrdered')+'-'+receivedQty+',0)))))',
    '=MAP(A2:A,LAMBDA(id,IF(id="","",'+orderField('UOM')+')))',
    '=MAP(A2:A,LAMBDA(id,IF(id="","",IF('+orderField('Status')+'="CANCELLED","CANCELLED",IF('+orderField('Status')+'="DRAFT","DRAFT",IF('+receivedQty+'>='+orderField('QtyOrdered')+',"RECEIVED",IF('+receivedQty+'>0,"PARTIAL","ORDERED")))))))',
    '=MAP(A2:A,LAMBDA(id,IF(id="","",'+receivedAmt+')))',
    '=MAP(A2:A,LAMBDA(id,IF(id="","",IF('+receivedAmt+'<=0,"",ROUND('+receivedGst+'/'+receivedAmt+'*100,2)))))',
    '=MAP(A2:A,LAMBDA(id,IF(id="","",'+receivedGst+')))',
    '=MAP(A2:A,LAMBDA(id,IF(id="","",'+receivedAmt+'+'+receivedGst+')))',
    '=MAP(A2:A,LAMBDA(id,IF(id="","",'+returnedAmt+'+'+returnedGst+')))',
    '=MAP(A2:A,LAMBDA(id,IF(id="","",('+receivedAmt+'+'+receivedGst+')-('+returnedAmt+'+'+returnedGst+'))))',
    '=MAP(A2:A,LAMBDA(id,IF(id="","",IF('+receivedQty+'<=0,"",LET(link,IFERROR(TEXTJOIN(", ",TRUE,UNIQUE(FILTER('+l('BillPhotoURL')+','+l('PORef')+'=id,'+l('Type')+'="RECEIPT",'+l('Status')+'<>"VOID",'+l('BillPhotoURL')+'<>""))),""),IF(link="","No bill attached",link))))))',
    '=MAP(A2:A,LAMBDA(id,IF(id="","",IFERROR(TEXTJOIN(" | ",TRUE,UNIQUE(FILTER('+l('Notes')+','+l('PORef')+'=id,'+l('Type')+'="RECEIPT",'+l('Status')+'<>"VOID",'+l('Notes')+'<>""))),""))))'
  ],dateColumns:[1,2]};
  return defs;
}

/** Additive migration: never import the old seed workbook over live master data. */
function upgradeInventoryDatabase() {
  var ss=db();
  Object.keys(SCHEMA).forEach(function(name){if(name.indexOf('OPENING_')!==0 || name==='OPENING_COUNTS')ensureTab(ss,name,SCHEMA[name]);});
  var headers={};['PRODUCTS','LEDGER','OPENING_COUNTS','PURCHASE_ORDERS','LISTS','PEOPLE'].forEach(function(n){headers[n]=table(n).headers;});
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
