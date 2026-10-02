import { normalizeHeader } from './format';

/**
 * Qué banco exportó el archivo y qué significa cada columna.
 *
 * DOS PREGUNTAS DISTINTAS Y SÓLO UNA IMPORTA PARA EL DINERO. Saber que el
 * archivo es de Bancolombia sirve para decirlo en la vista previa y para
 * preferir sus nombres de columna; lo que de verdad decide qué entra es el
 * PAPEL de cada columna (fecha, descripción, débito, crédito, saldo…), y ése se
 * reconoce por el encabezado con la misma lista de sinónimos para todos los
 * bancos. Por eso un banco que no está aquí no es un error: es el perfil
 * genérico, que lee igual cualquier extracto con encabezados reconocibles.
 *
 * LOS PERFILES ESTÁN HECHOS SOBRE LOS FORMATOS PÚBLICOS CONOCIDOS de la banca
 * en línea de cada banco (Excel/CSV de movimientos). Los bancos cambian sus
 * exportaciones sin avisar; cuando una columna no se reconoce, la pantalla
 * enseña los encabezados que encontró y deja escoger, en vez de adivinar.
 */

export type BankId = 'bancolombia' | 'davivienda' | 'bbva' | 'bogota' | 'generic';

export interface BankProfile {
  id: BankId;
  label: string;
  /** Cómo aparece el nombre del banco en las primeras filas o en el nombre del archivo. */
  names: RegExp;
  /**
   * Conjuntos de encabezados (normalizados) que, juntos, delatan el formato.
   * Basta con que uno de los conjuntos esté completo.
   */
  signatures: string[][];
  /**
   * El banco exporta UN valor con signo (salidas en negativo). Con esto, un
   * archivo que sólo trae abonos —un periodo sin salidas— se lee como abonos y
   * no como «valor sin signo, no sé qué es».
   */
  signedAmounts: boolean;
}

export const BANK_PROFILES: BankProfile[] = [
  {
    id: 'bancolombia',
    label: 'Bancolombia',
    names: /bancolombia/i,
    // Sucursal Virtual Empresas: FECHA | DESCRIPCIÓN | SUCURSAL | DCTO. | VALOR | SALDO
    signedAmounts: true,
    signatures: [
      ['sucursal', 'dcto'],
      ['sucursal canal', 'valor'],
    ],
  },
  {
    id: 'davivienda',
    label: 'Davivienda',
    names: /davivienda|daviplata/i,
    // Fecha de Sistema | Documento | Descripción motivo | Transacción |
    // Oficina de Recaudo | ID Origen/Destino | Valor Total | Referencia 1 | Referencia 2
    signedAmounts: true,
    signatures: [['descripcion motivo'], ['oficina de recaudo'], ['id origen destino']],
  },
  {
    id: 'bbva',
    label: 'BBVA',
    names: /\bbbva\b/i,
    // Fecha Operación | Fecha Valor | Código | Concepto | Importe | Saldo
    signedAmounts: true,
    signatures: [
      ['fecha operacion', 'fecha valor'],
      ['f operacion', 'f valor'],
    ],
  },
  {
    id: 'bogota',
    label: 'Banco de Bogotá',
    names: /banco\s*de\s*bogot|bancodebogota|bco\.?\s*bogot/i,
    // Fecha | Transacción | Oficina | Documento | Débitos | Créditos | Saldo
    signedAmounts: false,
    signatures: [['transaccion', 'oficina', 'debitos', 'creditos']],
  },
];

export const GENERIC_PROFILE: BankProfile = {
  id: 'generic',
  label: 'Otro banco',
  names: /$^/,
  signatures: [],
  signedAmounts: false,
};

export function profileOf(id: BankId | null | undefined): BankProfile {
  return BANK_PROFILES.find((p) => p.id === id) ?? GENERIC_PROFILE;
}

/**
 * El banco, por lo que dicen las primeras filas, el nombre del archivo y los
 * encabezados. El nombre escrito pesa más que la forma: un extracto que dice
 * «BANCOLOMBIA» arriba es de Bancolombia aunque alguien le haya cambiado una
 * columna.
 */
export function detectBank(input: {
  headers: string[];
  preamble: string;
  fileName?: string | null;
}): { profile: BankProfile; by: 'name' | 'headers' | 'none' } {
  const text = `${input.preamble} ${input.fileName ?? ''}`;
  const headers = new Set(input.headers.map(normalizeHeader));
  let best: { profile: BankProfile; score: number; by: 'name' | 'headers' } | null = null;
  for (const profile of BANK_PROFILES) {
    let score = 0;
    let by: 'name' | 'headers' = 'headers';
    if (profile.names.test(text)) {
      score += 3;
      by = 'name';
    }
    if (profile.signatures.some((set) => set.every((h) => headers.has(h)))) score += 2;
    if (score > 0 && (!best || score > best.score)) best = { profile, score, by };
  }
  return best ? { profile: best.profile, by: best.by } : { profile: GENERIC_PROFILE, by: 'none' };
}

// ---------------------------------------------------------------------------
// El papel de cada columna
// ---------------------------------------------------------------------------

export type ColumnRole =
  | 'date'
  | 'description'
  | 'reference'
  | 'reference2'
  | 'txid'
  | 'amount'
  | 'debit'
  | 'credit'
  | 'balance'
  | 'direction'
  | 'nit'
  | 'counterparty'
  | 'branch';

