'use client';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import {
  AuthBody,
  AuthDocument,
  AuthError,
  AuthMasthead,
  AuthTitle,
} from '../../_components/AuthDocument';

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
      setErr(
        error.message ??
          'This invitation could not be answered — it may have expired. Ask for a new one.',
      );
      setState('idle');
      return;
    }
    setState('done');
    router.push(action === 'accept' ? '/' : '/login');
  }

  return (
    <AuthDocument>
      <AuthMasthead />

      <AuthBody>
        <AuthTitle hint="Accepting links your account to the workspace and to its shared agents, Brain Knowledge and integrations.">
          Workspace invitation
        </AuthTitle>

        {/* The invitation id is the one checkable fact on this screen — it is
            what an admin needs if the invite has to be traced. */}
        <div className="mb-5">
          <div className="field-label">Invitation</div>
          <div className="tabular mt-1 truncate text-[13px] text-ink" title={id}>
            {id}
          </div>
        </div>

        <div className="flex gap-3">
          <Button
            type="button"
            disabled={state !== 'idle'}
            onClick={() => respond('accept')}
            className="flex-1 py-2.5"
          >
            {state === 'working' ? 'Working…' : 'Accept'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={state !== 'idle'}
            onClick={() => respond('reject')}
            className="flex-1 py-2.5"
          >
            Decline
          </Button>
        </div>

        {err && <AuthError>{err}</AuthError>}
      </AuthBody>
    </AuthDocument>
  );
}
