'use client';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Panel, Select, TextInput, StatusBanner } from './ui/field';
import { Button } from './ui/button';
import { PhotoCapture, type CapturedPhoto } from './photo-capture';
import { ProductPicker } from './product-picker';
import { postAction } from '@/lib/api-client';
import type { Catalogue } from '@/lib/catalogue';
import { cn } from '@/lib/utils';

export interface FmsHandover {
  handoverId: string; date: string; category: string; investmentLevel: string; productName: string; qtyGiven: number;
  technician: string; clientName: string; service: string; handoverCheck: string; handoverTimestamp: string;
  appliedToClient: string; appliedTimestamp: string; qtyOnBill: number | null; billTally: string;
  billNo: string; billProofPhoto: string; billProofStatus: string; billTallyTimestamp: string;
  investigationNeeded: string; investigationStatus: string; investigationNotes: string;
  qtyReturned: number | null; investigationReturnTimestamp: string; qtyOutstanding: number | null;
  finalStatus: string; closedTimestamp: string;
}

function todayISO() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
/** Mirrors the FMS sheet's own Category data-validation list (Consumable / Retail / Hair Patch / Wig) exactly. */
const FMS_CATEGORIES = ['Consumable', 'Retail', 'Hair Patch / Wig'] as const;
/** Best first guess at this product's FMS category, from the main catalogue's own productType -- still just a default, the dropdown stays fully editable. */
function guessFmsCategory(productType: string | undefined): string {
  if (productType === 'Consumable') return 'Consumable';
  if (productType === 'Retail' || productType === 'Both') return 'Retail';
  return 'Hair Patch / Wig';
}
function Field({ title, wide, children }: { title: string; wide?: boolean; children: ReactNode }) { return <label className={cn('grid min-w-0 gap-2 text-sm', wide && 'sm:col-span-2')}>{title}{children}</label>; }
function Section({ title, description, button, onClick, disabled }: { title: string; description: string; button?: string; onClick?: () => void; disabled?: boolean }) {
  return <div className="flex flex-wrap items-start justify-between gap-3 border-b p-5"><div><h2 className="font-semibold">{title}</h2><p className="mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">{description}</p></div>{button && <Button variant="outline" disabled={disabled} onClick={onClick}><RefreshCw className="size-4" />{button}</Button>}</div>;
}

/** Drives the inline "what's next" action purely off the sheet's own FINAL STATUS text -- stable
    across any future column reorganization in the FMS tracker, unlike re-deriving the underlying
    column logic here. */
