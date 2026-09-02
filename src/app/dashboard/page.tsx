"use client";

import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, Boxes, Clock3, Download, RefreshCw, Search } from "lucide-react";
import { AppShell, PageContainer, PageHeader } from "@/components/app-shell";
import { Panel, PanelHeader, Select, StatusBanner, TextInput } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { postAction } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { MOCK_CATEGORIES, MOCK_USERS } from "@/lib/mock-data";

interface StockRow {
  productId: string;
  name: string;
  categoryId: string;
  productType: string;
  uom: string;
  reorderLevel: number;
  receivingBalance: number;
  receivingAvailable?: number;
  custodyBalance: number;
  pendingHandover?: number;
  totalBalance: number;
  lowStock: boolean;
}

interface PendingHandoverRow {
  handoverId: string;
  productName: string;
  qty: number;
  uom: string;
  date: string;
  actor: string;
  notes?: string;
}

interface OpenRequestRow {
  requestId: string;
  date: string;
  productName: string;
  isNewProduct: boolean;
  qty: number;
  requestedBy: string;
  status: string;
  estValue: number;
  approvedBy: string;
}

interface ActivityRow {
  txnId: string;
  date: string;
  type: string;
  direction: number;
  productName: string;
  qty: number;
  uom: string;
  locationId: string;
  categoryId?: string;
  personId?: string;
  actor: string;
  status: string;
  notes?: string;
}

interface VendorRateRow {
  productId: string;
  productName: string;
  vendorId: string;
  rate: number;
  date: string;
}

interface DashboardData {
  stock: StockRow[];
  pendingHandovers: PendingHandoverRow[];
  openRequests: OpenRequestRow[];
  recentActivity: ActivityRow[];
  vendorRates: VendorRateRow[];
}

const DEMO_DASHBOARD: DashboardData = {
  stock: [
    { productId: "PRD-0004", name: "Blue Tape", categoryId: "CAT-02", productType: "Consumable", uom: "PCS", reorderLevel: 50, receivingBalance: 40, receivingAvailable: 20, custodyBalance: 120, pendingHandover: 20, totalBalance: 160, lowStock: false },
    { productId: "PRD-0005", name: "Scalp Protector Spray", categoryId: "CAT-02", productType: "Consumable", uom: "ML", reorderLevel: 100, receivingBalance: 250, receivingAvailable: 150, custodyBalance: 450, pendingHandover: 100, totalBalance: 700, lowStock: false },
    { productId: "PRD-0015", name: "Aloe Vera Gel", categoryId: "CAT-02", productType: "Consumable", uom: "GM", reorderLevel: 5, receivingBalance: 500, receivingAvailable: 500, custodyBalance: 500, pendingHandover: 0, totalBalance: 1000, lowStock: false },
    { productId: "PRD-0026", name: "Colour Tube 100ml", categoryId: "CAT-09", productType: "Consumable", uom: "ML", reorderLevel: 50, receivingBalance: 600, receivingAvailable: 600, custodyBalance: 800, pendingHandover: 0, totalBalance: 1400, lowStock: false },
    { productId: "PRD-0028", name: "Kerastase Shampoo 250ml", categoryId: "CAT-08", productType: "Retail", uom: "BTL", reorderLevel: 10, receivingBalance: 6, receivingAvailable: 2, custodyBalance: 14, pendingHandover: 4, totalBalance: 20, lowStock: false },
    { productId: "PRD-0003", name: "Hair Topper - Standard", categoryId: "CAT-01", productType: "Retail", uom: "PCS", reorderLevel: 3, receivingBalance: 0, receivingAvailable: 0, custodyBalance: 2, pendingHandover: 0, totalBalance: 2, lowStock: true },
  ],
  pendingHandovers: [
    { handoverId: "DEMO-HND-003", productName: "Blue Tape", qty: 20, uom: "PCS", date: "2026-09-01", actor: "Satvik", notes: "Counted in person." },
    { handoverId: "DEMO-HND-001", productName: "Scalp Protector Spray", qty: 100, uom: "ML", date: "2026-09-01", actor: "Satvik" },
  ],
  openRequests: [
    { requestId: "DEMO-REQ-101", date: "2026-09-01", productName: "Blue Tape", isNewProduct: false, qty: 20, requestedBy: "Gauri", status: "OPEN", estValue: 1700, approvedBy: "" },
    { requestId: "DEMO-REQ-102", date: "2026-09-01", productName: "Colour Tube 100ml", isNewProduct: false, qty: 600, requestedBy: "Anita", status: "PENDING_APPROVAL", estValue: 6000, approvedBy: "Vishal Sir" },
    { requestId: "DEMO-REQ-104", date: "2026-09-01", productName: "Silicone Scalp Base", isNewProduct: true, qty: 2, requestedBy: "Daisy", status: "NEW_PRODUCT", estValue: 9000, approvedBy: "Jagruti Mam" },
  ],
  recentActivity: [
    { txnId: "DEMO-TXN-006", date: "2026-09-01", type: "ISSUE", direction: -1, productName: "Blue Tape", qty: 1, uom: "PCS", locationId: "LOC-01", categoryId: "CAT-02", personId: "USR-013", actor: "Hitesh", status: "ISSUED", notes: "Sonali — hair patch service" },
    { txnId: "DEMO-TXN-005", date: "2026-09-01", type: "HANDOVER", direction: 1, productName: "Scalp Protector Spray", qty: 100, uom: "ML", locationId: "LOC-01", personId: "USR-006", actor: "Satvik", status: "PENDING_CONFIRM" },
    { txnId: "DEMO-TXN-004", date: "2026-09-01", type: "RECEIPT", direction: 1, productName: "Aloe Vera Gel", qty: 500, uom: "GM", locationId: "LOC-07", categoryId: "CAT-02", actor: "Satvik", status: "RECEIVED" },
    { txnId: "DEMO-TXN-003", date: "2026-08-31", type: "ISSUE", direction: -1, productName: "Colour Tube 100ml", qty: 40, uom: "ML", locationId: "LOC-01", categoryId: "CAT-09", personId: "USR-012", actor: "Hitesh", status: "ISSUED", notes: "Colour service" },
  ],
  vendorRates: [
    { productId: "PRD-0004", productName: "Blue Tape", vendorId: "HairTech India", rate: 85, date: "2026-09-01" },
    { productId: "PRD-0004", productName: "Blue Tape", vendorId: "Khimaj Hair", rate: 82.5, date: "2026-08-28" },
    { productId: "PRD-0015", productName: "Aloe Vera Gel", vendorId: "HairTech India", rate: 25, date: "2026-09-01" },
    { productId: "PRD-0028", productName: "Kerastase Shampoo 250ml", vendorId: "New Beauty Point", rate: 850, date: "2026-08-29" },
  ],
};

