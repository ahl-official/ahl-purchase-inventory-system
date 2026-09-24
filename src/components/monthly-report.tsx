"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { Panel, StatusBanner, TextInput } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { postAction } from "@/lib/api-client";
import { downloadCsv } from "@/lib/csv";

interface Row {
  month: string; city: string; businessUnit: string; category: string; productId: string; product: string; uom: string;
  opening: number; purchases: number; transferIn: number; transferOut: number; consumedAHL: number; consumedALC: number; consumedShared: number;
  adjustments: number; closing: number; costPerUnit: number; closingValue: number;
}

// The input columns of finance's Inventory tab, in their order. Its formula columns are left out.
const HEADERS = ["Month", "City", "Business Unit", "Category", "Product Name", "Tracking Type", "Batch/Serial No.", "Opening Stock", "Purchases (Units)", "Transfer In", "Transfer Out", "Units Consumed in Service (AHL)", "Units Consumed in Service (ALC)", "Units Consumed in Service (Shared)", "Cost Per Unit (INR)", "Damaged / adjusted (info)", "Unit (info)", "Closing in app (info)"];
const COLUMNS = ["City", "Category", "Product", "Opening", "Purchases", "Transfer in", "Transfer out", "AHL", "ALC", "Shared", "Adjust.", "Closing", "Cost/unit", "Value"];
const num = (v: number) => (v ? v.toLocaleString("en-IN", { maximumFractionDigits: 3 }) : "–");
const inr = (v: number) => "₹" + v.toLocaleString("en-IN", { maximumFractionDigits: 0 });
const thisMonth = () => new Date().toISOString().slice(0, 7);

export function MonthlyReport() {
  const [month, setMonth] = useState(thisMonth);
  const [rows, setRows] = useState<Row[] | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("");

  const load = useCallback(async (m: string) => {
    setLoading(true); setError("");
    const r = await postAction<{ rows: Row[] }>("inventoryReport.read", { month: m });
    setLoading(false);
    if (r.ok) setRows(r.data.rows); else { setRows(null); setError(r.message); }
  }, []);
  useEffect(() => { const t = setTimeout(() => void load(thisMonth()), 0); return () => clearTimeout(t); }, [load]);

  const download = () => downloadCsv([HEADERS, ...rows!.map((r) => [`${r.month}-01`, r.city, r.businessUnit, r.category, r.product, "Bulk", "", r.opening, r.purchases, r.transferIn, r.transferOut, r.consumedAHL, r.consumedALC, r.consumedShared, r.costPerUnit, r.adjustments, r.uom, r.closing])], `ahl-inventory-${month}.csv`);
  const totalValue = (rows || []).reduce((s, r) => s + r.closingValue, 0);

  return <Panel>
    <div className="border-b p-5"><h2 className="font-semibold">Monthly inventory report</h2><p className="mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">Opening, purchases, transfers, consumption by business unit and cost for each city and product, in the column order of finance&apos;s Inventory tab.</p></div>
    <div className="flex flex-wrap items-end gap-3 border-b p-4 sm:p-5">
      <label className="grid gap-2 text-sm">Month<TextInput type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44" /></label>
      <Button type="button" variant="outline" className="min-h-11" disabled={loading || !month} onClick={() => void load(month)}>{loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}Load</Button>
      <Button type="button" className="min-h-11 sm:ml-auto" disabled={!rows?.length} onClick={download}><Download className="size-4" />Download CSV</Button>
    </div>
    {error && <div className="p-4"><StatusBanner tone="error" title="Could not load the report">{error}</StatusBanner></div>}
    {loading && !rows && <p className="px-6 py-12 text-center text-sm text-muted-foreground">Loading…</p>}
    {rows && !rows.length && <p className="px-6 py-12 text-center text-sm text-muted-foreground">No stock activity up to this month yet.</p>}
    {!!rows?.length && <>
      <div className="overflow-x-auto"><table className="w-full min-w-[980px] text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr>{COLUMNS.map((h, i) => <th key={h} className={`px-3 py-2.5 font-medium ${i > 2 ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
        <tbody className="divide-y">{rows.map((r) => <tr key={r.city + r.productId}>
          <td className="px-3 py-2.5">{r.city}</td>
          <td className="px-3 py-2.5">{r.category}<span className="block text-xs text-muted-foreground">{r.businessUnit}</span></td>
          <td className="px-3 py-2.5 font-medium">{r.product}<span className="block text-xs font-normal text-muted-foreground">{r.uom}</span></td>
          {[r.opening, r.purchases, r.transferIn, r.transferOut, r.consumedAHL, r.consumedALC, r.consumedShared, r.adjustments].map((v, i) => <td key={i} className="px-3 py-2.5 text-right tabular">{num(v)}</td>)}
          <td className="px-3 py-2.5 text-right font-semibold tabular">{num(r.closing)}</td>
          <td className="px-3 py-2.5 text-right tabular">{num(r.costPerUnit)}</td>
          <td className="px-3 py-2.5 text-right tabular">{inr(r.closingValue)}</td>
        </tr>)}</tbody>
      </table></div>
      <p className="border-t p-4 text-xs leading-relaxed text-muted-foreground sm:px-5">Closing stock value: <strong className="text-foreground">{inr(totalValue)}</strong>. Retail units sold come from finance&apos;s Revenue Tracker, so this report does not subtract them. Paste the CSV into the blue input columns of the Inventory tab only.</p>
    </>}
  </Panel>;
}
