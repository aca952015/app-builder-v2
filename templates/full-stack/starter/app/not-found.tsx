import Link from "next/link";

export default function NotFoundPage() {
  return (
    <section className="grid min-h-[50vh] place-items-center">
      <div className="grid max-w-md gap-4 rounded-[2rem] border border-slate-200 bg-white p-8 text-center shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-[0.3em] text-amber-700">404</p>
        <h1 className="text-3xl font-semibold text-slate-950">Record not found</h1>
        <p className="text-sm text-slate-600">The generated route could not find the requested resource.</p>
        <Link href="/" className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white">
          Back to dashboard
        </Link>
      </div>
    </section>
  );
}
