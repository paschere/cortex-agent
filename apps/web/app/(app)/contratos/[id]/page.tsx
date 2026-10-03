import { ContractDetail } from '@/components/contracts/ContractDetail';
import { contractDetail, wizardData } from '@/lib/contracts/screen';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { bogotaToday } from '@cortex/agent-tools';
import { notFound } from 'next/navigation';
import {
  addObligationAction,
  completeObligationAction,
  confirmObligationAction,
  discardObligationAction,
  extractAction,
  markSignedAction,
  saveTermAction,
  saveTextAction,
  sendToReviewAction,
  terminateAction,
} from '../actions';

/** La ficha de un contrato (0195): texto, vigencia, obligaciones y su línea de tiempo. */

export const dynamic = 'force-dynamic';

export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const [detail, wizard] = await Promise.all([
    contractDetail(db, id, { userId: user.id }, bogotaToday()),
    wizardData(db),
  ]);
  if (!detail) notFound();
  return (
    <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 sm:py-8">
      <ContractDetail
        data={detail}
        team={wizard.team}
        actions={{
          saveText: saveTextAction,
          sendToReview: sendToReviewAction,
          markSigned: markSignedAction,
          terminate: terminateAction,
          saveTerm: saveTermAction,
          extract: extractAction,
          confirmObligation: confirmObligationAction,
          discardObligation: discardObligationAction,
          completeObligation: completeObligationAction,
          addObligation: addObligationAction,
        }}
      />
    </div>
  );
}
