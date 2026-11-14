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
  // Per-row received qty, usable inside a FILTER condition on PURCHASE_ORDERS itself (where no
  // single "id" is bound yet) -- BYROW walks every order row and sums its own receipts.
  var receivedQtyByOrderRow='BYROW('+po('OrderID')+',LAMBDA(oid,IF(oid="",0,SUMIFS('+l('Qty')+','+l('PORef')+',oid,'+l('Type')+',"RECEIPT",'+l('Status')+',"<>VOID"))))';
  function orderField(col){return 'IFNA(XLOOKUP(id,'+po('OrderID')+','+po(col)+'),"")';}
  // Accounts verify payments off this tab, so it carries only orders with something actually
  // received -- never a pure CANCELLED order, and never one that's still just ORDERED with
  // nothing delivered yet (that lives in PENDING_ORDERS instead).
  // Every column below A is its OWN formula per row (not one array spilling down a column) --
  // so typing a correction into any single cell only ever touches that cell. An array-spill
  // column dies entirely (every row in it blanks out) the moment one cell in its range gets a
  // stray value, which is exactly the "editing a row wipes everything" bug this avoids.
  defs.PURCHASE_TRACKER={headers:['Order','Order date','Invoice date','Invoice number','Vendor','Product','Ordered','Received','Outstanding','Unit','Unit Price (Rs)','Status','Amount (Rs)','GST %','GST (Rs)','Total (Rs)','Returned (Rs)','Payable (Rs)','Bill','Note'],formulas:[
    '=IFERROR(SORT(FILTER('+po('OrderID')+','+po('OrderID')+'<>"",'+receivedQtyByOrderRow+'>0,'+po('Status')+'<>"CANCELLED"),FILTER('+po('Date')+','+po('OrderID')+'<>"",'+receivedQtyByOrderRow+'>0,'+po('Status')+'<>"CANCELLED"),TRUE),"")'
  ],rowFormula:function(r){
    var id='A'+r,M='M'+r,N='N'+r,O='O'+r,P='P'+r,Q='Q'+r;
    function orderFieldR(col){return 'IFNA(XLOOKUP('+id+','+po('OrderID')+','+po(col)+'),"")';}
    var receivedQtyR='SUMIFS('+l('Qty')+','+l('PORef')+','+id+','+l('Type')+',"RECEIPT",'+l('Status')+',"<>VOID")';
    var receivedAmtR='SUMIFS('+l('Amount')+','+l('PORef')+','+id+','+l('Type')+',"RECEIPT",'+l('Status')+',"<>VOID")';
    var receivedGstR='SUMIFS('+l('GSTAmount')+','+l('PORef')+','+id+','+l('Type')+',"RECEIPT",'+l('Status')+',"<>VOID")';
    var returnedAmtR='SUMIFS('+l('Amount')+','+l('PORef')+','+id+','+l('Type')+',"VENDOR_RETURN",'+l('Status')+',"<>VOID")';
    var returnedGstR='SUMIFS('+l('GSTAmount')+','+l('PORef')+','+id+','+l('Type')+',"VENDOR_RETURN",'+l('Status')+',"<>VOID")';
    return [
      '=IF('+id+'="","",'+orderFieldR('Date')+')',
      '=IF('+id+'="","",IFERROR(MIN(FILTER('+l('Date')+','+l('PORef')+'='+id+','+l('Type')+'="RECEIPT",'+l('Status')+'<>"VOID")),""))',
      '=IF('+id+'="","",IF('+receivedQtyR+'<=0,"",IFERROR(TEXTJOIN(", ",TRUE,UNIQUE(FILTER('+l('InvoiceNo')+','+l('PORef')+'='+id+','+l('Type')+'="RECEIPT",'+l('Status')+'<>"VOID",'+l('InvoiceNo')+'<>""))),"Not entered")))',
      '=IF('+id+'="","",IFNA(XLOOKUP(XLOOKUP('+id+','+po('OrderID')+','+po('VendorID')+'),'+ref('LISTS','Code')+','+ref('LISTS','Name')+'),""))',
      '=IF('+id+'="","",IFNA(XLOOKUP(XLOOKUP('+id+','+po('OrderID')+','+po('ProductID')+'),'+ref('PRODUCTS','ProductID')+','+ref('PRODUCTS','Name')+'),'+orderFieldR('ProductName')+'))',
      '=IF('+id+'="","",IFNA(XLOOKUP('+id+','+po('OrderID')+','+po('QtyOrdered')+'),0))',
      '=IF('+id+'="","",'+receivedQtyR+')',
      '=IF('+id+'="","",IF(OR('+orderFieldR('Status')+'="CANCELLED",'+orderFieldR('Status')+'="DRAFT"),0,IF('+orderFieldR('QtyOrdered')+'>'+receivedQtyR+','+orderFieldR('QtyOrdered')+'-'+receivedQtyR+',0)))',
      '=IF('+id+'="","",'+orderFieldR('UOM')+')',
      '=IF('+id+'="","",IF('+receivedQtyR+'<=0,"",ROUND('+receivedAmtR+'/'+receivedQtyR+',2)))',
      '=IF('+id+'="","",IF('+orderFieldR('Status')+'="CANCELLED","CANCELLED",IF('+orderFieldR('Status')+'="DRAFT","DRAFT",IF('+receivedQtyR+'>='+orderFieldR('QtyOrdered')+',"RECEIVED",IF('+receivedQtyR+'>0,"PARTIAL","ORDERED")))))',
      '=IF('+id+'="","",'+receivedAmtR+')',
      '=IF('+id+'="","",IF('+receivedAmtR+'<=0,"",ROUND('+receivedGstR+'/'+receivedAmtR+'*100,2)))',
      // GST (Rs) and everything after it derive from THIS row's own Amount (M) and GST % (N)
      // cells, not a fresh ledger sum -- so editing GST % (or Amount) here recalculates them.
      '=IF('+id+'="","",IF(OR('+M+'="",'+N+'=""),"",ROUND('+M+'*'+N+'/100,2)))',
      '=IF('+id+'="","",IF('+M+'="","",'+M+'+IF('+O+'="",0,'+O+')))',
      '=IF('+id+'="","",'+returnedAmtR+'+'+returnedGstR+')',
      '=IF('+id+'="","",IF('+P+'="","",'+P+'-'+Q+'))',
      '=IF('+id+'="","",IF('+receivedQtyR+'<=0,"",LET(link,IFERROR(TEXTJOIN(", ",TRUE,UNIQUE(FILTER('+l('BillPhotoURL')+','+l('PORef')+'='+id+','+l('Type')+'="RECEIPT",'+l('Status')+'<>"VOID",'+l('BillPhotoURL')+'<>""))),""),IF(link="","No bill attached",link))))',
      '=IF('+id+'="","",IFERROR(TEXTJOIN(" | ",TRUE,UNIQUE(FILTER('+l('Notes')+','+l('PORef')+'='+id+','+l('Type')+'="RECEIPT",'+l('Status')+'<>"VOID",'+l('Notes')+'<>""))),""))'
    ];
  },maxRows:1000,dateColumns:[1,2]};
  // Orders placed but with nothing received yet -- purchasing's follow-up list, kept separate
  // from PURCHASE_TRACKER so accounts only ever sees money actually owed against real deliveries.
  // Once anything is received the order moves itself into PURCHASE_TRACKER and drops out of here.
  defs.PENDING_ORDERS={headers:['Order','Order date','Vendor','Product','Ordered','Unit','Note'],formulas:[
    '=IFERROR(SORT(FILTER('+po('OrderID')+','+po('OrderID')+'<>"",'+po('Status')+'="ORDERED",'+receivedQtyByOrderRow+'=0),FILTER('+po('Date')+','+po('OrderID')+'<>"",'+po('Status')+'="ORDERED",'+receivedQtyByOrderRow+'=0),TRUE),"")'
  ],rowFormula:function(r){
    var id='A'+r;
    function orderFieldR(col){return 'IFNA(XLOOKUP('+id+','+po('OrderID')+','+po(col)+'),"")';}
    return [
      '=IF('+id+'="","",'+orderFieldR('Date')+')',
      '=IF('+id+'="","",IFNA(XLOOKUP(XLOOKUP('+id+','+po('OrderID')+','+po('VendorID')+'),'+ref('LISTS','Code')+','+ref('LISTS','Name')+'),""))',
      '=IF('+id+'="","",IFNA(XLOOKUP(XLOOKUP('+id+','+po('OrderID')+','+po('ProductID')+'),'+ref('PRODUCTS','ProductID')+','+ref('PRODUCTS','Name')+'),""))',
      '=IF('+id+'="","",'+orderFieldR('QtyOrdered')+')',
      '=IF('+id+'="","",'+orderFieldR('UOM')+')',
      '=IF('+id+'="","",'+orderFieldR('Notes')+')'
    ];
  },maxRows:300,dateColumns:[1]};
  return defs;
}

