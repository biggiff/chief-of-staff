export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const sp = await searchParams;

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold tracking-tight">Chief of Staff</h1>
          <p className="text-sm text-neutral-500">Enter your password to continue.</p>
        </div>
        <form action="/api/login" method="post" className="space-y-3">
          <input type="hidden" name="next" value={sp.next ?? "/chat"} />
          <input
            type="password"
            name="password"
            autoFocus
            required
            placeholder="Password"
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
          />
          {sp.error && (
            <p className="text-sm text-red-600">Incorrect password. Try again.</p>
          )}
          <button
            type="submit"
            className="w-full rounded-lg bg-neutral-900 px-3 py-2 text-sm text-white hover:bg-neutral-800"
          >
            Unlock
          </button>
        </form>
      </div>
    </div>
  );
}
