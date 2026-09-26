'use client';
import { useState } from 'react';
import { TextInput } from './ui/field';
import { groupProducts, type Lookup, type Product } from '@/lib/catalogue';

/** One box: click or type, the list narrows as you type. Without typing it shows the vendor's products first. */
export function ProductPicker({ products, vendors, vendorId, value, onChange, disabled, required, unitOf }: { products: Product[]; vendors: Lookup[]; vendorId: string; value: string; onChange: (id: string) => void; disabled?: boolean; required?: boolean; unitOf: (p: Product) => string }) {
  const [q, setQ] = useState(''), [open, setOpen] = useState(false);
  const chosen = products.find(p => p.id === value), groups = groupProducts(products, vendors, vendorId, q);
  return <div className="relative w-full">
    <TextInput role="combobox" aria-expanded={open} autoComplete="off" disabled={disabled} placeholder="Type to search, or tap to pick" value={open ? q : chosen?.name ?? ''}
      onFocus={() => { setQ(''); setOpen(true); }} onBlur={() => setOpen(false)} onChange={e => { setQ(e.target.value); setOpen(true); }} />
    {required && <input tabIndex={-1} aria-hidden required value={value} onChange={() => {}} className="pointer-events-none absolute inset-x-0 bottom-0 h-px opacity-0" />}
    {open && <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-xl border bg-card shadow-lg">
      {!groups.length && <li className="p-3 text-sm text-muted-foreground">No product found.</li>}
      {groups.map(g => <li key={g.label}><p className="sticky top-0 bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground">{g.label}</p><ul>{g.items.slice(0, 60).map(p => <li key={p.id}><button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-muted" onMouseDown={e => { e.preventDefault(); onChange(p.id); setOpen(false); (document.activeElement as HTMLElement | null)?.blur(); }}>{p.name} <span className="text-xs text-muted-foreground">({unitOf(p)})</span></button></li>)}</ul></li>)}
    </ul>}
  </div>;
}
