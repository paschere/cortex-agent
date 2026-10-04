'use client';

import { FounderChangeDialog } from '@/components/team/FounderChangeDialog';
import { Button } from '@/components/ui/button';
import { Panel, PanelHead } from '@/components/ui/panel';
import type { StepUpRequirement } from '@/lib/team/step-up-rules';
import { Building2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { leaveCompanyAction, stepDownAction } from '../../admin/users/founder-actions';

/**
 * «Tu lugar en la empresa»: lo que cualquiera puede hacer con el suyo sin
 * pasar por «Personas» (que sólo ven los administradores). Un miembro raso que
 * quiere irse no tiene que pedirle a nadie que lo retire.
 *
 * `canStepDown` / `canLeave` vienen calculados del servidor con las mismas
 * reglas de founder-rules.ts que repiten las acciones.
 */
export function CompanyPlacement({
  companyName,
  roleLabel,
  isOwner,
  ownerCount,
  canStepDown,
  canLeave,
  requirement,
  hasTwoFactor,
}: {
  companyName: string;
  roleLabel: string;
  isOwner: boolean;
  ownerCount: number;
  canStepDown: boolean;
  canLeave: boolean;
  requirement: StepUpRequirement;
  hasTwoFactor: boolean;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<'step_down' | 'leave' | null>(null);

  return (
    <Panel>
      <PanelHead title="Tu lugar en la empresa" icon={<Building2 className="h-4 w-4" />} />
      <div className="space-y-3 px-6 pb-6 pt-3 text-sm">
        <p className="text-ink-muted">
          En <strong className="font-semibold text-ink">{companyName}</strong> eres{' '}
          <strong className="font-semibold text-ink">{roleLabel}</strong>.
          {isOwner &&
            (ownerCount > 1
              ? ` Hay ${ownerCount} fundadores.`
              : ' Eres el único fundador: antes de poder irte, nombra a otro desde «Personas».')}
        </p>
        <div className="flex flex-wrap gap-2">
          {canStepDown && (
            <Button variant="outline" onClick={() => setDialog('step_down')}>
              Dejar de ser fundador
            </Button>
          )}
          {canLeave && (
            <Button
              variant="outline"
              className="hover:text-rose"
              onClick={() => setDialog('leave')}
            >
              Dejar la empresa
            </Button>
          )}
        </div>
      </div>

      {dialog === 'step_down' && (
        <FounderChangeDialog
          mode="step_down"
          open
          onOpenChange={(open) => !open && setDialog(null)}
          companyName={companyName}
          requirement={requirement}
          hasTwoFactor={hasTwoFactor}
          onSubmit={(payload) => stepDownAction(payload)}
          onDone={() => router.refresh()}
        />
      )}
      {dialog === 'leave' && (
        <FounderChangeDialog
          mode="leave"
          open
          onOpenChange={(open) => !open && setDialog(null)}
          companyName={companyName}
          requirement={isOwner ? requirement : null}
          hasTwoFactor={hasTwoFactor}
          onSubmit={(payload) => leaveCompanyAction(payload)}
          onDone={() => window.location.assign('/')}
        />
      )}
    </Panel>
  );
}
