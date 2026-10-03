import { ModulesScreen } from '@/components/modules/ModulesScreen';
import { PageHeader } from '@/components/ui/page-header';
import { buildModuleAreas } from '@/lib/modules/shape';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { toolLabel } from '@/lib/tool-labels';
import {
  MODULE_PRESETS,
  type ModuleKey,
  isCompanyManager,
  listTools,
  moduleForTool,
  readModuleStates,
} from '@cortex/agent-tools';
import { Boxes } from 'lucide-react';
import { MODULE_ACTIONS } from './module-actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Módulos · Cortex' };

/**
 * AJUSTES › MÓDULOS (0186): qué áreas de Cortex usa esta empresa.
 *
 * Cualquiera de la empresa la ve; prender y apagar es de quien administra o
 * es dueño, y lo vuelve a comprobar la acción de servidor.
 */
export default async function ModulosPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const [states, canEdit] = await Promise.all([
    readModuleStates(db),
    isCompanyManager(db, user.id),
  ]);

  // Lo que Cortex puede hacer con cada módulo en el chat, en español.
  const toolLabels: Partial<Record<ModuleKey, string[]>> = {};
  for (const t of listTools()) {
    const m = moduleForTool(t.id);
    if (!m) continue;
    const list = toolLabels[m.key] ?? [];
    list.push(toolLabel(t.id).label);
    toolLabels[m.key] = list;
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 pb-10">
      <PageHeader
        title="Módulos"
        subtitle="Prende lo que tu empresa usa y apaga lo que no. Lo apagado sale del menú, del chat y del piloto automático, y sus datos quedan guardados."
        icon={<Boxes className="h-5 w-5" aria-hidden />}
      />
      <ModulesScreen
        areas={buildModuleAreas(states, toolLabels)}
        canEdit={canEdit}
        actions={MODULE_ACTIONS}
        presets={MODULE_PRESETS.map(({ key, label, examples }) => ({ key, label, examples }))}
        workspaceId={user.organization.id}
      />
    </div>
  );
}
