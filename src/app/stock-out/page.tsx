"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Check, Loader2, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import { IssueStockSchema, type IssueStock } from "@/lib/schemas/domain";
import {
  MOCK_PRODUCTS,
  MOCK_CATEGORIES,
  MOCK_USERS,
  DEFAULT_LOCATION_ID,
  SALON_FLOOR_LOCATION_ID,
  PRODUCT_TYPES,
  type ProductType,
} from "@/lib/mock-data";
import { OpeningStockPanel } from "@/components/workflow-panels";
import { AppShell, PageContainer, PageHeader, ActionBar } from "@/components/app-shell";
import {
  Field,
  FieldLabel,
  FieldError,
  Select,
  TextInput,
  StatusBanner,
  Panel,
  PanelHeader,
} from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { postAction } from "@/lib/api-client";
import { cn } from "@/lib/utils";

type Banner = { tone: "success" | "error"; title: string; text: string } | null;
type StockOutTab = "issue" | "confirm" | "request" | "opening";

// Sentinel for "the product I need isn't in the list yet." Never sent to the
// backend as a productId — it switches the request form into free-text mode.
const NEW_PRODUCT_VALUE = "__NEW__";

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

interface StockBalanceRow {
  productId: string;
  custodyBalance: number;
}

interface DashboardStockOnly {
  stock: StockBalanceRow[];
}

type BalanceSource = "demo" | "live";

let requestKeySeq = 0;

// Hitesh has no purchasing authority, so his own request always names
// himself as requester — there is nobody else for him to pick.
const HITESH_USER_ID = "USR-006";

const STOCK_OUT_TABS: { id: StockOutTab; label: string; hint: string }[] = [
  { id: "issue", label: "Issue Stock", hint: "To technicians" },
  { id: "confirm", label: "Confirm Handovers", hint: "From Satvik" },
  { id: "request", label: "Request Stock", hint: "Needs Satvik's approval" },
  { id: "opening", label: "Opening Stock", hint: "First-time count" },
];

