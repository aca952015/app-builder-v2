import { authenticate } from "@/app/login/actions";

export default function LoginPage() {
  return (
    <div className="relative p-6 bg-white z-1 dark:bg-gray-900 sm:p-0">
      <div className="relative flex lg:flex-row w-full h-screen justify-center flex-col dark:bg-gray-900 sm:p-0">
        <div className="flex flex-col flex-1 w-full lg:w-1/2">
          <div className="w-full max-w-md pt-10 mx-auto mb-5">
            <a
              href="/"
              className="inline-flex items-center text-sm text-gray-500 transition-colors hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
            >
              <svg className="mr-2" width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M8.33366 5L3.33366 10L8.33366 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M16.667 10H3.33366" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Back to dashboard
            </a>
          </div>

          <div className="flex flex-col justify-center flex-1 w-full max-w-md mx-auto">
            <div className="mb-5 sm:mb-8">
              <span className="inline-flex rounded-full bg-brand-50 px-3 py-1 text-theme-xs font-medium text-brand-600 dark:bg-brand-500/15 dark:text-brand-400">
                TailAdmin auth shell
              </span>
              <h1 className="mt-4 mb-2 font-semibold text-gray-800 text-title-sm dark:text-white/90 sm:text-title-md">
                Sign in
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Enter your demo credentials to open the TailAdmin-based workspace.
              </p>
            </div>

            <form action={authenticate} className="space-y-6">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Email <span className="text-error-500">*</span>
                </label>
                <input
                  name="email"
                  type="email"
                  required
                  defaultValue="demo@example.com"
                  className="h-11 w-full rounded-lg border border-gray-300 bg-transparent px-4 py-2.5 text-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-brand-300 focus:outline-hidden focus:ring-3 focus:ring-brand-500/10 dark:border-gray-700 dark:bg-white/[0.03] dark:text-white/90"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Password <span className="text-error-500">*</span>
                </label>
                <input
                  name="password"
                  type="password"
                  required
                  defaultValue="demo12345"
                  className="h-11 w-full rounded-lg border border-gray-300 bg-transparent px-4 py-2.5 text-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-brand-300 focus:outline-hidden focus:ring-3 focus:ring-brand-500/10 dark:border-gray-700 dark:bg-white/[0.03] dark:text-white/90"
                />
              </div>

              <button className="inline-flex w-full items-center justify-center rounded-lg bg-brand-500 px-4 py-3 text-sm font-medium text-white shadow-theme-xs hover:bg-brand-600">
                Continue to dashboard
              </button>
            </form>
          </div>
        </div>

        <div className="hidden h-full lg:grid lg:w-1/2 lg:items-center bg-brand-950 dark:bg-white/[0.05]">
          <div className="mx-auto max-w-md px-10">
            <p className="text-theme-xl font-semibold text-white">TailAdmin Next.js starter</p>
            <p className="mt-4 text-theme-sm text-white/70">
              The agent should keep this two-column auth treatment, reuse TailAdmin tokens and spacing, and extend
              the admin shell instead of replacing it with a generic UI.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
