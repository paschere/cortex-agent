import type { WorkspaceKind } from '@cortex/core';
import { Building2 } from 'lucide-react';

export function CorporateSupervisionNotice({ kind }: { kind?: WorkspaceKind }) {
  if (kind !== 'company') return null;
  // Una línea discreta: el aviso tiene que estar (la persona sabe que su
  // trabajo aquí es de la empresa), pero no merece una tarjeta en el pie.
  return (
    <p className="flex items-center gap-1.5 px-2 text-micro leading-snug text-ink-faint">
      <Building2 className="h-3 w-3 shrink-0" aria-hidden />
      <span>Los fundadores pueden revisar el trabajo en esta empresa.</span>
    </p>
  );
}
