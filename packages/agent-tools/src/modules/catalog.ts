/**
 * LOS MÓDULOS DE CORTEX, CON SU INTERRUPTOR.
 *
 * Cada área grande del producto se puede prender o apagar por empresa: una
 * ferretería no necesita órdenes de servicio y una agencia no necesita
 * inventario. Apagar un módulo lo saca del menú, de la paleta, de las
 * herramientas que el agente ve y del piloto automático — no borra datos.
 *
 * Este archivo es el CONTRATO entre quien construye los interruptores (store,
 * pantalla /settings/modulos, filtro del menú y de herramientas) y cada módulo
 * que se construye a la vez. Agregar módulos o campos opcionales sí; cambiar
 * o quitar claves, no (están guardadas en la base).
 *
 * `toolPrefixes`: familias de herramientas que el módulo gobierna (ids que
 * empiezan así). `routes`: pantallas que esconde. `defaultOn`: estado de una
 * empresa que nunca tocó el interruptor. `beta`: se muestra con ese rótulo.
 */

export interface CortexModule {
  key: ModuleKey;
  label: string;
  description: string;
  area: 'Operación' | 'Plata' | 'Personas' | 'Legal' | 'Crecimiento' | 'Dirección' | 'Canales';
  toolPrefixes: string[];
  routes: string[];
  defaultOn: boolean;
  beta?: boolean;
  /** Otros módulos que necesita encendidos para tener sentido. */
  requires?: ModuleKey[];
}

