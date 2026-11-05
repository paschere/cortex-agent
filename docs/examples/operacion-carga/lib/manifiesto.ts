import { N, hay } from './formato';
import type { Guia, Prealerta } from './datos';

/**
 * MANIFIESTO INTELIGENTE: el escaneo trae renglones; aquí se normalizan los
 * números de guía, se cruzan con las prealertas y se marca qué coincide.
 */

/** «176-1234 5678» → «17612345678»: sin espacios ni guiones, en mayúsculas. */
export function normGuia(g: unknown): string {
  return String(g ?? '')
    .toUpperCase()
    .replace(/[\s\-_.\/]+/g, '')
    .trim();
}

/** Normaliza un nombre para comparar (sin tildes, espacios ni signos). */
export function normNombre(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** Número de vuelo comparable: «av 1234» = «AV1234». */
export const normVuelo = (s: unknown): string => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export type EstadoCruce = 'coincide' | 'diferencia' | 'sobrante' | 'repetida' | 'ya_esta';

/** Un renglón editable del manifiesto (todo en texto, como lo escribe la persona). */
export interface Renglon {
  /** Clave estable para React. */
  k: string;
  incluir: boolean;
  guia: string;
  tipo: string;
  madre: string;
  cliente: string;
  piezas: string;
  kilos: string;
  pallets: string;
  /** Prealerta elegida a mano (cuando el renglón nació de una prealerta). */
  prealertaId?: string;
}

export interface Cruce {
  estado: EstadoCruce;
  nota: string;
  prealerta: Prealerta | null;
  clienteId: string;
}

export interface Contexto {
  prealertas: Prealerta[];
  existentes: Guia[];
  clientes: { id: string; label: string }[];
}

/** Busca en un renglón del escaneo el primer alias que traiga valor. */
export function leer(row: Record<string, string | number>, alias: string[]): string {
  const claves = Object.keys(row);
  for (const a of alias) {
    const k = claves.find((c) => normNombre(c).replace(/ /g, '') === normNombre(a).replace(/ /g, ''));
    if (k !== undefined && hay(row[k])) return String(row[k]).trim();
  }
  return '';
}

const A = {
  guia: ['guia', 'guía', 'awb', 'hawb', 'mawb', 'numero_guia', 'numero de guia', 'guide', 'waybill', 'documento'],
  tipo: ['tipo_guia', 'tipo guia', 'tipo'],
  madre: ['guia_madre', 'guia madre', 'master'],
  cliente: ['cliente', 'consignatario', 'consignee', 'destinatario', 'importador'],
  piezas: ['piezas_esperadas', 'piezas', 'pieces', 'pcs', 'bultos'],
  kilos: ['kilos_esperados', 'kilos', 'kg', 'peso', 'weight', 'gross_weight', 'peso bruto'],
  pallets: ['pallets_esperados', 'pallets', 'pallet', 'ulds'],
};

/** Resuelve el id del cliente por nombre normalizado ('' si no hay coincidencia exacta). */
export function clienteId(nombre: string, clientes: { id: string; label: string }[]): string {
  const n = normNombre(nombre);
  if (!n) return '';
  return clientes.find((c) => normNombre(c.label) === n)?.id ?? '';
}

function tipoDe(s: string): string {
  const t = s.toUpperCase();
  if (t.includes('MAWB') || t.includes('MADRE') || t.includes('MASTER')) return 'Madre (MAWB)';
  if (t.includes('HAWB') || t.includes('HIJA') || t.includes('HOUSE')) return 'Hija (HAWB)';
  if (t.includes('DIRECT')) return 'Directa';
  return '';
}

function indicePrealertas(prealertas: Prealerta[]): Map<string, Prealerta> {
  const m = new Map<string, Prealerta>();
  for (const p of prealertas) {
    const k = normGuia(p.guia);
    if (!k) continue;
    const previa = m.get(k);
    // Si hay una Duplicada y una Normal, manda la Normal.
    if (!previa || (previa.estado === 'Duplicada' && p.estado !== 'Duplicada')) m.set(k, p);
  }
  return m;
}

/** Cruza cada renglón por número de guía (normalizado) con las prealertas y con las guías ya cargadas. */
export function evaluar(renglones: Renglon[], ctx: Contexto): Cruce[] {
  const idx = indicePrealertas(ctx.prealertas);
  const yaEstan = new Set(ctx.existentes.map((g) => normGuia(g.guia)));
  const vistas = new Set<string>();
  return renglones.map((r) => {
    const k = normGuia(r.guia);
    const pre = (r.prealertaId ? ctx.prealertas.find((p) => p.id === r.prealertaId) : undefined) ?? idx.get(k) ?? null;
    const cid = clienteId(r.cliente, ctx.clientes);
    let estado: EstadoCruce = 'sobrante';
    let nota = 'No está en las prealertas';
    if (pre) {
      const kilos = r.kilos ? N(r.kilos) : 0;
      if (kilos && pre.kilos && Math.abs(kilos - pre.kilos) > Math.max(0.5, pre.kilos * 0.005)) {
        estado = 'diferencia';
        nota = `Prealerta ${Math.round(pre.kilos * 10) / 10} kg · manifiesto ${Math.round(kilos * 10) / 10} kg`;
      } else {
        estado = 'coincide';
        nota = 'Coincide con la prealerta';
      }
    }
    if (k && vistas.has(k)) {
      estado = 'repetida';
      nota = 'Repetida en el manifiesto';
    } else if (k && yaEstan.has(k)) {
      estado = 'ya_esta';
      nota = 'Ya está en este vuelo';
    }
    if (k) vistas.add(k);
    return { estado, nota, prealerta: pre, clienteId: cid };
  });
}

const sinIncluir: EstadoCruce[] = ['repetida', 'ya_esta'];

/** Convierte lo escaneado (o pegado) en renglones editables. */
export function renglonesDe(rows: Record<string, string | number>[], ctx: Contexto): Renglon[] {
  const idx = indicePrealertas(ctx.prealertas);
  const base: Renglon[] = [];
  rows.forEach((row, i) => {
    const guia = leer(row, A.guia);
    if (!guia) return;
    const pre = idx.get(normGuia(guia));
    const madre = leer(row, A.madre);
    base.push({
      k: `m${Date.now().toString(36)}-${i}`,
      incluir: true,
      guia: guia.toUpperCase().replace(/\s+/g, ''),
      tipo: tipoDe(leer(row, A.tipo)),
      madre: madre && normGuia(madre) !== normGuia(guia) ? madre : '',
      cliente: leer(row, A.cliente) || pre?.cliente || '',
      piezas: leer(row, A.piezas) || (pre?.piezas ? String(pre.piezas) : ''),
      kilos: leer(row, A.kilos) || (pre?.kilos ? String(pre.kilos) : ''),
      pallets: leer(row, A.pallets),
    });
  });
  const cruce = evaluar(base, ctx);
  return base.map((r, i) => ({ ...r, incluir: !sinIncluir.includes(cruce[i]?.estado ?? 'sobrante') }));
}

/** Renglón nacido de una prealerta (faltante que se agrega al vuelo). */
export function renglonDePrealerta(p: Prealerta): Renglon {
  return {
    k: `p${p.id}`,
    incluir: true,
    guia: p.guia.toUpperCase().replace(/\s+/g, ''),
    tipo: '',
    madre: '',
    cliente: p.cliente,
    piezas: p.piezas ? String(p.piezas) : '',
    kilos: p.kilos ? String(p.kilos) : '',
    pallets: '',
    prealertaId: p.id,
  };
}

/** Prealertas del vuelo que NO aparecieron en el manifiesto: faltantes. */
export function faltantes(renglones: Renglon[], delVuelo: Prealerta[], existentes: Guia[]): Prealerta[] {
  const vistos = new Set([...renglones.map((r) => normGuia(r.guia)), ...existentes.map((g) => normGuia(g.guia))]);
  return delVuelo.filter((p) => !vistos.has(normGuia(p.guia)));
}

/** Prealertas que corresponden a un vuelo (mismo número de vuelo normalizado). */
export function prealertasDelVuelo(todas: Prealerta[], numeroVuelo: string, fecha: string): Prealerta[] {
  const n = normVuelo(numeroVuelo);
  if (!n) return [];
  return todas.filter((p) => {
    if (normVuelo(p.numeroVuelo) !== n) return false;
    return !p.fecha || !fecha || p.fecha === fecha;
  });
}

/** Texto pegado («guía [piezas] [kilos]» por línea) → renglones como si vinieran del escaneo. */
export function desdeTexto(texto: string): Record<string, string | number>[] {
  const out: Record<string, string | number>[] = [];
  for (const linea of texto.split(/\r?\n/)) {
    const partes = linea.trim().split(/[\t;,]+|\s{2,}/).map((s) => s.trim()).filter(Boolean);
    if (!partes.length) continue;
    const [guia, a, b] = partes;
    const row: Record<string, string | number> = { guia: guia ?? '' };
    if (partes.length === 2 && a) row.kilos = a;
    if (partes.length >= 3) {
      if (a) row.piezas = a;
      if (b) row.kilos = b;
    }
    out.push(row);
  }
  return out;
}
