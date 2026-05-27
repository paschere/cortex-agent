import { getOptionalSession } from '@/lib/session';

export default async function HomePage() {
  const user = await getOptionalSession();
  return (
    <main className="min-h-screen grid place-items-center p-8">
      <div className="max-w-md w-full rounded-2xl border bg-white dark:bg-neutral-900 p-8 shadow-sm">
        <h1 className="text-2xl font-semibold">Zipdev Agent</h1>
        <p className="mt-2 text-sm text-neutral-500">
          {user ? `Signed in as ${user.email}` : 'Not signed in'}
        </p>
      </div>
    </main>
  );
}
