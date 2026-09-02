"use client";

import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Check, Loader2, Package, RefreshCw, Send } from "lucide-react";
import { AppShell, PageContainer, PageHeader, ActionBar } from "@/components/app-shell";
import {
  Field,
  FieldLabel,
  FieldHint,
  FieldError,
  Select,
  TextInput,
  StatusBanner,
  Panel,
  PanelHeader,
} from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { PhotoCapture, type CapturedPhoto } from "@/components/photo-capture";
import { postAction } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  MOCK_PRODUCTS,
  MOCK_USERS,
  MOCK_CATEGORIES,
  MOCK_LOCATIONS,
  MOCK_VENDORS,
  MOCK_APPROVERS,
  PRODUCT_TYPES,
  type ProductType,
} from "@/lib/mock-data";

// Mirrors CONFIG.ApprovalThreshold on the backend (apps-script/Setup.gs
// DEFAULT_CONFIG). Kept as a constant here rather than fetched, same stopgap
// as the rest of mock-data.ts — it only decides whether the form asks for an
// approver before submitting; the backend is the one that actually enforces it.
const APPROVAL_THRESHOLD = 5000;

// Custody sits here the moment Satvik receives it, before it is handed to
// Hitesh. Mirrors mock-data.ts MOCK_LOCATIONS "Receiving (Satvik)".
const RECEIVING_LOCATION_ID = "LOC-07";
const HITESH_USER_ID = "USR-006";

// Sentinel for "the product I need isn't in the list yet." Never sent to the
// backend as a productId — it switches the form into free-text mode instead.
const NEW_PRODUCT_VALUE = "__NEW__";

type Tab = "request" | "grn" | "handover";
type Banner = { tone: "success" | "error"; title: string; text: string } | null;
type DataSource = "demo" | "live";

interface RequestForm {
  productTypeId: ProductType | "";
  productId: string;
  newProductName: string;
  estimatedCost: string;
  qty: number;
  requestedByUserId: string;
  urgency: "Normal" | "Urgent";
  approvedBy: string;
  notes: string;
}

interface GrnForm {
  productId: string;
  qty: number;
  locationId: string;
  vendorId: string;
  categoryId: string;
  poId: string;
  invoiceNo: string;
  amount: string;
  receivedByUserId: string;
}

interface HandoverForm {
  productId: string;
  qty: number;
  toUserId: string;
  notes: string;
}

interface LoggedRequest {
  key: string;
  requestId?: string;
  product: string;
  qty: number;
  by: string;
  state: "pending" | "saved";
}

interface PendingHandover {
  handoverId: string;
  productId: string;
  productName: string;
  qty: number;
  uom: string;
  date: string;
  actor: string;
  notes?: string;
}

// List keys for optimistic rows. A plain counter rather than Date.now(): pure
// from React's point of view, and immune to two submits inside one millisecond.
let requestKeySeq = 0;
let demoHandoverSeq = 2;

const DEMO_REQUESTS: LoggedRequest[] = [
  {
    key: "demo-request-1",
    requestId: "DEMO-REQ-101",
    product: "Blue Tape",
    qty: 20,
    by: "Gauri",
    state: "saved",
  },
  {
    key: "demo-request-2",
    requestId: "DEMO-REQ-102",
    product: "Colour Tube 100ml",
    qty: 600,
    by: "Anita",
    state: "saved",
  },
  {
    key: "demo-request-3",
    requestId: "DEMO-REQ-103",
    product: "Kerastase Shampoo 250ml",
    qty: 6,
    by: "Daisy",
    state: "saved",
  },
];

const DEMO_RECEIVING_BALANCES: Record<string, number> = {
  "PRD-0004": 40,
  "PRD-0005": 250,
  "PRD-0015": 500,
  "PRD-0026": 600,
  "PRD-0028": 6,
};

const DEMO_PENDING_HANDOVERS: PendingHandover[] = [
  {
    handoverId: "DEMO-HND-001",
    productId: "PRD-0005",
    productName: "Scalp Protector Spray",
    qty: 100,
    uom: "ML",
    date: "2026-09-01",
    actor: "satvik@ahl.com",
    notes: "Counted and handed over at the stock room.",
  },
  {
    handoverId: "DEMO-HND-002",
    productId: "PRD-0028",
    productName: "Kerastase Shampoo 250ml",
    qty: 4,
    uom: "BTL",
    date: "2026-09-01",
    actor: "satvik@ahl.com",
    notes: "Retail stock for display and sale.",
  },
];

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: "request", label: "Log Request", hint: "From WhatsApp" },
  { id: "grn", label: "Receive Delivery", hint: "Goods receipt" },
  { id: "handover", label: "Handover", hint: "To Hitesh" },
];

interface IncomingRequest {
  requestId: string;
  productName: string;
  isNewProduct: boolean;
  qty: number;
  requestedBy: string;
  estValue: number;
  status: string;
  notes?: string;
}

