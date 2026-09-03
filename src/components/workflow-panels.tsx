"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, Panel, PanelHeader, Select, StatusBanner, TextInput } from "@/components/ui/field";
import { postAction } from "@/lib/api-client";
import { MOCK_CATEGORIES, MOCK_USERS, HEAD_OFFICE_LOCATION_ID } from "@/lib/mock-data";

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
  const { products, loading, error, load } = useLiveProducts();
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("1");
  const [recipient, setRecipient] = useState("");
  const [categoryId, setCategoryId] = useState("CAT-15");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [assets, setAssets] = useState<AssetAssignment[]>([]);
  const product = useMemo(() => products.find((p) => p.productId === productId), [products, productId]);

  const loadAssets = useCallback(async () => { const r = await postAction<AssetAssignment[]>("asset.list", {}); if (r.ok) setAssets(r.data ?? []); }, []);
  useEffect(() => { const id = window.setTimeout(() => void loadAssets(), 0); return () => window.clearTimeout(id); }, [loadAssets]);

  const submit = async () => {
    if (!product || !recipient || Number(qty) <= 0) { setBanner({ tone: "error", title: "Complete the issue", text: "Select product, recipient and quantity." }); return; }
    setBusy(true);
    const result = product.productType.toLowerCase() === "furniture"
      ? await postAction<{ assignmentId: string }>("asset.issue", { productId, qty: Number(qty), assignedTo: recipient, categoryId, notes })
      : await postAction<{ handoverId: string }>("stock.issue", { productId, fromLocationId: HEAD_OFFICE_LOCATION_ID, splits: [{ qty: Number(qty), recipientUserId: recipient, categoryId, notes }] });
    setBusy(false);
    if (result.ok) { setBanner({ tone: "success", title: product.productType === "Furniture" ? "Asset marked In Use" : "Head Office stock issued", text: "The live ledger and available balance were updated." }); setProductId(""); setQty("1"); setRecipient(""); setNotes(""); void load(); void loadAssets(); }
    else setBanner({ tone: "error", title: result.error, text: result.message });
  };
  const updateAsset = async (assignmentId: string, status: string) => {
    setBusy(true); const result = await postAction("asset.status", { assignmentId, status }); setBusy(false);
    if (result.ok) { setBanner({ tone: "success", title: "Asset updated", text: `${assignmentId} is now ${status}.` }); void loadAssets(); void load(); }
    else setBanner({ tone: "error", title: result.error, text: result.message });
  };

  return <div className="space-y-4">
    {banner && <StatusBanner tone={banner.tone} title={banner.title}>{banner.text}</StatusBanner>}
    {error && <StatusBanner tone="error" title="Live data unavailable">{error}</StatusBanner>}
    <Panel><PanelHeader title="Issue from Head Office" description="Consumables are consumed; Furniture is tracked as In Use." />
      <div className="grid gap-4 p-5 sm:grid-cols-2">
        <Field><FieldLabel>Product</FieldLabel><Select value={productId} onChange={(e) => setProductId(e.target.value)} disabled={loading || busy}><option value="">Select product</option>{products.map((p) => <option key={p.productId} value={p.productId}>{p.name} · {p.productType} · {p.headOfficeAvailable ?? 0} available</option>)}</Select></Field>
        <Field><FieldLabel>Quantity</FieldLabel><TextInput type="number" min="0.01" step="0.01" value={qty} onChange={(e) => setQty(e.target.value)} disabled={busy} /></Field>
        <Field><FieldLabel>Employee / user</FieldLabel><Select value={recipient} onChange={(e) => setRecipient(e.target.value)} disabled={busy}><option value="">Select recipient</option>{MOCK_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
        <Field><FieldLabel>Purpose / category</FieldLabel><Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={busy}>{MOCK_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        <Field className="sm:col-span-2"><FieldLabel>Note</FieldLabel><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Back office use, room or purpose" disabled={busy} /></Field>
        <Button onClick={() => void submit()} disabled={busy || loading} className="sm:w-fit">{busy && <Loader2 className="size-4 animate-spin" />}{product?.productType === "Furniture" ? "Mark In Use" : "Issue stock"}</Button>
      </div>
    </Panel>
    <Panel><PanelHeader title="Furniture currently In Use" description="Return it to Head Office or close it as damaged, lost or disposed." />
      {assets.length === 0 ? <p className="p-5 text-sm text-muted-foreground">No assets currently marked In Use.</p> : <ul className="divide-y divide-border">{assets.map((a) => <li key={a.assignmentId} className="space-y-2 p-4"><div className="text-sm"><strong>{a.productName}</strong> · {a.qty} {a.uom} · {a.assignedTo}</div><div className="flex flex-wrap gap-2">{["RETURNED", "DAMAGED", "LOST", "DISPOSED"].map((s) => <Button key={s} size="sm" variant="outline" disabled={busy} onClick={() => void updateAsset(a.assignmentId, s)}>{s}</Button>)}</div></li>)}</ul>}
    </Panel>
  </div>;
}