/** PRODUCTS' "Unit Price (Rs)" column, one formula per row -- the price from that product's
 * most recently dated PURCHASE_TRACKER row (matched by name, since that's what the tracker
 * carries). Cost stays the separate, auto-updating-per-receipt field everything else uses;
 * this is a read-only reference pulled live off the tracker, nothing more. */
function productUnitPriceFormula(row) {
  var name = 'B' + row;
  return '=IFERROR(INDEX(FILTER(PURCHASE_TRACKER!K2:K,PURCHASE_TRACKER!F2:F=' + name + ',PURCHASE_TRACKER!B2:B=MAXIFS(PURCHASE_TRACKER!B2:B,PURCHASE_TRACKER!F2:F,' + name + ')),1),"")';
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
    if(v.rowFormula){
      var rows=[];
      for(var r=2;r<v.maxRows+2;r++)rows.push(v.rowFormula(r));
      sheet.getRange(2,2,v.maxRows,v.headers.length-1).setFormulas(rows);
    }
    sheet.setFrozenRows(1);sheet.setColumnWidths(1,v.headers.length,145);sheet.setColumnWidth(name.indexOf('OPENING_')===0?1:2,250);
    v.dateColumns.forEach(function(i){sheet.getRange(2,i+1,sheet.getMaxRows()-1,1).setNumberFormat('dd mmm yyyy hh:mm');});
  });
  return 'Schema and inventory views updated. Existing ledger and masters preserved.';
}
