import { rankingItems } from "@/data/mock-dashboard";
import { formatPercent } from "@/lib/format";

export function RankingList() {
  return (
    <ol className="space-y-3">
      {rankingItems.map((item, index) => (
        <li key={item.label} className="rounded-2xl border border-cyan-300/10 bg-white/[0.03] p-3">
          <div className="mb-2 flex items-center justify-between gap-3 text-sm">
            <span className="font-medium text-white/90">
              <span className="mr-2 text-cyan-200/80">#{index + 1}</span>
              {item.label}
            </span>
            <span className="text-cyan-100">{item.value}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-cyan-950/80">
            <div
              className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-emerald-300"
              style={{ width: formatPercent(item.percent) }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}
