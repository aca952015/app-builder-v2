import Link from "next/link";

export default function NotFoundPage() {
  return (
    <div className="min-h-screen grid place-items-center bg-gray-50 px-6 dark:bg-gray-900">
      <div className="max-w-xl rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-theme-lg dark:border-gray-800 dark:bg-white/[0.03]">
        <span className="inline-flex rounded-full bg-error-50 px-3 py-1 text-theme-xs font-medium text-error-600 dark:bg-error-500/15 dark:text-error-400">
          404
        </span>
        <h1 className="mt-5 text-3xl font-semibold text-gray-900 dark:text-white">Page not found</h1>
        <p className="mt-3 text-theme-sm text-gray-500 dark:text-gray-400">
          The TailAdmin starter could not find the requested route. Generated pages should keep the existing
          admin or full-width route grouping.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex items-center justify-center rounded-lg bg-brand-500 px-5 py-3 text-sm font-medium text-white hover:bg-brand-600"
        >
          Return to dashboard
        </Link>
      </div>
    </div>
  );
}
