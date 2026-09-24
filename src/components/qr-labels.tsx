"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Printer, Search } from "lucide-react";
import { Panel, Select, TextInput } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import type { Product } from "@/lib/catalogue";

interface Label { productId: string; name: string; copies: number; dataUrl: string }

/** One QR per product (it encodes the product id), printed once per physical tube or bottle. */
export function QrLabels({ products, preset }: { products: Product[]; preset: { id: string; n: number } | null }) {
  const [search, setSearch] = useState(""), [type, setType] = useState("");
  const [copies, setCopies] = useState<Record<string, number>>(preset ? { [preset.id]: preset.n } : {});
  const [labels, setLabels] = useState<Label[] | null>(null), [generating, setGenerating] = useState(false);

  const shown = products
    .filter((p) => (!type || p.productType === type) && p.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => Number(b.id === preset?.id) - Number(a.id === preset?.id) || a.name.localeCompare(b.name));
  const total = Object.values(copies).reduce((s, n) => s + (n || 0), 0);

  const generate = async () => {
    setGenerating(true);
    const next = await Promise.all(Object.entries(copies).filter(([, n]) => n > 0).map(async ([productId, n]) => ({
      productId, copies: n, name: products.find((p) => p.id === productId)?.name || productId,
      dataUrl: await QRCode.toDataURL(productId, { margin: 1, width: 240 }),
    })));
    setGenerating(false);
    setLabels(next);
  };

  // Printing has to wait until the label sheet is in the DOM.
  useEffect(() => { if (labels?.length) window.print(); }, [labels]);

  return <>
    <Panel>
      <div className="border-b p-5"><h2 className="font-semibold">QR labels</h2><p className="mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">Print a code once per product, then stick a copy on every tube or bottle that arrives. Set the number of copies, then print.</p></div>
      <div className="grid gap-3 border-b p-5 sm:grid-cols-[1fr_160px]">
        <label className="relative"><Search className="absolute left-3 top-3.5 size-4 text-muted-foreground" /><TextInput aria-label="Search products" placeholder="Search products…" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <Select aria-label="Product type" value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{["Consumable", "Retail", "Both", "Furniture"].map((t) => <option key={t}>{t}</option>)}</Select>
      </div>
      <ul className="divide-y">
        {shown.map((p) => <li key={p.id} className="flex items-center gap-3 p-4 sm:px-5">
          <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{p.name}</p><p className="mt-1 text-xs text-muted-foreground">{p.productType} · {p.uom} · {p.id}</p></div>
          <TextInput type="number" min={0} step={1} aria-label={`Copies of ${p.name}`} className="w-20 text-right" placeholder="0" value={copies[p.id] ?? ""} onChange={(e) => setCopies({ ...copies, [p.id]: Math.max(0, Math.floor(Number(e.target.value)) || 0) })} />
        </li>)}
        {!shown.length && <li className="px-6 py-12 text-center text-sm text-muted-foreground">No matching products.</li>}
      </ul>
      <div className="sticky bottom-0 flex items-center justify-between gap-3 rounded-b-2xl border-t bg-card p-4 sm:p-5">
        <p className="text-sm text-muted-foreground">{total} label{total === 1 ? "" : "s"} selected</p>
        <Button type="button" className="min-h-11" disabled={!total || generating} onClick={() => void generate()}><Printer className="size-4" />{generating ? "Generating…" : "Generate & print"}</Button>
      </div>
    </Panel>
    {labels && <div id="qr-print-sheet" className="hidden print:grid print:grid-cols-3 print:gap-4">
      {labels.flatMap((l) => Array.from({ length: l.copies }, (_, i) => (
        <div key={`${l.productId}-${i}`} className="qr-label flex flex-col items-center gap-1 border border-black/20 p-2 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={l.dataUrl} alt={`QR code for ${l.name}`} className="h-24 w-24" />
          <p className="text-[10px] font-semibold leading-tight">{l.name}</p><p className="text-[9px] leading-tight text-black/60">{l.productId}</p>
        </div>
      )))}
    </div>}
  </>;
}
