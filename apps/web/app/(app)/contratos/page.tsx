import { ContractsHome } from '@/components/contracts/ContractsHome';
import { contractsList } from '@/lib/contracts/screen';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { LEGAL_CONTRACT_TYPES, LEGAL_CONTRACT_TYPE_LABEL, bogotaToday } from '@cortex/agent-tools';
import { uploadSignedContractAction } from './actions';

/**
 * CONTRATOS (0195): la lista en la grilla compartida, con su vigencia, su
 * aviso previo y lo que falta (datos por completar, obligaciones por
 * confirmar). Desde aquí se redacta uno nuevo o se sube uno ya firmado.
 */

export const dynamic = 'force-dynamic';

export default async function ContractsPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const { items, hidden } = await contractsList(db, { userId: user.id }, bogotaToday());
  return (
    <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 sm:py-8">
      <ContractsHome
        items={items}
        hidden={hidden}
        types={LEGAL_CONTRACT_TYPES.map((t) => ({ value: t, label: LEGAL_CONTRACT_TYPE_LABEL[t] }))}
        onUpload={uploadSignedContractAction}
      />
    </div>
  );
}
