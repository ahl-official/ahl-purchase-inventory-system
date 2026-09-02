import { z } from "zod";

export const IssueSplitSchema = z.object({
  qty: z.number().positive("Quantity must be greater than 0"),
  categoryId: z.string().min(1, "Category is required"),
  recipientUserId: z.string().min(1, "Recipient is required"),
  /** Client, service, or other reason the technician is taking this split. */
  notes: z.string().max(500, "Keep the purpose under 500 characters").optional(),
});

export const IssueStockSchema = z.object({
  productId: z.string().min(1, "Product is required"),
  fromLocationId: z.string().min(1, "Location is required"),
  splits: z.array(IssueSplitSchema).min(1, "At least one split is required"),
});

export type IssueSplit = z.infer<typeof IssueSplitSchema>;
export type IssueStock = z.infer<typeof IssueStockSchema>;

export const ReceiveStockSchema = z.object({
  productId: z.string().min(1, "Product is required"),
  qty: z.number().positive("Quantity must be greater than 0"),
  locationId: z.string().min(1, "Location is required"),
  categoryId: z.string().optional(),
  vendorId: z.string().optional(),
  poId: z.string().optional(),
  /** From the printed bill — lets a partial delivery be traced back to the invoice line it drew down. */
  invoiceNo: z.string().optional(),
  /** Bill total in rupees. Feeds vendor price history; falls back to catalogue cost when omitted. */
  amount: z.number().nonnegative().optional(),
  /** Who physically took delivery, if not Satvik himself (e.g. he was out and a colleague signed for it). */
  receivedByUserId: z.string().optional(),
});

export type ReceiveStock = z.infer<typeof ReceiveStockSchema>;

/** A photo captured by <PhotoCapture />, as carried inside stock.receive. */
export const BillPhotoSchema = z.object({
  base64: z.string().min(1, "Photo data is empty"),
  mimeType: z.string().min(1),
  fileName: z.string().min(1),
  sizeBytes: z.number().nonnegative(),
});

export type BillPhoto = z.infer<typeof BillPhotoSchema>;

/** stock.receive as sent from the GRN tab: ReceiveStock plus the bill and an optional product photo. */
export const ReceiveStockWithPhotoSchema = ReceiveStockSchema.extend({
  photo: BillPhotoSchema.optional(),
  productPhoto: BillPhotoSchema.optional(),
});

export type ReceiveStockWithPhoto = z.infer<typeof ReceiveStockWithPhotoSchema>;

export const PurchaseRequestSchema = z
  .object({
    /** Exactly one of productId / newProductName is expected — see the refine below. */
    productId: z.string().optional(),
    /** A product not yet in the catalogue. Logs as a flagged request, never a live PRODUCTS row. */
    newProductName: z.string().optional(),
    qty: z.number().positive("Quantity must be greater than 0"),
    requestedByUserId: z.string().min(1, "Requester is required"),
    /** Required once the estimated value clears the approval threshold — who signed off, not a workflow. */
    approvedBy: z.string().optional(),
    /** Only meaningful for a new product — there is no catalogue cost to fall back on. */
    estimatedValue: z.number().nonnegative().optional(),
    urgency: z.enum(["Normal", "Urgent"]).optional(),
    /** Why the floor needs it. Required so every purchase can be explained later. */
    notes: z.string().trim().min(3, "Add a short reason for the request"),
  })
  .refine((v) => !!v.productId || !!v.newProductName, {
    message: "Pick a product, or name the new one",
    path: ["productId"],
  });

export type PurchaseRequest = z.infer<typeof PurchaseRequestSchema>;

/** Satvik handing physical stock from receiving over to Hitesh. */
export const HandoverStockSchema = z.object({
  productId: z.string().min(1, "Product is required"),
  qty: z.number().positive("Quantity must be greater than 0"),
  toUserId: z.string().min(1, "Pick who is receiving custody"),
  notes: z.string().optional(),
});

export type HandoverStock = z.infer<typeof HandoverStockSchema>;

/** Hitesh confirming a handover after his own recount. */
export const ConfirmHandoverSchema = z.object({
  handoverId: z.string().min(1),
  /** Hitesh's independent physical count. A mismatch leaves the handover pending. */
  countedQty: z.number().positive("Enter the quantity you counted"),
  notes: z.string().optional(),
});

export type ConfirmHandover = z.infer<typeof ConfirmHandoverSchema>;
