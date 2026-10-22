"use client";

import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from './ui/button';
import { Panel, Select, TextInput } from './ui/field';
import { PhotoCapture, type CapturedPhoto } from './photo-capture';
import type { Catalogue } from '@/lib/catalogue';
import type { AppsScriptAction } from '@/lib/api';

export interface ReceivingOrder {
  orderId:string; date:string; productId:string; productName:string; vendorId:string;
  qty:number; received:number; remaining:number; uom:string; status:string; deliveryLocationId:string;
  notes?:string; unitPrice?:number|null;
}

const money=(amount:number)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format(amount);

// Enter in a row's input would otherwise submit the whole receipt (default HTML form
// behaviour). Move to the next field in the basket instead, like tabbing.
export function focusNextOnEnter(e:KeyboardEvent<HTMLInputElement>) {
  if(e.key!=='Enter')return;
  e.preventDefault();
  const form=e.currentTarget.form;
  if(!form)return;
  const fields=Array.from(form.elements).filter((el):el is HTMLInputElement|HTMLSelectElement=>(el instanceof HTMLInputElement||el instanceof HTMLSelectElement)&&!el.disabled&&el.tabIndex!==-1);
  const next=fields[fields.indexOf(e.currentTarget)+1];
  next?.focus();
}

// Order dates are business dates in India, independent of the browser's timezone.
function orderDay(value:string) {
  const d=new Date(value);
  if(Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
}

export function OrderReceiving({orders,catalogue:c,busy,onSubmit}:{
  orders:ReceivingOrder[]; catalogue:Catalogue; busy:boolean;
  onSubmit:(action:AppsScriptAction,values:object)=>Promise<boolean>;
}) {
  const [vendor,setVendor]=useState(''),[day,setDay]=useState('');
  const open=orders.filter(o=>o.remaining>0&&o.status!=='CANCELLED');
  const dates=[...new Set(open.filter(o=>o.vendorId===vendor).map(o=>orderDay(o.date)).filter(Boolean))].sort().reverse();
  const matching=open.filter(o=>o.vendorId===vendor&&orderDay(o.date)===day);
  return <Panel><div className="space-y-4 p-5">
    <div><h2 className="font-semibold">Receive ordered products</h2><p className="mt-1 text-sm text-muted-foreground">Select the vendor and order date. Review every product, then record the delivery together.</p></div>
    <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
      <label className="grid gap-2 text-sm">Vendor<Select value={vendor} onChange={e=>{setVendor(e.target.value);setDay('');}}><option value="">Select vendor</option>{c.vendors.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</Select></label>
      <label className="grid gap-2 text-sm">Order date<Select disabled={!vendor} value={day} onChange={e=>setDay(e.target.value)}><option value="">Select order date</option>{dates.map(d=><option key={d} value={d}>{d}</option>)}</Select></label>
    </fieldset>
    {vendor&&!dates.length&&<p className="text-sm text-muted-foreground">No outstanding orders for this vendor.</p>}
    {vendor&&day&&matching.length>0&&<ReceiptBasket key={JSON.stringify([vendor,day,matching.map(o=>[o.orderId,o.remaining])])} orders={matching} catalogue={c} vendor={vendor} busy={busy} onSubmit={onSubmit}/>}
    {vendor&&day&&!matching.length&&<p className="text-sm text-muted-foreground">All products for this date have been received.</p>}
  </div></Panel>;
}

function ReceiptBasket({orders,catalogue:c,vendor,busy,onSubmit}:{orders:ReceivingOrder[];catalogue:Catalogue;vendor:string;busy:boolean;onSubmit:(action:AppsScriptAction,values:object)=>Promise<boolean>}) {
  const [quantities,setQuantities]=useState<Record<string,string>>(()=>Object.fromEntries(orders.map(o=>[o.orderId,String(o.remaining)])));
  const [amounts,setAmounts]=useState<Record<string,string>>({});
  const [date,setDate]=useState(()=>orderDay(new Date().toISOString()));
  const [invoice,setInvoice]=useState(''),[notes,setNotes]=useState(''),[receiver,setReceiver]=useState(''),[gst,setGst]=useState(''),[discount,setDiscount]=useState('');
  const [photo,setPhoto]=useState<CapturedPhoto|null>(null);
  const [error,setError]=useState(''),[photoKey,setPhotoKey]=useState(0);
  const selected=orders.filter(o=>Number(quantities[o.orderId])>0);
  // Older orders kept the price as "Unit price ₹X" text in Notes; newer ones carry a real unitPrice field.
  const orderUnitPrice=(o:ReceivingOrder):number|null=>{
    if(o.unitPrice!=null) return o.unitPrice;
    const legacy=(o.notes||'').match(/Unit price ₹([0-9.]+)/)?.[1];
    return legacy!=null?Number(legacy):null;
  };
  // Amount is typed directly -- it does not auto-fill or shift as quantity or unit price change.
  const lineAmount=(o:ReceivingOrder):number|null=>amounts[o.orderId]?Number(amounts[o.orderId]):null;
  const subtotal=selected.reduce((sum,o)=>sum+(lineAmount(o)||0),0);
  const gstAmount=gst===''?0:subtotal*Number(gst)/100;
  const submit=async(e:FormEvent<HTMLFormElement>)=>{
    e.preventDefault(); setError('');
    if(!selected.length){setError('Enter a received quantity for at least one product.');return;}
    if(orders.some(o=>!Number.isFinite(Number(quantities[o.orderId]))||Number(quantities[o.orderId])<0||Number(quantities[o.orderId])>o.remaining)){setError('Received quantities must be between zero and the outstanding quantity.');return;}
    const ok=await onSubmit('stock.receiveOrders',{
      vendorId:vendor,date,invoiceNo:invoice,notes,receivedByName:receiver.trim(),photo,
      gstPercent:gst===''?undefined:Number(gst),discountedAmount:discount===''?undefined:Number(discount),
      lines:selected.map(o=>({poId:o.orderId,productId:o.productId,qty:Number(quantities[o.orderId]),amount:lineAmount(o)==null?undefined:lineAmount(o)})),
    });
    if(ok){setQuantities(Object.fromEntries(orders.map(o=>[o.orderId,'0'])));setAmounts({});setDiscount('');setPhoto(null);setPhotoKey(k=>k+1);setInvoice('');}
  };
  return <form onSubmit={submit}><fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
    <p className="text-sm text-muted-foreground">Quantities start at the full outstanding amount. Enter a smaller quantity for a partial delivery, or 0 for a missing product. The rest stays pending. Unit price carries over from the order for reference; type the amount for each product directly.</p>
    <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={()=>setQuantities(Object.fromEntries(orders.map(o=>[o.orderId,String(o.remaining)])))}>Fill all outstanding quantities</Button><Button type="button" variant="outline" onClick={()=>setQuantities(Object.fromEntries(orders.map(o=>[o.orderId,'0'])))}>Clear quantities</Button></div>
    <div className="overflow-hidden overflow-x-auto rounded-xl border"><table className="w-full min-w-[640px] text-left text-sm"><thead className="border-b bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-4 py-3 font-medium">Product / order</th><th className="px-4 py-3 text-right font-medium">Received</th><th className="px-4 py-3 text-right font-medium">Unit price (₹)</th><th className="px-4 py-3 text-right font-medium">Amount (₹)</th></tr></thead><tbody className="divide-y">{orders.map(o=>{const price=orderUnitPrice(o);return <tr key={o.orderId}>
      <td className="px-4 py-3 align-top"><p className="text-sm font-semibold">{o.productName}</p><p className="text-xs text-muted-foreground">{o.orderId} · {c.locations.find(l=>l.id===o.deliveryLocationId)?.name||o.deliveryLocationId}</p><p className="mt-1 text-xs">Ordered {o.qty} · Received {o.received} · Due {o.remaining} {o.uom}</p><p className="mt-1 text-xs text-muted-foreground">Still due after this delivery: {Math.max(0,o.remaining-(Number(quantities[o.orderId])||0))} {o.uom}</p></td>
      <td className="px-4 py-3 align-top text-right"><TextInput required type="number" min="0" max={o.remaining} step={o.uom==='PCS'?1:'any'} value={quantities[o.orderId]} onChange={e=>setQuantities(q=>({...q,[o.orderId]:e.target.value}))} onKeyDown={focusNextOnEnter} className="w-24 text-right"/><p className="mt-1 text-xs text-muted-foreground">{o.uom}</p></td>
      <td className="px-4 py-3 align-top text-right tabular">{price!=null?price.toFixed(2):<span className="text-muted-foreground">Not set</span>}</td>
      <td className="px-4 py-3 align-top text-right"><TextInput type="number" min="0" step="0.01" value={amounts[o.orderId]??''} onChange={e=>setAmounts(a=>({...a,[o.orderId]:e.target.value}))} onKeyDown={focusNextOnEnter} className="w-28 text-right"/></td>
    </tr>;})}</tbody></table></div>
    <div className="space-y-2 rounded-xl border p-4 text-sm"><div className="flex justify-between"><span>Subtotal</span><span className="tabular">{money(subtotal)}</span></div>{gst!==''&&<div className="flex justify-between"><span>GST ({gst}%)</span><span className="tabular">{money(gstAmount)}</span></div>}<div className="flex justify-between font-semibold"><span>Bill total</span><span className="tabular">{money(subtotal+gstAmount)}</span></div><label className="flex items-center justify-between gap-2 pt-1 text-sm">Discounted price (optional)<TextInput type="number" min="0" step="0.01" placeholder="Final price after discount" value={discount} onChange={e=>setDiscount(e.target.value)} className="w-32 text-right"/></label></div>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="grid gap-2 text-sm">Receipt date<TextInput required type="date" max={orderDay(new Date().toISOString())} value={date} onChange={e=>setDate(e.target.value)}/></label>
      <label className="grid gap-2 text-sm">Invoice number<TextInput value={invoice} onChange={e=>setInvoice(e.target.value)}/></label>
      <label className="grid gap-2 text-sm">Received by (optional)<TextInput value={receiver} onChange={e=>setReceiver(e.target.value)}/></label>
      <label className="grid gap-2 text-sm">GST % (optional)<TextInput type="number" min="0" max="28" step="0.01" value={gst} onChange={e=>setGst(e.target.value)}/></label>
      <label className="grid gap-2 text-sm sm:col-span-2">Delivery notes / missing products<TextInput value={notes} onChange={e=>setNotes(e.target.value)}/></label>
    </div>
    <PhotoCapture key={photoKey} label="Bill photo" onCapture={setPhoto} disabled={busy}/>
    {error&&<p role="alert" className="text-sm text-danger">{error}</p>}
    <Button type="submit" disabled={busy||!selected.length}>{busy?'Saving delivery…':`Receive ${selected.length} ${selected.length===1?'product':'products'}`}</Button>
  </fieldset></form>;
}
