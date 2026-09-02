"use client";

import * as React from "react";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Form primitives shared by every screen.
 *
 * These exist so a form field looks the same in Stock Out as it does in the
 * Purchase Hub. Before this, each page re-declared its own input classes and
 * they had drifted apart.
 */

export function Field({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("space-y-2", className)}>{children}</div>;
}

export function FieldLabel({
  children,
  step,
  optional,
  htmlFor,
}: {
  children: React.ReactNode;
  /** Small leading numeral. Guides floor staff through a form in order. */
  step?: number;
  optional?: boolean;
  htmlFor?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="flex items-center gap-2 text-sm font-medium text-foreground"
    >
      {step !== undefined && (
        <span
          aria-hidden
          className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground tabular"
        >
          {step}
        </span>
      )}
      <span>{children}</span>
      {optional && (
        <span className="text-xs font-normal text-muted-foreground">
          Optional
        </span>
      )}
    </label>
  );
}

export function FieldHint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

export function FieldError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p className="flex items-center gap-1.5 text-xs font-medium text-danger">
      <AlertCircle className="size-3.5 shrink-0" />
      {children}
    </p>
  );
}

/**
 * Native select, styled by the .field-control class in globals.css.
 * Master data is always chosen from a list, never typed, so this is used
 * everywhere products, categories, locations, vendors and staff are picked.
 */
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, ...props }, ref) {
  return (
    <select ref={ref} className={cn("field-control", className)} {...props} />
  );
});

export const TextInput = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function TextInput({ className, ...props }, ref) {
  return (
    <input ref={ref} className={cn("field-control", className)} {...props} />
  );
});

type BannerTone = "success" | "error" | "info";

const BANNER_STYLES: Record<
  BannerTone,
  { wrap: string; icon: typeof Info }
> = {
  success: {
    wrap: "border-success/25 bg-success-subtle text-success",
    icon: CheckCircle2,
  },
  error: {
    wrap: "border-danger/25 bg-danger-subtle text-danger",
    icon: AlertCircle,
  },
  info: { wrap: "border-brand-border bg-brand-subtle text-brand", icon: Info },
};

export function StatusBanner({
  tone,
  title,
  children,
}: {
  tone: BannerTone;
  title?: string;
  children: React.ReactNode;
}) {
  const { wrap, icon: Icon } = BANNER_STYLES[tone];
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm",
        wrap
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 space-y-0.5">
        {title && <p className="font-semibold">{title}</p>}
        <p className="break-words opacity-90">{children}</p>
      </div>
    </div>
  );
}

/** Surface panel. Replaces ad-hoc Card usage so radius and border match. */
export function Panel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-xl border border-border bg-card shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]",
        className
      )}
    >
      {children}
    </section>
  );
}

export function PanelHeader({
  title,
  description,
  aside,
}: {
  title: string;
  description?: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
      <div className="space-y-0.5">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {aside}
    </div>
  );
}
