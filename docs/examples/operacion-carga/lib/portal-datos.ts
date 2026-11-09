/**
 * PORTAL DE CLIENTES — datos y reglas puras de «Mis prealertas».
 *
 * Todo lo que usa la pantalla portal.tsx y que se puede probar sin pantalla:
 * validación de guías (AWB), lectura de lo pegado desde Excel, estado legible para el cliente
 * y lectura de SUS prealertas. No importa nada de datos.ts / ui.tsx a propósito: el portal lo ve
 * alguien de afuera y no debe arrastrar las lecturas internas (vuelos, tareas, costos) que otras
 * pantallas hacen y que el servidor le negaría.
 */
import { cortex } from '@cortex/app-sdk';
import type { SdkRow } from '@cortex/app-sdk';

/* ───────────── Guía aérea (AWB) ───────────── */

/** Solo dígitos: «176-1234 5675» → «17612345675». */
export const soloDigitos = (s: string): string => s.replace(/\D/g, '');

/** Para comparar guías: sin espacios, guiones ni mayúsculas. */
export const normGuia = (s: unknown): string =>
  String(s ?? '')
    .toUpperCase()
    .replace(/[\s\-_.\/]+/g, '')
    .trim();

export type VeredictoGuia =
  | { ok: true; formateada: string; control: boolean; esperado?: number }
  | { ok: false; motivo: string };

/**
 * Guía aérea IATA: 3 dígitos de prefijo + 8 de serie; el último dígito es la serie (7 primeros) mod 7.
 * `control: false` = el formato está bien pero el dígito de control no cuadra (aviso: probablemente un error de digitación).
 */
export function revisarGuia(texto: string): VeredictoGuia {
  const t = texto.trim();
  if (!t) return { ok: false, motivo: 'Escribe el número de guía.' };
  if (/[^\d\s\-]/.test(t)) return { ok: false, motivo: 'La guía solo lleva números (ej. 176-12345675).' };
  const d = soloDigitos(t);
  if (d.length !== 11) return { ok: false, motivo: d.length < 11 ? `Faltan dígitos: son 11 (3 de prefijo y 8 de serie), tienes ${d.length}.` : `Sobran dígitos: son 11 (3 de prefijo y 8 de serie), tienes ${d.length}.` };
  const serie = d.slice(3);
  const esperado = Number(serie.slice(0, 7)) % 7;
  const control = esperado === Number(serie.slice(7));
  return { ok: true, formateada: `${d.slice(0, 3)}-${serie}`, control, esperado };
}

/* ───────────── Números ───────────── */

/** «1.234,5» o «1,234.5» o «12,5» → 1234.5 / 12.5. Vacío o ilegible → null. */
export function aNumero(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v ?? '').trim().replace(/\s/g, '');
  if (!s) return null;
  const coma = s.lastIndexOf(',');
  const punto = s.lastIndexOf('.');
  if (coma >= 0 && punto >= 0) s = coma > punto ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (coma >= 0) s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export const num = (n: number, dec = 0): string => n.toLocaleString('es-CO', { maximumFractionDigits: dec, minimumFractionDigits: 0 });

/* ───────────── Fecha ───────────── */

const MESES: Record<string, string> = { ene: '01', jan: '01', feb: '02', mar: '03', abr: '04', apr: '04', may: '05', jun: '06', jul: '07', ago: '08', aug: '08', sep: '09', set: '09', oct: '10', nov: '11', dic: '12', dec: '12' };

