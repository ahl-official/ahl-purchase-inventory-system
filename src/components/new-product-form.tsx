"use client";
import { useState, type FormEvent } from 'react';
import { Loader2, QrCode } from 'lucide-react';
import { Button } from './ui/button';
import { Panel, Select, StatusBanner, TextInput } from './ui/field';
import { postAction } from '@/lib/api-client';
import type { Catalogue } from '@/lib/catalogue';

const TYPES = [
  ['Consumable', 'Used up in services (colour, developer, tape)'],
  ['Retail', 'Sold to clients'],
  ['Both', 'Used in services and also sold'],
] as const;
export const PURCHASE_UNITS = ['TUBE', 'BTL', 'CAN', 'PCS', 'BOX', 'KIT', 'ROLL', 'KG'];
export const STOCK_UNITS = ['ML', 'GM', 'PCS', 'ROLL', 'MTR', 'KG'];

export function NewProductForm({ catalogue, onCreated, onPrintLabel }: { catalogue: Catalogue; onCreated: () => void; onPrintLabel: (productId: string) => void }) {
  const [name, setName] = useState(''), [brand, setBrand] = useState(''), [type, setType] = useState('Consumable');
  const [purchaseUom, setPurchaseUom] = useState('TUBE'), [issueUom, setIssueUom] = useState('GM'), [conv, setConv] = useState('');
  const [categoryId, setCategoryId] = useState(''), [gst, setGst] = useState('0'), [vendorId, setVendorId] = useState(''), [otherVendor, setOtherVendor] = useState('');
  const unit = catalogue.categories.find(c => c.id === categoryId)?.unit;
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [created, setCreated] = useState<{ productId: string; name: string } | null>(null);
  const same = purchaseUom === issueUom;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    // Cost isn't asked here -- it comes from what's actually paid on the first delivery, and stays
    // current automatically from every delivery after that (see stock.receive on the Apps Script side).
    let vendor = vendorId;
    if (vendorId === 'OTHER') {
      const added = await postAction<{ id: string }>('list.add', { type: 'VENDOR', name: otherVendor.trim() });
      if (!added.ok || !added.data) { setBusy(false); setError(added.ok ? 'Could not add that vendor.' : added.message); return; }
      vendor = added.data.id;
    }
    const r = await postAction<{ productId: string; name: string }>('product.create', { name, brand, productType: type, purchaseUom, issueUom, convFactor: same ? 1 : Number(conv), categoryId, cost: '', gstPercent: Number(gst || 0), vendorId: vendor, reorderLevel: 0 });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setCreated(r.data); setName(''); setBrand(''); setConv(''); setVendorId(''); setOtherVendor('');
    onCreated();
  };

  return <Panel>
    <div className="border-b p-5"><h2 className="font-semibold">Add new product</h2><p className="mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">Create it once. Its QR label is ready straight away, and it appears in Requests, Purchases and Issue stock.</p></div>
    <form onSubmit={submit} className="grid gap-5 p-5 sm:grid-cols-2 sm:p-6">
      {created && <div className="grid gap-3 sm:col-span-2"><StatusBanner tone="success" title={`${created.name} added (${created.productId})`}>Print its QR label now and stick one on every tube or bottle.</StatusBanner>
        <button type="button" onClick={() => onPrintLabel(created.productId)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-white"><QrCode className="size-4" />Print QR label</button></div>}
      {error && <div className="sm:col-span-2"><StatusBanner tone="error" title="Could not add product">{error}</StatusBanner></div>}
      <label className="grid gap-2 text-sm sm:col-span-2">Product name (as printed on the pack)<TextInput required minLength={3} maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Wella Koleston 7/1" /></label>
      <label className="grid gap-2 text-sm">Brand (optional)<TextInput value={brand} onChange={e => setBrand(e.target.value)} /></label>
      <label className="grid gap-2 text-sm">Type<Select value={type} onChange={e => setType(e.target.value)}>{TYPES.map(([t, d]) => <option key={t} value={t}>{t} — {d}</option>)}</Select></label>
      <label className="grid gap-2 text-sm">Bought as<Select value={purchaseUom} onChange={e => setPurchaseUom(e.target.value)}>{PURCHASE_UNITS.map(u => <option key={u}>{u}</option>)}</Select></label>
      <label className="grid gap-2 text-sm">Stock counted in<Select value={issueUom} onChange={e => setIssueUom(e.target.value)}>{STOCK_UNITS.map(u => <option key={u}>{u}</option>)}</Select></label>
      {!same && <label className="grid gap-2 text-sm sm:col-span-2">Quantity in one {purchaseUom} ({issueUom})<TextInput required type="number" min="0.001" step="any" value={conv} onChange={e => setConv(e.target.value)} placeholder="e.g. 60" />
        <span className="text-xs text-muted-foreground">{conv ? `1 ${purchaseUom} = ${conv} ${issueUom}` : 'For a 5 L can enter 5000 and choose ML.'}</span></label>}
      <label className="grid gap-2 text-sm">Category<Select required value={categoryId} onChange={e => setCategoryId(e.target.value)}><option value="">Select category</option>{catalogue.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        <span className="text-xs text-muted-foreground">{unit ? `Business unit: ${unit}` : 'The category decides the business unit in finance reports.'}</span></label>
      <label className="grid gap-2 text-sm">GST % (optional)<TextInput type="number" min="0" max="28" step="any" value={gst} onChange={e => setGst(e.target.value)} /></label>
      <label className="grid gap-2 text-sm">Main vendor (optional)<Select value={vendorId} onChange={e => setVendorId(e.target.value)}><option value="">None</option>{catalogue.vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}<option value="OTHER">Other</option></Select>
        <span className="text-xs text-muted-foreground">Cost per {issueUom} is set automatically from the price paid on its first delivery, and stays current from every delivery after that.</span></label>
      {vendorId === 'OTHER' && <label className="grid gap-2 text-sm">Vendor name<TextInput required value={otherVendor} onChange={e => setOtherVendor(e.target.value)} placeholder="Type it once. It stays in the list." /></label>}
      <div className="sm:col-span-2"><Button type="submit" className="min-h-11 w-full sm:w-auto" disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" />}Add product</Button></div>
    </form>
  </Panel>;
}
