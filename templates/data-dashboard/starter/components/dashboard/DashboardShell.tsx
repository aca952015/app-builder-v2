import { ChartPanel } from "@/components/dashboard/ChartPanel";
import { DataTicker } from "@/components/dashboard/DataTicker";
import { EChartsPanel } from "@/components/dashboard/EChartsPanel";
import { FullscreenFrame } from "@/components/dashboard/FullscreenFrame";
import { MetricCard } from "@/components/dashboard/MetricCard";
import { RankingList } from "@/components/dashboard/RankingList";
import { channelShare, dashboardMetrics, regionalLoad, slaSnapshot, trafficTrend } from "@/data/mock-dashboard";
import {
  buildChannelShareOption,
  buildRegionalLoadOption,
  buildSlaGaugeOption,
  buildTrafficTrendOption,
} from "@/lib/chart-theme";

export function DashboardShell() {
  const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "Data Dashboard";

  return (
    <FullscreenFrame>
      <header className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.32em] text-cyan-200/80">Command Center</p>
          <h1 className="mt-2 text-[clamp(2rem,5vw,4.4rem)] font-semibold leading-none tracking-[-0.06em] text-white">
            {appName}
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--dashboard-muted)] sm:text-base">
            A deterministic frontend dashboard starter. Replace the mock data module or connect PRD-backed APIs during generation.
          </p>
        </div>
        <div className="rounded-[1.25rem] border border-cyan-300/20 bg-cyan-300/10 px-4 py-3 text-right">
          <p className="text-xs uppercase tracking-[0.18em] text-cyan-100/70">Refresh cadence</p>
          <p className="mt-1 text-2xl font-semibold text-white">30s</p>
          <p className="text-xs text-[var(--dashboard-muted)]">Mock timestamp 2026-06-10 09:30</p>
        </div>
      </header>

      <DataTicker />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {dashboardMetrics.map((metric) => (
          <MetricCard key={metric.label} metric={metric} />
        ))}
      </section>

      <section className="grid flex-1 gap-4 xl:grid-cols-[1.35fr_0.9fr]">
        <div className="grid gap-4 lg:grid-rows-[1fr_0.85fr]">
          <ChartPanel title="Traffic Trend" subtitle="Inbound, outbound, and incidents by deterministic time bucket">
            <EChartsPanel title="Traffic trend chart" option={buildTrafficTrendOption(trafficTrend)} className="h-[22rem] w-full" />
          </ChartPanel>
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartPanel title="Regional Load" subtitle="Capacity utilization by region">
              <EChartsPanel title="Regional load chart" option={buildRegionalLoadOption(regionalLoad)} className="h-64 w-full" />
            </ChartPanel>
            <ChartPanel title="Channel Share" subtitle="Current traffic distribution">
              <EChartsPanel title="Channel share chart" option={buildChannelShareOption(channelShare)} className="h-64 w-full" />
            </ChartPanel>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-rows-[0.9fr_1.1fr]">
          <ChartPanel title="SLA Gauge" subtitle="Service-level target based on mock fixture">
            <EChartsPanel title="SLA gauge chart" option={buildSlaGaugeOption(slaSnapshot)} className="h-72 w-full" />
          </ChartPanel>
          <ChartPanel title="Top Nodes" subtitle="Ranked deterministic demo entities">
            <RankingList />
          </ChartPanel>
        </div>
      </section>
    </FullscreenFrame>
  );
}
