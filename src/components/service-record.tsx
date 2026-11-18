'use client';
import { useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Panel, Select, TextInput } from './ui/field';
import { Button } from './ui/button';
import { postAction } from '@/lib/api-client';
import type { Catalogue } from '@/lib/catalogue';
import { cn } from '@/lib/utils';

export interface ServiceRecipe { service: string; items: { productId: string; productName: string; qty: number; unit: string }[]; }
interface ServiceLine { productId: string; productName: string; unit: string; qty: string; }

function todayISO() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function Field({ title, wide, children }: { title: string; wide?: boolean; children: ReactNode }) { return <label className={cn('grid min-w-0 gap-2 text-sm', wide && 'sm:col-span-2')}>{title}{children}</label>; }
function Section({ title, description }: { title: string; description: string }) {
  return <div className="border-b p-5"><h2 className="font-semibold">{title}</h2><p className="mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">{description}</p></div>;
}

export function ServiceRecord({ catalogue, stock, locationId, recipes, busy, onSubmit }: {
  catalogue: Catalogue; stock: { productId: string; locationBalances?: Record<string, number> }[]; locationId: string;
  recipes: ServiceRecipe[]; busy: boolean;
  onSubmit: (action: 'service.record', values: object) => Promise<boolean>;
}) {
  const [clientName, setClientName] = useState(''), [technician, setTechnician] = useState(''), [otherTechnician, setOtherTechnician] = useState('');
  const [service, setService] = useState(''), [date, setDate] = useState(todayISO());
  const [lines, setLines] = useState<ServiceLine[]>([]);
  const [extraError, setExtraError] = useState('');

  const technicians = catalogue.people.filter(p => p.role === 'Technician');
  const availableOf = (productId: string) => stock.find(s => s.productId === productId)?.locationBalances?.[locationId] ?? 0;
  const costOf = (line: ServiceLine) => {
    const p = catalogue.products.find(x => x.id === line.productId);
    if (!p || line.qty === '') return 0;
    return Number(line.qty) * (p.unitPrice / (p.conversion || 1));
  };
  const totalCost = lines.reduce((sum, l) => sum + costOf(l), 0);

  const pickService = (name: string) => {
    setService(name);
    const recipe = recipes.find(r => r.service === name);
    setLines(recipe ? recipe.items.map(it => ({ productId: it.productId, productName: it.productName, unit: it.unit, qty: String(it.qty) })) : []);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setExtraError('');
    if (!service || !lines.length) { setExtraError('Select a service.'); return; }
    let technicianId = technician;
    if (technician === 'OTHER') {
      const added = await postAction<{ id: string }>('person.add', { name: otherTechnician.trim(), locationId });
      if (!added.ok || !added.data) { setExtraError(added.ok ? 'Could not add that technician.' : added.message); return; }
      technicianId = added.data.id;
    }
    const ok = await onSubmit('service.record', { clientName, technicianId, service, date, lines: lines.map(l => ({ productId: l.productId, qty: Number(l.qty) })) });
    if (ok) { setClientName(''); setTechnician(''); setOtherTechnician(''); setService(''); setLines([]); setDate(todayISO()); setExtraError(''); }
  };

  return <Panel>
    <Section title="Record a service" description="Pick a service to see what it needs -- quantities are editable, cost is calculated live, and submitting deducts the real stock used." />
    <form onSubmit={submit} className="p-5 sm:p-6"><fieldset disabled={busy} className="grid min-w-0 gap-5 sm:grid-cols-2 disabled:opacity-60">
      <Field title="Client name"><TextInput required value={clientName} onChange={e => setClientName(e.target.value)} /></Field>
      <Field title="Technician"><Select required value={technician} onChange={e => setTechnician(e.target.value)}><option value="">Select technician</option>{technicians.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}<option value="OTHER">Other</option></Select></Field>
      {technician === 'OTHER' && <Field title="Technician name"><TextInput required value={otherTechnician} onChange={e => setOtherTechnician(e.target.value)} placeholder="Type the name once. It stays in the list." /></Field>}
      <Field title="Service" wide><Select required value={service} onChange={e => pickService(e.target.value)}><option value="">Select service</option>{recipes.map(r => <option key={r.service} value={r.service}>{r.service}</option>)}</Select></Field>
      <Field title="Date"><TextInput required type="date" value={date} max={todayISO()} onChange={e => setDate(e.target.value)} /></Field>

      {lines.length > 0 && <div className="grid gap-3 sm:col-span-2">
        {lines.map((line, i) => { const available = availableOf(line.productId); const cost = costOf(line); return <div key={line.productId} className="grid items-end gap-3 rounded-xl border p-3 sm:grid-cols-[1fr_8rem_8rem]">
          <div><p className="text-sm font-medium">{line.productName}</p><p className="text-xs text-muted-foreground">Available: {available} {line.unit}</p></div>
          <Field title={`Qty (${line.unit})`}><TextInput required type="number" min="0" step="any" max={available || undefined} value={line.qty} onChange={e => setLines(ls => ls.map((l, j) => j === i ? { ...l, qty: e.target.value } : l))} /></Field>
          <p className="text-sm font-medium">₹{cost.toFixed(2)}</p>
        </div>; })}
        <p className="text-sm font-semibold">Total cost: ₹{totalCost.toFixed(2)}</p>
      </div>}

      {extraError && <p className="rounded-xl bg-danger-subtle p-3 text-sm text-danger sm:col-span-2">{extraError}</p>}
      <div className="sm:col-span-2"><Button type="submit" disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" />}Record service</Button></div>
    </fieldset></form>
  </Panel>;
}
