"use client";
import { useEffect, useState } from 'react';
import { postAction } from './api-client';
export interface Product { id:string; name:string; categoryId:string; vendorId?:string; productType:string; uom:string; purchaseUom:string; conversion:number; cost:number; reorderLevel:number; }
export interface Person { id:string; name:string; role:string; locationId:string; }
export interface Lookup { id:string; name:string; unit:string; dot:string; }
export interface Catalogue { products:Product[]; people:Person[]; categories:Lookup[]; vendors:Lookup[]; locations:Lookup[]; headOfficeLocationId:string; salonFloorLocationId:string; approvalThreshold:number; }
export const EMPTY_CATALOGUE: Catalogue = { products:[],people:[],categories:[],vendors:[],locations:[],headOfficeLocationId:'LOC-01',salonFloorLocationId:'LOC-02',approvalThreshold:5000 };
export function useCatalogue() {
  const [catalogue,setCatalogue]=useState(EMPTY_CATALOGUE);
  useEffect(()=>{let active=true; void postAction<Catalogue>('catalogue.read',{}).then(r=>{if(active && r.ok && r.data)setCatalogue(r.data);});return()=>{active=false;};},[]);
  return catalogue;
}

/** Product picker order: typing shows only matches (the vendor's first); otherwise the chosen vendor's products, products with no vendor, other vendors. Nothing is hidden. */
export function groupProducts(products: Product[], vendors: Lookup[], vendorId: string, query: string) {
  const q = query.trim().toLowerCase(), vendor = vendors.find(v => v.id === vendorId);
  if (q) { const hits = products.filter(p => p.name.toLowerCase().includes(q)); return hits.length ? [{ label: 'Results', items: [...hits.filter(p => p.vendorId === vendorId), ...hits.filter(p => p.vendorId !== vendorId)] }] : []; }
  const groups: { label: string; items: Product[] }[] = [
    { label: '', items: [] }, { label: vendor ? `${vendor.name} products` : 'Products', items: [] },
    { label: 'No vendor yet', items: [] }, { label: 'Other vendors', items: [] },
  ];
  for (const p of products) {
    const i = !vendor || p.vendorId === vendorId ? 1 : !p.vendorId ? 2 : 3;
    groups[i].items.push(p);
  }
  return groups.filter(g => g.items.length);
}