export const COLUMN_ROLES: ColumnRole[] = [
  'date',
  'description',
  'reference',
  'reference2',
  'txid',
  'amount',
  'debit',
  'credit',
  'balance',
  'direction',
  'nit',
  'counterparty',
  'branch',
];

/** Cómo se llama cada papel en la pantalla. */
export const ROLE_LABEL: Record<ColumnRole, string> = {
  date: 'Fecha',
  description: 'Descripción',
  reference: 'Referencia',
  reference2: 'Referencia 2',
  txid: 'Id de la transacción',
  amount: 'Valor (con signo)',
  debit: 'Débitos (salidas)',
  credit: 'Créditos (entradas)',
  balance: 'Saldo',
  direction: 'Tipo (débito/crédito)',
  nit: 'NIT de quien paga',
  counterparty: 'Nombre de quien paga',
  branch: 'Oficina',
};

/**
 * Sinónimos EXACTOS por papel, ya normalizados. El orden de los papeles
 * importa: un encabezado se queda con el primer papel que lo nombra, así que
 * «fecha valor» (la de BBVA que no es la del movimiento) sólo se usa como fecha
 * si no hubo otra.
 */
const SYNONYMS: Array<[ColumnRole, string[]]> = [
  [
    'date',
    [
      'fecha',
      'fecha movimiento',
      'fecha de movimiento',
      'fecha transaccion',
      'fecha de transaccion',
      'fecha operacion',
      'fecha de operacion',
      'f operacion',
      'fecha de sistema',
      'fecha sistema',
      'fecha contable',
      'fecha aplicacion',
      'fecha de aplicacion',
      'fecha mov',
      'date',
      'fecha valor',
      'f valor',
    ],
  ],
  [
    'txid',
    [
      'id transaccion',
      'id de transaccion',
      'numero transaccion',
      'numero de transaccion',
      'no transaccion',
      'nro transaccion',
      'num transaccion',
      'id movimiento',
      'numero de operacion',
      'numero operacion',
      'no operacion',
      'nro operacion',
      'consecutivo',
      'codigo unico',
      'transaction id',
      'id',
    ],
  ],
  [
    'description',
    [
      'descripcion',
      'descripcion motivo',
      'descripcion movimiento',
      'descripcion de la transaccion',
      'concepto',
      'detalle',
      'detalle movimiento',
      'detalle de la transaccion',
      'transaccion',
      'movimiento',
      'glosa',
      'observaciones',
      'description',
      'narrativa',
    ],
  ],
  [
    'reference',
    [
      'referencia',
      'referencia 1',
      'referencia1',
      'ref',
      'ref 1',
      'documento',
      'dcto',
      'doc',
      'no documento',
      'numero documento',
      'numero de documento',
      'nro documento',
      'num documento',
      'comprobante',
      'referencia del pago',
    ],
  ],
  ['reference2', ['referencia 2', 'referencia2', 'ref 2', 'referencia adicional']],
  [
    'credit',
    [
      'credito',
      'creditos',
      'abono',
      'abonos',
      'consignacion',
      'consignaciones',
      'deposito',
      'depositos',
      'entrada',
      'entradas',
      'ingreso',
      'ingresos',
      'valor credito',
      'credit',
      'haber',
    ],
  ],
  [
    'debit',
    [
      'debito',
      'debitos',
      'cargo',
      'cargos',
      'retiro',
      'retiros',
      'salida',
      'salidas',
      'egreso',
      'egresos',
      'valor debito',
      'debit',
      'debe',
    ],
  ],
  [
    'amount',
    [
      'valor',
      'monto',
      'importe',
      'valor total',
      'valor transaccion',
      'valor de la transaccion',
      'valor movimiento',
      'amount',
    ],
  ],
  [
    'balance',
    ['saldo', 'saldo disponible', 'saldo total', 'saldo final', 'saldo actual', 'balance'],
  ],
  [
    'direction',
    [
      'tipo',
      'naturaleza',
      'tipo movimiento',
      'tipo de movimiento',
      'debito credito',
      'd c',
      'db cr',
      'cr db',
      'signo',
    ],
  ],
  [
    'nit',
    [
      'nit',
      'nit originador',
      'id origen destino',
      'identificacion',
      'documento originador',
      'nit cc',
      'cedula nit',
      'nit ordenante',
      'id originador',
    ],
  ],
  [
    'counterparty',
    ['nombre', 'nombre originador', 'tercero', 'ordenante', 'beneficiario', 'nombre tercero'],
  ],
  ['branch', ['sucursal', 'oficina', 'oficina de recaudo', 'sucursal canal', 'canal']],
];

export type ColumnMap = Partial<Record<ColumnRole, number>>;

/** El papel de cada columna según su encabezado. Cada papel, una sola columna. */
export function mapColumns(headers: string[]): ColumnMap {
  const normalized = headers.map(normalizeHeader);
  const out: ColumnMap = {};
  const taken = new Set<number>();
  for (const [role, names] of SYNONYMS) {
    // El sinónimo que aparezca primero en la lista gana, no la columna que
    // aparezca primero en el archivo: «fecha» antes que «fecha valor».
    for (const name of names) {
      const idx = normalized.findIndex((h, i) => h === name && !taken.has(i));
      if (idx >= 0) {
        out[role] = idx;
        taken.add(idx);
        break;
      }
    }
  }
  return out;
}

/** ¿Este mapa basta para leer dinero? Fecha, y o un valor con signo o créditos. */
export function mapIsUsable(map: ColumnMap): boolean {
  return map.date != null && (map.amount != null || map.credit != null);
}
