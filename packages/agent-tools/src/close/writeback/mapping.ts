/**
 * EL PLAN DE CUENTAS CON QUE CORTEX ESCRIBE (migración 0192). Puro.
 *
 * Para causar una compra o registrar un recibo, Cortex tiene que decir a qué
 * cuenta va cada peso. La empresa ya tiene su plan de cuentas (el PUC del
 * Decreto 2650 de 1993, con sus auxiliares) en el programa contable; aquí se
 * guarda sólo lo que Cortex necesita de él:
 *
 *   - cada CATEGORÍA del libro de plata → su cuenta de gasto («arriendo» →
 *     512010 Arrendamientos – construcciones y edificaciones);
 *   - un PROVEEDOR puntual → su cuenta, cuando no es la de su categoría (el
 *     contador de afuera va a 511095 aunque el pago caiga en «otros»);
 *   - los PAPELES fijos de la partida: proveedores nacionales (220505), las
 *     retenciones por pagar (2365xx, 236705, 236801), el IVA descontable
 *     (240810), los clientes (130505) y los bancos (111005, o una por cuenta).
 *
 * Sin fila de la empresa, manda el defecto de abajo: códigos de SUBCUENTA del
 * PUC (seis dígitos), sensatos para una pyme de servicios. El programa puede
 * exigir la AUXILIAR (Siigo: ocho o más dígitos, la que exista en su plan), y
 * por eso la vista previa dice siempre de dónde salió cada cuenta («defecto
 * de Cortex») y la pantalla de cuentas de /cierre deja corregirla. Alegra y
 * QuickBooks no reciben el código sino el id de su propia cuenta: se busca
 * por código en el catálogo del programa y, si no aparece, se guarda a mano
 * en `provider_refs`.
 *
 * El orden de resolución, de lo más puntual a lo más general:
 *   proveedor → categoría → defecto de la categoría → «otros gastos».
 */

export type MapScope = 'categoria' | 'proveedor' | 'rol';

export interface AccountMapRow {
  id?: string;
  scope: MapScope;
  key: string;
  account_code: string;
  account_name: string | null;
  cost_center: string | null;
  provider_refs: Partial<Record<'alegra' | 'quickbooks' | 'siigo', string>> | null;
  updated_at?: string;
}

export interface ResolvedAccount {
  code: string;
  name: string;
  costCenter: string | null;
  refs: Partial<Record<'alegra' | 'quickbooks' | 'siigo', string>>;
  /** De dónde salió, para la vista previa. */
  source: 'proveedor' | 'categoria' | 'rol' | 'defecto';
}

