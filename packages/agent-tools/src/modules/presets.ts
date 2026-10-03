import type { ModuleKey } from './catalog';

/**
 * «¿QUÉ HACE TU EMPRESA?» — UN PUNTO DE PARTIDA, NO UNA JAULA.
 *
 * Cada respuesta prende los módulos que una empresa así usa casi siempre y
 * apaga los que casi nunca. Lo que no aparece en ninguna de las dos listas se
 * queda como esté. Nada se aplica sin que quien administra lo confirme, y
 * después cada interruptor se mueve suelto en Ajustes › Módulos.
 *
 * Puro y sin importaciones de valor: lo lee la pantalla (componente cliente)
 * por ruta directa, igual que `ledger/forecast-shared`.
 */
export interface ModulePreset {
  key: 'comercio' | 'servicios' | 'logistica' | 'manufactura';
  label: string;
  /** Ejemplos para que alguien se reconozca. */
  examples: string;
  on: ModuleKey[];
  off: ModuleKey[];
}

export const MODULE_PRESETS: readonly ModulePreset[] = [
  {
    key: 'comercio',
    label: 'Comercio',
    examples: 'Tienda, distribuidora, ferretería, almacén',
    on: ['finance', 'payables', 'sales', 'inventory', 'taxes', 'crm', 'whatsapp_service'],
    off: ['service_orders', 'fleet'],
  },
  {
    key: 'servicios',
    label: 'Servicios',
    examples: 'Agencia, consultora, firma, mantenimiento',
    on: ['finance', 'payables', 'sales', 'taxes', 'crm', 'service_orders', 'contracts', 'team'],
    off: ['inventory', 'fleet'],
  },
  {
    key: 'logistica',
    label: 'Logística y transporte',
    examples: 'Transportadora, mensajería, carga, agencia de aduanas',
    on: [
      'finance',
      'payables',
      'sales',
      'taxes',
      'fleet',
      'doc_expirations',
      'sst',
      'service_orders',
    ],
    off: ['inventory'],
  },
  {
    key: 'manufactura',
    label: 'Manufactura',
    examples: 'Fábrica, taller, planta de alimentos, confección',
    on: ['finance', 'payables', 'sales', 'inventory', 'taxes', 'sst', 'budget'],
    off: ['service_orders'],
  },
];

export function presetByKey(key: string): ModulePreset | null {
  return MODULE_PRESETS.find((p) => p.key === key) ?? null;
}
