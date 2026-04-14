import { authenticate } from "./actions";

export default function LoginPage() {
  return (
    <section className="mx-auto grid min-h-[60vh] max-w-md content-center gap-8">
      <div className="grid gap-3 text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.3em] text-amber-700">Sign in</p>
        <h1 className="text-4xl font-semibold tracking-tight text-slate-950">Generated App</h1>
        <p className="text-sm leading-7 text-slate-600">
          The agent should replace this intro with project-specific sign-in guidance.
        </p>
      </div>

      <form action={authenticate} className="grid gap-4 rounded-[2rem] border border-white/80 bg-white/95 p-8 shadow-sm">
        <label className="grid gap-2 text-sm font-medium text-slate-700">
          <span>Email</span>
          <input
            name="email"
            type="email"
            required
            defaultValue="demo@example.com"
            className="rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-900"
          />
        </label>

        <label className="grid gap-2 text-sm font-medium text-slate-700">
          <span>Password</span>
          <input
            name="password"
            type="password"
            required
            defaultValue="demo12345"
            className="rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-900"
          />
        </label>

        <button className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white">
          Continue
        </button>
      </form>
    </section>
  );
}
