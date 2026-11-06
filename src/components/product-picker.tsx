'use client';
import { useState } from 'react';
import { Select, TextInput } from './ui/field';
import { Button } from './ui/button';
import { groupProducts, packLabel, type Lookup, type Product } from '@/lib/catalogue';
import { postAction } from '@/lib/api-client';
import { PURCHASE_UNITS, STOCK_UNITS } from './new-product-form';
import { cn } from '@/lib/utils';

const TYPES = ['Consumable', 'Retail', 'Both'] as const;

/** One box: click or type, the list narrows as you type. Without typing it shows the vendor's products first. With balanceOf, each row also shows what's on hand here and zero-stock products sink to the bottom.
    When categories + onCreated are given, a product that genuinely isn't in the list yet can be
    registered right here (e.g. while entering a bill) instead of leaving the form to do it. */
export function ProductPicker({ products, vendors, vendorId, value, onChange, disabled, required, unitOf, balanceOf, categories, onCreated }: { products: Product[]; vendors: Lookup[]; vendorId: string; value: string; onChange: (id: string) => void; disabled?: boolean; required?: boolean; unitOf: (p: Product) => string; balanceOf?: (p: Product) => number; categories?: Lookup[]; onCreated?: () => void }) {
  const [q, setQ] = useState(''), [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(''), [categoryId, setCategoryId] = useState(''), [productType, setProductType] = useState<string>('Consumable');
  const [purchaseUom, setPurchaseUom] = useState('TUBE'), [issueUom, setIssueUom] = useState('TUBE'), [conv, setConv] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const chosen = products.find(p => p.id === value), groups = groupProducts(products, vendors, vendorId, q, balanceOf);
  const allowCreate = !!categories && !!onCreated;
  const same = purchaseUom === issueUom;

  const startCreate = () => { setCreating(true); setName(q.trim()); setError(''); };
  const cancelCreate = () => { setCreating(false); setError(''); };
  const submitCreate = async () => {
    if (name.trim().length < 3) { setError('Enter the product name (3+ characters).'); return; }
    if (!categoryId) { setError('Choose a category.'); return; }
    if (!same && (!conv || Number(conv) <= 0)) { setError('Enter how much stock one purchase unit contains.'); return; }
    setBusy(true); setError('');
    const r = await postAction<{ productId: string; name: string }>('product.create', {
      name: name.trim(), productType, purchaseUom, issueUom, convFactor: same ? 1 : Number(conv),
      categoryId, cost: '', gstPercent: 0, vendorId: vendorId && vendorId !== 'OTHER' ? vendorId : '', reorderLevel: 0,
    });
    setBusy(false);
    if (!r.ok || !r.data) { setError(r.ok ? 'Could not add that product.' : r.message); return; }
    onChange(r.data.productId);
    onCreated?.();
    setCreating(false); setOpen(false); setName(''); setCategoryId(''); setConv('');
    (document.activeElement as HTMLElement | null)?.blur();
  };

  return <div className="relative w-full">
    <TextInput role="combobox" aria-expanded={open} autoComplete="off" disabled={disabled} placeholder="Type to search, or tap to pick" value={open ? q : chosen?.name ?? ''}
      onFocus={() => { setQ(''); setOpen(true); setCreating(false); }} onBlur={() => { if (!creating) setOpen(false); }} onChange={e => { setQ(e.target.value); setOpen(true); }} />
    {required && <input tabIndex={-1} aria-hidden required value={value} onChange={() => {}} className="pointer-events-none absolute inset-x-0 bottom-0 h-px opacity-0" />}
    {open && creating && <div onMouseDown={e => e.preventDefault()} className="absolute z-20 mt-1 w-full space-y-3 rounded-xl border bg-card p-3 shadow-lg">
      <p className="text-sm font-semibold">Add new product</p>
      {error && <p className="text-xs text-danger">{error}</p>}
      <label className="grid gap-1 text-xs">Product name<TextInput value={name} onChange={e => setName(e.target.value)} placeholder="As printed on the pack" /></label>
      <label className="grid gap-1 text-xs">Category<Select value={categoryId} onChange={e => setCategoryId(e.target.value)}><option value="">Select category</option>{categories!.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></label>
      <div className="grid grid-cols-2 gap-2">
        <label className="grid gap-1 text-xs">Type<Select value={productType} onChange={e => setProductType(e.target.value)}>{TYPES.map(t => <option key={t} value={t}>{t}</option>)}</Select></label>
        <label className="grid gap-1 text-xs">Bought as<Select value={purchaseUom} onChange={e => setPurchaseUom(e.target.value)}>{PURCHASE_UNITS.map(u => <option key={u}>{u}</option>)}</Select></label>
      </div>
      <label className="grid gap-1 text-xs">Stock counted in<Select value={issueUom} onChange={e => setIssueUom(e.target.value)}>{STOCK_UNITS.map(u => <option key={u}>{u}</option>)}</Select></label>
      {!same && <label className="grid gap-1 text-xs">Quantity in one {purchaseUom} ({issueUom})<TextInput type="number" min="0.001" step="any" value={conv} onChange={e => setConv(e.target.value)} placeholder="e.g. 60" /></label>}
      <div className="flex gap-2"><Button type="button" className="min-h-9 flex-1" disabled={busy} onClick={submitCreate}>{busy ? 'Adding…' : 'Add & select'}</Button><Button type="button" variant="outline" className="min-h-9" onClick={cancelCreate}>Back</Button></div>
    </div>}
    {open && !creating && <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-xl border bg-card shadow-lg">
      {!groups.length && <li className="p-3 text-sm text-muted-foreground">No product found.</li>}
      {groups.map(g => <li key={g.label}><p className="sticky top-0 bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground">{g.label}</p><ul>{g.items.slice(0, 500).map(p => { const bal = balanceOf?.(p); return <li key={p.id}><button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted" onMouseDown={e => { e.preventDefault(); onChange(p.id); setOpen(false); (document.activeElement as HTMLElement | null)?.blur(); }}><span className="block min-w-0 flex-1 overflow-x-auto whitespace-nowrap">{p.name}</span><span className={cn('shrink-0 text-xs', bal !== undefined && bal <= 0 ? 'text-danger' : 'text-muted-foreground')}>{bal === undefined ? `(${unitOf(p)})` : bal <= 0 ? 'Out of stock' : `${bal} ${unitOf(p)}${packLabel(p, bal) ? ` · ${packLabel(p, bal)}` : ''}`}</span></button></li>; })}</ul></li>)}
      {allowCreate && <li className="border-t"><button type="button" onMouseDown={e => { e.preventDefault(); startCreate(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold text-brand hover:bg-muted">+ Add {q.trim() ? `"${q.trim()}"` : 'a new product'}</button></li>}
    </ul>}
  </div>;
}
