"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { ArrowLeftRight, ClipboardList, Gauge, LayoutGrid, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutGrid;
  roles: string[];
}

// Mirrors the role gating in src/middleware.ts. Showing a link the middleware
// would bounce is worse than hiding it.
const NAV: NavItem[] = [
  {
    href: "/dashboard",
    label: "Dashboard",
    icon: Gauge,
    roles: ["PurchaseCoordinator", "ProductDistributor", "Admin"],
  },
  {
    href: "/purchase",
    label: "Purchase",
    icon: ClipboardList,
    roles: ["PurchaseCoordinator", "Admin"],
  },
  {
    href: "/stock-out",
    label: "Stock Out",
    icon: ArrowLeftRight,
    roles: ["ProductDistributor", "Admin"],
  },
  { href: "/admin", label: "Admin", icon: LayoutGrid, roles: ["Admin"] },
];

const ROLE_LABEL: Record<string, string> = {
  Admin: "Management",
  PurchaseCoordinator: "Purchase",
  ProductDistributor: "Distribution",
};

function initials(name?: string | null, email?: string | null): string {
  const source = name?.trim() || email?.split("@")[0] || "?";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function Monogram() {
  return (
    <span
      aria-hidden
      className="grid size-7 shrink-0 place-items-center rounded-[7px] bg-primary text-[11px] font-bold tracking-tight text-primary-foreground"
    >
      AHL
    </span>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { data: session } = useSession();

  const role = session?.user?.role ?? "";
  const items = NAV.filter((item) => item.roles.includes(role));

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-card/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4 sm:px-6">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25"
          >
            <Monogram />
            <span className="text-[0.9375rem] font-semibold tracking-tight text-foreground">
              Inventory
            </span>
          </Link>

          {/* Desktop navigation. On mobile this moves to its own row below. */}
          <nav className="ml-4 hidden items-center gap-1 sm:flex">
            {items.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
                    active
                      ? "bg-brand-subtle text-brand"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {session?.user && (
              <div className="flex items-center gap-2.5">
                <div className="hidden text-right leading-tight sm:block">
                  <div className="text-sm font-medium text-foreground">
                    {session.user.name}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {ROLE_LABEL[role] ?? role}
                  </div>
                </div>
                <span className="grid size-8 place-items-center rounded-full bg-brand-subtle text-xs font-semibold text-brand">
                  {initials(session.user.name, session.user.email)}
                </span>
              </div>
            )}
            <button
              type="button"
              onClick={() => signOut({ callbackUrl: "/login" })}
              aria-label="Sign out"
              title="Sign out"
              className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none"
            >
              <LogOut className="size-4" />
            </button>
          </div>
        </div>

        {/* Mobile navigation row. Only shown when there is a real choice to make. */}
        {items.length > 1 && (
          <nav className="flex gap-1 border-t border-border px-4 py-1.5 sm:hidden">
            {items.map((item) => {
              const active = pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex flex-1 items-center justify-center gap-1.5 rounded-md py-2 text-[0.8125rem] font-medium transition-colors",
                    active
                      ? "bg-brand-subtle text-brand"
                      : "text-muted-foreground"
                  )}
                >
                  <Icon className="size-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        )}
      </header>

      <main className="flex-1">{children}</main>
    </div>
  );
}

/** Standard page width. Every screen uses this so columns line up across routes. */
export function PageContainer({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-5xl px-4 sm:px-6", className)}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 pt-7 pb-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * Thumb-zone action bar. Primary actions live at the bottom of the screen
 * because Hitesh and Satvik operate this one-handed on a phone.
 */
export function ActionBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky bottom-0 z-20 border-t border-border bg-card/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md">
      <div className="mx-auto w-full max-w-5xl px-4 py-3 sm:px-6">{children}</div>
    </div>
  );
}
