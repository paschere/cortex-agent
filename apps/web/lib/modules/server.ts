import 'server-only';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { MODULE_KEYS, type ModuleKey, enabledModules } from '@cortex/agent-tools';
import { cache } from 'react';

/**
 * LOS MÓDULOS DE LA EMPRESA, UNA LECTURA POR PETICIÓN.
 *
 * El shell (menú y paleta), la barra del teléfono y la pantalla de un módulo
 * preguntan lo mismo en el mismo render; `cache` de React hace que sea una
 * sola lectura de `company_modules` (0186). Nunca lanza: si la base falla,
 * `enabledModules` cae al estado por defecto del catálogo.
 */
export const companyModules = cache(
  async (organizationId: string): Promise<Set<ModuleKey>> =>
    enabledModules(getOrgScopedClient(organizationId)),
);

/** Lo apagado, como arreglo: lo que se le puede pasar a un componente cliente. */
export async function modulesOffFor(organizationId: string): Promise<ModuleKey[]> {
  const on = await companyModules(organizationId);
  return MODULE_KEYS.filter((k) => !on.has(k));
}