/**
 * Hitesh has no purchasing authority — every request he raises lands
 * PENDING_APPROVAL (see processPurchaseRequest in apps-script/Ledger.gs) and
 * sits here until Satvik approves or rejects it. Nothing renders when there
 * is nothing waiting, so this never clutters the page on a normal day.
 */
function PendingApprovalsPanel({
  busy,
  setBusy,
  setBanner,
}: {
  busy: boolean;
  setBusy: (v: boolean) => void;
  setBanner: (b: Banner) => void;
}) {
  const [items, setItems] = useState<IncomingRequest[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await postAction<{ openRequests: IncomingRequest[] }>("dashboard.read", {});
    setLoading(false);
    if (result.ok) {
      setItems(result.data.openRequests.filter((r) => r.status === "PENDING_APPROVAL"));
    }
  }, []);

  const refresh = () => {
    setLoading(true);
    void load();
  };

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);

  const decide = async (requestId: string, decision: "APPROVE" | "REJECT") => {
    setBanner(null);
    setDecidingId(requestId);
    setBusy(true);
    const result = await postAction<{ status?: string }>("purchase.approve", {
      requestId,
      decision,
    });
    setBusy(false);
    setDecidingId(null);

    if (result.ok) {
      setItems((prev) => (prev ?? []).filter((r) => r.requestId !== requestId));
      setBanner({
        tone: "success",
        title: decision === "APPROVE" ? "Request approved" : "Request rejected",
        text:
          decision === "APPROVE"
            ? `${requestId} is now ${result.data?.status === "NEW_PRODUCT" ? "flagged as a new product" : "open"} for purchasing.`
            : `${requestId} was rejected and will not be purchased.`,
      });
    } else {
      setBanner({ tone: "error", title: result.error, text: result.message });
    }
  };

  if (!loading && items !== null && items.length === 0) return null;

  return (
    <Panel>
      <PanelHeader
        title="Waiting on your approval"
        description="From Hitesh — he can ask, but only you can approve a purchase."
        aside={
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </button>
        }
      />
      {items === null ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((r) => {
            const requester = MOCK_USERS.find((u) => u.id === r.requestedBy)?.name ?? r.requestedBy;
            const deciding = decidingId === r.requestId;
            return (
              <li key={r.requestId} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-foreground">
                    <span className="font-medium tabular">{r.qty}</span> × {r.productName}
                    {r.isNewProduct && (
                      <span className="ml-2 text-xs font-medium text-warning">New product</span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    from {requester}
                    {r.estValue ? ` · ~₹${Number(r.estValue).toLocaleString("en-IN")}` : ""}
                    {r.notes ? ` · ${r.notes}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => void decide(r.requestId, "REJECT")}
                    disabled={busy}
                  >
                    {deciding ? <Loader2 className="size-3.5 animate-spin" /> : "Reject"}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void decide(r.requestId, "APPROVE")}
                    disabled={busy}
                  >
                    {deciding ? <Loader2 className="size-3.5 animate-spin" /> : "Approve"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export default function PurchaseHub() {
  const [tab, setTab] = useState<Tab>("request");
  const [banner, setBanner] = useState<Banner>(null);
  const [dataSource, setDataSource] = useState<DataSource>("demo");

  // ------------------------------------------------------------ log request
  const requestForm = useForm<RequestForm>({
    defaultValues: {
      productTypeId: "Consumable",
      productId: "PRD-0004",
      newProductName: "",
      estimatedCost: "",
      qty: 20,
      requestedByUserId: "USR-012",
      urgency: "Urgent",
      approvedBy: "",
      notes: "WhatsApp request — salon floor stock is running low.",
    },
  });
  const [requestPending, setRequestPending] = useState(false);
  const [logged, setLogged] = useState<LoggedRequest[]>(DEMO_REQUESTS);

  const requestedTypeId = requestForm.watch("productTypeId");
  const requestedProductId = requestForm.watch("productId");
  const requestedQty = requestForm.watch("qty");
  const requestedEstimatedCost = requestForm.watch("estimatedCost");
  const isNewProduct = requestedProductId === NEW_PRODUCT_VALUE;
  const requestedProduct = isNewProduct
    ? undefined
    : MOCK_PRODUCTS.find((p) => p.id === requestedProductId);
  const requestedCategory = requestedProduct
    ? MOCK_CATEGORIES.find((c) => c.id === requestedProduct.categoryId)
    : undefined;
  const productsForType = requestedTypeId
    ? MOCK_PRODUCTS.filter((p) => p.productType === requestedTypeId)
    : MOCK_PRODUCTS;
  const estValue = requestedProduct
    ? (Number(requestedQty) || 0) * requestedProduct.cost
    : isNewProduct
      ? (Number(requestedQty) || 0) * (Number(requestedEstimatedCost) || 0)
      : 0;
  const needsApproval = estValue >= APPROVAL_THRESHOLD;

  const onSubmitRequest = async (values: RequestForm) => {
    setBanner(null);

    if (isNewProduct && !values.newProductName.trim()) {
      setBanner({
        tone: "error",
        title: "Name it",
        text: "Enter what the new product is called before logging the request.",
      });
      return;
    }

    if (needsApproval && !values.approvedBy) {
      setBanner({
        tone: "error",
        title: "Approval needed",
        text: `This comes to roughly ₹${estValue.toLocaleString("en-IN")} — record who approved it before logging.`,
      });
      return;
    }

    setRequestPending(true);

    const key = `req-${(requestKeySeq += 1)}`;
    const productLabel = isNewProduct
      ? `${values.newProductName} (new)`
      : (MOCK_PRODUCTS.find((p) => p.id === values.productId)?.name ?? values.productId);

    // Optimistic row so the floor never waits on Apps Script to feel progress.
    setLogged((prev) =>
      [
        {
          key,
          product: productLabel,
          qty: Number(values.qty),
          by:
            MOCK_USERS.find((u) => u.id === values.requestedByUserId)?.name ??
            values.requestedByUserId,
          state: "pending" as const,
        },
        ...prev,
      ].slice(0, 6)
    );

    if (dataSource === "demo") {
      setRequestPending(false);
      setLogged((prev) =>
        prev.map((request) =>
          request.key === key
            ? {
                ...request,
                state: "saved" as const,
                requestId: `DEMO-REQ-${104 + requestKeySeq}`,
              }
            : request
        )
      );
      setBanner({
        tone: "success",
        title: "Demo request logged",
        text: "The sample request was added locally. No Google Sheet data was changed.",
      });
      requestForm.reset();
      return;
    }

    const result = await postAction<{ requestId?: string; approvedBy?: string; status?: string }>(
      "purchase.request",
      {
        productId: isNewProduct ? undefined : values.productId,
        newProductName: isNewProduct ? values.newProductName.trim() : undefined,
        qty: Number(values.qty),
        requestedByUserId: values.requestedByUserId,
        urgency: values.urgency,
        approvedBy: values.approvedBy || undefined,
        estimatedValue: estValue || undefined,
        notes: values.notes,
      }
    );

    setRequestPending(false);

    if (result.ok) {
      setLogged((prev) =>
        prev.map((r) =>
          r.key === key
            ? { ...r, state: "saved" as const, requestId: result.data?.requestId }
            : r
        )
      );
      setBanner({
        tone: "success",
        title: "Request logged",
        text:
          result.data?.status === "NEW_PRODUCT"
            ? "Flagged as a new product — it needs adding to the catalogue before it can be ordered."
            : result.data?.approvedBy
              ? `Recorded as approved by ${result.data.approvedBy}.`
              : "Added to the purchase queue.",
      });
      requestForm.reset();
    } else {
      // Roll back so the list never shows a write that did not land.
      setLogged((prev) => prev.filter((r) => r.key !== key));
      setBanner({ tone: "error", title: result.error, text: result.message });
    }
  };

  // -------------------------------------------------------------------- GRN
  const grnForm = useForm<GrnForm>({
    defaultValues: {
      productId: "PRD-0015",
      qty: 500,
      locationId: RECEIVING_LOCATION_ID,
      vendorId: "VND-01",
      categoryId: "CAT-02",
      poId: "PO-DEMO-1042",
      invoiceNo: "INV-DEMO-88213",
      amount: "12500",
      receivedByUserId: "",
    },
  });
  const [billPhoto, setBillPhoto] = useState<CapturedPhoto | null>(null);
  const [productPhoto, setProductPhoto] = useState<CapturedPhoto | null>(null);
  const [grnPending, setGrnPending] = useState(false);

  const onSubmitGrn = async (values: GrnForm) => {
    setBanner(null);
    if (!billPhoto) {
      setBanner({
        tone: "error",
        title: "Bill photo required",
        text: "Capture the physical bill before confirming the receipt.",
      });
      return;
    }

    setGrnPending(true);
    if (dataSource === "demo") {
      const receivedQty = Number(values.qty);
      setReceivingBalances((current) => ({
        ...(current ?? {}),
        [values.productId]: (current?.[values.productId] ?? 0) + receivedQty,
      }));
      setGrnPending(false);
      setBanner({
        tone: "success",
        title: "Demo stock received",
        text: `${receivedQty} units were added to Satvik's demo Receiving stock. No Google Sheet data was changed.`,
      });
      setBillPhoto(null);
      setProductPhoto(null);
      return;
    }

    const result = await postAction<{ txnId?: string }>("stock.receive", {
      productId: values.productId,
      qty: Number(values.qty),
      locationId: values.locationId,
      categoryId: values.categoryId || undefined,
      vendorId: values.vendorId || undefined,
      poId: values.poId || undefined,
      invoiceNo: values.invoiceNo || undefined,
      amount: values.amount ? Number(values.amount) : undefined,
      receivedByUserId: values.receivedByUserId || undefined,
      photo: {
        base64: billPhoto.base64,
        mimeType: billPhoto.mimeType,
        fileName: billPhoto.fileName,
        sizeBytes: billPhoto.sizeBytes,
      },
      productPhoto: productPhoto
        ? {
            base64: productPhoto.base64,
            mimeType: productPhoto.mimeType,
            fileName: productPhoto.fileName,
            sizeBytes: productPhoto.sizeBytes,
          }
        : undefined,
    });
    setGrnPending(false);

    if (result.ok) {
      setBanner({
        tone: "success",
        title: "Stock received",
        text: `${result.data?.txnId ?? "Transaction"} recorded, sitting in Receiving until handed to Hitesh.`,
      });
      grnForm.reset({
        productId: "",
        qty: 1,
        locationId: RECEIVING_LOCATION_ID,
        vendorId: "",
        categoryId: "",
        poId: "",
        invoiceNo: "",
        amount: "",
        receivedByUserId: "",
      });
      setBillPhoto(null);
      setProductPhoto(null);
    } else {
      setBanner({ tone: "error", title: result.error, text: result.message });
    }
  };

  // --------------------------------------------------------------- handover
  const handoverForm = useForm<HandoverForm>({
    defaultValues: {
      productId: "PRD-0004",
      qty: 20,
      toUserId: HITESH_USER_ID,
      notes: "Counted and handed over in person.",
    },
  });
  const [handoverPending, setHandoverPending] = useState(false);
  const [pendingHandovers, setPendingHandovers] = useState<PendingHandover[] | null>(
    DEMO_PENDING_HANDOVERS
  );
  const [pendingLoading, setPendingLoading] = useState(false);

  const loadPendingHandovers = useCallback(async () => {
    setPendingLoading(true);
    const result = await postAction<PendingHandover[]>("handover.list", {});
    setPendingLoading(false);
    if (result.ok) setPendingHandovers(result.data ?? []);
  }, []);

  // What's actually sitting in Receiving, live from the ledger -- so Satvik
  // can see what there is to hand over before he tries, not just find out
  // via an INSUFFICIENT_STOCK rejection after submitting.
  const [receivingBalances, setReceivingBalances] = useState<Record<string, number> | null>(
    DEMO_RECEIVING_BALANCES
  );
  const loadReceivingBalances = useCallback(async () => {
    const result = await postAction<{
      stock: { productId: string; receivingBalance: number; receivingAvailable?: number }[];
    }>(
      "dashboard.read",
      {}
    );
    if (result.ok) {
      const next: Record<string, number> = {};
      result.data.stock.forEach((s) => {
        next[s.productId] = s.receivingAvailable ?? s.receivingBalance;
      });
      setReceivingBalances(next);
      setDataSource("live");
      setBanner({
        tone: "success",
        title: "Live Receiving stock loaded",
        text: "Satvik's handover form now uses the Google Sheet ledger.",
      });
    } else {
      setDataSource("demo");
      setBanner({
        tone: "error",
        title: "Live data unavailable",
        text: "Satvik's demo records are still active. No Google Sheet data will be changed.",
      });
    }
  }, []);

  const handoverProductId = handoverForm.watch("productId");
  const receivingBalanceForSelected =
    handoverProductId && receivingBalances ? (receivingBalances[handoverProductId] ?? 0) : null;

  const onSubmitHandover = async (values: HandoverForm) => {
    setBanner(null);
    setHandoverPending(true);

    if (dataSource === "demo") {
      const available = receivingBalances?.[values.productId] ?? 0;
      const qty = Number(values.qty);
      if (qty > available) {
        setHandoverPending(false);
        setBanner({
          tone: "error",
          title: "Not enough demo stock",
          text: `Only ${available} are sitting in Receiving.`,
        });
        return;
      }

      const product = MOCK_PRODUCTS.find((item) => item.id === values.productId);
      demoHandoverSeq += 1;
      const handoverId = `DEMO-HND-${String(demoHandoverSeq).padStart(3, "0")}`;
      setReceivingBalances((current) => ({
        ...(current ?? {}),
        [values.productId]: Math.max(0, (current?.[values.productId] ?? 0) - qty),
      }));
      setPendingHandovers((current) => [
        {
          handoverId,
          productId: values.productId,
          productName: product?.name ?? values.productId,
          qty,
          uom: product?.uom ?? "UNIT",
          date: "2026-09-01",
          actor: "satvik@ahl.com",
          notes: values.notes,
        },
        ...(current ?? []),
      ]);
      setHandoverPending(false);
      setBanner({
        tone: "success",
        title: "Demo handover logged",
        text: `${handoverId} is ready to explain as Hitesh's pending confirmation. No Google Sheet data was changed.`,
      });
      handoverForm.reset({ productId: "", qty: 1, toUserId: HITESH_USER_ID, notes: "" });
      return;
    }

    const result = await postAction<{ handoverId?: string }>("stock.handover", {
      productId: values.productId,
      qty: Number(values.qty),
      toUserId: values.toUserId,
      notes: values.notes || undefined,
    });

    setHandoverPending(false);

    if (result.ok) {
      setBanner({
        tone: "success",
        title: "Handed over",
        text: `${result.data?.handoverId ?? "Handover"} logged — waiting for Hitesh to confirm his recount.`,
      });
      handoverForm.reset({ productId: "", qty: 1, toUserId: HITESH_USER_ID, notes: "" });
      void loadPendingHandovers();
      void loadReceivingBalances();
    } else {
      setBanner({ tone: "error", title: result.error, text: result.message });
    }
  };

  const busy = requestPending || grnPending || handoverPending;
  const requestErrors = requestForm.formState.errors;
  const grnErrors = grnForm.formState.errors;
  const handoverErrors = handoverForm.formState.errors;

  return (
    <AppShell>
      <PageContainer>
        <PageHeader
          title="Purchase Hub"
          description="Log what the floor asks for, record deliveries, and hand stock over to Hitesh."
        />

        {dataSource === "demo" && (
          <div className="mb-5">
            <StatusBanner tone="info" title="Satvik demo data">
              Sample requests, delivery details and Receiving stock are loaded locally. Demo
              actions do not change Google Sheets.
            </StatusBanner>
          </div>
        )}

        {/* Segmented control. Three moments of one job, not three destinations. */}
        <div
          role="tablist"
          className="inline-flex w-full rounded-lg border border-border bg-muted p-1 sm:w-auto"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "flex-1 rounded-md px-4 py-2 text-sm font-medium transition-all sm:flex-none",
                tab === t.id
                  ? "bg-card text-foreground shadow-[0_1px_2px_0_rgb(0_0_0/0.06)]"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
              <span className="ml-2 hidden text-xs font-normal text-muted-foreground sm:inline">
                {t.hint}
              </span>
            </button>
          ))}
        </div>

        {banner && (
          <div className="mt-5">
            <StatusBanner tone={banner.tone} title={banner.title}>
              {banner.text}
            </StatusBanner>
          </div>
        )}

        {tab === "request" ? (
          <div className="mt-5 space-y-5 pb-8">
            <PendingApprovalsPanel
              busy={requestPending}
              setBusy={setRequestPending}
              setBanner={setBanner}
            />
            <Panel>
              <PanelHeader
                title="New request"
                description="Captured from a WhatsApp message or a call from the floor."
                aside={<span className="text-xs font-medium text-brand">Sample filled</span>}
              />
              <div className="space-y-5 p-5">
                <Field>
                  <FieldLabel step={1} htmlFor="req-type">
                    Product type
                  </FieldLabel>
                  <Select
                    id="req-type"
                    disabled={busy}
                    {...requestForm.register("productTypeId", {
                      onChange: () => requestForm.setValue("productId", ""),
                    })}
                  >
                    <option value="">All types…</option>
                    {PRODUCT_TYPES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                  <FieldHint>Narrows the product list below. Leave blank to see everything.</FieldHint>
                </Field>

                <Field>
                  <FieldLabel step={2} htmlFor="req-product">
                    What was asked for
                  </FieldLabel>
                  <Select
                    id="req-product"
                    disabled={busy}
                    aria-invalid={!!requestErrors.productId}
                    {...requestForm.register("productId", { required: "Pick a product" })}
                  >
                    <option value="">Select a product…</option>
                    {productsForType.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                    <option value={NEW_PRODUCT_VALUE}>+ Something else (new product)</option>
                  </Select>
                  <FieldError>{requestErrors.productId?.message}</FieldError>
                  {requestedCategory && (
                    <FieldHint>Category: {requestedCategory.name}</FieldHint>
                  )}
                </Field>

                {isNewProduct && (
                  <div className="space-y-4 rounded-lg border border-dashed border-border bg-muted/30 p-4">
                    <div className="grid gap-5 sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="req-new-name">New product name</FieldLabel>
                        <TextInput
                          id="req-new-name"
                          placeholder="e.g. Silicone Scalp Base"
                          disabled={busy}
                          {...requestForm.register("newProductName", {
                            required: isNewProduct ? "Name the new product" : false,
                          })}
                        />
                        <FieldError>{requestErrors.newProductName?.message}</FieldError>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="req-new-cost" optional>
                          Estimated cost each (₹)
                        </FieldLabel>
                        <TextInput
                          id="req-new-cost"
                          type="number"
                          min={0}
                          inputMode="decimal"
                          placeholder="Rough guess is fine"
                          disabled={busy}
                          {...requestForm.register("estimatedCost")}
                        />
                      </Field>
                    </div>
                    <FieldHint>
                      This won&apos;t be orderable until it&apos;s added to the catalogue with a real
                      unit and cost — this just flags that it&apos;s needed.
                    </FieldHint>
                  </div>
                )}

                <div className="grid gap-5 sm:grid-cols-2">
                  <Field>
                    <FieldLabel step={3} htmlFor="req-qty">
                      Quantity
                    </FieldLabel>
                    <TextInput
                      id="req-qty"
                      type="number"
                      min={1}
                      inputMode="numeric"
                      disabled={busy}
                      aria-invalid={!!requestErrors.qty}
                      {...requestForm.register("qty", {
                        valueAsNumber: true,
                        required: "Enter a quantity",
                        min: { value: 1, message: "Must be at least 1" },
                      })}
                    />
                    <FieldError>{requestErrors.qty?.message}</FieldError>
                  </Field>

                  <Field>
                    <FieldLabel step={4} htmlFor="req-by">
                      Requested by
                    </FieldLabel>
                    <Select
                      id="req-by"
                      disabled={busy}
                      aria-invalid={!!requestErrors.requestedByUserId}
                      {...requestForm.register("requestedByUserId", {
                        required: "Pick who asked",
                      })}
                    >
                      <option value="">Select staff…</option>
                      {MOCK_USERS.filter((u) => u.role !== "Approver").map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name} · {u.role}
                        </option>
                      ))}
                    </Select>
                    <FieldError>{requestErrors.requestedByUserId?.message}</FieldError>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="req-urgency">Urgency</FieldLabel>
                    <Select
                      id="req-urgency"
                      disabled={busy}
                      {...requestForm.register("urgency")}
                    >
                      <option value="Normal">Normal</option>
                      <option value="Urgent">Urgent — stock is low or finished</option>
                    </Select>
                  </Field>
                </div>

                {needsApproval && (
                  <Field>
                    <FieldLabel htmlFor="req-approved-by">Approved by</FieldLabel>
                    <Select
                      id="req-approved-by"
                      disabled={busy}
                      aria-invalid={!!requestErrors.approvedBy}
                      {...requestForm.register("approvedBy", {
                        required: "Over ₹5,000 needs a name here before it can be logged",
                      })}
                    >
                      <option value="">Select who signed off…</option>
                      {MOCK_APPROVERS.map((a) => (
                        <option key={a.id} value={a.name}>
                          {a.name}
                        </option>
                      ))}
                    </Select>
                    <FieldError>{requestErrors.approvedBy?.message}</FieldError>
                    <FieldHint>
                      Roughly ₹{estValue.toLocaleString("en-IN")} — over ₹5,000, so record who
                      already said yes.
                    </FieldHint>
                  </Field>
                )}

                <Field>
                  <FieldLabel htmlFor="req-notes">
                    Reason / where it will be used
                  </FieldLabel>
                  <TextInput
                    id="req-notes"
                    placeholder="e.g. Salon floor stock finished"
                    disabled={busy}
                    aria-invalid={!!requestErrors.notes}
                    {...requestForm.register("notes", {
                      required: "Add a short reason for the request",
                      minLength: { value: 3, message: "Add a short reason" },
                    })}
                  />
                  <FieldError>{requestErrors.notes?.message}</FieldError>
                  {!needsApproval && (
                    <FieldHint>
                      Requests above ₹5,000 will ask for an approver&apos;s name above.
                    </FieldHint>
                  )}
                </Field>
              </div>
            </Panel>

            {logged.length > 0 && (
              <Panel>
                <PanelHeader
                  title="Logged this session"
                  aside={
                    <span className="text-xs text-muted-foreground tabular">
                      {logged.length}
                    </span>
                  }
                />
                <ul className="divide-y divide-border">
                  {logged.map((r) => (
                    <li
                      key={r.key}
                      className="flex items-center justify-between gap-3 px-5 py-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm text-foreground">
                          <span className="font-medium tabular">{r.qty}</span>
                          <span className="mx-1.5 text-muted-foreground">×</span>
                          {r.product}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          for {r.by}
                          {r.requestId && (
                            <span className="id-text ml-2 text-muted-foreground">
                              {r.requestId}
                            </span>
                          )}
                        </p>
                      </div>
                      {r.state === "pending" ? (
                        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                      ) : (
                        <Check className="size-4 shrink-0 text-success" />
                      )}
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
          </div>
        ) : tab === "grn" ? (
          <div className="mt-5 space-y-5 pb-8">
            <Panel>
              <PanelHeader
                title="Goods receipt"
                description="Check the delivery against the bill, then record it."
                aside={<span className="text-xs font-medium text-brand">Sample filled</span>}
              />
              <div className="space-y-5 p-5">
                <Field>
                  <FieldLabel step={1} htmlFor="grn-product">
                    What arrived
                  </FieldLabel>
                  <Select
                    id="grn-product"
                    disabled={busy}
                    aria-invalid={!!grnErrors.productId}
                    {...grnForm.register("productId", { required: "Pick a product" })}
                  >
                    <option value="">Select a product…</option>
                    {MOCK_PRODUCTS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                  <FieldError>{grnErrors.productId?.message}</FieldError>
                </Field>

                <div className="grid gap-5 sm:grid-cols-2">
                  <Field>
                    <FieldLabel step={2} htmlFor="grn-qty">
                      Quantity received
                    </FieldLabel>
                    <TextInput
                      id="grn-qty"
                      type="number"
                      min={1}
                      inputMode="numeric"
                      disabled={busy}
                      aria-invalid={!!grnErrors.qty}
                      {...grnForm.register("qty", {
                        valueAsNumber: true,
                        required: "Enter a quantity",
                        min: { value: 1, message: "Must be at least 1" },
                      })}
                    />
                    <FieldError>{grnErrors.qty?.message}</FieldError>
                  </Field>

                  <Field>
                    <FieldLabel step={3} htmlFor="grn-location">
                      Store into
                    </FieldLabel>
                    <Select
                      id="grn-location"
                      disabled={busy}
                      aria-invalid={!!grnErrors.locationId}
                      {...grnForm.register("locationId", { required: "Pick a location" })}
                    >
                      {MOCK_LOCATIONS.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </Select>
                    <FieldHint>Defaults to Receiving — hand it to Hitesh next.</FieldHint>
                  </Field>

                  <Field>
                    <FieldLabel step={4} htmlFor="grn-vendor">
                      Vendor
                    </FieldLabel>
                    <Select id="grn-vendor" disabled={busy} {...grnForm.register("vendorId")}>
                      <option value="">Select vendor…</option>
                      {MOCK_VENDORS.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </Select>
                    <FieldHint>Recorded against the product so vendor rates build up over time.</FieldHint>
                  </Field>

                  <Field>
                    <FieldLabel step={5} htmlFor="grn-category" optional>
                      Category
                    </FieldLabel>
                    <Select
                      id="grn-category"
                      disabled={busy}
                      {...grnForm.register("categoryId")}
                    >
                      <option value="">Unallocated</option>
                      {MOCK_CATEGORIES.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                    <FieldHint>Can be assigned later during the P&amp;L review.</FieldHint>
                  </Field>
                </div>

                <div className="grid gap-5 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="grn-po" optional>
                      PO number
                    </FieldLabel>
                    <TextInput
                      id="grn-po"
                      placeholder="PO-1042"
                      disabled={busy}
                      {...grnForm.register("poId")}
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="grn-invoice" optional>
                      Invoice number
                    </FieldLabel>
                    <TextInput
                      id="grn-invoice"
                      placeholder="INV-88213"
                      disabled={busy}
                      {...grnForm.register("invoiceNo")}
                    />
                    <FieldHint>
                      If this delivery only fills part of the invoice, the rest can be
                      received later against the same number.
                    </FieldHint>
                  </Field>
                </div>

                <div className="grid gap-5 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="grn-amount" optional>
                      Bill amount (₹)
                    </FieldLabel>
                    <TextInput
                      id="grn-amount"
                      type="number"
                      min={0}
                      step="0.01"
                      inputMode="decimal"
                      placeholder="As printed on the bill"
                      disabled={busy}
                      {...grnForm.register("amount")}
                    />
                    <FieldHint>What was actually paid — feeds vendor price history.</FieldHint>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="grn-received-by" optional>
                      Received by
                    </FieldLabel>
                    <Select
                      id="grn-received-by"
                      disabled={busy}
                      {...grnForm.register("receivedByUserId")}
                    >
                      <option value="">Satvik (self)</option>
                      {MOCK_USERS.filter((u) => u.id !== "USR-005" && u.role !== "Approver").map(
                        (u) => (
                          <option key={u.id} value={u.id}>
                            {u.name} · {u.role}
                          </option>
                        )
                      )}
                    </Select>
                    <FieldHint>Only if someone stood in for Satvik on this delivery.</FieldHint>
                  </Field>
                </div>
              </div>
            </Panel>

            <Panel>
              <PanelHeader
                title="Bill photo"
                description="Required. Filed to Drive and linked on the ledger row."
                aside={
                  billPhoto ? (
                    <span className="flex items-center gap-1.5 text-xs font-medium text-success">
                      <Check className="size-3.5" />
                      Attached
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">Not attached</span>
                  )
                }
              />
              <div className="p-5">
                <PhotoCapture onCapture={setBillPhoto} disabled={busy} label="" />
              </div>
            </Panel>

            <Panel>
              <PanelHeader
                title="Product photo"
                description="Recommended — a photo of what actually showed up, next to the bill."
                aside={
                  productPhoto ? (
                    <span className="flex items-center gap-1.5 text-xs font-medium text-success">
                      <Check className="size-3.5" />
                      Attached
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">Not attached</span>
                  )
                }
              />
              <div className="p-5">
                <PhotoCapture
                  onCapture={setProductPhoto}
                  disabled={busy}
                  label=""
                  targetBytes={500 * 1024}
                />
              </div>
            </Panel>
          </div>
        ) : (
          <div className="mt-5 space-y-5 pb-8">
            <Panel>
              <PanelHeader
                title="Hand over to Hitesh"
                description="Stock leaves Receiving and moves into Hitesh's custody. He confirms it after his own recount."
                aside={
                  <button
                    type="button"
                    onClick={() => void loadReceivingBalances()}
                    className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    <RefreshCw className="size-3.5" />
                    {dataSource === "demo" ? "Load live stock" : "Refresh"}
                  </button>
                }
              />
              <div className="space-y-5 p-5">
                <Field>
                  <FieldLabel step={1} htmlFor="ho-product">
                    Product
                  </FieldLabel>
                  <Select
                    id="ho-product"
                    disabled={busy}
                    aria-invalid={!!handoverErrors.productId}
                    {...handoverForm.register("productId", { required: "Pick a product" })}
                  >
                    <option value="">Select a product…</option>
                    {MOCK_PRODUCTS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                  <FieldError>{handoverErrors.productId?.message}</FieldError>
                  {handoverProductId && (
                    <FieldHint>
                      {receivingBalanceForSelected === null
                        ? "Loading what's in Receiving…"
                        : `${receivingBalanceForSelected} sitting in Receiving right now.`}
                    </FieldHint>
                  )}
                </Field>

                <div className="grid gap-5 sm:grid-cols-2">
                  <Field>
                    <FieldLabel step={2} htmlFor="ho-qty">
                      Quantity
                    </FieldLabel>
                    <TextInput
                      id="ho-qty"
                      type="number"
                      min={1}
                      inputMode="numeric"
                      disabled={busy}
                      aria-invalid={!!handoverErrors.qty}
                      {...handoverForm.register("qty", {
                        valueAsNumber: true,
                        required: "Enter a quantity",
                        min: { value: 1, message: "Must be at least 1" },
                      })}
                    />
                    <FieldError>{handoverErrors.qty?.message}</FieldError>
                  </Field>

                  <Field>
                    <FieldLabel step={3} htmlFor="ho-to">
                      Handing over to
                    </FieldLabel>
                    <Select
                      id="ho-to"
                      disabled={busy}
                      aria-invalid={!!handoverErrors.toUserId}
                      {...handoverForm.register("toUserId", { required: "Pick who is taking custody" })}
                    >
                      {MOCK_USERS.filter((u) => u.role === "Distribution").map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </Select>
                    <FieldError>{handoverErrors.toUserId?.message}</FieldError>
                  </Field>
                </div>

                <Field>
                  <FieldLabel htmlFor="ho-notes" optional>
                    Notes
                  </FieldLabel>
                  <TextInput
                    id="ho-notes"
                    placeholder="Handed over in person, 3 boxes…"
                    disabled={busy}
                    {...handoverForm.register("notes")}
                  />
                </Field>

                <Button
                  size="lg"
                  onClick={() => void handoverForm.handleSubmit(onSubmitHandover)()}
                  disabled={busy}
                  className="h-12 w-full text-[0.9375rem] font-semibold"
                >
                  {handoverPending ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Recording…
                    </>
                  ) : (
                    <>
                      <Send className="size-4" />
                      Log handover
                    </>
                  )}
                </Button>
              </div>
            </Panel>

            <Panel>
              <PanelHeader
                title="Awaiting Hitesh's confirmation"
                description="Everyone's, not just yours — this is the same queue he sees on Stock Out."
                aside={
                  <button
                    type="button"
                    onClick={() => void loadPendingHandovers()}
                    disabled={pendingLoading}
                    className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    <RefreshCw className={cn("size-3.5", pendingLoading && "animate-spin")} />
                    Refresh
                  </button>
                }
              />
              {pendingHandovers === null ? (
                <p className="px-5 py-6 text-sm text-muted-foreground">Loading…</p>
              ) : pendingHandovers.length === 0 ? (
                <p className="px-5 py-6 text-sm text-muted-foreground">
                  Nothing outstanding — everything handed over has been confirmed.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {pendingHandovers.map((h) => (
                    <li key={h.handoverId} className="px-5 py-3.5">
                      <div className="flex items-center justify-between gap-3">
                        <p className="truncate text-sm text-foreground">
                          <span className="font-medium tabular">{h.qty}</span>
                          <span className="mx-1.5 text-muted-foreground">{h.uom}</span>·{" "}
                          {h.productName}
                        </p>
                        <span className="id-text shrink-0 text-xs text-muted-foreground">
                          {h.handoverId}
                        </span>
                      </div>
                      {h.notes && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{h.notes}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        )}
      </PageContainer>

      <ActionBar>
        {tab === "request" ? (
          <Button
            size="lg"
            onClick={() => void requestForm.handleSubmit(onSubmitRequest)()}
            disabled={busy}
            className="h-12 w-full text-[0.9375rem] font-semibold"
          >
            {requestPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Logging request…
              </>
            ) : (
              "Log request"
            )}
          </Button>
        ) : tab === "grn" ? (
          <div className="flex items-center gap-3">
            <div className="hidden min-w-0 flex-1 sm:block">
              <p className="truncate text-xs text-muted-foreground">
                {billPhoto
                  ? "Bill attached — ready to record."
                  : "Attach the bill photo to continue."}
              </p>
            </div>
            <Button
              size="lg"
              onClick={() => void grnForm.handleSubmit(onSubmitGrn)()}
              disabled={busy || !billPhoto}
              className="h-12 w-full text-[0.9375rem] font-semibold sm:w-auto sm:px-8"
            >
              {grnPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Recording…
                </>
              ) : (
                <>
                  <Package className="size-4" />
                  Confirm receipt
                </>
              )}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Use the button above the form to log a handover.
          </p>
        )}
      </ActionBar>
    </AppShell>
  );
}