export const MODULE_KEYS = [
  'finance',
  'payables',
  'sales',
  'inventory',
  'taxes',
  'accounting_close',
  'statements',
  'budget',
  'payroll',
  'sst',
  'contracts',
  'compliance',
  'crm',
  'service_orders',
  'fleet',
  'doc_expirations',
  'team',
  'autopilot',
  'whatsapp_service',
  'board_report',
  'prospecting',
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export const MODULES: readonly CortexModule[] = [
  {
    key: 'finance',
    label: 'Finanzas',
    description: 'Caja, proyección a 13 semanas, escenarios, resultados del mes.',
    area: 'Plata',
    toolPrefixes: ['ledger.'],
    routes: ['/finance'],
    defaultOn: true,
  },
  {
    key: 'payables',
    label: 'Cuentas por pagar',
    description: 'Facturas de proveedores, revisión, aprobación y programa de pagos.',
    area: 'Plata',
    toolPrefixes: ['payables.'],
    routes: ['/pagar'],
    defaultOn: true,
    requires: ['finance'],
  },
  {
    key: 'sales',
    label: 'Ventas y facturación',
    description: 'Cotizaciones, pedidos y factura electrónica en Siigo o Alegra.',
    area: 'Plata',
    toolPrefixes: ['sales.'],
    routes: ['/ventas'],
    defaultOn: true,
  },
  {
    key: 'inventory',
    label: 'Inventario y compras',
    description: 'Existencias por bodega, alertas de mínimo y órdenes de compra.',
    area: 'Operación',
    toolPrefixes: ['inventory.', 'purchasing.'],
    routes: ['/inventario'],
    defaultOn: false,
  },
  {
    key: 'taxes',
    label: 'Impuestos',
    description: 'Calendario tributario, trámites DIAN y borradores para el contador.',
    area: 'Plata',
    toolPrefixes: ['tax.'],
    routes: ['/impuestos'],
    defaultOn: true,
  },
  {
    key: 'accounting_close',
    label: 'Cierre contable',
    description: 'Registrar en el programa contable y cerrar el mes con una lista guiada.',
    area: 'Plata',
    toolPrefixes: ['close.', 'accounting.write_'],
    routes: ['/cierre'],
    defaultOn: false,
    beta: true,
  },
  {
    key: 'statements',
    label: 'Estados financieros',
    description: 'Balance y resultados comparativos, indicadores y márgenes.',
    area: 'Plata',
    toolPrefixes: ['statements.'],
    routes: ['/estados'],
    defaultOn: true,
  },
  {
    key: 'budget',
    label: 'Presupuesto y pronósticos',
    description: 'Presupuesto anual contra lo real, pronóstico de ventas y resultados.',
    area: 'Dirección',
    toolPrefixes: ['budget.', 'forecast.'],
    routes: ['/presupuesto'],
    defaultOn: true,
  },
  {
    key: 'payroll',
    label: 'Nómina',
    description: 'Novedades, liquidación, prestaciones, PILA y nómina electrónica.',
    area: 'Personas',
    toolPrefixes: ['payroll.'],
    routes: ['/nomina'],
    defaultOn: false,
    beta: true,
  },
  {
    key: 'sst',
    label: 'Seguridad y salud en el trabajo',
    description: 'SG-SST: plan anual, capacitaciones, incidentes y evidencias.',
    area: 'Personas',
    toolPrefixes: ['sst.'],
    routes: ['/sst'],
    defaultOn: false,
  },
  {
    key: 'contracts',
    label: 'Contratos',
    description: 'Contratos desde plantillas, revisión y obligaciones con sus fechas.',
    area: 'Legal',
    toolPrefixes: ['contracts.'],
    routes: ['/contratos'],
    defaultOn: true,
  },
  {
    key: 'compliance',
    label: 'Cumplimiento',
    description: 'Societario, SIC (bases de datos), PQRS, SAGRILAFT/PTEE y procesos judiciales.',
    area: 'Legal',
    toolPrefixes: ['compliance.'],
    routes: ['/cumplimiento'],
    defaultOn: false,
  },
  {
    key: 'crm',
    label: 'Embudo comercial',
    description: 'Oportunidades por etapa, seguimiento, riesgo de perder clientes y satisfacción.',
    area: 'Crecimiento',
    toolPrefixes: ['crm.'],
    routes: ['/comercial'],
    defaultOn: true,
  },
  {
    key: 'service_orders',
    label: 'Órdenes de servicio y proyectos',
    description: 'Trabajo por cliente con horas, avance, costos y rentabilidad.',
    area: 'Operación',
    toolPrefixes: ['projects.'],
    routes: ['/proyectos'],
    defaultOn: false,
  },
  {
    key: 'fleet',
    label: 'Flota y rutas',
    description: 'Vehículos, documentos, mantenimiento, conductores y rutas.',
    area: 'Operación',
    toolPrefixes: ['vehicles.', 'fleet.'],
    routes: ['/flota'],
    defaultOn: false,
  },
  {
    key: 'doc_expirations',
    label: 'Documentos que vencen',
    description: 'Pólizas, SOAT, licencias y contratos leídos de tus documentos.',
    area: 'Legal',
    // Sólo las tres de vencimientos: `documents.` a secas también nombra la
    // lectura de facturas y guías (documents.extract, .records, .totals…),
    // que es del núcleo y no se apaga con este módulo.
    toolPrefixes: [
      'documents.expiring',
      'documents.confirm_expiration',
      'documents.track_expiration',
    ],
    routes: ['/documentos-vencen'],
    defaultOn: true,
  },
  {
    key: 'team',
    label: 'Equipo',
    description: 'Registro de trabajo, «Mi semana» y señales con evidencia.',
    area: 'Personas',
    toolPrefixes: ['work.'],
    routes: ['/team'],
    defaultOn: true,
  },
  {
    key: 'autopilot',
    label: 'Piloto automático',
    description: 'El plan de cada mañana: hace lo rutinario y te pregunta lo demás.',
    area: 'Dirección',
    toolPrefixes: ['autopilot.'],
    routes: ['/piloto'],
    defaultOn: true,
  },
  {
    key: 'whatsapp_service',
    label: 'Atención por WhatsApp',
    description: 'Responde a tus clientes estado de pedidos, facturas y saldo.',
    area: 'Canales',
    toolPrefixes: ['whatsapp.customer_', 'whatsapp.reply'],
    routes: ['/integrations/whatsapp/atencion'],
    defaultOn: false,
  },
  {
    key: 'board_report',
    label: 'Informe para socios',
    description: 'El informe mensual de gerencia, armado solo, para socios o junta.',
    area: 'Dirección',
    toolPrefixes: ['board.'],
    routes: ['/informe-socios'],
    defaultOn: true,
    requires: ['statements'],
  },
  {
    // Agregado con los interruptores (0186): señales de compra en la web,
    // contacto y primer correo. Un área entera que no toda empresa usa.
    key: 'prospecting',
    label: 'Prospección',
    description:
      'Señales de empresas que podrían comprarte, el contacto indicado y el primer correo.',
    area: 'Crecimiento',
    toolPrefixes: ['growth.'],
    routes: ['/prospects'],
    defaultOn: true,
  },
];

export function moduleByKey(key: ModuleKey): CortexModule {
  const found = MODULES.find((m) => m.key === key);
  if (!found) throw new Error(`Módulo desconocido: ${key}`);
  return found;
}

/** El módulo que gobierna una herramienta, si alguno (el prefijo más largo gana). */
export function moduleForTool(toolId: string): CortexModule | null {
  let best: CortexModule | null = null;
  let len = 0;
  for (const m of MODULES) {
    for (const p of m.toolPrefixes) {
      if (toolId.startsWith(p) && p.length > len) {
        best = m;
        len = p.length;
      }
    }
  }
  return best;
}

/** El módulo que gobierna una ruta, si alguno. */
export function moduleForRoute(path: string): CortexModule | null {
  for (const m of MODULES) {
    for (const r of m.routes) {
      if (path === r || path.startsWith(`${r}/`)) return m;
    }
  }
  return null;
}

/**
 * Lo que implementa el store (la otra mitad del contrato), para que cada
 * módulo pueda llamar `isModuleEnabled(db, 'payroll')` desde ya:
 *
 *   isModuleEnabled(db, key): Promise<boolean>        — default `defaultOn`
 *   enabledModules(db): Promise<Set<ModuleKey>>        — una lectura
 *   setModule(db, { key, enabled, userId }): Promise<void>  — sólo admin/dueño
 *
 * Viven en `modules/store.ts`, exportados desde `modules/index.ts`.
 */
