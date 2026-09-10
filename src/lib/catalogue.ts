"use client";
import { useEffect, useState } from 'react';
import { postAction } from './api-client';
export interface Product { id:string; name:string; categoryId:string; productType:string; uom:string; purchaseUom:string; conversion:number; cost:number; reorderLevel:number; }
export interface Person { id:string; name:string; role:string; locationId:string; }
export interface Lookup { id:string; name:string; unit:string; dot:string; }
export interface Catalogue { products:Product[]; people:Person[]; categories:Lookup[]; vendors:Lookup[]; locations:Lookup[]; headOfficeLocationId:string; salonFloorLocationId:string; approvalThreshold:number; }
export const EMPTY_CATALOGUE: Catalogue = { products:[],people:[],categories:[],vendors:[],locations:[],headOfficeLocationId:'LOC-01',salonFloorLocationId:'LOC-02',approvalThreshold:5000 };
export function useCatalogue() {
  const [catalogue,setCatalogue]=useState(EMPTY_CATALOGUE);
  useEffect(()=>{let active=true; void postAction<Catalogue>('catalogue.read',{}).then(r=>{if(active && r.ok)setCatalogue(r.data);});return()=>{active=false;};},[]);
  return catalogue;
}