function ConfirmHandoversPanel({
  busy,
  setBusy,
  setBanner,
}: {
  busy: boolean;
  setBusy: (v: boolean) => void;
  setBanner: (b: Banner) => void;
}) {
  const [pending, setPending] = useState<PendingHandover[] | null>(null);
  const [dataSource, setDataSource] = useState<BalanceSource>("demo");
  const [loading, setLoading] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [notesById, setNotesById] = useState<Record<string, string>>({});
  const [countedById, setCountedById] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const result = await postAction<PendingHandover[]>("handover.list", {});
    setLoading(false);
    if (result.ok) {
      setPending(result.data ?? []);
      setDataSource("live");
      setBanner({
        tone: "success",
        title: "Live handovers loaded",
        text: "This queue now matches the Google Sheet ledger.",
      });
    } else {
      setPending([]);
      setDataSource("demo");
      setBanner({
        tone: "error",
        title: "Live handovers unavailable",
        text: "Confirmation is disabled until the live ledger is available.",
      });
    }
  }, [setBanner]);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const confirm = async (handoverId: string) => {
    setBanner(null);
    const handover = pending?.find((item) => item.handoverId === handoverId);
    const countedInput = countedById[handoverId];
    const countedQty = Number(countedInput ?? 0);

    // The count field starts empty on purpose -- this is a recount, not a
    // rubber stamp, so it must never silently fall back to the expected qty.
    if (!handover || !countedInput || countedQty <= 0) {
      setBanner({
        tone: "error",
        title: "Enter your count",
        text: "Count the physical stock and enter the quantity before confirming.",
      });
      return;
    }

    setConfirmingId(handoverId);
    setBusy(true);

    if (dataSource === "demo") {
      setBusy(false);
      setConfirmingId(null);
      setBanner({
        tone: "error",
        title: "Live ledger required",
        text: "Refresh and reconnect before confirming stock.",
      });
      return;
    }

    const result = await postAction<{ rowsConfirmed?: number }>("stock.confirmHandover", {
      handoverId,
      countedQty,
      notes: notesById[handoverId] || undefined,
    });

    setBusy(false);
    setConfirmingId(null);

    if (result.ok) {
      setBanner({
        tone: "success",
        title: "Handover confirmed",
        text: `${handoverId} is now in your custody.`,
      });
      setPending((prev) => (prev ?? []).filter((h) => h.handoverId !== handoverId));
    } else {
      setBanner({ tone: "error", title: result.error, text: result.message });
    }
  };

  return (
    <Panel>
      <PanelHeader
        title="Waiting on your recount"
        description="Confirm only after counting the physical stock yourself — not a rubber stamp."
        aside={
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            {dataSource === "demo" ? "Load live handovers" : "Refresh"}
          </button>
        }
      />
      {pending === null ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">Loading…</p>
      ) : pending.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">
          Nothing waiting — you are caught up with everything Satvik has handed over.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {pending.map((h) => (
            <li key={h.handoverId} className="space-y-3 px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    <span className="tabular">{h.qty}</span> {h.uom} · {h.productName}
                  </p>
                  <p className="text-xs text-muted-foreground">from {h.actor}</p>
                </div>
                <span className="id-text shrink-0 text-xs text-muted-foreground">
                  {h.handoverId}
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-[8rem_1fr_auto]">
                <TextInput
                  aria-label={`Physical count for ${h.productName}`}
                  type="number"
                  min={0.01}
                  step={h.uom === "PCS" || h.uom === "BTL" || h.uom === "ROLL" ? 1 : 0.01}
                  inputMode="decimal"
                  placeholder={`${h.qty} expected`}
                  value={countedById[h.handoverId] ?? ""}
                  onChange={(e) =>
                    setCountedById((prev) => ({ ...prev, [h.handoverId]: e.target.value }))
                  }
                  disabled={busy}
                  className="h-9 tabular"
                />
                <TextInput
                  aria-label={`Confirmation note for ${h.productName}`}
                  placeholder="Optional note"
                  value={notesById[h.handoverId] ?? ""}
                  onChange={(e) =>
                    setNotesById((prev) => ({ ...prev, [h.handoverId]: e.target.value }))
                  }
                  disabled={busy}
                  className="h-9"
                />
                <Button
                  size="sm"
                  onClick={() => void confirm(h.handoverId)}
                  disabled={busy || dataSource !== "live"}
                  className="h-9 shrink-0"
                >
                  {confirmingId === h.handoverId ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Check className="size-3.5" />
                  )}
                  Confirm
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

interface RequestForm {
  productTypeId: ProductType | "";
  productId: string;
  newProductName: string;
  qty: number;
  urgency: "Normal" | "Urgent";
  notes: string;
}

interface SentRequest {
  key: string;
  product: string;
  qty: number;
  state: "pending" | "saved";
}

function RequestPanel({
  busy,
  setBusy,
  setBanner,
}: {
  busy: boolean;
  setBusy: (v: boolean) => void;
  setBanner: (b: Banner) => void;
}) {
  const requestForm = useForm<RequestForm>({
    defaultValues: {
      productTypeId: "",
      productId: "",
      newProductName: "",
      qty: 1,
      urgency: "Normal",
      notes: "",
    },
  });
  const [sent, setSent] = useState<SentRequest[]>([]);

  const errors = requestForm.formState.errors;
  const productTypeId = requestForm.watch("productTypeId");
  const productId = requestForm.watch("productId");
  const isNewProduct = productId === NEW_PRODUCT_VALUE;
  const productsForType = productTypeId
    ? MOCK_PRODUCTS.filter((p) => p.productType === productTypeId)
    : MOCK_PRODUCTS;

  const onSubmit = async (values: RequestForm) => {
    setBanner(null);

    if (isNewProduct && !values.newProductName.trim()) {
      setBanner({
        tone: "error",
        title: "Name it",
        text: "Enter what the new product is called before sending the request.",
      });
      return;
    }

    setBusy(true);
    const key = `hitesh-req-${(requestKeySeq += 1)}`;
    const productLabel = isNewProduct
      ? `${values.newProductName} (new)`
      : (MOCK_PRODUCTS.find((p) => p.id === values.productId)?.name ?? values.productId);

    // Optimistic row so Hitesh sees the request land before Apps Script replies.
    setSent((prev) =>
      [{ key, product: productLabel, qty: Number(values.qty), state: "pending" as const }, ...prev].slice(0, 6)
    );

    const result = await postAction<{ requestId?: string; status?: string }>("purchase.request", {
      productId: isNewProduct ? undefined : values.productId,
      newProductName: isNewProduct ? values.newProductName.trim() : undefined,
      qty: Number(values.qty),
      requestedByUserId: HITESH_USER_ID,
      urgency: values.urgency,
      notes: values.notes,
      source: "APP",
    });

    setBusy(false);

    if (result.ok) {
      setSent((prev) => prev.map((r) => (r.key === key ? { ...r, state: "saved" as const } : r)));
      setBanner({
        tone: "success",
        title: "Sent to Satvik",
        text: "It's waiting on his approval before anything is purchased.",
      });
      requestForm.reset();
    } else {
      // Roll back so the list never shows a request that did not land.
      setSent((prev) => prev.filter((r) => r.key !== key));
      setBanner({ tone: "error", title: result.error, text: result.message });
    }
  };

  return (
    <div className="space-y-5 pb-8">
      <Panel>
        <PanelHeader
          title="Ask Satvik for stock"
          description="Goes straight to Satvik as pending — nothing is ordered until he approves it."
        />
        <div className="space-y-5 p-5">
          <Field>
            <FieldLabel htmlFor="hq-type">Product type</FieldLabel>
            <Select
              id="hq-type"
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
          </Field>

          <Field>
            <FieldLabel htmlFor="hq-product">What do you need</FieldLabel>
            <Select
              id="hq-product"
              disabled={busy}
              aria-invalid={!!errors.productId}
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
            <FieldError>{errors.productId?.message}</FieldError>
          </Field>

          {isNewProduct && (
            <div className="rounded-lg border border-dashed border-border bg-muted/30 p-4">
              <Field>
                <FieldLabel htmlFor="hq-new-name">New product name</FieldLabel>
                <TextInput
                  id="hq-new-name"
                  placeholder="e.g. Silicone Scalp Base"
                  disabled={busy}
                  {...requestForm.register("newProductName", {
                    required: isNewProduct ? "Name the new product" : false,
                  })}
                />
                <FieldError>{errors.newProductName?.message}</FieldError>
              </Field>
            </div>
          )}

          <div className="grid gap-5 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="hq-qty">Quantity</FieldLabel>
              <TextInput
                id="hq-qty"
                type="number"
                min={1}
                inputMode="numeric"
                disabled={busy}
                aria-invalid={!!errors.qty}
                {...requestForm.register("qty", {
                  valueAsNumber: true,
                  required: "Enter a quantity",
                  min: { value: 1, message: "Must be at least 1" },
                })}
              />
              <FieldError>{errors.qty?.message}</FieldError>
            </Field>

            <Field>
              <FieldLabel htmlFor="hq-urgency">Urgency</FieldLabel>
              <Select id="hq-urgency" disabled={busy} {...requestForm.register("urgency")}>
                <option value="Normal">Normal</option>
                <option value="Urgent">Urgent — stock is low or finished</option>
              </Select>
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="hq-notes">Reason</FieldLabel>
            <TextInput
              id="hq-notes"
              placeholder="e.g. Running low on the floor"
              disabled={busy}
              aria-invalid={!!errors.notes}
              {...requestForm.register("notes", {
                required: "Add a short reason",
                minLength: { value: 3, message: "Add a short reason" },
              })}
            />
            <FieldError>{errors.notes?.message}</FieldError>
          </Field>

          <Button
            onClick={() => void requestForm.handleSubmit(onSubmit)()}
            disabled={busy}
            className="h-11 w-full sm:w-auto sm:px-8"
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            Send to Satvik
          </Button>
        </div>
      </Panel>

      {sent.length > 0 && (
        <Panel>
          <PanelHeader
            title="Sent this session"
            aside={<span className="text-xs text-muted-foreground tabular">{sent.length}</span>}
          />
          <ul className="divide-y divide-border">
            {sent.map((r) => (
              <li key={r.key} className="flex items-center justify-between gap-3 px-5 py-3">
                <p className="min-w-0 truncate text-sm text-foreground">
                  <span className="font-medium tabular">{r.qty}</span>
                  <span className="mx-1.5 text-muted-foreground">×</span>
                  {r.product}
                </p>
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
  );
}

export default function StockOutPage() {
  const [stockOutTab, setStockOutTab] = useState<StockOutTab>("issue");
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [pending, setPending] = useState(false);

  // Start with clearly labelled local demo data so Hitesh can test the screen
  // even while Apps Script is unavailable. A successful refresh replaces this
  // object with the authoritative ledger balances.
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [balanceSource, setBalanceSource] = useState<BalanceSource>("demo");
  const [balancesLoading, setBalancesLoading] = useState(false);

  const loadBalances = useCallback(async () => {
    setBalancesLoading(true);
    const result = await postAction<DashboardStockOnly>("dashboard.read", {});
    setBalancesLoading(false);
    if (result.ok) {
      const next: Record<string, number> = {};
      result.data.stock.forEach((s) => {
        next[s.productId] = s.custodyBalance;
      });
      setBalances(next);
      setBalanceSource("live");
      setBanner({
        tone: "success",
        title: "Live stock loaded",
        text: "Balances now match Hitesh's custody ledger.",
      });
    } else {
      setBalances({});
      setBalanceSource("demo");
      setBanner({
        tone: "error",
        title: "Live stock unavailable",
        text: "Stock issuing is disabled until the live ledger is available.",
      });
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void loadBalances(), 0);
    return () => window.clearTimeout(id);
  }, [loadBalances]);

  const form = useForm<IssueStock>({
    resolver: zodResolver(IssueStockSchema),
    defaultValues: {
      productId: "",
      fromLocationId: DEFAULT_LOCATION_ID,
      splits: [{ qty: 1, categoryId: "", recipientUserId: "", notes: "" }],
    },
  });

  const { fields, append, remove, replace } = useFieldArray({
    control: form.control,
    name: "splits",
  });

  const product = MOCK_PRODUCTS.find((p) => p.id === selectedProduct);
  const sortedProducts = useMemo(
    () =>
      [...MOCK_PRODUCTS].sort((a, b) => {
        const aBalance = balances[a.id] ?? 0;
        const bBalance = balances[b.id] ?? 0;
        const availabilityOrder = Number(bBalance > 0) - Number(aBalance > 0);

        if (availabilityOrder !== 0) return availabilityOrder;
        if (aBalance !== bBalance) return bBalance - aBalance;
        return a.name.localeCompare(b.name);
      }),
    [balances]
  );
  const splits = form.watch("splits");
  const issuing = splits?.reduce((sum, s) => sum + (Number(s.qty) || 0), 0) ?? 0;
  // Live from the ledger (loadBalances). Falls back to null -- not 0 -- while
  // still loading, so the UI says "not synced" rather than lying that
  // there's nothing on hand.
  const known = selectedProduct ? (balances[selectedProduct] ?? 0) : null;
  const remaining = known === null ? null : known - issuing;
  const overdrawn = remaining !== null && remaining < 0;

  const onSubmit = async (data: IssueStock) => {
    setBanner(null);
    setPending(true);

    if (balanceSource === "demo") {
      setPending(false);
      setBanner({
        tone: "error",
        title: "Live ledger required",
        text: "Refresh the stock balance before issuing anything.",
      });
      return;
    }

    const result = await postAction<{ handoverId?: string; newBalance?: number }>(
      "stock.issue",
      data
    );

    setPending(false);

    if (result.ok) {
      setBanner({
        tone: "success",
        title: "Stock issued",
        text: `Handover ${result.data?.handoverId ?? ""} recorded. ${
          result.data?.newBalance !== undefined
            ? `${result.data.newBalance} remaining.`
            : ""
        }`.trim(),
      });
      form.reset();
      setSelectedProduct(null);
      void loadBalances();
    } else {
      setBanner({ tone: "error", title: result.error, text: result.message });
    }
  };

  return (
    <AppShell>
      <PageContainer>
        <PageHeader
          title="Stock Out"
          description="Issue products from the store to technicians, and confirm what Satvik hands over."
        />

        <div
          role="tablist"
          className="mb-5 inline-flex w-full rounded-lg border border-border bg-muted p-1 sm:w-auto"
        >
          {STOCK_OUT_TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={stockOutTab === t.id}
              onClick={() => setStockOutTab(t.id)}
              className={cn(
                "flex-1 rounded-md px-4 py-2 text-sm font-medium transition-all sm:flex-none",
                stockOutTab === t.id
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
          <div className="mb-5">
            <StatusBanner tone={banner.tone} title={banner.title}>
              {banner.text}
            </StatusBanner>
          </div>
        )}

        {stockOutTab === "confirm" ? (
          <div className="pb-8">
            <ConfirmHandoversPanel busy={pending} setBusy={setPending} setBanner={setBanner} />
          </div>
        ) : stockOutTab === "request" ? (
          <RequestPanel busy={pending} setBusy={setPending} setBanner={setBanner} />
        ) : stockOutTab === "opening" ? (
          <div className="pb-8"><OpeningStockPanel locationId={SALON_FLOOR_LOCATION_ID} locationName="Salon Floor" /></div>
        ) : (
        <div className="grid gap-5 pb-8 lg:grid-cols-12">
          {/* Product picker */}
          <div className="lg:col-span-5">
            <Panel>
              <PanelHeader
                title="Select product"
                description={
                  "Salon Floor stock in Hitesh's custody — available products first."
                }
                aside={
                  <button
                    type="button"
                    onClick={() => void loadBalances()}
                    disabled={balancesLoading}
                    className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    <RefreshCw className={cn("size-3.5", balancesLoading && "animate-spin")} />
                    {balanceSource === "demo" ? "Connect live stock" : "Refresh"}
                  </button>
                }
              />
              <ul className="divide-y divide-border">
                {sortedProducts.map((p) => {
                  const active = selectedProduct === p.id;
                  const bal = balances[p.id] ?? 0;
                  const low = bal > 0 && bal <= p.reorderLevel;
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => {
                          setSelectedProduct(p.id);
                          form.setValue("productId", p.id, { shouldValidate: true });
                          replace([
                            {
                              qty: 1,
                              categoryId: p.categoryId,
                              recipientUserId: "",
                              notes: "",
                            },
                          ]);
                        }}
                        aria-pressed={active}
                        className={cn(
                          "flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors disabled:pointer-events-none disabled:opacity-50",
                          active ? "bg-brand-subtle" : "hover:bg-muted"
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <p
                            className={cn(
                              "truncate text-sm font-medium",
                              active ? "text-brand" : "text-foreground"
                            )}
                          >
                            {p.name}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            <span className="tabular">{bal}</span> {p.uom} available
                            {low && (
                              <span className="ml-2 font-medium text-warning">Low</span>
                            )}
                          </p>
                        </div>
                        {active && <Check className="size-4 shrink-0 text-brand" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Panel>
            <div className="mt-2">
              <FieldError>{form.formState.errors.productId?.message}</FieldError>
            </div>
          </div>

          {/* Allocation */}
          <div className="lg:col-span-7">
            {product ? (
              <Panel>
                <PanelHeader
                  title="Allocation"
                  description="Split the issue across categories and recipients."
                  aside={
                    <div className="text-right">
                      <div
                        className={cn(
                          "text-sm font-semibold tabular",
                          overdrawn ? "text-danger" : "text-foreground"
                        )}
                      >
                        {known === null
                          ? `${issuing} ${product.uom}`
                          : `${issuing} / ${known}`}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {known === null
                          ? "Balance not synced"
                          : overdrawn
                            ? "Over balance"
                            : `${remaining} left`}
                      </div>
                    </div>
                  }
                />

                <div className="space-y-4 p-5">
                  {overdrawn && (
                    <StatusBanner tone="error" title="Not enough stock">
                      Issuing {issuing} {product.uom} but only {known} are on hand. The
                      backend re-checks this under a lock and will reject it.
                    </StatusBanner>
                  )}

                  {fields.map((field, index) => {
                    const errors = form.formState.errors.splits?.[index];
                    const selectedCategory = form.watch(`splits.${index}.categoryId`);

                    return (
                      <div
                        key={field.id}
                        className="relative rounded-lg border border-border bg-muted/30 p-4"
                      >
                        {fields.length > 1 && (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => remove(index)}
                            aria-label={`Remove split ${index + 1}`}
                            className="absolute top-3 right-3 grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-danger-subtle hover:text-danger disabled:pointer-events-none disabled:opacity-50"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        )}

                        {fields.length > 1 && (
                          <p className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                            Split {index + 1}
                          </p>
                        )}

                        <div className="space-y-4">
                          <Field>
                            <FieldLabel htmlFor={`qty-${index}`}>Quantity</FieldLabel>
                            <div className="flex items-center gap-2">
                              <TextInput
                                id={`qty-${index}`}
                                type="number"
                                min={
                                  product.uom === "PCS" ||
                                  product.uom === "BTL" ||
                                  product.uom === "ROLL"
                                    ? 1
                                    : 0.01
                                }
                                step={
                                  product.uom === "PCS" ||
                                  product.uom === "BTL" ||
                                  product.uom === "ROLL"
                                    ? 1
                                    : 0.01
                                }
                                inputMode="decimal"
                                className="w-28 text-center font-semibold"
                                disabled={pending}
                                aria-invalid={!!errors?.qty}
                                {...form.register(`splits.${index}.qty`, {
                                  valueAsNumber: true,
                                })}
                              />
                              <span className="text-sm text-muted-foreground">
                                {product.uom}
                              </span>
                            </div>
                            <FieldError>{errors?.qty?.message}</FieldError>
                          </Field>

                          <Field>
                            <FieldLabel>Category</FieldLabel>
                            <div className="flex flex-wrap gap-1.5">
                              {MOCK_CATEGORIES.map((cat) => {
                                const on = selectedCategory === cat.id;
                                return (
                                  <button
                                    type="button"
                                    key={cat.id}
                                    disabled={pending}
                                    onClick={() =>
                                      form.setValue(
                                        `splits.${index}.categoryId`,
                                        cat.id,
                                        { shouldValidate: true }
                                      )
                                    }
                                    aria-pressed={on}
                                    className={cn(
                                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[0.8125rem] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
                                      on
                                        ? "border-brand bg-brand text-brand-foreground"
                                        : "border-border bg-card text-muted-foreground hover:border-input hover:text-foreground"
                                    )}
                                  >
                                    <span
                                      aria-hidden
                                      className={cn(
                                        "size-1.5 rounded-full",
                                        on ? "bg-brand-foreground" : cat.dot
                                      )}
                                    />
                                    {cat.name}
                                  </button>
                                );
                              })}
                            </div>
                            <FieldError>{errors?.categoryId?.message}</FieldError>
                          </Field>

                          <Field>
                            <FieldLabel htmlFor={`to-${index}`}>Issued to</FieldLabel>
                            <Select
                              id={`to-${index}`}
                              disabled={pending}
                              aria-invalid={!!errors?.recipientUserId}
                              {...form.register(`splits.${index}.recipientUserId`)}
                            >
                              <option value="">Select technician…</option>
                              {MOCK_USERS.filter((u) => u.role === "Floor").map((u) => (
                                <option key={u.id} value={u.id}>
                                  {u.name} · {u.role}
                                </option>
                              ))}
                            </Select>
                            <FieldError>{errors?.recipientUserId?.message}</FieldError>
                          </Field>

                          <Field>
                            <FieldLabel htmlFor={`purpose-${index}`} optional>
                              Client / service note
                            </FieldLabel>
                            <TextInput
                              id={`purpose-${index}`}
                              placeholder="e.g. Sonali — hair patch service"
                              disabled={pending}
                              {...form.register(`splits.${index}.notes`)}
                            />
                          </Field>
                        </div>
                      </div>
                    );
                  })}

                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      append({
                        qty: 1,
                        categoryId: product.categoryId,
                        recipientUserId: "",
                        notes: "",
                      })
                    }
                    className="h-10 w-full border-dashed text-muted-foreground"
                  >
                    <Plus className="size-4" />
                    Add another split
                  </Button>
                </div>
              </Panel>
            ) : (
              <div className="flex h-full min-h-52 flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-12 text-center">
                <p className="text-sm font-medium text-foreground">
                  No product selected
                </p>
                <p className="mt-1 max-w-xs text-sm text-muted-foreground">
                  Choose what is leaving the store to set quantities, categories and
                  recipients.
                </p>
              </div>
            )}
          </div>
        </div>
        )}
      </PageContainer>

      {stockOutTab === "issue" && (
        <ActionBar>
          <div className="flex items-center gap-3">
            <div className="hidden min-w-0 flex-1 sm:block">
              {product && (
                <p className="truncate text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{product.name}</span>
                  <span className="mx-1.5">·</span>
                  <span className="tabular">{issuing}</span> {product.uom} to{" "}
                  {fields.length} {fields.length === 1 ? "recipient" : "recipients"}
                </p>
              )}
            </div>
            <Button
              size="lg"
              onClick={() => void form.handleSubmit(onSubmit)()}
              disabled={!selectedProduct || pending || overdrawn || balanceSource !== "live"}
              className="h-12 w-full text-[0.9375rem] font-semibold sm:w-auto sm:px-8"
            >
              {pending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Recording…
                </>
              ) : (
                "Confirm issue"
              )}
            </Button>
          </div>
        </ActionBar>
      )}
    </AppShell>
  );
}
