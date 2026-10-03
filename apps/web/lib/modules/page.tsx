import 'server-only';
import { toggleModule } from '@/app/(app)/settings/modulos/actions';
import { ModuleOff } from '@/components/modules/ModuleOff';
import { companyModules } from '@/lib/modules/server';
import { modulePageState } from '@/lib/modules/shape';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { workspaceHref } from '@/lib/workspace-context';
import { type ModuleKey, isCompanyManager } from '@cortex/agent-tools';
import type { ReactElement, ReactNode } from 'react';

/**
 * LA PUERTA DE LA PANTALLA DE UN MÓDULO (0186).
 *
 * Con el módulo prendido devuelve `null` y la página sigue; apagado devuelve
 * la pantalla «Este módulo está apagado» (con «Prenderlo» para quien
 * administra) para que la página la devuelva tal cual, en vez de un 404:
 *
 *   const off = await requireModulePage('payroll');
 *   if (off) return off;
 *
 * Las rutas de los módulos que ya existían la usan desde su `layout.tsx` con
 * `<ModuleGate>`, que cubre también sus subpáginas. La lectura de módulos es
 * la misma del shell (`cache`), así que no cuesta otra consulta.
 */
export async function requireModulePage(key: ModuleKey): Promise<ReactElement | null> {
  const user = await requireSession();
  const enabled = await companyModules(user.organization.id);
  if (enabled.has(key)) return null;
  const canEnable = await isCompanyManager(getOrgScopedClient(user.organization.id), user.id);
  const state = modulePageState(key, enabled, canEnable);
  if (!state.off) return null;
  return (
    <ModuleOff
      state={state}
      toggle={canEnable ? toggleModule : undefined}
      modulesHref={workspaceHref(user.organization.id, '/settings/modulos')}
    />
  );
}

/** Para un `layout.tsx`: la pantalla del módulo, o la de «apagado». */
export async function ModuleGate({
  module,
  children,
}: {
  module: ModuleKey;
  children: ReactNode;
}) {
  const off = await requireModulePage(module);
  return off ?? <>{children}</>;
}
