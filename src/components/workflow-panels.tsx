"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, Panel, PanelHeader, Select, StatusBanner, TextInput } from "@/components/ui/field";
import { postAction } from "@/lib/api-client";
import { useCatalogue } from '@/lib/catalogue';

type Banner = { tone: "success" | "error"; title: string; text: string } | null;

interface LiveProduct {
  productId: string;
  name: string;
  productType: string;
  uom: string;
  headOfficeAvailable?: number;
  salonFloorBalance?: number;
}

interface OpeningCount {
  countId: string;
  productId: string;
  productName: string;
  qty: number;
  uom: string;
  locationId: string;
  countedBy: string;
  status: string;
}

function useLiveProducts() {
  const [products, setProducts] = useState<LiveProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const result = await postAction<{ stock: LiveProduct[] }>("dashboard.read", {});
    setLoading(false);
    if (result.ok) {
      setProducts(result.data.stock ?? []);
      setError("");
    } else {
      setProducts([]);
      setError(result.message);
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  return { products, loading, error, load };
}

export function OpeningStockPanel({ locationId, locationName }: { locationId: string; locationName: string }) {
  const { products, loading, error, load } = useLiveProducts();
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("0");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [counts, setCounts] = useState<OpeningCount[]>([]);

  const loadCounts = useCallback(async () => {
    const result = await postAction<OpeningCount[]>("opening.list", {});
    if (result.ok) setCounts(result.data ?? []);
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void loadCounts(), 0);
    return () => window.clearTimeout(id);
  }, [loadCounts]);

  const submit = async () => {
    if (!productId || Number(qty) < 0) {
      setBanner({ tone: "error", title: "Check count", text: "Select a product and enter its physical quantity." });
      return;
    }
    setBusy(true);
    const result = await postAction<{ countId: string }>("opening.submit", {
      productId, qty: Number(qty), locationId, notes,
    });
    setBusy(false);
    if (result.ok) {
      setBanner({ tone: "success", title: "Count submitted", text: `${result.data.countId} is waiting for admin approval.` });
      setProductId(""); setQty("0"); setNotes(""); void loadCounts();
    } else {
      setBanner({ tone: "error", title: result.error, text: result.message });
    }
  };

  return (
    <div className="space-y-4">
      {banner && <StatusBanner tone={banner.tone} title={banner.title}>{banner.text}</StatusBanner>}
      {error && <StatusBanner tone="error" title="Live data unavailable">{error}</StatusBanner>}
      <Panel>
        <PanelHeader title={`${locationName} opening stock`} description="Use once for the physical stock already present before go-live." aside={
          <button type="button" onClick={() => void load()} className="flex items-center gap-1 text-xs text-muted-foreground"><RefreshCw className="size-3.5" /> Refresh</button>
        } />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field>
            <FieldLabel>Product</FieldLabel>
            <Select value={productId} onChange={(e) => setProductId(e.target.value)} disabled={loading || busy}>
              <option value="">Select product</option>
              {products.map((p) => <option key={p.productId} value={p.productId}>{p.name} ({p.uom})</option>)}
            </Select>
          </Field>
          <Field>
            <FieldLabel>Physical quantity</FieldLabel>
            <TextInput type="number" min="0" step="0.01" value={qty} onChange={(e) => setQty(e.target.value)} disabled={busy} />
          </Field>
          <Field className="sm:col-span-2">
            <FieldLabel>Count note</FieldLabel>
            <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Shelf, room or count reference" disabled={busy} />
          </Field>
          <Button onClick={() => void submit()} disabled={busy || loading || !products.length} className="sm:w-fit">
            {busy && <Loader2 className="size-4 animate-spin" />} Submit for approval
          </Button>
        </div>
      </Panel>
      {counts.length > 0 && <Panel><PanelHeader title="Submitted opening counts" description="Approved counts become permanent ledger entries." />
        <ul className="divide-y divide-border">{counts.slice(0, 20).map((c) => <li key={c.countId} className="flex items-center justify-between gap-3 px-5 py-3 text-sm"><span>{c.productName}: <strong>{c.qty} {c.uom}</strong></span><span className="text-xs text-muted-foreground">{c.status}</span></li>)}</ul>
      </Panel>}
    </div>
  );
}

