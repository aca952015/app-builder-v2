export default function DashboardPage() {
  return (
    <div className="grid grid-cols-12 gap-4 md:gap-6">
      <section className="col-span-12 rounded-2xl border border-gray-200 bg-white p-6 shadow-theme-sm dark:border-gray-800 dark:bg-white/[0.03] xl:col-span-8">
        <span className="inline-flex rounded-full bg-brand-50 px-3 py-1 text-theme-xs font-medium text-brand-600 dark:bg-brand-500/15 dark:text-brand-400">
          TailAdmin Dashboard Shell
        </span>
        <h1 className="mt-4 text-2xl font-semibold text-gray-900 dark:text-white">
          Replace this overview with generated business metrics
        </h1>
        <p className="mt-3 max-w-3xl text-theme-sm text-gray-500 dark:text-gray-400">
          This starter uses the official TailAdmin Next.js layout approach. The agent should keep the sidebar,
          sticky header, dashboard card rhythm, and utility classes while filling in product-specific data.
        </p>
      </section>

      <section className="col-span-12 xl:col-span-4">
        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-theme-sm dark:border-gray-800 dark:bg-white/[0.03]">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Workspace checklist</h2>
          <ul className="mt-4 space-y-3 text-theme-sm text-gray-500 dark:text-gray-400">
            <li>Use TailAdmin cards, tables, and spacing scale for generated pages.</li>
            <li>Keep this app in Next.js App Router MPA mode.</li>
            <li>Extend the existing admin shell instead of swapping frameworks.</li>
          </ul>
        </div>
      </section>

      <section className="col-span-12 grid gap-4 md:grid-cols-3">
        {[
          { label: "Assets", value: "0", note: "Generated entities should appear here." },
          { label: "Monitoring", value: "0", note: "Live metrics and charts plug into this area." },
          { label: "Alarms", value: "0", note: "Severity cards should reuse this card style." },
        ].map((item) => (
          <article
            key={item.label}
            className="rounded-2xl border border-gray-200 bg-white p-5 shadow-theme-sm dark:border-gray-800 dark:bg-white/[0.03]"
          >
            <p className="text-theme-sm text-gray-500 dark:text-gray-400">{item.label}</p>
            <p className="mt-3 text-3xl font-semibold text-gray-900 dark:text-white">{item.value}</p>
            <p className="mt-2 text-theme-sm text-gray-500 dark:text-gray-400">{item.note}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
