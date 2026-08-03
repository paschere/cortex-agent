'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';

/**
 * Landing page for organization invitation emails
 * (/accept-invitation/<invitationId>). The route is session-protected by
 * middleware, so an invitee without an account signs up / signs in first and
 * is bounced back here via the ?next= param.
 */
export default function AcceptInvitationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'working' | 'done'>('idle');
  const [err, setErr] = useState<string | null>(null);

  async function respond(action: 'accept' | 'reject') {
    setState('working');
    setErr(null);
    const { error } =
      action === 'accept'
        ? await authClient.organization.acceptInvitation({ invitationId: id })
        : await authClient.organization.rejectInvitation({ invitationId: id });
    if (error) {
      setErr(error.message ?? 'Something went wrong — the invitation may have expired.');
      setState('idle');
      return;
    }
    setState('done');
    router.push(action === 'accept' ? '/' : '/login');
  }

  return (
    <div className="w-full max-w-sm rounded-card border border-border bg-surface p-8 shadow-card">
      <h1 className="text-xl font-extrabold tracking-tight">Workspace invitation</h1>
      <p className="mt-2 text-[13px] leading-snug text-ink-muted">
        You&apos;ve been invited to join a workspace on Cortex. Accepting links your account to the
        organization and its shared agents, knowledge base and integrations.
      </p>
      <div className="mt-6 flex gap-3">
        <button
          type="button"
          disabled={state !== 'idle'}
          onClick={() => respond('accept')}
          className="flex-1 rounded-pill bg-primary py-2.5 font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong disabled:opacity-50"
        >
          {state === 'working' ? 'Working…' : 'Accept'}
        </button>
        <button
          type="button"
          disabled={state !== 'idle'}
          onClick={() => respond('reject')}
          className="flex-1 rounded-pill border border-border py-2.5 font-semibold text-ink transition-colors hover:bg-primary-soft disabled:opacity-50"
        >
          Decline
        </button>
      </div>
      {err && (
        <p className="mt-4 rounded-[10px] border border-rose/30 bg-rose-soft px-3 py-2 text-[12.5px] text-rose">
          {err}
        </p>
      )}
    </div>
  );
}
