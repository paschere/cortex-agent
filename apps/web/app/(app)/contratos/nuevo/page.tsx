import { ContractWizard } from '@/components/contracts/ContractWizard';
import { wizardData } from '@/lib/contracts/screen';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { createDraftAction } from '../actions';

/** Redactar un contrato desde una plantilla (0195). */

export const dynamic = 'force-dynamic';

export default async function NewContractPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const data = await wizardData(db);
  return (
    <div className="mx-auto max-w-[1100px] px-4 py-6 sm:px-6 sm:py-8">
      <ContractWizard
        data={data}
        initialTemplate={typeof q.plantilla === 'string' ? q.plantilla : null}
        onCreate={createDraftAction}
      />
    </div>
  );
}
