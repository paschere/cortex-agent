import { MODULES, type ModuleKey } from '@cortex/agent-tools';
import { AREA_ORDER, routeLabel } from './shape';

/**
 * «TODAS LAS ÁREAS»: EL LANZADOR DE MÓDULOS.
 *
 * El menú lateral se mantiene corto a propósito (ver `moreGroups`), así que los
 * módulos —nómina, contratos, estados financieros, proyectos…— necesitaban un
 * lugar donde encontrarse sin saberse la ruta ni el atajo ⌘K. Esta es esa
 * pantalla: las áreas que la empresa tiene prendidas, cada una con sus
 * pantallas, y cuántos módulos quedan apagados con el enlace para prenderlos.
 *
 * Puro: recibe lo prendido y devuelve qué pintar. Sin lecturas.
 */

export interface LauncherLink {
  href: string;
  label: string;
  description: string;
  moduleKey: ModuleKey;
  beta: boolean;
}

export interface LauncherArea {
  area: string;
  links: LauncherLink[];
}

export interface Launcher {
  areas: LauncherArea[];
  /** Módulos apagados, para ofrecer prenderlos. */
  off: Array<{ key: ModuleKey; label: string; area: string }>;
}

export function buildLauncher(on: ReadonlySet<ModuleKey>): Launcher {
  const byArea = new Map<string, LauncherLink[]>();
  const off: Launcher['off'] = [];
  for (const m of MODULES) {
    if (!on.has(m.key)) {
      off.push({ key: m.key, label: m.label, area: m.area });
      continue;
    }
    const links = byArea.get(m.area) ?? [];
    for (const route of m.routes) {
      links.push({
        href: route,
        label: routeLabel(route, m),
        description: m.description,
        moduleKey: m.key,
        beta: Boolean(m.beta),
      });
    }
    byArea.set(m.area, links);
  }
  const order = (a: string) => {
    const i = AREA_ORDER.indexOf(a as (typeof AREA_ORDER)[number]);
    return i === -1 ? AREA_ORDER.length : i;
  };
  const areas = [...byArea.entries()]
    .filter(([, links]) => links.length > 0)
    .sort(([a], [b]) => order(a) - order(b))
    .map(([area, links]) => ({ area, links }));
  return { areas, off };
}