/** Fecha en ISO (YYYY-MM-DD) desde lo que pegue el cliente: 2026-11-09, 09/11/2026, 9-nov-26, 9 nov 2026. Si no se entiende: ''. */
export function aFechaIso(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return '';
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return ok(m[1]!, m[2]!, m[3]!);
  m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/.exec(s);
  if (m) return ok(m[3]!.length === 2 ? `20${m[3]}` : m[3]!, m[2]!, m[1]!); // día/mes/año (Colombia)
  m = /^(\d{1,2})[\s\-\/]*([a-zñ]{3})[a-zñ]*\.?[\s\-\/,]*(\d{2,4})?/.exec(s);
  if (m && MESES[m[2]!]) return ok(m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : String(new Date().getFullYear()), MESES[m[2]!]!, m[1]!);
  return '';
}
function ok(a: string, m: string, d: string): string {
  const y = Number(a);
  const mm = Number(m);
  const dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || y < 2000 || y > 2100) return '';
  return `${String(y)}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

export const fechaLinda = (iso: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso;
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

/* ───────────── Pegado desde Excel ───────────── */

export interface RenglonPegado {
  guia: string;
  vuelo: string;
  fecha: string;
  origen: string;
  piezas: string;
  kilos: string;
  descripcion: string;
}

type Col = keyof RenglonPegado;
const ALIAS: Record<Col, string[]> = {
  guia: ['guia', 'awb', 'hawb', 'mawb', 'waybill', 'numero de guia', 'no guia', 'guia aerea', 'documento'],
  vuelo: ['vuelo', 'numero de vuelo', 'no vuelo', 'flight', 'flight number', 'numero vuelo'],
  fecha: ['fecha', 'fecha estimada', 'fecha de llegada', 'eta', 'llegada', 'fecha estimada de llegada', 'date'],
  origen: ['origen', 'procedencia', 'origin', 'ciudad de origen'],
  piezas: ['piezas', 'pcs', 'pieces', 'bultos', 'cajas', 'paquetes'],
  kilos: ['kilos', 'kg', 'peso', 'weight', 'kgs', 'peso kg', 'peso bruto'],
  descripcion: ['descripcion', 'descripcion de la carga', 'mercancia', 'contenido', 'naturaleza', 'description', 'carga'],
};
const ORDEN_SIN_ENCABEZADO: Col[] = ['guia', 'vuelo', 'fecha', 'origen', 'piezas', 'kilos', 'descripcion'];

const limpiarTitulo = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function colDe(titulo: string): Col | null {
  const t = limpiarTitulo(titulo);
  if (!t) return null;
  for (const [col, alias] of Object.entries(ALIAS) as [Col, string[]][]) if (alias.includes(t)) return col;
  return null;
}

const vacio = (): RenglonPegado => ({ guia: '', vuelo: '', fecha: '', origen: '', piezas: '', kilos: '', descripcion: '' });

/** ¿Un texto parece una guía (11 dígitos con o sin guion)? Sirve para detectar si la primera fila es encabezado. */
const pareceGuia = (s: string): boolean => soloDigitos(s).length >= 8 && !/[a-z]{3,}/i.test(s);

/**
 * Texto pegado desde Excel (separado por tabulaciones) o escrito a mano («guía; piezas; kilos» por línea).
 * Con encabezado reconoce las columnas por su nombre (en cualquier orden); sin encabezado asume
 * Guía, Vuelo, Fecha, Origen, Piezas, Kilos, Descripción. Si solo hay 3 columnas y la primera es la guía,
 * se toman como Guía, Piezas, Kilos.
 */
export function leerPegado(texto: string): RenglonPegado[] {
  const lineas = texto
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim());
  if (!lineas.length) return [];
  const celdas = lineas.map((l) => (l.includes('\t') ? l.split('\t') : l.split(/;|\s{2,}/)).map((c) => c.trim().replace(/^"|"$/g, '')));
  const primera = celdas[0]!;
  const mapa = primera.map(colDe);
  const hayEncabezado = mapa.filter(Boolean).length >= 2 || (mapa.includes('guia') && !primera.some(pareceGuia));
  let cols: (Col | null)[];
  let cuerpo = celdas;
  if (hayEncabezado) {
    cols = mapa;
    cuerpo = celdas.slice(1);
  } else {
    const ancho = Math.max(...celdas.map((c) => c.length));
    cols = ancho <= 3 ? (['guia', 'piezas', 'kilos'] as Col[]).slice(0, ancho) : ORDEN_SIN_ENCABEZADO;
    if (ancho === 2) cols = ['guia', 'kilos'];
  }
  const out: RenglonPegado[] = [];
  for (const fila of cuerpo) {
    const r = vacio();
    fila.forEach((c, i) => {
      const col = cols[i];
      if (col && c) r[col] = c;
    });
    if (r.guia || r.vuelo || r.piezas || r.kilos) out.push(r);
  }
  return out.slice(0, 500);
}

/* ───────────── Estado legible para el cliente ───────────── */

export type Tono = 'good' | 'warn' | 'bad' | 'info' | 'neutral' | 'quiet';

export interface Prealerta {
  id: string;
  guia: string;
  numeroVuelo: string;
  aerolinea: string;
  origen: string;
  fecha: string;
  piezas: number | null;
  kilos: number | null;
  descripcion: string;
  documentos: { url: string; name: string }[];
  estado: string;
  estadoCruce: string;
  tieneVuelo: boolean;
  cancelacion: string;
  canal: string;
  creada: string;
}

const T = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? String((v as { label?: unknown }).label ?? '') : String(v));
const relTiene = (v: unknown): boolean => (v && typeof v === 'object' ? Boolean((v as { id?: unknown }).id) : typeof v === 'string' && v.trim() !== '');

function archivosDe(v: unknown): { url: string; name: string }[] {
  let x: unknown = v;
  if (typeof x === 'string') {
    try {
      x = JSON.parse(x);
    } catch {
      return [];
    }
  }
  const lista = Array.isArray(x) ? x : x && typeof x === 'object' ? [x] : [];
  return lista
    .map((a) => a as { url?: unknown; name?: unknown })
    .filter((a) => typeof a.url === 'string' && a.url)
    .map((a) => ({ url: String(a.url), name: String(a.name ?? 'Documento') }));
}

export function aPrealerta(r: SdkRow): Prealerta {
  const v = r.values;
  return {
    id: r.id,
    guia: T(v.guia) || r.label,
    numeroVuelo: T(v.numero_vuelo),
    aerolinea: T(v.aerolinea),
    origen: T(v.origen),
    fecha: T(v.fecha_estimada).slice(0, 10),
    piezas: aNumero(v.piezas),
    kilos: aNumero(v.kilos),
    descripcion: T(v.descripcion_carga),
    documentos: archivosDe(v.documento),
    estado: T(v.estado),
    estadoCruce: T(v.estado_cruce),
    tieneVuelo: relTiene(v.vuelo),
    cancelacion: T(v.cancelacion),
    canal: T(v.canal),
    creada: r.created_at,
  };
}

export type Etapa = 'recibida' | 'cruzada' | 'cerrada';

export interface EstadoCliente {
  /** Lo que lee el cliente. */
  texto: string;
  tono: Tono;
  /** Cuántos pasos de la línea (Recibida → Cruzada con vuelo → Carga recibida) ya van. */
  paso: 1 | 2 | 3;
  /** Frase corta de qué sigue. */
  sigue: string;
  novedad: boolean;
  /** Se puede corregir o cancelar: todavía no la cruzamos con un vuelo. */
  editable: boolean;
  cancelada: boolean;
}

/**
 * De los campos internos (estado, estado_cruce, vuelo, cancelacion) al lenguaje del cliente.
 * Recibida → Cruzada con vuelo → Carga recibida / Con novedad. Lo interno («Sin vuelo», «Duplicada»)
 * no se muestra tal cual.
 */
export function estadoCliente(p: Prealerta): EstadoCliente {
  const cruce = p.estadoCruce;
  const cancelada = p.cancelacion === 'Pedida';
  const sinCruzar = !p.tieneVuelo && (cruce === '' || cruce === 'Sin vuelo');
  const base = { cancelada, editable: sinCruzar && !cancelada };
  if (cancelada) return { ...base, texto: 'Cancelación pedida', tono: 'quiet', paso: 1, sigue: 'Nuestro equipo documental confirmará la cancelación.', novedad: false };
  if (p.estado === 'Duplicada') return { ...base, texto: 'Guía repetida', tono: 'warn', paso: 1, sigue: 'Esta guía ya estaba prealertada; la dejamos una sola vez.', novedad: false };
  if (cruce === 'Coincide') return { ...base, texto: 'Carga recibida', tono: 'good', paso: 3, sigue: 'Tu carga llegó y coincide con lo que prealertaste.', novedad: false };
  if (cruce === 'Faltante') return { ...base, texto: 'Con novedad: faltante', tono: 'bad', paso: 3, sigue: 'Llegó menos de lo prealertado. Documental se comunicará contigo.', novedad: true };
  if (cruce === 'Sobrante') return { ...base, texto: 'Con novedad: sobrante', tono: 'warn', paso: 3, sigue: 'Llegó más de lo prealertado. Documental se comunicará contigo.', novedad: true };
  if (cruce === 'Diferencia') return { ...base, texto: 'Con novedad: diferencia', tono: 'warn', paso: 3, sigue: 'Hay diferencia de piezas o kilos. Documental se comunicará contigo.', novedad: true };
  if (p.tieneVuelo || cruce === 'En vuelo') return { ...base, texto: 'Cruzada con vuelo', tono: 'info', paso: 2, sigue: 'Esperando la llegada y el recibo de la carga.', novedad: false };
  return { ...base, texto: 'Recibida', tono: 'neutral', paso: 1, sigue: 'La estamos cruzando con el vuelo. Si el vuelo aún no está programado, queda en espera.', novedad: false };
}

/** Referencia corta que se le da al cliente: PA-XXXXXX (de la fila; no cambia). */
export const referenciaDe = (id: string): string => `PA-${id.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase()}`;

/* ───────────── Lectura ───────────── */

/** Sus prealertas, las más nuevas primero. El servidor ya filtra por su cliente; aquí no se confía en eso para nada que no sea mostrar. */
export async function traerMisPrealertas(max = 1000): Promise<Prealerta[]> {
  const out: SdkRow[] = [];
  const pagina = 500;
  for (let off = 0; off < max; off += pagina) {
    const res = await cortex.tables.query('prealertas', { order: { field: 'created_at', dir: 'desc' }, limit: Math.min(pagina, max - off), offset: off });
    out.push(...res.rows);
    if (res.rows.length < pagina) break;
  }
  return out.map(aPrealerta);
}

/** Lo que se manda a crear/actualizar: SOLO campos que el rol cliente puede escribir (el servidor rechaza cualquier otro). */
export interface FormPrealerta {
  guia: string;
  vuelo: string;
  aerolinea: string;
  fecha: string;
  origen: string;
  piezas: string;
  kilos: string;
  descripcion: string;
}

export const FORM_VACIO: FormPrealerta = { guia: '', vuelo: '', aerolinea: '', fecha: '', origen: '', piezas: '', kilos: '', descripcion: '' };

export function valoresDe(f: FormPrealerta, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const v = revisarGuia(f.guia);
  const piezas = aNumero(f.piezas);
  const kilos = aNumero(f.kilos);
  const out: Record<string, unknown> = {
    guia: v.ok ? v.formateada : f.guia.trim(),
    numero_vuelo: f.vuelo.trim().toUpperCase() || undefined,
    aerolinea: f.aerolinea.trim() || undefined,
    fecha_estimada: f.fecha || undefined,
    origen: f.origen.trim() || undefined,
    piezas: piezas ?? undefined,
    kilos: kilos ?? undefined,
    descripcion_carga: f.descripcion.trim() || undefined,
    ...extra,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

export const CANAL_PORTAL = 'Portal cliente';

/** Cambios entre lo que hay y lo que se editó (solo los campos que cambiaron y traen valor; borrar un dato no se hace desde aquí). */
export function cambios(p: Prealerta, f: FormPrealerta): Record<string, unknown> {
  const nuevo = valoresDe(f);
  const antes: Record<string, unknown> = {
    guia: p.guia,
    numero_vuelo: p.numeroVuelo || undefined,
    aerolinea: p.aerolinea || undefined,
    fecha_estimada: p.fecha || undefined,
    origen: p.origen || undefined,
    piezas: p.piezas ?? undefined,
    kilos: p.kilos ?? undefined,
    descripcion_carga: p.descripcion || undefined,
  };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(antes)) if (nuevo[k] !== undefined && String(nuevo[k]) !== String(antes[k] ?? '')) out[k] = nuevo[k];
  return out;
}
