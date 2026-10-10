"use client";
import { useEffect, useState } from 'react';
import { postAction } from './api-client';
export interface Product { id:string; name:string; categoryId:string; vendorId?:string; productType:string; uom:string; purchaseUom:string; conversion:number; cost:number; reorderLevel:number; }
export interface Person { id:string; name:string; role:string; locationId:string; }
export interface Lookup { id:string; name:string; unit:string; dot:string; }
export interface Catalogue { products:Product[]; people:Person[]; categories:Lookup[]; vendors:Lookup[]; receivers?:Lookup[]; locations:Lookup[]; headOfficeLocationId:string; salonFloorLocationId:string; dispatchLocationId:string; approvalThreshold:number; }
export const EMPTY_CATALOGUE: Catalogue = { products:[],people:[],categories:[],vendors:[],receivers:[],locations:[],headOfficeLocationId:'LOC-01',salonFloorLocationId:'LOC-02',dispatchLocationId:'LOC-05',approvalThreshold:5000 };
export function useCatalogue() {
  const [catalogue,setCatalogue]=useState(EMPTY_CATALOGUE);
  useEffect(()=>{let active=true; void postAction<Catalogue>('catalogue.read',{}).then(r=>{if(active && r.ok && r.data)setCatalogue(r.data);});return()=>{active=false;};},[]);
  return catalogue;
}

// Ignores hyphens, spaces and other punctuation so "C 22" finds "C-22 Solvent" -- people don't
// type a product's exact punctuation, and a product search that requires it finds nothing.
export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Product picker order: typing shows only matches (the vendor's first); otherwise the chosen vendor's products, products with no vendor, other vendors. Nothing is hidden. When balanceOf is given, zero-stock products sink to the bottom of each group instead of being removed. */
export function groupProducts(products: Product[], vendors: Lookup[], vendorId: string, query: string, balanceOf?: (p: Product) => number) {
  const q = norm(query.trim()), vendor = vendors.find(v => v.id === vendorId);
  const byStock = (items: Product[]) => balanceOf ? [...items].sort((a, b) => (balanceOf(a) > 0 ? 0 : 1) - (balanceOf(b) > 0 ? 0 : 1)) : items;
  if (q) { const hits = products.filter(p => norm(p.name).includes(q)); return hits.length ? [{ label: 'Results', items: byStock([...hits.filter(p => p.vendorId === vendorId), ...hits.filter(p => p.vendorId !== vendorId)]) }] : []; }
  const groups: { label: string; items: Product[] }[] = [
    { label: vendor ? `${vendor.name} products` : 'Products', items: [] },
    { label: 'No vendor yet', items: [] }, { label: 'Other vendors', items: [] },
  ];
  for (const p of products) {
    const i = !vendor || p.vendorId === vendorId ? 0 : !p.vendorId ? 1 : 2;
    groups[i].items.push(p);
  }
  return groups.filter(g => g.items.length).map(g => ({ ...g, items: byStock(g.items) }));
}

/** e.g. 750 ML in a product bought by the Tube (60 ML each) -> "12 Tube + 30 ML". Nothing to show when the stock and purchase unit are the same (conversion 1). */
export function packLabel(p: Product | undefined, qty: number) {
  if (!p || p.conversion <= 1 || qty <= 0) return undefined;
  const full = Math.floor(qty / p.conversion + 1e-9), loose = Math.round((qty - full * p.conversion) * 100) / 100;
  return `${full} ${p.purchaseUom}${loose > 0 ? ` + ${loose} ${p.uom}` : ''}`;
}
