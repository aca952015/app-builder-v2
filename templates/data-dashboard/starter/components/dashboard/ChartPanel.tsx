import type { ReactNode } from "react";

export type ChartPanelStatus = "live" | "loading" | "empty" | "error";

type ChartPanelProps = {
  title: string;
  subtitle?: string;
  children?: ReactNode;
  status?: ChartPanelStatus;
  statusMessage?: string;
  stateContent?: ReactNode;
  className?: string;
};

const statusConfig: Record<ChartPanelStatus, { label: string; className: string; message: string }> = {
  live: {
    label: "Live",
    className: "border-cyan-300/20 bg-cyan-300/10 text-cyan-200",
    message: "Panel data is available.",
  },
  loading: {
    label: "Loading",
    className: "border-sky-300/20 bg-sky-300/10 text-sky-100",
    message: "Loading dashboard data…",
  },
  empty: {
    label: "Empty",
    className: "border-slate-300/20 bg-slate-300/10 text-slate-200",
    message: "No data matches the current filters.",
  },
  error: {
    label: "Error",
    className: "border-amber-300/30 bg-amber-300/10 text-amber-100",
    message: "This panel could not load its data.",
  },
};

export function ChartPanel({
  title,
  subtitle,
  children,
  status = "live",
  statusMessage,
  stateContent,
  className,
}: ChartPanelProps) {
  const state = statusConfig[status];
  const shouldShowState = status !== "live";

  return (
    <section className={`rounded-[1.35rem] border border-[var(--dashboard-line)] bg-[var(--dashboard-panel)] p-4 shadow-[0_1.5rem_4rem_rgba(0,0,0,0.26)] backdrop-blur-xl ${className ?? ""}`}>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--dashboard-ink)]">{title}</h2>
          {subtitle ? <p className="mt-1 text-xs text-[var(--dashboard-muted)]">{subtitle}</p> : null}
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.16em] ${state.className}`}>
          {state.label}
        </span>
      </div>
      {shouldShowState ? (
        <div
          className="grid min-h-40 place-items-center rounded-[1rem] border border-dashed border-[var(--dashboard-line)] bg-slate-950/20 px-4 py-8 text-center"
          role={status === "error" ? "alert" : "status"}
        >
          {stateContent ?? (
            <p className="max-w-sm text-sm leading-6 text-[var(--dashboard-muted)]">
              {statusMessage ?? state.message}
            </p>
          )}
        </div>
      ) : (
        children
      )}
    </section>
  );
}
