import type { ReactNode } from "react";

export function FullscreenFrame({ children }: { children: ReactNode }) {
  return (
    <main className="dashboard-grid-bg min-h-screen overflow-hidden px-4 py-4 text-[var(--dashboard-ink)] sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] w-full max-w-[1800px] flex-col gap-4 rounded-[2rem] border border-cyan-300/10 bg-slate-950/45 p-4 shadow-[0_2rem_6rem_rgba(0,0,0,0.36)] backdrop-blur-2xl">
        {children}
      </div>
    </main>
  );
}
