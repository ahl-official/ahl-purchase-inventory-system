"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import { Printer, Search } from "lucide-react";
import { Panel, Select, TextInput } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import type { Product } from "@/lib/catalogue";

// Label sizes in millimetres and points: tubes are small, bottles medium, tubs and cans large.
const SIZES = {
  S: { label: "Small 30 × 20 mm", w: 30, h: 20, qr: 15, name: 5.5, id: 5 },
  M: { label: "Medium 50 × 30 mm", w: 50, h: 30, qr: 24, name: 8, id: 7 },
  L: { label: "Large 70 × 40 mm", w: 70, h: 40, qr: 34, name: 10, id: 8 },
} as const;
type Size = keyof typeof SIZES;

/** Suggest a size from how much one pack holds; the person can change it. */
const suggest = (p: Product): Size => (p.conversion <= 100 ? "S" : p.conversion <= 500 ? "M" : "L");

interface Label { productId: string; name: string; copies: number; size: Size; dataUrl: string }

/** One QR per product (it encodes the product id), printed once per physical tube or bottle. */
export function QrLabels({ products, preset }: { products: Product[]; preset: { id: string; n: number } | null }) {
  const [search, setSearch] = useState(""), [type, setType] = useState("");
  const [copies, setCopies] = useState<Record<string, number>>(preset ? { [preset.id]: preset.n } : {});
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const [labels, setLabels] = useState<Label[] | null>(null), [generating, setGenerating] = useState(false);

  const sizeOf = (p: Product) => sizes[p.id] ?? suggest(p);
  const shown = products
    .filter((p) => (!type || p.productType === type) && p.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => Number(b.id === preset?.id) - Number(a.id === preset?.id) || a.name.localeCompare(b.name));
  const total = Object.values(copies).reduce((s, n) => s + (n || 0), 0);

  const generate = async () => {
    setGenerating(true);
    const next = await Promise.all(products.filter((p) => (copies[p.id] || 0) > 0).map(async (p) => ({
      productId: p.id, name: p.name, copies: copies[p.id], size: sizeOf(p),
      dataUrl: await QRCode.toDataURL(p.id, { margin: 0, width: 400 }),
    })));
    setGenerating(false);
    setLabels(next);
  };

  // Print only after the code images have decoded; otherwise the labels come out with empty squares.
  useEffect(() => {
    if (!labels?.length) return;
    let live = true;
    void Promise.all([...document.querySelectorAll<HTMLImageElement>("#qr-print-root img")].map((i) => i.decode().catch(() => undefined)))
      .then(() => { if (live) window.print(); });
    return () => { live = false; };
  }, [labels]);

  return <>
    <Panel>
      <div className="border-b p-5"><h2 className="font-semibold">QR labels</h2><p className="mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">Print a code once per product, then stick a copy on every tube or bottle that arrives. Pick a label size that fits the pack, set the number of copies, then print.</p></div>
      <div className="grid gap-3 border-b p-5 sm:grid-cols-[1fr_160px]">
        <label className="relative"><Search className="absolute left-3 top-3.5 size-4 text-muted-foreground" /><TextInput aria-label="Search products" placeholder="Search products…" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <Select aria-label="Product type" value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{["Consumable", "Retail", "Both"].map((t) => <option key={t}>{t}</option>)}</Select>
      </div>
      <ul className="divide-y">
        {shown.map((p) => <li key={p.id} className="flex flex-wrap items-center gap-3 p-4 sm:px-5">
          <div className="min-w-0 flex-1 basis-56"><p className="break-words text-sm font-medium">{p.name}</p><p className="mt-1 text-xs text-muted-foreground">{p.productType} · {p.uom} · {p.id}</p></div>
          <Select aria-label={`Label size for ${p.name}`} className="w-44" value={sizeOf(p)} onChange={(e) => setSizes({ ...sizes, [p.id]: e.target.value as Size })}>{(Object.keys(SIZES) as Size[]).map((k) => <option key={k} value={k}>{SIZES[k].label}</option>)}</Select>
          <TextInput type="number" min={0} step={1} aria-label={`Copies of ${p.name}`} className="w-20 text-right" placeholder="0" value={copies[p.id] ?? ""} onChange={(e) => setCopies({ ...copies, [p.id]: Math.max(0, Math.floor(Number(e.target.value)) || 0) })} />
        </li>)}
        {!shown.length && <li className="px-6 py-12 text-center text-sm text-muted-foreground">No matching products.</li>}
      </ul>
      <div className="sticky bottom-0 flex items-center justify-between gap-3 rounded-b-2xl border-t bg-card p-4 sm:p-5">
        <p className="text-sm text-muted-foreground">{total} label{total === 1 ? "" : "s"} selected</p>
        <Button type="button" className="min-h-11" disabled={!total || generating} onClick={() => void generate()}><Printer className="size-4" />{generating ? "Generating…" : "Generate & print"}</Button>
      </div>
    </Panel>
    {/* Rendered straight into <body> so printing can hide everything else without leaving blank pages. */}
    {labels && createPortal(
      <div id="qr-print-root">
        {labels.flatMap((l) => Array.from({ length: l.copies }, (_, i) => {
          const s = SIZES[l.size];
          return (
            <div key={`${l.productId}-${i}`} className="qr-label" style={{ width: `${s.w}mm`, height: `${s.h}mm` }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={l.dataUrl} alt={`QR code for ${l.name}`} style={{ width: `${s.qr}mm`, height: `${s.qr}mm` }} />
              <div className="qr-label-text">
                <p style={{ fontSize: `${s.name}pt` }}>{l.name}</p>
                <p style={{ fontSize: `${s.id}pt` }}>{l.productId}</p>
              </div>
            </div>
          );
        }))}
      </div>,
      document.body
    )}
  </>;
}
