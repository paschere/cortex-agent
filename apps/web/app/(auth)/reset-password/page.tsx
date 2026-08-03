'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { authClient } from '@/lib/auth-client';

function ResetPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) {
      setErr('Missing or invalid reset token — request a new link.');
      return;
    }
    setLoading(true);
    setErr(null);
    const { error } = await authClient.resetPassword({ newPassword: password, token });
    setLoading(false);
    if (error) {
      setErr(error.message ?? 'Reset failed — the link may have expired.');
      return;
    }
    router.push('/login');
  }

  return (
    <div className="w-full max-w-sm rounded-card border border-border bg-surface p-8 shadow-card">
      <h1 className="text-xl font-extrabold tracking-tight">Choose a new password</h1>
      <form onSubmit={submit} className="mt-5 space-y-3">
        <input
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
          placeholder="New password (10+ characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-[10px] border border-border bg-transparent px-3 py-2.5 text-[13px] outline-none focus:border-primary"
        />
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-pill bg-primary py-2.5 font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong disabled:opacity-50"
        >
          {loading ? 'Saving…' : 'Set new password'}
        </button>
      </form>
      <p className="mt-4 text-center text-[11.5px] text-ink-faint">
        <Link href="/login" className="font-semibold text-primary hover:underline">
          Back to sign in
        </Link>
      </p>
      {err && (
        <p className="mt-4 rounded-[10px] border border-rose/30 bg-rose-soft px-3 py-2 text-[12.5px] text-rose">
          {err}
        </p>
      )}
    </div>
  );
}

export default function ResetPasswordPage() {
  // useSearchParams requires a Suspense boundary during prerender.
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
