export default function HomePage() {
  return (
    <main className="grid min-h-screen place-items-center px-6 py-10 sm:px-8">
      <section className="w-full max-w-3xl rounded-[1.75rem] border border-[var(--line)] bg-[var(--panel)] p-8 shadow-[0_1.5rem_4rem_rgba(24,32,40,0.08)] backdrop-blur sm:p-10">
        <p className="mb-3 inline-flex rounded-full bg-[color:rgba(14,116,144,0.12)] px-3 py-1 text-[0.72rem] font-bold uppercase tracking-[0.2em] text-[var(--accent)]">
          Mini App Starter
        </p>
        <h1 className="max-w-2xl text-[clamp(2.5rem,7vw,4.75rem)] font-semibold leading-[0.92] tracking-[-0.04em] text-[var(--ink)]">
          Generated Mini App
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-[var(--muted)] sm:text-lg">
          Replace this home entry with pages derived from the approved planSpec. Keep the shell small, fast, and
          direct.
        </p>
        <div className="mt-8 grid gap-3 text-sm text-[var(--muted)] sm:grid-cols-3">
          <div className="rounded-2xl border border-[var(--line)] bg-white/70 p-4">
            Next.js App Router shell
          </div>
          <div className="rounded-2xl border border-[var(--line)] bg-white/70 p-4">
            REST-style route handlers
          </div>
          <div className="rounded-2xl border border-[var(--line)] bg-white/70 p-4">
            Tailwind v4 ready
          </div>
        </div>
      </section>
    </main>
  );
}
