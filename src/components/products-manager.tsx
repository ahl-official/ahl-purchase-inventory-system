"use client";
import { useState, useEffect, type FormEvent } from 'react';
import { Loader2, Search, Plus, Archive, RotateCcw, PackageSearch } from 'lucide-react';
import { AppShell, PageContainer, PageHeader } from '@/components/app-shell';
import { Panel, PanelHeader, TextInput, Select, StatusBanner } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { NewProductForm, PURCHASE_UNITS, STOCK_UNITS } from '@/components/new-product-form';
import { postAction } from '@/lib/api-client';
import type { Catalogue, Product } from '@/lib/catalogue';
import { EMPTY_CATALOGUE } from '@/lib/catalogue';

// ---------- helpers ----------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

// ---------- Confirm dialog ----------

function ConfirmDialog({
  product, action, onConfirm, onCancel, busy,
}: {
  product: Product;
  action: 'archive' | 'restore';
  onConfirm: (notes: string) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [notes, setNotes] = useState('');
  const isArchive = action === 'archive';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xl">
        <h3 className="text-base font-semibold text-foreground">
          {isArchive ? 'Archive product?' : 'Restore product?'}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{product.name}</span>
          {isArchive
            ? ' will be hidden from all dropdowns and forms. Stock history is kept.'
            : ' will reappear in all dropdowns and forms.'}
        </p>
        <label className="mt-4 block">
          <span className="text-sm font-medium text-foreground">Reason</span>
          <TextInput
            required
            className="mt-1 w-full"
            placeholder="e.g. Discontinued by brand"
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
        </label>
        <div className="mt-5 flex gap-3">
          <Button
            type="button"
            variant={isArchive ? 'destructive' : 'default'}
            className="flex-1"
            disabled={busy || !notes.trim()}
            onClick={() => onConfirm(notes.trim())}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {isArchive ? 'Archive' : 'Restore'}
          </Button>
          <Button type="button" variant="outline" className="flex-1" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------- Product row ----------

function ProductRow({
  product, categories, vendors, onAction,
}: {
  product: Product;
  categories: Catalogue['categories'];
  vendors: Catalogue['vendors'];
  onAction: (p: Product, action: 'archive' | 'restore') => void;
}) {
  const cat = categories.find(c => c.id === product.categoryId);
  const vendor = vendors.find(v => v.id === product.vendorId);
  const isActive = product.active !== false;

  return (
    <div className={`flex items-start gap-4 border-b border-border px-5 py-4 last:border-0 ${isActive ? '' : 'opacity-50'}`}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{product.name}</span>
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
            product.productType === 'Retail' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
            : product.productType === 'Both' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
            : 'bg-brand-subtle text-brand'
          }`}>
            {product.productType}
          </span>
          {!isActive && (
            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              Archived
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {product.id}
          {cat && <> · {cat.name}</>}
          {vendor && <> · {vendor.name}</>}
          <> · {product.purchaseUom} → {product.uom}</>
          {product.conversion !== 1 && <> (1:{product.conversion})</>}
        </p>
      </div>
      <Button
        type="button"
        variant={isActive ? 'destructive' : 'outline'}
        size="sm"
        onClick={() => onAction(product, isActive ? 'archive' : 'restore')}
      >
        {isActive ? <><Archive className="size-3.5" /> Archive</> : <><RotateCcw className="size-3.5" /> Restore</>}
      </Button>
    </div>
  );
}

// ---------- Main component ----------

export function ProductsManager() {
  const [catalogue, setCatalogue] = useState<Catalogue>(EMPTY_CATALOGUE);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<'active' | 'archived' | 'all'>('active');
  const [showAddForm, setShowAddForm] = useState(false);
  const [confirm, setConfirm] = useState<{ product: Product; action: 'archive' | 'restore' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const load = async () => {
    setLoading(true);
    const r = await postAction<Catalogue>('catalogue.read', { includeInactive: true });
    if (r.ok && r.data) setCatalogue(r.data);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const filtered = catalogue.products.filter(p => {
    const matchStatus =
      filterStatus === 'all' ? true
      : filterStatus === 'archived' ? p.active === false
      : p.active !== false;
    const matchQuery = !query.trim() || norm(p.name).includes(norm(query));
    return matchStatus && matchQuery;
  });

  const handleAction = async (notes: string) => {
    if (!confirm) return;
    setBusy(true);
    setError('');
    const r = await postAction(
      confirm.action === 'archive' ? 'product.delete' : 'product.restore',
      { productId: confirm.product.id, notes }
    );
    setBusy(false);
    if (!r.ok) { setError(r.message); return; }
    setSuccess(`${confirm.product.name} ${confirm.action === 'archive' ? 'archived' : 'restored'} successfully.`);
    setConfirm(null);
    await load();
    setTimeout(() => setSuccess(''), 4000);
  };

  const activeCount = catalogue.products.filter(p => p.active !== false).length;
  const archivedCount = catalogue.products.filter(p => p.active === false).length;

  return (
    <AppShell>
      <PageContainer>
        <PageHeader
          title="Product catalogue"
          description={`${activeCount} active · ${archivedCount} archived`}
        />

        {/* Toolbar */}
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <TextInput
              id="product-search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search products…"
              className="pl-9"
            />
          </div>
          <Select
            id="product-status-filter"
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value as typeof filterStatus)}
            className="w-36"
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">All</option>
          </Select>
          <Button
            type="button"
            onClick={() => { setShowAddForm(v => !v); setError(''); setSuccess(''); }}
          >
            <Plus className="size-4" />
            {showAddForm ? 'Cancel' : 'Add product'}
          </Button>
        </div>

        {/* Banners */}
        {error && (
          <div className="mb-4">
            <StatusBanner tone="error" title="Action failed">{error}</StatusBanner>
          </div>
        )}
        {success && (
          <div className="mb-4">
            <StatusBanner tone="success">{success}</StatusBanner>
          </div>
        )}

        {/* Add product form */}
        {showAddForm && (
          <div className="mb-6">
            <NewProductForm
              catalogue={catalogue}
              onCreated={() => { void load(); setShowAddForm(false); }}
              onPrintLabel={() => {}}
            />
          </div>
        )}

        {/* Products list */}
        <Panel>
          <PanelHeader
            title={`${filtered.length} product${filtered.length !== 1 ? 's' : ''}`}
            description={
              filterStatus === 'active' ? 'Showing active products'
              : filterStatus === 'archived' ? 'Showing archived products'
              : 'Showing all products'
            }
          />
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
              <PackageSearch className="size-8 opacity-40" />
              <p>{query ? 'No products match your search.' : 'No products here.'}</p>
            </div>
          ) : (
            <div>
              {filtered.map(p => (
                <ProductRow
                  key={p.id}
                  product={p}
                  categories={catalogue.categories}
                  vendors={catalogue.vendors}
                  onAction={(prod, action) => { setConfirm({ product: prod, action }); setError(''); }}
                />
              ))}
            </div>
          )}
        </Panel>

        {/* Confirm dialog */}
        {confirm && (
          <ConfirmDialog
            product={confirm.product}
            action={confirm.action}
            busy={busy}
            onConfirm={handleAction}
            onCancel={() => setConfirm(null)}
          />
        )}
      </PageContainer>
    </AppShell>
  );
}
