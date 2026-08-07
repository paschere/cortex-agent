'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { count } from '@/lib/plan-shape';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Inviting the rest of the company, from inside the product.
 *
 * There was no way to do this anywhere in Cortex before now: better-auth has had
 * `inviteMember` and an invitation email wired since migration 0052, and nothing
 * ever called it — so "invita a tu equipo" was a sentence on the signup screen
 * and a support request in practice. This is the missing half of a company being
 * able to start without us.
 *
 * The seat check lives in the route, not here. A disabled button is a courtesy;
 * it is not a limit.
 */
export function InviteTeam({
  seatsUsed,
  seatsLimit,
  canInvite,
}: {
  seatsUsed: number;
  seatsLimit: number | null;
  canInvite: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [state, setState] = useState<'idle' | 'sending'>('idle');
  const [sent, setSent] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const full = seatsLimit !== null && seatsUsed + sent.length >= seatsLimit;

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setState('sending');
    setErr(null);
    try {
      const res = await fetch('/api/team/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setErr(data.error ?? 'No se pudo enviar la invitación.');
        return;
      }
      setSent((prev) => [...prev, email]);
      setEmail('');
      startTransition(() => router.refresh());
    } catch {
      setErr('No se pudo enviar la invitación. Revisa tu conexión.');
    } finally {
      setState('idle');
    }
  }

  if (!canInvite) {
    return (
      <p className="text-[12.5px] text-ink-muted">
        Quien administra el espacio es quien invita. Pídele a esa persona que te agregue a alguien.
      </p>
    );
  }

  return (
    <div>
      <form onSubmit={invite} className="flex flex-wrap items-end gap-2">
        <label className="min-w-[200px] flex-1">
          <span className="field-label mb-1 block">Correo</span>
          <Input
            type="email"
            required
            autoComplete="off"
            placeholder="colega@empresa.com"
            className="font-mono"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label mb-1 block">Rol</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as 'member' | 'admin')}
            className="h-[38px] rounded-pill border border-border bg-surface px-3.5 text-[13px] text-ink"
          >
            <option value="member">Miembro</option>
            <option value="admin">Administra</option>
          </select>
        </label>
        <Button type="submit" disabled={state === 'sending' || full} className="py-2">
          {state === 'sending' ? 'Enviando…' : 'Invitar'}
        </Button>
      </form>

      <p className="mt-2.5 text-[12px] text-ink-faint">
        {seatsLimit === null ? (
          <>
            <span className="tabular">{count(seatsUsed)}</span> personas en el espacio.
          </>
        ) : (
          <>
            <span className="tabular">{count(seatsUsed)}</span> de{' '}
            <span className="tabular">{count(seatsLimit)}</span> puestos de tu plan.
          </>
        )}
      </p>

      {sent.length > 0 && (
        <p className="mt-2 text-[12px] text-emerald">
          Invitación enviada a{' '}
          <span className="font-mono">{sent[sent.length - 1]}</span>. Le llega un enlace que dura
          48 horas.
        </p>
      )}
      {err && <p className="mt-2 text-[12px] leading-relaxed text-rose">{err}</p>}
    </div>
  );
}
