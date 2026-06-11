import { tickerItems } from "@/data/mock-dashboard";

export function DataTicker() {
  return (
    <div className="overflow-hidden rounded-full border border-cyan-300/20 bg-cyan-300/10 px-4 py-2 text-xs text-cyan-100">
      <div className="flex flex-wrap gap-x-6 gap-y-1">
        {tickerItems.map((item) => (
          <span key={item} className="inline-flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_1rem_rgba(52,211,153,0.9)]" />
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}
