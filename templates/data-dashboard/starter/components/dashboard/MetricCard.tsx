import type { Metric } from "@/data/mock-dashboard";

const toneClassName: Record<Metric["tone"], string> = {
  positive: "text-emerald-300 bg-emerald-300/10 border-emerald-300/20",
  warning: "text-amber-200 bg-amber-300/10 border-amber-300/20",
  neutral: "text-cyan-200 bg-cyan-300/10 border-cyan-300/20",
};

export function MetricCard({ metric }: { metric: Metric }) {
  return (
    <article className="rounded-[1.25rem] border border-[var(--dashboard-line)] bg-[var(--dashboard-panel-strong)] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
      <p className="text-xs uppercase tracking-[0.18em] text-[var(--dashboard-muted)]">{metric.label}</p>
      <div className="mt-3 flex items-end justify-between gap-3">
        <strong className="text-2xl font-semibold tracking-[-0.03em] text-white sm:text-3xl">{metric.value}</strong>
        <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${toneClassName[metric.tone]}`}>
          {metric.delta}
        </span>
      </div>
    </article>
  );
}