/** Los papeles fijos de una partida. */
export const ROLE_KEYS = [
  'proveedores',
  'clientes',
  'banco',
  'iva_descontable',
  'retefuente_compras',
  'retefuente_servicios',
  'retefuente_honorarios',
  'reteiva',
  'reteica',
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const ROLE_DEFAULTS: Record<RoleKey, { code: string; name: string }> = {
  proveedores: { code: '220505', name: 'Proveedores nacionales' },
  clientes: { code: '130505', name: 'Clientes nacionales' },
  banco: { code: '111005', name: 'Bancos – moneda nacional' },
  iva_descontable: { code: '240810', name: 'IVA descontable por compras y servicios' },
  retefuente_compras: { code: '236540', name: 'Retención en la fuente por pagar – compras' },
  retefuente_servicios: { code: '236525', name: 'Retención en la fuente por pagar – servicios' },
  retefuente_honorarios: { code: '236515', name: 'Retención en la fuente por pagar – honorarios' },
  reteiva: { code: '236705', name: 'Retención de IVA por pagar (reteIVA)' },
  reteica: { code: '236801', name: 'Retención de ICA por pagar (reteICA)' },
};

export const ROLE_LABEL: Record<RoleKey, string> = {
  proveedores: 'Cuentas por pagar a proveedores',
  clientes: 'Cuentas por cobrar a clientes',
  banco: 'Banco (por defecto)',
  iva_descontable: 'IVA descontable',
  retefuente_compras: 'Retención en la fuente – compras',
  retefuente_servicios: 'Retención en la fuente – servicios',
  retefuente_honorarios: 'Retención en la fuente – honorarios',
  reteiva: 'ReteIVA',
  reteica: 'ReteICA',
};

/** Gasto por categoría del libro de plata (ledger/types.ts › LEDGER_CATEGORIES). */
export const CATEGORY_DEFAULTS: Record<string, { code: string; name: string }> = {
  nomina: { code: '510506', name: 'Sueldos' },
  arriendo: { code: '512010', name: 'Arrendamientos – construcciones y edificaciones' },
  servicios_publicos: { code: '513530', name: 'Servicios públicos (energía y otros)' },
  transporte: { code: '513550', name: 'Transporte, fletes y acarreos' },
  proveedores: { code: '6205', name: 'Compras de mercancías' },
  impuestos: { code: '511595', name: 'Impuestos – otros' },
  bancos_y_financieros: { code: '530505', name: 'Gastos bancarios' },
  software: { code: '513520', name: 'Procesamiento electrónico de datos (software)' },
  mercadeo: { code: '523560', name: 'Publicidad, propaganda y promoción' },
  mantenimiento: { code: '514510', name: 'Mantenimiento de construcciones y edificaciones' },
  honorarios: { code: '511095', name: 'Honorarios – otros' },
  otros_gastos: { code: '519595', name: 'Gastos diversos – otros' },
};

export const FALLBACK_EXPENSE = CATEGORY_DEFAULTS.otros_gastos as { code: string; name: string };

export function bankRoleKey(accountName: string): string {
  return `banco:${accountName.toLowerCase().replace(/\s+/g, ' ').trim()}`.slice(0, 120);
}

function fromRow(row: AccountMapRow, source: ResolvedAccount['source']): ResolvedAccount {
  return {
    code: row.account_code,
    name: row.account_name ?? row.account_code,
    costCenter: row.cost_center,
    refs: { ...(row.provider_refs ?? {}) },
    source,
  };
}

export class AccountMap {
  private readonly byKey = new Map<string, AccountMapRow>();

  constructor(rows: readonly AccountMapRow[]) {
    for (const r of rows) this.byKey.set(`${r.scope}|${r.key}`, r);
  }

  private row(scope: MapScope, key: string | null | undefined): AccountMapRow | undefined {
    return key ? this.byKey.get(`${scope}|${key}`) : undefined;
  }

  /** La cuenta del gasto de una compra: proveedor → categoría → defecto. */
  expense(input: { supplierId?: string | null; category?: string | null }): ResolvedAccount {
    const bySupplier = this.row('proveedor', input.supplierId);
    if (bySupplier) return fromRow(bySupplier, 'proveedor');
    const category = input.category ?? 'proveedores';
    const byCategory = this.row('categoria', category);
    if (byCategory) return fromRow(byCategory, 'categoria');
    const def = CATEGORY_DEFAULTS[category] ?? FALLBACK_EXPENSE;
    return { code: def.code, name: def.name, costCenter: null, refs: {}, source: 'defecto' };
  }

  role(role: RoleKey): ResolvedAccount {
    const r = this.row('rol', role);
    if (r) return fromRow(r, 'rol');
    const def = ROLE_DEFAULTS[role];
    return { code: def.code, name: def.name, costCenter: null, refs: {}, source: 'defecto' };
  }

  /** El banco de una cuenta del extracto, o el banco por defecto. */
  bank(accountName: string | null | undefined): ResolvedAccount {
    const r = accountName ? this.row('rol', bankRoleKey(accountName)) : undefined;
    return r ? fromRow(r, 'rol') : this.role('banco');
  }

  /** Qué retención en la fuente usa el gasto (compras, servicios u honorarios). */
  withholdingRole(category: string | null | undefined): RoleKey {
    if (category === 'honorarios') return 'retefuente_honorarios';
    if (category === 'proveedores' || !category) return 'retefuente_compras';
    return 'retefuente_servicios';
  }

  rows(): AccountMapRow[] {
    return [...this.byKey.values()];
  }
}

/** Valida lo que llega de la pantalla. Devuelve el porqué en español, o null. */
export function validateMapRow(input: {
  scope: string;
  key: string;
  accountCode: string;
  costCenter?: string | null;
}): string | null {
  if (!['categoria', 'proveedor', 'rol'].includes(input.scope)) return 'Tipo de cuenta no válido.';
  if (!input.key || input.key.trim().length < 2) return 'Falta a qué se aplica la cuenta.';
  if (!/^[0-9]{4,10}$/.test(input.accountCode.trim()))
    return 'El código de la cuenta son de 4 a 10 dígitos del PUC (sin puntos), por ejemplo 51352001.';
  if (
    input.scope === 'rol' &&
    !ROLE_KEYS.includes(input.key as RoleKey) &&
    !input.key.startsWith('banco:')
  )
    return 'Ese papel de la partida no existe.';
  if (input.costCenter && input.costCenter.length > 40) return 'El centro de costo es muy largo.';
  return null;
}
