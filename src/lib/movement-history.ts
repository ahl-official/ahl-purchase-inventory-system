export interface MovementHistory {
  txnId:string; date:string; productId:string; qty:number; uom:string; type:string;
  locationId:string; personId:string; status:string; notes:string;
  vendorId?:string; invoiceNo?:string; receiptId?:string; poRef?:string;
  amount?:number|null; gstAmount?:number|null; billPhotoUrl?:string;
}

export function historyDay(date:string) {
  const value=new Date(date);
  return Number.isNaN(value.getTime())?'':new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(value);
}

/** Never guess that unrelated purchases belong together just because their dates match. */
export function historyKey(row:MovementHistory):string {
  if(row.type!=='RECEIPT')return JSON.stringify(['movement',row.txnId]);
  const prefix=['receipt',row.vendorId||'',row.status==='VOID'?'VOID':'POSTED'];
  const invoice=row.invoiceNo?.trim();
  if(invoice&&row.vendorId)return JSON.stringify([...prefix,'invoice',invoice,historyDay(row.date)]);
  if(row.receiptId)return JSON.stringify([...prefix,'batch',row.receiptId]);
  if(row.billPhotoUrl)return JSON.stringify([...prefix,'bill',row.billPhotoUrl]);
  return JSON.stringify([...prefix,'transaction',row.txnId]);
}

export function groupHistory(rows:MovementHistory[]) {
  const groups=new Map<string,MovementHistory[]>();
  for(const row of rows){const key=historyKey(row);const group=groups.get(key);if(group)group.push(row);else groups.set(key,[row]);}
  return [...groups.entries()].map(([key,lines])=>({key,lines}));
}

/** Include whole invoices at the history cutoff, so their totals are never truncated. */
export function recentHistory(rows:MovementHistory[],limit=500) {
  const keys=new Set(rows.slice(-limit).map(historyKey));
  return rows.filter(row=>keys.has(historyKey(row))).reverse();
}

export function receiptTotals(lines:MovementHistory[]) {
  const known=(v:number|null|undefined):v is number=>typeof v==='number'&&Number.isFinite(v);
  const subtotal=Math.round(lines.reduce((sum,row)=>sum+(known(row.amount)?row.amount:0),0)*100)/100;
  const gst=Math.round(lines.reduce((sum,row)=>sum+(known(row.gstAmount)?row.gstAmount:0),0)*100)/100;
  return {subtotal,gst,total:Math.round((subtotal+gst)*100)/100,complete:lines.every(row=>known(row.amount)),hasGst:lines.some(row=>known(row.gstAmount))};
}
