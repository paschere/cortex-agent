import {
  type CortexModule,
  MODULES,
  type ModuleKey,
  moduleByKey,
} from '@cortex/agent-tools/src/modules/catalog';

/**
 * LA PANTALLA DE MÓDULOS, COMO DATO (0186).
 *
 * Puro y sin base de datos: la página de servidor arma las tarjetas con esto,
 * la pantalla «Este módulo está apagado» decide con esto, y las pruebas corren
 * en Node sin DOM. El catálogo entra por su ruta directa porque es sólo datos.
 */

/** El orden de las áreas en la pantalla: primero la plata, al final los canales. */
export const AREA_ORDER: CortexModule['area'][] = [
  'Plata',
  'Operación',
  'Personas',
  'Legal',
  'Crecimiento',
  'Dirección',
  'Canales',
];

/**
 * Cómo se llama cada pantalla de un módulo para alguien que no sabe rutas.
 * Una ruta que no esté aquí se dice con el nombre del módulo.
 */
export const ROUTE_LABEL: Record<string, string> = {
  '/finance': 'Resumen financiero',
  '/pagar': 'Por pagar',
  '/ventas': 'Ventas',
  '/inventario': 'Inventario y compras',
  '/impuestos': 'Impuestos',
  '/cierre': 'Cierre del mes',
  '/estados': 'Estados financieros',
  '/presupuesto': 'Presupuesto',
  '/nomina': 'Nómina',
  '/sst': 'SG-SST',
  '/contratos': 'Contratos',
  '/cumplimiento': 'Cumplimiento',
  '/comercial': 'Embudo comercial',
  '/proyectos': 'Proyectos',
  '/flota': 'Flota',
  '/documentos-vencen': 'Documentos que vencen',
  '/team': 'Equipo y «Mi semana»',
  '/piloto': 'Piloto automático',
  '/integrations/whatsapp/atencion': 'Atención por WhatsApp',
  '/informe-socios': 'Informe para socios',
  '/prospects': 'Prospectos',
};

export function routeLabel(route: string, module: Pick<CortexModule, 'label'>): string {
  return ROUTE_LABEL[route] ?? module.label;
}

export interface ModuleCard {
  key: ModuleKey;
  label: string;
  description: string;
  beta: boolean;
  enabled: boolean;
  /** Nadie lo ha tocado: está así porque así viene. */
  isDefault: boolean;
  /** Las pantallas que trae, en palabras. */
  screens: Array<{ href: string; label: string }>;
  /** Lo que Cortex puede hacer con él en el chat, en palabras. */
  tools: string[];
  /** «Necesita Finanzas.» / «Lo necesita Cuentas por pagar.» */
  note: string | null;
  /** Módulos que necesita (para prenderlos juntos). */
  requires: ModuleKey[];
  /** Módulos prendidos que lo necesitan: mientras haya, no se apaga. */
  blockedBy: string[];
}

export interface ModuleArea {
  area: CortexModule['area'];
  modules: ModuleCard[];
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} y ${labels[labels.length - 1]}`;
}

/** Quién depende de quién, en palabras. */
export function dependencyText(key: ModuleKey): string | null {
  const m = moduleByKey(key);
  const needs = (m.requires ?? []).map((k) => moduleByKey(k).label);
  const dependents = MODULES.filter((x) => (x.requires ?? []).includes(key)).map((x) => x.label);
  const parts: string[] = [];
  if (needs.length) parts.push(`Necesita ${joinLabels(needs)}.`);
  if (dependents.length) parts.push(`Lo necesita ${joinLabels(dependents)}.`);
  return parts.length ? parts.join(' ') : null;
}

/**
 * Las tarjetas, agrupadas por área y en el orden del catálogo dentro de cada
 * una. `toolLabels` trae, por módulo, el nombre en español de cada herramienta
 * que gobierna (lo arma el servidor con el registro).
 */
export function buildModuleAreas(
  states: ReadonlyArray<{ key: ModuleKey; enabled: boolean; isDefault: boolean }>,
  toolLabels: Partial<Record<ModuleKey, string[]>> = {},
): ModuleArea[] {
  const enabled = new Set(states.filter((s) => s.enabled).map((s) => s.key));
  const byKey = new Map(states.map((s) => [s.key, s]));
  const cards: ModuleCard[] = MODULES.map((m) => {
    const state = byKey.get(m.key);
    return {
      key: m.key,
      label: m.label,
      description: m.description,
      beta: Boolean(m.beta),
      enabled: state ? state.enabled : m.defaultOn,
      isDefault: state ? state.isDefault : true,
      screens: m.routes.map((href) => ({ href, label: routeLabel(href, m) })),
      tools: toolLabels[m.key] ?? [],
      note: dependencyText(m.key),
      requires: m.requires ?? [],
      blockedBy: MODULES.filter(
        (x) => enabled.has(x.key) && (x.requires ?? []).includes(m.key),
      ).map((x) => x.label),
    };
  });
  return AREA_ORDER.map((area) => ({
    area,
    modules: cards.filter((c) => moduleByKey(c.key).area === area),
  })).filter((a) => a.modules.length > 0);
}

/** Lo que dice la pantalla de un módulo: abrirse, o explicar que está apagado. */
export type ModulePageState =
  | { off: false }
  | {
      off: true;
      key: ModuleKey;
      label: string;
      description: string;
      /** Quien administra o es dueño ve «Prenderlo»; los demás, a quién pedírselo. */
      canEnable: boolean;
      /** Lo que se prende con él, si necesita otros. */
      alsoEnables: string[];
    };

export function modulePageState(
  key: ModuleKey,
  enabled: ReadonlySet<ModuleKey>,
  canEnable: boolean,
): ModulePageState {
  if (enabled.has(key)) return { off: false };
  const m = moduleByKey(key);
  return {
    off: true,
    key,
    label: m.label,
    description: m.description,
    canEnable,
    alsoEnables: (m.requires ?? []).filter((k) => !enabled.has(k)).map((k) => moduleByKey(k).label),
  };
}
