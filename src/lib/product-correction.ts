import type { Product } from './catalogue';

/** Send type-only edits independently of units; retain an explicit snapshot for stale forms. */
export function productCorrection(product:Product, edit:{productType:string;purchaseUom:string;issueUom:string;conversion:string;notes:string}) {
  const purchaseUom=edit.purchaseUom||product.purchaseUom,issueUom=edit.issueUom||product.uom;
  const conversion=purchaseUom===issueUom?1:edit.conversion!==''?Number(edit.conversion):product.conversion;
  const unitChanged=purchaseUom!==product.purchaseUom||issueUom!==product.uom||conversion!==product.conversion;
  return {
    productId:product.id,productType:edit.productType||product.productType,notes:edit.notes,
    expected:{productType:product.productType,purchaseUom:product.purchaseUom,issueUom:product.uom,convFactor:product.conversion},
    ...(unitChanged?{purchaseUom,issueUom,convFactor:conversion}:{}),
  };
}
