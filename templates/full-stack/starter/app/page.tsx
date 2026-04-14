import { requireUser } from "@/lib/session";

export default async function DashboardPage() {
  await requireUser();

  return (
    <section className="grid gap-8">
      <header className="grid gap-3 rounded-[2rem] border border-amber-200 bg-amber-50 p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.3em] text-amber-700">Starter Dashboard</p>
        <h1 className="text-4xl font-semibold tracking-tight text-slate-950">Replace with generated overview</h1>
        <p className="max-w-3xl text-sm leading-7 text-slate-700">
          The agent should replace this dashboard with product-specific counts, links, and copy.
        </p>
      </header>
    </section>
  );
}
