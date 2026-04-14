import { requireUser } from "@/lib/session";

export default async function SettingsPage() {
  const user = await requireUser();

  return (
    <div className="grid gap-6">
      <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-theme-sm dark:border-gray-800 dark:bg-white/[0.03]">
        <p className="text-theme-sm font-medium text-brand-600 dark:text-brand-400">Settings</p>
        <h1 className="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">Starter environment</h1>
        <p className="mt-3 max-w-2xl text-theme-sm text-gray-500 dark:text-gray-400">
          The agent should expand this page with generated assumptions, environment notes, and workspace-specific
          controls while keeping the TailAdmin settings card pattern.
        </p>
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-theme-sm dark:border-gray-800 dark:bg-white/[0.03]">
        <div className="grid gap-5 md:grid-cols-2">
          <div className="rounded-2xl border border-gray-100 bg-gray-50 p-5 dark:border-gray-800 dark:bg-gray-900/40">
            <p className="text-theme-xs uppercase tracking-[0.2em] text-gray-400">Signed in user</p>
            <p className="mt-3 text-lg font-semibold text-gray-900 dark:text-white">{user.email}</p>
          </div>
          <div className="rounded-2xl border border-gray-100 bg-gray-50 p-5 dark:border-gray-800 dark:bg-gray-900/40">
            <p className="text-theme-xs uppercase tracking-[0.2em] text-gray-400">Starter mode</p>
            <p className="mt-3 text-lg font-semibold text-gray-900 dark:text-white">Next.js + TailAdmin shell</p>
          </div>
        </div>
      </section>
    </div>
  );
}