function nextStep(h: FmsHandover): 'applied' | 'billTally' | 'investigate' | 'return' | 'closed' | 'blocked' | null {
  const s = h.finalStatus;
  if (!s) return null;
  if (s.startsWith('Closed')) return 'closed';
  if (s === 'Blocked - Incomplete Details') return 'blocked';
  if (s === 'Open - Awaiting Applied Confirmation') return 'applied';
  if (s === 'Open - Bill Tally Pending' || s === 'Open - Bill Proof Pending') return 'billTally';
  if (['Open - Not Found (Escalate)', 'Open - Investigation Pending', 'Open - Under Investigation'].includes(s)) return 'investigate';
  if (s === 'Open - Return to Inventory Pending' || s === 'Open - Product Outstanding') return 'return';
  return null;
}
function isDelayed(h: FmsHandover): boolean {
  if (!h.handoverTimestamp || !h.billTallyTimestamp) return false;
  return new Date(h.billTallyTimestamp).getTime() - new Date(h.handoverTimestamp).getTime() > 60 * 60 * 1000;
}
function Badge({ text, tone }: { text: string; tone: 'open' | 'closed' | 'blocked' }) {
  return <span className={cn('inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide',
    tone === 'closed' ? 'bg-teal-50 text-teal-800' : tone === 'blocked' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800')}>{text}</span>;
}

export function FmsRetail({ catalogue, stock, locationId, busy, onSubmit }: { catalogue: Catalogue; stock: { productId: string; locationBalances?: Record<string, number> }[]; locationId: string; busy: boolean; onSubmit: (action: 'fms.create' | 'fms.applied' | 'fms.billTally' | 'fms.investigate' | 'fms.return', values: object) => Promise<boolean> }) {
  const [rows, setRows] = useState<FmsHandover[] | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [productId, setProductId] = useState(''), [qtyGiven, setQtyGiven] = useState(''), [technician, setTechnician] = useState('');
  const [clientName, setClientName] = useState(''), [service, setService] = useState(''), [category, setCategory] = useState('');
  const [investmentLevel, setInvestmentLevel] = useState(''), [date, setDate] = useState(todayISO());
  const [billForms, setBillForms] = useState<Record<string, { qty: string; billNo: string; photo: CapturedPhoto | null }>>({});
  const [investigateForms, setInvestigateForms] = useState<Record<string, { status: string; notes: string }>>({});
  const [returnForms, setReturnForms] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const r = await postAction<FmsHandover[]>('fms.list', {});
    setLoading(false);
    if (r.ok) setRows(r.data); else setError(r.message);
  }, []);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  const technicians = Array.from(new Set(catalogue.people.filter(p => p.role === 'Technician').map(p => p.name)));
  const p = catalogue.products.find(x => x.id === productId);
  // A client buys whole bottles/packs, not ml/gm -- show and collect qty in the product's
  // purchase unit, converting down to the stock unit on hand to check real availability.
  const available = p ? (stock.find(s => s.productId === p.id)?.locationBalances?.[locationId] ?? 0) / (p.conversion || 1) : 0;
  const open = (rows || []).filter(h => nextStep(h) !== 'closed');
  const closed = (rows || []).filter(h => nextStep(h) === 'closed');

  const submitCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!p) return;
    const ok = await onSubmit('fms.create', { productId: p.id, productName: p.name, qtyGiven: Number(qtyGiven), technician, clientName, service, category, investmentLevel, date });
    if (ok) { setProductId(''); setQtyGiven(''); setTechnician(''); setClientName(''); setService(''); setCategory(''); setInvestmentLevel(''); void load(); }
  };
  const submitApplied = async (handoverId: string, applied: 'Yes' | 'No') => { if (await onSubmit('fms.applied', { handoverId, applied })) void load(); };
  const submitBillTally = async (handoverId: string) => {
    const f = billForms[handoverId];
    if (!f?.photo) { setError('Attach a bill proof photo before saving.'); return; }
    if (await onSubmit('fms.billTally', { handoverId, qtyOnBill: Number(f.qty), billNo: f.billNo, photo: { base64: f.photo.base64, mimeType: f.photo.mimeType, fileName: f.photo.fileName } })) { setBillForms(b => ({ ...b, [handoverId]: { qty: '', billNo: '', photo: null } })); void load(); }
  };
  const submitInvestigate = async (handoverId: string) => {
    const f = investigateForms[handoverId]; if (!f?.status) return;
    if (await onSubmit('fms.investigate', { handoverId, status: f.status, notes: f.notes || '' })) void load();
  };
  const submitReturn = async (handoverId: string) => {
    const qty = returnForms[handoverId]; if (!qty) return;
    if (await onSubmit('fms.return', { handoverId, qtyReturned: Number(qty) })) { setReturnForms(r => ({ ...r, [handoverId]: '' })); void load(); }
  };

  return <div className="space-y-4">
    <Panel>
      <Section title="New handover" description="Hand a retail product to a technician for a client. Tracked through billing, investigation and return in the FMS tracker." />
      <form onSubmit={submitCreate} className="p-5 sm:p-6"><fieldset disabled={busy} className="grid min-w-0 gap-5 sm:grid-cols-2 disabled:opacity-60">
        <Field title="Product" wide><ProductPicker products={catalogue.products} vendors={catalogue.vendors} vendorId="" value={productId} required unitOf={x => x.purchaseUom} onChange={id => { setProductId(id); const prod = catalogue.products.find(x => x.id === id); if (!category) setCategory(guessFmsCategory(prod?.productType)); }} /></Field>
        {p && (available > 0 ? <p className="rounded-xl bg-brand-subtle p-3 text-sm text-brand sm:col-span-2">Available: <strong>{Number(available.toFixed(2))} {p.purchaseUom}</strong></p> : <p className="rounded-xl bg-danger-subtle p-3 text-sm text-danger sm:col-span-2">Nothing in stock here yet for this product.</p>)}
        <Field title={`Qty given${p?.purchaseUom ? ` (${p.purchaseUom})` : ''}`}><TextInput required disabled={!!p && available <= 0} type="number" min="0.001" max={available || undefined} step="any" value={qtyGiven} onChange={e => setQtyGiven(e.target.value)} /></Field>
        <Field title="Technician"><TextInput required list="fms-technicians" value={technician} onChange={e => setTechnician(e.target.value)} placeholder="Type or pick a name" /><datalist id="fms-technicians">{technicians.map(t => <option key={t} value={t} />)}</datalist></Field>
        <Field title="Client name"><TextInput required value={clientName} onChange={e => setClientName(e.target.value)} /></Field>
        <Field title="Service"><TextInput value={service} onChange={e => setService(e.target.value)} /></Field>
        <Field title="Category"><Select value={category} onChange={e => setCategory(e.target.value)}><option value="">Select category</option>{FMS_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</Select></Field>
        <Field title="Investment level"><TextInput value={investmentLevel} onChange={e => setInvestmentLevel(e.target.value)} /></Field>
        <Field title="Date"><TextInput required type="date" value={date} max={todayISO()} onChange={e => setDate(e.target.value)} /></Field>
        {error && <p className="rounded-xl bg-danger-subtle p-3 text-sm text-danger sm:col-span-2">{error}</p>}
        <div className="sm:col-span-2"><Button type="submit" disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" />}Record handover</Button></div>
      </fieldset></form>
    </Panel>

    <Panel>
      <Section title="Open handovers" description="Everything still waiting on applied confirmation, bill tally, investigation or return." button="Refresh" onClick={() => void load()} />
      {loading ? <p className="p-5 text-sm text-muted-foreground">Loading…</p> : !open.length ? <p className="p-5 text-sm text-muted-foreground">Nothing open right now.</p> : <ul className="divide-y">
        {open.map(h => { const step = nextStep(h); const delayed = isDelayed(h); const unit = catalogue.products.find(x => x.name === h.productName)?.purchaseUom || ''; return <li key={h.handoverId} className="space-y-3 p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div><p className="text-sm font-semibold">{h.productName} · {h.qtyGiven} {unit} · {h.technician}</p><p className="text-xs text-muted-foreground">{h.clientName}{h.service ? ` · ${h.service}` : ''} · {h.handoverId}</p></div>
            <div className="flex flex-wrap items-center gap-2"><Badge text={h.finalStatus || 'Open'} tone={step === 'blocked' ? 'blocked' : 'open'} />{delayed && <Badge text="Delayed (bill tally > 1hr)" tone="blocked" />}</div>
          </div>

          {step === 'applied' && <div className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => void submitApplied(h.handoverId, 'Yes')}>Applied to client</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void submitApplied(h.handoverId, 'No')}>Not applied</Button></div>}

          {step === 'billTally' && <div className="grid gap-3 rounded-xl border p-3 sm:grid-cols-2">
            <Field title={`Qty on bill${unit ? ` (${unit})` : ''}`}><TextInput type="number" min="0" step="any" value={billForms[h.handoverId]?.qty || ''} onChange={e => setBillForms(b => ({ ...b, [h.handoverId]: { qty: e.target.value, billNo: b[h.handoverId]?.billNo || '', photo: b[h.handoverId]?.photo || null } }))} /></Field>
            <Field title="Bill no. / proof link (optional)"><TextInput value={billForms[h.handoverId]?.billNo || ''} onChange={e => setBillForms(b => ({ ...b, [h.handoverId]: { qty: b[h.handoverId]?.qty || '', billNo: e.target.value, photo: b[h.handoverId]?.photo || null } }))} /></Field>
            <div className="sm:col-span-2"><PhotoCapture label="Bill proof photo" onCapture={photo => setBillForms(b => ({ ...b, [h.handoverId]: { qty: b[h.handoverId]?.qty || '', billNo: b[h.handoverId]?.billNo || '', photo } }))} disabled={busy} /></div>
            <div className="sm:col-span-2"><Button size="sm" disabled={busy || !billForms[h.handoverId]?.qty} onClick={() => void submitBillTally(h.handoverId)}>Save bill tally</Button></div>
          </div>}

          {step === 'investigate' && <div className="grid gap-3 rounded-xl border p-3 sm:grid-cols-2">
            <Field title="Investigation status"><Select value={investigateForms[h.handoverId]?.status || ''} onChange={e => setInvestigateForms(f => ({ ...f, [h.handoverId]: { status: e.target.value, notes: f[h.handoverId]?.notes || '' } }))}><option value="">Select</option><option value="In Progress">In Progress</option><option value="Found">Found</option><option value="Not Found">Not Found</option></Select></Field>
            <Field title="Notes (who took it / where)"><TextInput value={investigateForms[h.handoverId]?.notes || ''} onChange={e => setInvestigateForms(f => ({ ...f, [h.handoverId]: { status: f[h.handoverId]?.status || '', notes: e.target.value } }))} /></Field>
            <div className="sm:col-span-2"><Button size="sm" disabled={busy || !investigateForms[h.handoverId]?.status} onClick={() => void submitInvestigate(h.handoverId)}>Save investigation</Button></div>
          </div>}

          {step === 'return' && <div className="flex flex-wrap items-end gap-3 rounded-xl border p-3">
            <Field title={`Qty returned to inventory${unit ? ` (${unit})` : ''}${h.qtyOutstanding != null ? ` (outstanding: ${h.qtyOutstanding})` : ''}`}><TextInput type="number" min="0" step="any" value={returnForms[h.handoverId] || ''} onChange={e => setReturnForms(r => ({ ...r, [h.handoverId]: e.target.value }))} /></Field>
            <Button size="sm" disabled={busy || !returnForms[h.handoverId]} onClick={() => void submitReturn(h.handoverId)}>Record return</Button>
          </div>}

          {step === 'blocked' && <StatusBanner tone="error" title="Incomplete details">Check this handover&apos;s data in the FMS tracker.</StatusBanner>}
        </li>; })}
      </ul>}
    </Panel>

    {closed.length > 0 && <Panel>
      <Section title="Closed" description="Fully reconciled handovers." />
      <ul className="divide-y">{closed.slice(0, 20).map(h => <li key={h.handoverId} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm"><span>{h.productName} · {h.qtyGiven} · {h.technician} · {h.clientName}</span><Badge text={h.finalStatus} tone="closed" /></li>)}</ul>
    </Panel>}
  </div>;
}
