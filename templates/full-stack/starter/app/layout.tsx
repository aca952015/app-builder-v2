import "./globals.css";

import Link from "next/link";

import { logout } from "@/app/login/actions";
import { getCurrentUser } from "@/lib/session";

export const metadata = {
  title: "Generated App",
  description: "Starter scaffold copied from the full-stack template.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await getCurrentUser();

  return (
    <html lang="en">
      <body>
        <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-5 py-6 md:px-8">
          <header className="mb-8 rounded-[2rem] border border-white/70 bg-white/80 px-6 py-5 shadow-sm backdrop-blur">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="grid gap-1">
                <Link href="/" className="text-xl font-semibold text-slate-950">Generated App</Link>
                <p className="text-sm text-slate-600">
                  The agent should replace this summary with the generated product summary.
                </p>
              </div>
              <nav className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
                <Link href="/">Dashboard</Link>
                <Link href="/settings">Settings</Link>
                {user ? (
                  <form action={logout}>
                    <button className="rounded-full border border-slate-200 px-4 py-2 font-medium text-slate-700">
                      Sign out
                    </button>
                  </form>
                ) : (
                  <Link href="/login" className="rounded-full bg-slate-950 px-4 py-2 font-medium text-white">
                    Sign in
                  </Link>
                )}
              </nav>
            </div>
          </header>
          <main className="flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}
