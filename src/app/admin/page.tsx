"use client";

import Link from "next/link";
import { ArrowRight, CheckSquare, ClipboardList, Layers, PackageCheck, PieChart } from "lucide-react";
import { AppShell, PageContainer, PageHeader } from "@/components/app-shell";
import { Panel } from "@/components/ui/field";
import { OpeningApprovalsPanel } from "@/components/workflow-panels";

/**
 * Management workspace. The three sections below are the Task 3 scope and are
 * deliberately empty rather than populated with placeholder figures -- a
 * dashboard showing invented numbers is worse than one showing none.
 */
const SECTIONS = [
  {
    icon: CheckSquare,
    title: "Approvals",
    description:
      "Purchase requests above ₹5,000 arrive here as PENDING_APPROVAL for sign-off before a PO is raised.",
    status: "Recorded on every request",
  },
  {
    icon: Layers,
    title: "Three-way match",
    description:
      "Compare the purchase order, the bill photo from Drive and the goods receipt before authorising payment.",
    status: "Needs bill access",
  },
  {
    icon: PieChart,
    title: "Category P&L",
    description:
      "Spend grouped by category — SMB, Microblading, Skin, Hair, Retail — across the period.",
    status: "Needs read sync",
  },
];

export default function AdminDashboard() {
  return (
    <AppShell>
      <PageContainer>
        <PageHeader
          title="Owner Control Centre"
          description="Read every balance and audit each step without changing Satvik or Hitesh's responsibilities."
        />

        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          <Link href="/dashboard" className="group rounded-xl border border-border bg-card p-4 transition-colors hover:border-brand/40">
            <PackageCheck className="size-5 text-brand" />
            <p className="mt-3 text-sm font-semibold text-foreground">All stock &amp; reports</p>
            <p className="mt-1 text-xs text-muted-foreground">Balances, pending work, activity and CSV export.</p>
            <ArrowRight className="mt-3 size-4 text-muted-foreground transition-transform group-hover:translate-x-1" />
          </Link>
          <Link href="/purchase" className="group rounded-xl border border-border bg-card p-4 transition-colors hover:border-brand/40">
            <ClipboardList className="size-5 text-brand" />
            <p className="mt-3 text-sm font-semibold text-foreground">Satvik workflow</p>
            <p className="mt-1 text-xs text-muted-foreground">Requests, deliveries and handovers.</p>
            <ArrowRight className="mt-3 size-4 text-muted-foreground transition-transform group-hover:translate-x-1" />
          </Link>
          <Link href="/stock-out" className="group rounded-xl border border-border bg-card p-4 transition-colors hover:border-brand/40">
            <Layers className="size-5 text-brand" />
            <p className="mt-3 text-sm font-semibold text-foreground">Hitesh workflow</p>
            <p className="mt-1 text-xs text-muted-foreground">Recounts, custody and technician issues.</p>
            <ArrowRight className="mt-3 size-4 text-muted-foreground transition-transform group-hover:translate-x-1" />
          </Link>
        </div>

        <div className="grid gap-4 pb-10 sm:grid-cols-2 lg:grid-cols-3">
          {SECTIONS.map(({ icon: Icon, title, description, status }) => (
            <Panel key={title} className="flex flex-col p-5">
              <div className="mb-3 grid size-9 place-items-center rounded-lg bg-brand-subtle text-brand">
                <Icon className="size-4.5" />
              </div>
              <h2 className="text-sm font-semibold tracking-tight text-foreground">
                {title}
              </h2>
              <p className="mt-1.5 flex-1 text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
              <span className="mt-4 inline-flex w-fit items-center rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground">
                {status}
              </span>
            </Panel>
          ))}
        </div>
        <div className="pb-10">
          <OpeningApprovalsPanel />
        </div>
      </PageContainer>
    </AppShell>
  );
}
