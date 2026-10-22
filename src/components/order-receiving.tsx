"use client";

import { useState, type FormEvent } from 'react';
import { Button } from './ui/button';
import { Panel, Select, TextInput } from './ui/field';
import { PhotoCapture, type CapturedPhoto } from './photo-capture';
import type { Catalogue } from '@/lib/catalogue';
import type { AppsScriptAction } from '@/lib/api';

export interface ReceivingOrder {
  orderId:string; date:string; productId:string; productName:string; vendorId:string;
  qty:number; received:number; remaining:number; uom:string; status:string; deliveryLocationId:string;
  notes?:string;
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
  const [prices,setPrices]=useState<Record<string,string>>({});
  const [date,setDate]=useState(()=>orderDay(new Date().toISOString()));
  const [invoice,setInvoice]=useState(''),[notes,setNotes]=useState(''),[receiver,setReceiver]=useState(''),[gst,setGst]=useState('');
  const [photo,setPhoto]=useState<CapturedPhoto|null>(null);
  const [error,setError]=useState(''),[photoKey,setPhotoKey]=useState(0);
  const selected=orders.filter(o=>Number(quantities[o.orderId])>0);
  const submit=async(e:FormEvent<HTMLFormElement>)=>{
    e.preventDefault(); setError('');
    if(!selected.length){setError('Enter a received quantity for at least one product.');return;}
    if(orders.some(o=>!Number.isFinite(Number(quantities[o.orderId]))||Number(quantities[o.orderId])<0||Number(quantities[o.orderId])>o.remaining)){setError('Received quantities must be between zero and the outstanding quantity.');return;}
    const ok=await onSubmit('stock.receiveOrders',{
      vendorId:vendor,date,invoiceNo:invoice,notes,receivedByName:receiver.trim(),photo,
      gstPercent:gst===''?undefined:Number(gst),
      lines:selected.map(o=>({poId:o.orderId,productId:o.productId,qty:Number(quantities[o.orderId]),amount:prices[o.orderId]===undefined||prices[o.orderId]===''?undefined:Number(prices[o.orderId])*Number(quantities[o.orderId])})),
    });
    if(ok){setQuantities(Object.fromEntries(orders.map(o=>[o.orderId,'0'])));setPhoto(null);setPhotoKey(k=>k+1);setInvoice('');}
  };
  return <form onSubmit={submit}><fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
    <p className="text-sm text-muted-foreground">Quantities start at the full outstanding amount. Enter a smaller quantity for a partial delivery, or 0 for a missing product. The rest stays pending.</p>
    <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={()=>setQuantities(Object.fromEntries(orders.map(o=>[o.orderId,String(o.remaining)])))}>Fill all outstanding quantities</Button><Button type="button" variant="outline" onClick={()=>setQuantities(Object.fromEntries(orders.map(o=>[o.orderId,'0'])))}>Clear quantities</Button></div>
    <div className="divide-y rounded-xl border">{orders.map(o=><div key={o.orderId} className="grid gap-3 p-4 sm:grid-cols-[1fr_8rem_9rem]">
      <div><p className="text-sm font-semibold">{o.productName}</p><p className="text-xs text-muted-foreground">{o.orderId} · {c.locations.find(l=>l.id===o.deliveryLocationId)?.name||o.deliveryLocationId}</p><p className="mt-1 text-xs">Ordered {o.qty} · Received {o.received} · Due {o.remaining} {o.uom}</p><p className="mt-1 text-xs text-muted-foreground">Still due after this delivery: {Math.max(0,o.remaining-(Number(quantities[o.orderId])||0))} {o.uom}</p></div>
      <label className="grid content-start gap-2 text-sm">Received ({o.uom})<TextInput required type="number" min="0" max={o.remaining} step={o.uom==='PCS'?1:'any'} value={quantities[o.orderId]} onChange={e=>setQuantities(q=>({...q,[o.orderId]:e.target.value}))}/></label>
      <label className="grid content-start gap-2 text-sm">Unit price (₹)<TextInput type="number" min="0" step="0.01" value={prices[o.orderId]||''} onChange={e=>setPrices(p=>({...p,[o.orderId]:e.target.value}))}/></label>
    </div>)}</div>
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