function fmtDate(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

const STATUS_TONE: Record<string, string> = {
  NEW_PRODUCT: "border-warning/30 text-warning",
  PENDING_APPROVAL: "border-warning/30 text-warning",
  OPEN: "border-border text-muted-foreground",
};

function csvCell(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(DEMO_DASHBOARD);
  const [dataSource, setDataSource] = useState<"demo" | "live">("demo");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ title: string; text: string } | null>(null);
  const [stockQuery, setStockQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [activityType, setActivityType] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await postAction<DashboardData>("dashboard.read", {});
    setLoading(false);
    if (result.ok) {
      setData(result.data);
      setDataSource("live");
    } else {
      setData(DEMO_DASHBOARD);
      setDataSource("demo");
      setError({ title: result.error, text: result.message });
    }
  }, []);

  const stock = useMemo(() => {
    const query = stockQuery.trim().toLowerCase();
    return [...(data?.stock ?? [])]
      .filter((row) => !categoryFilter || row.categoryId === categoryFilter)
      .filter((row) => !query || row.name.toLowerCase().includes(query))
      .sort((a, b) => {
        // The meeting requirement is explicit: usable stock stays on top.
        const availableOrder = Number(b.custodyBalance > 0) - Number(a.custodyBalance > 0);
        if (availableOrder !== 0) return availableOrder;
        if (a.lowStock !== b.lowStock) return a.lowStock ? -1 : 1;
        return b.custodyBalance - a.custodyBalance || a.name.localeCompare(b.name);
      });
  }, [categoryFilter, data?.stock, stockQuery]);
  const activity = (data?.recentActivity ?? []).filter(
    (row) => !activityType || row.type === activityType
  );
  const lowStockCount = stock.filter((s) => s.lowStock).length;
  const availableProductCount = stock.filter((s) => s.custodyBalance > 0).length;

  const downloadActivity = () => {
    const headers = [
      "Date",
      "Type",
      "Product",
      "Direction",
      "Quantity",
      "UOM",
      "Category",
      "Issued To",
      "Actor",
      "Status",
      "Notes",
    ];
    const rows = activity.map((row) => [
      row.date,
      row.type,
      row.productName,
      row.direction,
      row.qty,
      row.uom,
      MOCK_CATEGORIES.find((item) => item.id === row.categoryId)?.name ?? row.categoryId,
      MOCK_USERS.find((item) => item.id === row.personId)?.name ?? row.personId,
      row.actor,
      row.status,
      row.notes,
    ]);
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `ahl-stock-activity-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AppShell>
      <PageContainer>
        <PageHeader
          title="Dashboard"
          description="What's in Receiving, what's with Hitesh, and what's still open — the one screen both of you read from."
          actions={
            <>
            <button
              type="button"
              onClick={downloadActivity}
              disabled={!activity.length}
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <Download className="size-3.5" />
              Download CSV
            </button>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              {dataSource === "demo" ? "Load live data" : "Refresh"}
            </button>
            </>
          }
        />

        {dataSource === "demo" && (
          <div className="mb-5">
            <StatusBanner tone="info" title="Demo dashboard">
              Sample stock, requests, handovers, activity and vendor rates are shown for the presentation.
            </StatusBanner>
          </div>
        )}

        {error && (
          <div className="mb-5">
            <StatusBanner tone="error" title={error.title}>
              {error.text}
            </StatusBanner>
          </div>
        )}

        <div className="space-y-5 pb-10">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Boxes className="size-4 text-brand" /> Available products
              </div>
              <p className="mt-2 text-2xl font-semibold tabular text-foreground">
                {availableProductCount}
              </p>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Clock3 className="size-4 text-warning" /> Pending handovers
              </div>
              <p className="mt-2 text-2xl font-semibold tabular text-foreground">
                {data?.pendingHandovers.length ?? 0}
              </p>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <AlertTriangle className="size-4 text-danger" /> Low stock
              </div>
              <p className="mt-2 text-2xl font-semibold tabular text-foreground">
                {lowStockCount}
              </p>
            </div>
          </div>

          <Panel>
            <PanelHeader
              title="Stock on hand"
              description="Receiving and Hitesh show usable stock. Pending stays locked until Hitesh confirms his recount."
              aside={
                lowStockCount > 0 ? (
                  <span className="flex items-center gap-1.5 text-xs font-medium text-warning">
                    <AlertTriangle className="size-3.5" />
                    {lowStockCount} low
                  </span>
                ) : undefined
              }
            />
            <div className="grid gap-3 border-b border-border p-4 sm:grid-cols-[1fr_15rem]">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <TextInput
                  aria-label="Search stock"
                  placeholder="Search product…"
                  value={stockQuery}
                  onChange={(event) => setStockQuery(event.target.value)}
                  className="pl-9"
                />
              </div>
              <Select
                aria-label="Filter stock by category"
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value)}
              >
                <option value="">All categories</option>
                {MOCK_CATEGORIES.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </Select>
            </div>
            {!data && loading ? (
              <p className="px-5 py-6 text-sm text-muted-foreground">Loading…</p>
            ) : stock.length === 0 ? (
              <p className="px-5 py-6 text-sm text-muted-foreground">No active products found.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">In Receiving</TableHead>
                    <TableHead className="text-right">Pending</TableHead>
                    <TableHead className="text-right">With Hitesh</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stock.map((s) => {
                    const category = MOCK_CATEGORIES.find((c) => c.id === s.categoryId);
                    return (
                      <TableRow key={s.productId}>
                        <TableCell className="whitespace-normal">
                          <div className="font-medium text-foreground">{s.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {category?.name ?? s.categoryId}
                            {s.productType && <> · {s.productType}</>}
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {s.receivingAvailable ?? s.receivingBalance} {s.uom}
                        </TableCell>
                        <TableCell className="text-right tabular text-warning">
                          {s.pendingHandover ?? 0} {s.uom}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {s.custodyBalance} {s.uom}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular">
                          {s.totalBalance} {s.uom}
                        </TableCell>
                        <TableCell>
                          {s.lowStock && (
                            <Badge variant="outline" className="border-warning/30 text-warning">
                              Low
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Panel>

          <div className="grid gap-5 lg:grid-cols-2">
            <Panel>
              <PanelHeader
                title="Pending handovers"
                description="Satvik has sent these — Hitesh hasn't confirmed his recount yet."
              />
              {!data ? (
                <p className="px-5 py-6 text-sm text-muted-foreground">
                  {loading ? "Loading…" : "—"}
                </p>
              ) : data.pendingHandovers.length === 0 ? (
                <p className="px-5 py-6 text-sm text-muted-foreground">Nothing outstanding.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {data.pendingHandovers.map((h) => (
                    <li key={h.handoverId} className="px-5 py-3">
                      <p className="text-sm text-foreground">
                        <span className="font-medium tabular">{h.qty}</span> {h.uom} ·{" "}
                        {h.productName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {fmtDate(h.date)} · from {h.actor}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel>
              <PanelHeader
                title="Open requests"
                description="Not yet fulfilled — includes items flagged as new to the catalogue."
              />
              {!data ? (
                <p className="px-5 py-6 text-sm text-muted-foreground">
                  {loading ? "Loading…" : "—"}
                </p>
              ) : data.openRequests.length === 0 ? (
                <p className="px-5 py-6 text-sm text-muted-foreground">Nothing open.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {data.openRequests.map((r) => (
                    <li key={r.requestId} className="px-5 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="min-w-0 truncate text-sm text-foreground">
                          <span className="font-medium tabular">{r.qty}</span> × {r.productName}
                        </p>
                        <Badge
                          variant="outline"
                          className={cn("shrink-0", STATUS_TONE[r.status] ?? "text-muted-foreground")}
                        >
                          {r.isNewProduct ? "New product" : r.status}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {fmtDate(r.date)}
                        {r.approvedBy && <> · approved by {r.approvedBy}</>}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Panel>
              <PanelHeader
                title="Recent activity"
                description="Last 30 ledger movements, newest first. Download the visible rows as CSV."
                aside={
                  <Select
                    aria-label="Filter activity type"
                    value={activityType}
                    onChange={(event) => setActivityType(event.target.value)}
                    className="h-8 w-32 text-xs"
                  >
                    <option value="">All activity</option>
                    <option value="RECEIPT">Receipts</option>
                    <option value="HANDOVER">Handovers</option>
                    <option value="ISSUE">Issues</option>
                  </Select>
                }
              />
              {!data ? (
                <p className="px-5 py-6 text-sm text-muted-foreground">
                  {loading ? "Loading…" : "—"}
                </p>
              ) : activity.length === 0 ? (
                <p className="px-5 py-6 text-sm text-muted-foreground">
                  No movements yet — the ledger is empty.
                </p>
              ) : (
                <ul className="max-h-96 divide-y divide-border overflow-y-auto">
                  {activity.map((a) => {
                    const category = MOCK_CATEGORIES.find((item) => item.id === a.categoryId);
                    const person = MOCK_USERS.find((item) => item.id === a.personId);
                    return (
                    <li key={a.txnId} className="px-5 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="min-w-0 truncate text-sm text-foreground">
                          <span className={a.direction > 0 ? "text-success" : "text-danger"}>
                            {a.direction > 0 ? "+" : "−"}
                            {Math.abs(Number(a.qty))} {a.uom}
                          </span>{" "}
                          {a.productName}
                        </p>
                        <span className="shrink-0 text-xs text-muted-foreground">{a.type}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {fmtDate(a.date)} · {a.actor}
                        {category && <> · {category.name}</>}
                        {person && <> · to {person.name}</>}
                      </p>
                      {a.notes && <p className="mt-0.5 text-xs text-muted-foreground">{a.notes}</p>}
                    </li>
                    );
                  })}
                </ul>
              )}
            </Panel>

            <Panel>
              <PanelHeader
                title="Recent vendor rates"
                description="What was actually paid, per delivery — for comparing vendors."
              />
              {!data ? (
                <p className="px-5 py-6 text-sm text-muted-foreground">
                  {loading ? "Loading…" : "—"}
                </p>
              ) : data.vendorRates.length === 0 ? (
                <p className="px-5 py-6 text-sm text-muted-foreground">
                  No priced deliveries yet.
                </p>
              ) : (
                <ul className="max-h-96 divide-y divide-border overflow-y-auto">
                  {data.vendorRates.map((v, i) => (
                    <li key={`${v.productId}-${v.date}-${i}`} className="px-5 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="min-w-0 truncate text-sm text-foreground">{v.productName}</p>
                        <span className="shrink-0 text-sm font-medium tabular text-foreground">
                          ₹{Number(v.rate).toFixed(2)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {v.vendorId} · {fmtDate(v.date)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      </PageContainer>
    </AppShell>
  );
}
