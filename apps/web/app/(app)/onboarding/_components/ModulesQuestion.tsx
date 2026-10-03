import { MODULE_ACTIONS } from '@/app/(app)/settings/modulos/module-actions';
import { PresetPicker } from '@/components/modules/PresetPicker';
import { Panel } from '@/components/ui/panel';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { workspaceHref } from '@/lib/workspace-context';
import { MODULE_PRESETS, isCompanyManager, readModuleStates } from '@cortex/agent-tools';
import { Boxes, ChevronRight } from 'lucide-react';
import Link from 'next/link';

/**
 * «¿QUÉ HACE TU EMPRESA?» EN LA PUESTA EN MARCHA (0186).
 *
 * Mientras nadie haya tocado un interruptor, quien administra ve la pregunta
 * con su sugerencia de módulos (nada cambia hasta que confirma). Después, o
 * para quien no administra, queda una fila que lleva a Ajustes › Módulos.
 * Una lectura que falle cuesta la tarjeta, nunca la página.
 */
export async function ModulesQuestion({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}) {
  const db = getOrgScopedClient(organizationId);
  const [states, canEdit] = await Promise.all([
    readModuleStates(db).catch(() => null),
    isCompanyManager(db, userId),
  ]);
  if (!states) return null;
  const href = workspaceHref(organizationId, '/settings/modulos');
  const untouched = states.every((s) => s.isDefault);
  if (canEdit && untouched) {
    return (
      <div className="flex flex-col gap-2">
        <PresetPicker
          compact
          presets={MODULE_PRESETS.map(({ key, label, examples }) => ({ key, label, examples }))}
          actions={MODULE_ACTIONS}
        />
        <Link href={href} className="self-end text-sm font-bold text-primary hover:underline">
          Elegir módulo por módulo
        </Link>
      </div>
    );
  }
  const on = states.filter((s) => s.enabled).length;
  return (
    <Panel>
      <Link
        href={href}
        className="flex items-center gap-3 rounded-card px-4 py-3 transition-colors hover:bg-surface-2"
      >
        <Boxes className="h-4 w-4 text-ink-muted" aria-hidden />
        <span className="flex-1 text-sm">
          <span className="font-bold text-ink">Módulos</span>{' '}
          <span className="text-ink-muted">
            · {on} de {states.length} prendidos{canEdit ? '. Cambia lo que usa la empresa.' : '.'}
          </span>
        </span>
        <ChevronRight className="h-4 w-4 text-ink-faint" aria-hidden />
      </Link>
    </Panel>
  );
}
