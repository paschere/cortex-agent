'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';

/**
 * TOTP challenge shown after a correct password when the account has
 * two-factor enabled (see onTwoFactorRedirect in lib/auth-client.ts).
 * Accepts either a 6-digit authenticator code or a backup code.
 */
export default function TwoFactorPage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [trust, setTrust] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    const { error } = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code })
      : await authClient.twoFactor.verifyTotp({ code, trustDevice: trust });
    setLoading(false);
    if (error) {
      setErr(error.message ?? 'Invalid code');
      return;
    }
    router.push('/');
  }

  return (
    <div className="w-full max-w-sm rounded-card border border-border bg-surface p-8 shadow-card">
      <h1 className="text-xl font-extrabold tracking-tight">Two-factor verification</h1>
      <p className="mt-2 text-[13px] leading-snug text-ink-muted">
        {useBackup
          ? 'Enter one of your backup codes.'
          : 'Enter the 6-digit code from your authenticator app.'}
      </p>
      <form onSubmit={submit} className="mt-5 space-y-3">
        <input
          type="text"
          required
          inputMode={useBackup ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          placeholder={useBackup ? 'Backup code' : '123456'}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="w-full rounded-[10px] border border-border bg-transparent px-3 py-2.5 text-center text-[15px] tracking-widest outline-none focus:border-primary"
        />
        {!useBackup && (
          <label className="flex items-center gap-2 text-[12px] text-ink-muted">
            <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
            Trust this device for 60 days
          </label>
        )}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-pill bg-primary py-2.5 font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong disabled:opacity-50"
        >
          {loading ? 'Verifying…' : 'Verify'}
        </button>
      </form>
      <button
        type="button"
        onClick={() => {
          setUseBackup((v) => !v);
          setCode('');
          setErr(null);
        }}
        className="mt-4 w-full text-center text-[11.5px] font-semibold text-primary hover:underline"
      >
        {useBackup ? 'Use authenticator code instead' : 'Use a backup code instead'}
      </button>
      {err && (
        <p className="mt-4 rounded-[10px] border border-rose/30 bg-rose-soft px-3 py-2 text-[12.5px] text-rose">
          {err}
        </p>
      )}
    </div>
  );
}