export function OpeningApprovalsPanel() {
  const [counts, setCounts] = useState<OpeningCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [banner, setBanner] = useState<Banner>(null);
  const load = useCallback(async () => {
    setLoading(true);
    const result = await postAction<OpeningCount[]>("opening.list", {});
    setLoading(false);
    if (result.ok) setCounts((result.data ?? []).filter((c) => c.status === "PENDING"));
    else setBanner({ tone: "error", title: result.error, text: result.message });
  }, []);
  useEffect(() => { const id = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(id); }, [load]);
  const decide = async (countId: string, decision: "APPROVE" | "REJECT") => {
    setBusyId(countId);
    const result = await postAction("opening.approve", { countId, decision });
    setBusyId("");
    if (result.ok) { setBanner({ tone: "success", title: "Opening count updated", text: `${countId} was ${decision.toLowerCase()}d.` }); void load(); }
    else setBanner({ tone: "error", title: result.error, text: result.message });
  };
  return <Panel>
    <PanelHeader title="Opening stock approvals" description="Approve only after checking the physical count." aside={<button type="button" onClick={() => void load()} className="text-xs text-muted-foreground">Refresh</button>} />
    {banner && <div className="border-b border-border p-4"><StatusBanner tone={banner.tone} title={banner.title}>{banner.text}</StatusBanner></div>}
    {loading ? <p className="p-5 text-sm text-muted-foreground">Loading…</p> : counts.length === 0 ? <p className="p-5 text-sm text-muted-foreground">No opening counts waiting.</p> :
      <ul className="divide-y divide-border">{counts.map((c) => <li key={c.countId} className="flex flex-wrap items-center justify-between gap-3 p-4"><div><p className="text-sm font-medium">{c.productName}: {c.qty} {c.uom}</p><p className="text-xs text-muted-foreground">{c.locationId} · counted by {c.countedBy}</p></div><div className="flex gap-2"><Button size="sm" variant="outline" disabled={!!busyId} onClick={() => void decide(c.countId, "REJECT")}>Reject</Button><Button size="sm" disabled={!!busyId} onClick={() => void decide(c.countId, "APPROVE")}>{busyId === c.countId && <Loader2 className="size-3.5 animate-spin" />}Approve</Button></div></li>)}</ul>}
  </Panel>;
}

interface AssetAssignment { assignmentId: string; productName: string; qty: number; uom: string; assignedTo: string; }

