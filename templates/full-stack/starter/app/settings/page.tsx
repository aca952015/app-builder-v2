import { requireUser } from "@/lib/session";

export default async function SettingsPage() {
  const user = await requireUser();

  return (
    <section className="grid max-w-3xl gap-6">
      <header className="grid gap-2">
        <p className="text-sm font-semibold uppercase tracking-[0.3em] text-amber-700">Settings</p>
        <h1 className="text-3xl font-semibold text-slate-950">Environment</h1>
        <p className="text-sm leading-7 text-slate-600">
          The agent should replace this section with generated assumptions and environment notes.
        </p>
      </header>

      <div className="grid gap-4 rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <p className="text-sm font-semibold text-slate-500">Signed in as</p>
          <p className="text-base text-slate-950">{user.email}</p>
        </div>
      </div>
    </section>
  );
}