export function HeadOfficeIssuePanel() {
  const { categories: MOCK_CATEGORIES, people: MOCK_USERS, headOfficeLocationId: HEAD_OFFICE_LOCATION_ID } = useCatalogue();
  const { products, loading, error, load } = useLiveProducts();
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("1");
  const [recipient, setRecipient] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [assets, setAssets] = useState<AssetAssignment[]>([]);
  const product = useMemo(() => products.find((p) => p.productId === productId), [products, productId]);

  const loadAssets = useCallback(async () => { const r = await postAction<AssetAssignment[]>("asset.list", {}); if (r.ok) setAssets(r.data ?? []); }, []);
  useEffect(() => { const id = window.setTimeout(() => void loadAssets(), 0); return () => window.clearTimeout(id); }, [loadAssets]);

  const isFurniture = product?.productType.toLowerCase() === "furniture";
  const recipients = MOCK_USERS.filter((user) =>
    isFurniture ? user.role !== "Approver" : user.role === "Floor"
  );
  const sortedProducts = useMemo(
    () =>
      [...products].sort(
        (a, b) =>
          Number((b.headOfficeAvailable ?? 0) > 0) -
            Number((a.headOfficeAvailable ?? 0) > 0) ||
          (b.headOfficeAvailable ?? 0) - (a.headOfficeAvailable ?? 0) ||
          a.name.localeCompare(b.name)
      ),
    [products]
  );

  const submit = async () => {
    if (!product || !recipient || !categoryId || Number(qty) <= 0) { setBanner({ tone: "error", title: "Complete the issue", text: "Select product, technician, service category and quantity." }); return; }
    if (Number(qty) > (product.headOfficeAvailable ?? 0)) { setBanner({ tone: "error", title: "Not enough Head Office stock", text: `Only ${product.headOfficeAvailable ?? 0} ${product.uom} is currently available.` }); return; }
    setBusy(true);
    const result = isFurniture
      ? await postAction<{ assignmentId: string }>("asset.issue", { productId, qty: Number(qty), assignedTo: recipient, categoryId, notes })
      : await postAction<{ handoverId: string }>("stock.issue", { productId, fromLocationId: HEAD_OFFICE_LOCATION_ID, splits: [{ qty: Number(qty), recipientUserId: recipient, categoryId, notes }] });
    setBusy(false);
    if (result.ok) { setBanner({ tone: "success", title: isFurniture ? "Asset marked In Use" : "Issued directly to technician", text: "Head Office stock, technician ownership and service category were updated in the live ledger." }); setProductId(""); setQty("1"); setRecipient(""); setCategoryId(""); setNotes(""); void load(); void loadAssets(); }
    else setBanner({ tone: "error", title: result.error, text: result.message });
  };
  const updateAsset = async (assignmentId: string, status: string) => {
    setBusy(true); const result = await postAction("asset.status", { assignmentId, status }); setBusy(false);
    if (result.ok) { setBanner({ tone: "success", title: "Asset updated", text: `${assignmentId} is now ${status}.` }); void loadAssets(); void load(); }
    else setBanner({ tone: "error", title: result.error, text: result.message });
  };

  return (
    <div className="space-y-4">
      {banner && (
        <StatusBanner tone={banner.tone} title={banner.title}>
          {banner.text}
        </StatusBanner>
      )}
      {error && (
        <StatusBanner tone="error" title="Live data unavailable">
          {error}
        </StatusBanner>
      )}

      <Panel className="overflow-hidden">
        <PanelHeader
          title="Issue directly from Head Office"
          description="Give stock to a technician without moving it through Salon Floor."
          aside={
            product ? (
              <div className="rounded-lg bg-brand-subtle px-3 py-1.5 text-right">
                <p className="text-sm font-semibold tabular text-brand">
                  {product.headOfficeAvailable ?? 0} {product.uom}
                </p>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  available
                </p>
              </div>
            ) : undefined
          }
        />

        <div className="grid gap-4 p-5 lg:grid-cols-6">
          <Field className="lg:col-span-4">
            <FieldLabel step={1}>Product</FieldLabel>
            <Select
              value={productId}
              onChange={(event) => {
                setProductId(event.target.value);
                setRecipient("");
                setCategoryId("");
              }}
              disabled={loading || busy}
            >
              <option value="">Select a Head Office product</option>
              {sortedProducts.map((item) => (
                <option key={item.productId} value={item.productId}>
                  {item.name} · {item.productType} · {item.headOfficeAvailable ?? 0} {item.uom}
                </option>
              ))}
            </Select>
          </Field>

          <Field className="lg:col-span-2">
            <FieldLabel step={2}>Quantity</FieldLabel>
            <TextInput
              type="number"
              min="0.01"
              step="0.01"
              value={qty}
              onChange={(event) => setQty(event.target.value)}
              disabled={busy || !product}
            />
          </Field>

          <Field className="lg:col-span-3">
            <FieldLabel step={3}>{isFurniture ? "Assigned employee" : "Technician"}</FieldLabel>
            <Select
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
              disabled={busy || !product}
            >
              <option value="">{isFurniture ? "Select employee" : "Select technician"}</option>
              {recipients.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field className="lg:col-span-3">
            <FieldLabel step={4}>Service / category</FieldLabel>
            <Select
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
              disabled={busy || !product}
            >
              <option value="">Select where it will be used</option>
              {MOCK_CATEGORIES.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field className="lg:col-span-4">
            <FieldLabel optional>Note</FieldLabel>
            <TextInput
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Client, room, job or reason"
              disabled={busy}
            />
          </Field>

          <div className="flex items-end lg:col-span-2">
            <Button
              onClick={() => void submit()}
              disabled={busy || loading || !product}
              className="h-11 w-full font-semibold"
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {isFurniture ? "Mark In Use" : "Issue to technician"}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border bg-muted/40 px-5 py-3 text-xs text-muted-foreground">
          <span><strong className="text-foreground">From:</strong> Head Office</span>
          <span><strong className="text-foreground">Recorded against:</strong> Technician + service</span>
          <span><strong className="text-foreground">Salon Floor:</strong> Not affected</span>
        </div>
      </Panel>

      {(assets.length > 0 || products.some((item) => item.productType.toLowerCase() === "furniture")) && (
        <Panel>
          <PanelHeader
            title="Furniture currently In Use"
            description="Return it to Head Office or close it as damaged, lost or disposed."
          />
          {assets.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">No assets currently marked In Use.</p>
          ) : (
            <ul className="divide-y divide-border">
              {assets.map((asset) => (
                <li key={asset.assignmentId} className="space-y-2 p-4">
                  <div className="text-sm">
                    <strong>{asset.productName}</strong> · {asset.qty} {asset.uom} · {asset.assignedTo}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {["RETURNED", "DAMAGED", "LOST", "DISPOSED"].map((status) => (
                      <Button
                        key={status}
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void updateAsset(asset.assignmentId, status)}
                      >
                        {status}
                      </Button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </div>
  );
}
