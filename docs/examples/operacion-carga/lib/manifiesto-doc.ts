import { tituloManifiesto, aerolineaManifiesto } from './aerolineas';
import { N } from './formato';
import { LOGOS_AEROLINEA, LOGO_EMPRESA_ALTO, LOGO_EMPRESA_ANCHO, LOGO_EMPRESA_PNG } from './manifiesto-logo';

/**
 * EL MANIFIESTO DE LA AEROLÍNEA, TAL CUAL LA PLANTILLA «MANIFIESTO AEROLINEAS NO MODIFICAR»
 * (hoja «MANIFIESTO FORMULADO»): carta vertical, ajustada a 1 página, sin cuadrícula, márgenes
 * 0,25" a los lados y 0,75" arriba y abajo, 12 columnas A:L (la K va oculta), 42 renglones por
 * página (filas 19–60), totales en la fila 61 y pie en las filas 62–64.
 *
 * Una sola descripción de la hoja (celdas, combinaciones, anchos, alturas, bordes) alimenta los
 * dos exportadores: `htmlManifiesto` (impresión / PDF) y `xlsxManifiesto` (Excel).
 */

/* ───────────── Modelo ───────────── */

export interface GuiaManifiesto {
  guia: string;
  paquetes: string | number;
  peso: string | number;
  naturaleza: string;
  consignatario: string;
}

/** Imagen lista para incrustar (PNG o JPG como data URL, con su tamaño natural). */
export interface LogoImagen {
  dataUrl: string;
  ancho: number;
  alto: number;
}

export interface Manifiesto {
  /** Nombre de la aerolínea (el recuadro dice «MANIFIESTO <AEROLÍNEA>»). */
  aerolinea: string;
  matricula: string;
  vuelo: string;
  /** AAAA-MM-DD. */
  fecha: string;
  origen: string;
  destino: string;
  guias: GuiaManifiesto[];
  preparado_por: string;
  /** Logo de la aerolínea por dirección (la impresión lo pide al navegador). */
  logoUrl?: string;
  /** Logo ya descargado: se usa en vez de la dirección (y es el que se incrusta en Excel). */
  logo?: LogoImagen | null;
}

export const MANIFIESTO_VACIO: Manifiesto = { aerolinea: '', matricula: '', vuelo: '', fecha: '', origen: '', destino: 'BOG', guias: [], preparado_por: '' };

/** Renglones por página (filas 19–60 de la plantilla). */
export const RENGLONES_POR_PAGINA = 42;

export const guiaVacia = (): GuiaManifiesto => ({ guia: '', paquetes: '', peso: '', naturaleza: '', consignatario: '' });

/** ¿El renglón trae algo? */
export const renglonConDatos = (g: GuiaManifiesto): boolean => !!(g.guia.trim() || String(g.paquetes).trim() || String(g.peso).trim() || g.naturaleza.trim() || g.consignatario.trim());

/** Renglones con datos (los vacíos del final de una tabla editable no cuentan). */
export const guiasUtiles = (m: Manifiesto): GuiaManifiesto[] => m.guias.filter(renglonConDatos);

const tiene = (v: string | number): boolean => String(v ?? '').trim() !== '';

export function totalesManifiesto(guias: GuiaManifiesto[]): { guias: number; paquetes: number; peso: number } {
  let paquetes = 0;
  let peso = 0;
  let n = 0;
  for (const g of guias) {
    if (!renglonConDatos(g)) continue;
    n += 1;
    paquetes += N(g.paquetes);
    peso += N(g.peso);
  }
  return { guias: n, paquetes, peso: Math.round(peso * 100) / 100 };
}

/** Páginas del documento: de a 42 guías; siempre hay al menos una. */
export function paginasDe(guias: GuiaManifiesto[]): GuiaManifiesto[][] {
  const g = guias.filter(renglonConDatos);
  const out: GuiaManifiesto[][] = [];
  for (let i = 0; i < g.length; i += RENGLONES_POR_PAGINA) out.push(g.slice(i, i + RENGLONES_POR_PAGINA));
  return out.length ? out : [[]];
}

/** Fecha AAAA-MM-DD → DD-MM-AAAA (como la celda J8). */
export const fechaDMA = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
};

/* ───────────── Geometría de la plantilla ───────────── */

/** Anchos de columna A:L en caracteres de Excel (la K, 16,38, va oculta). */
export const ANCHOS_COLUMNA = [10.25, 9.13, 16.63, 11.38, 8.75, 14.38, 20.63, 30.38, 9.75, 7.88, 16.38, 18.38];
export const COLUMNA_OCULTA = 11;
export const FILAS = 64;
export const PRIMERA_FILA_DATOS = 19;
export const FILA_TOTALES = 61;

/** Ancho en píxeles que Excel le da a una columna (fuente base Calibri 11, 7 px por dígito). */
export const pxColumna = (w: number): number => Math.trunc(((256 * w + Math.trunc(128 / 7)) / 256) * 7);
const PX_COL = ANCHOS_COLUMNA.map(pxColumna);

/** Altura de cada fila en puntos (filas 1–64). */
export function alturaFila(r: number): number {
  if (r === 5) return 23.25;
  if (r <= PRIMERA_FILA_DATOS + 1) return 15;
  return 15.75;
}
const PX_FILA = (r: number): number => (alturaFila(r) * 96) / 72;

const ANCHO_NATURAL = PX_COL.reduce((a, w, i) => (i + 1 === COLUMNA_OCULTA ? a : a + w), 0);
const ALTO_NATURAL = (() => {
  let h = 0;
  for (let r = 1; r <= FILAS; r++) h += PX_FILA(r);
  return h;
})();
/** Área imprimible carta menos márgenes: 8" x 9,5" a 96 ppp. */
const AREA_ANCHO = 8 * 96;
const AREA_ALTO = 9.5 * 96;
/** Escala de «ajustar a 1 página de ancho por 1 de alto». */
export const ESCALA = Math.min(AREA_ANCHO / ANCHO_NATURAL, AREA_ALTO / ALTO_NATURAL);

/** Combinaciones del encabezado, de la tabla (A:B, E:G, I:L por renglón) y del pie. */
function combinaciones(): string[] {
  const m = ['H2:I4', 'E3:F5', 'H5:I5', 'A8:E8', 'J8:L8', 'A9:E9', 'A11:B11', 'C11:F11', 'I11:L11', 'A12:B12', 'C12:E12', 'I12:J12', 'K12:L12', 'A13:L13', 'A14:L14', 'A15:B16', 'E15:G16', 'I15:L16', 'A17:B18', 'E17:G18', 'I17:L18'];
  for (let r = PRIMERA_FILA_DATOS; r <= FILA_TOTALES; r++) m.push(`A${r}:B${r}`, `E${r}:G${r}`, `I${r}:L${r}`);
  m.push('A62:C62', 'A63:C63', 'D63:G63');
  return m;
}

/** Bordes por celda (izquierda, arriba, derecha, abajo): M = medio, t = fino, . = ninguno. Filas 1–18 y 61–64 de la plantilla. */
const BORDES_ENCABEZADO = [
  'MM.. .M.. .M.. .M.. .M.. .M.. .M.. .M.. .M.. .M.. .M.. .MM.',
  'M... .... .... .... .... .... .... MM.. .MM. .... .... ..M.',
  'M... .... .... .... .... .... .... M... ..M. .... .... ..M.',
  'M... .... .... .... .... .... .... M..M ..MM .... .... ..M.',
  'M... .... .... .... .... .... .... .... .... .... .... ..M.',
  'M... .... .... .... .... .... .... .... .... .... .... ..M.',
  'Mt.. .t.. .t.. .t.. .t.. .t.. .t.. .t.. .t.. .t.. .t.. .tM.',
  'M... .... .... .... .... ...t .... ...t .... ...t ...t ..Mt',
  'M... .... .... .... .... .t.t .... .t.t .... .t.t .t.t .tMt',
  'M..t ...t ...t ...t ...t ...t ...t ...t ...t ...t ...t ..Mt',
  'Mt.. .t.. .t.t .t.t .t.t .ttt .t.. .t.. .t.t .t.t .t.t .tMt',
  'M... .... .t.. .t.. .t.. .t.. .... .... .t.. .t.. .t.. .tM.',
  'M..t ...t ...t ...t ...t ...t ...t ...t ...t ...t ...t ..Mt',
  'M... .... .... .... .... .... .... .... .... .... .... ..M.',
  'Mt.. .tt. ttt. ttt. tt.. .t.. .tt. tt.. tt.. .t.. .t.. .tM.',
  'M... ..t. t.t. t.t. t... .... ..t. t... t... .... .... ..M.',
  'M... ..t. t.t. t.t. t... .... ..t. t... t... .... .... ..M.',
  'M..t ..tt t.tt t.tt t..t ...t ..tt t..t t..t ...t ...t ..Mt',
];
const BORDES_RENGLON = 'M... ..t. t.t. t... t... .... ..t. t... t... .... .... ..M.';
const BORDES_PIE = [
  'M..t ..tt t.tt t.tt t..t ...t ..tt t.tt t..t ...t ...t ..Mt',
  'Mt.. .t.. .t.. .... .... .... .... .... .... .... .... ..M.',
  'M... .... .... .... .... .... .... .... .... .... .... ..M.',
  'M..M ...M ...M ...M ...M ...M ...M ...M ...M ...M ...M ..MM',
];

/** Bordes de las 64 filas × 12 columnas, en 4 caracteres cada celda. */
function bordesHoja(): string[][] {
  const filas: string[] = [...BORDES_ENCABEZADO];
  for (let r = PRIMERA_FILA_DATOS; r < FILA_TOTALES; r++) filas.push(BORDES_RENGLON);
  filas.push(...BORDES_PIE);
  return filas.map((f) => f.split(' '));
}

/* ───────────── Contenido de cada página ───────────── */

type Fuente = 'ap' | 'ar';

interface Celda {
  r: number;
  c: number;
  /** Lo que se escribe en la celda (texto o número). */
  valor: string | number | Date;
  /** Cómo se ve (HTML); si falta, el mismo valor. */
  texto?: string;
  fmt?: string;
  formula?: string;
  f: Fuente;
  tam: number;
  b?: boolean;
  h?: 'l' | 'c';
  va?: 'm';
  w?: boolean;
  amarillo?: boolean;
  encoger?: boolean;
}

interface Pagina {
  celdas: Celda[];
  merges: string[];
  bordes: string[][];
  nGuias: number;
  n: number;
  de: number;
  filaTotales: boolean;
}

const LETRAS = 'ABCDEFGHIJKL';
const dir = (r: number, c: number): string => `${LETRAS[c - 1]}${r}`;

function enteroTxt(v: string | number): string {
  const n = N(v);
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}
/** Peso en formato colombiano: coma decimal y punto de miles («1.250,50»), siempre con dos decimales. */
const FORMATO_PESO = new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true });
export const pesoTxt = (v: string | number): string => FORMATO_PESO.format(N(v));
/** Formato de celda de Excel para el peso: número real (no texto); la coma o el punto decimal los pone Excel según la región. */
export const FORMATO_CELDA_PESO = '#,##0.00';

function armarPagina(m: Manifiesto, guias: GuiaManifiesto[], n: number, de: number, totales: { paquetes: number; peso: number } | null, formulasTotales: { c: string; d: string } | null): Pagina {
  const celdas: Celda[] = [];
  const poner = (r: number, c: number, valor: string | number | Date, o: Partial<Celda> = {}) => celdas.push({ r, c, valor, f: 'ap', tam: 11, ...o });

  // Encabezado
  poner(2, 8, tituloManifiesto(m.aerolinea), { f: 'ar', tam: 20, b: true, h: 'c', va: 'm', w: true, amarillo: true });
  if (!m.logo && !m.logoUrl) poner(3, 5, m.aerolinea.trim().toUpperCase(), { f: 'ar', tam: 14, b: true, h: 'c', va: 'm', w: true });
  poner(8, 1, 'MARKS OF NACIONALITY AND REGISTRATION:', { h: 'l' });
  poner(9, 1, 'MATRICULA, MARCA Y NACIONALIDAD:', { h: 'l' });
  poner(8, 6, m.matricula.trim().toUpperCase(), { f: 'ar', b: true, h: 'c' });
  poner(8, 7, 'FLIGHT No: ');
  poner(9, 7, 'VUELO No:');
  poner(8, 8, m.vuelo.trim().toUpperCase(), { f: 'ar', b: true, h: 'c' });
  poner(8, 9, 'DATE:');
  poner(9, 9, 'FECHA:');
  const fecha = /^(\d{4})-(\d{2})-(\d{2})/.exec(m.fecha);
  if (fecha) poner(8, 10, new Date(Date.UTC(Number(fecha[1]), Number(fecha[2]) - 1, Number(fecha[3]))), { texto: fechaDMA(m.fecha), fmt: 'dd-mm-yyyy', f: 'ar', tam: 10, b: true, h: 'c' });
  else if (m.fecha.trim()) poner(8, 10, m.fecha.trim(), { f: 'ar', tam: 10, b: true, h: 'c' });
  poner(11, 1, 'POINT OF LOADING:', { h: 'l' });
  poner(12, 1, 'PUNTO DE CARGA:', { h: 'l' });
  poner(11, 3, m.origen.trim().toUpperCase(), { f: 'ar', b: true, h: 'c' });
  poner(12, 3, '(PLACE AND COUNTRY)', { h: 'c' });
  poner(12, 6, '(LUGAR Y PAIS)', { f: 'ar', h: 'c' });
  poner(11, 8, 'POINT OF UNLOADING:', { h: 'l' });
  poner(12, 8, 'PUNTO DE DESCARGA:', { h: 'l' });
  poner(11, 9, m.destino.trim().toUpperCase(), { f: 'ar', b: true, h: 'c' });
  poner(12, 9, '(PLACE AND COUNTRY)', { h: 'c' });
  poner(12, 11, '(LUGAR Y PAIS)', { h: 'c' });

  // Encabezado de la tabla (filas 15–18, bilingüe)
  poner(15, 1, 'AIRWAYBILL NUMBER', { b: true, h: 'c', va: 'm', w: true });
  poner(17, 1, 'NUMERO DE GUIA', { b: true, h: 'c', va: 'm', w: true });
  poner(15, 3, 'NUMBER OF', { b: true, h: 'c' });
  poner(16, 3, 'PACKAGES', { b: true, h: 'c' });
  poner(17, 3, 'NUMERO DE', { b: true, h: 'c' });
  poner(18, 3, 'PAQUETES', { b: true, h: 'c' });
  poner(16, 4, 'PESO', { b: true, h: 'c', w: true });
  poner(15, 5, 'NATURE OF GOODS', { b: true, h: 'c', va: 'm' });
  poner(17, 5, 'NATURALEZA DE LA MERCANCIA', { b: true, h: 'c', va: 'm', w: true });
  poner(17, 8, 'CONSIGNEES', { b: true, h: 'c' });
  poner(15, 9, 'FOR OFFICIAL USE ONLY', { b: true, h: 'c', va: 'm' });
  poner(17, 9, 'PARA USO OFICIAL SOLAMENTE', { b: true, h: 'c', va: 'm' });

  // Renglones
  guias.slice(0, RENGLONES_POR_PAGINA).forEach((g, i) => {
    const r = PRIMERA_FILA_DATOS + i;
    if (g.guia.trim()) poner(r, 1, g.guia.trim(), { f: 'ar', h: 'c' });
    if (tiene(g.paquetes)) poner(r, 3, N(g.paquetes), { texto: enteroTxt(g.paquetes), fmt: '0', f: 'ar', h: 'c' });
    if (tiene(g.peso)) poner(r, 4, N(g.peso), { texto: pesoTxt(g.peso), fmt: FORMATO_CELDA_PESO, f: 'ar', h: 'c' });
    if (g.naturaleza.trim()) poner(r, 5, g.naturaleza.trim(), { f: 'ar', h: 'c', encoger: true });
    if (g.consignatario.trim()) poner(r, 8, g.consignatario.trim(), { f: 'ar', h: 'c', encoger: true });
  });

  // Totales (solo la última página)
  if (totales) {
    poner(FILA_TOTALES, 3, totales.paquetes, { texto: enteroTxt(totales.paquetes), fmt: '0', formula: formulasTotales?.c, f: 'ar', b: true, h: 'c' });
    poner(FILA_TOTALES, 4, totales.peso, { texto: pesoTxt(totales.peso), fmt: FORMATO_CELDA_PESO, formula: formulasTotales?.d, f: 'ar', b: true, h: 'c' });
  }

  // Pie
  poner(62, 1, 'PREPARED BY', { h: 'c' });
  poner(63, 1, 'PREPARADO POR:', { h: 'c' });
  if (m.preparado_por.trim()) poner(63, 4, m.preparado_por.trim(), { f: 'ar', h: 'c', encoger: true });
  poner(62, 8, 'PAGE', { h: 'c' });
  poner(63, 8, 'PAGINA', { h: 'c' });
  poner(63, 9, `${n}/${de}`, { h: 'c' });
  poner(64, 1, `${guias.length} Reg,`);

  return { celdas, merges: combinaciones(), bordes: bordesHoja(), nGuias: guias.length, n, de, filaTotales: !!totales };
}

/** Todas las páginas del manifiesto (una hoja de Excel o una carta por cada 42 guías). */
function armarPaginas(m: Manifiesto): Pagina[] {
  const grupos = paginasDe(m.guias);
  const t = totalesManifiesto(m.guias);
  const nombres = grupos.map((_, i) => nombreHoja(i));
  const rango = (col: string) => nombres.map((h) => `'${h}'!${col}${PRIMERA_FILA_DATOS}:${col}${FILA_TOTALES - 1}`).join(',');
  return grupos.map((g, i) => armarPagina(m, g, i + 1, grupos.length, i === grupos.length - 1 ? t : null, { c: `SUM(${rango('C')})`, d: `SUM(${rango('D')})` }));
}

export const nombreHoja = (i: number): string => (i === 0 ? 'MANIFIESTO FORMULADO' : `MANIFIESTO FORMULADO ${i + 1}`);

/* ───────────── Rangos ───────────── */

interface Rango {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}
function rangoDe(ref: string): Rango {
  const [a = '', b = a] = ref.split(':');
  const p = (x: string) => {
    const mm = /^([A-Z]+)(\d+)$/.exec(x);
    return { c: (mm?.[1] ?? 'A').split('').reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0), r: Number(mm?.[2] ?? 1) };
  };
  const x = p(a);
  const y = p(b);
  return { r1: x.r, c1: x.c, r2: y.r, c2: y.c };
}

/* ───────────── Exportador 1: HTML de impresión ───────────── */

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const S = (px: number): string => `calc(var(--s)*${px}px)`;

function cssManifiesto(): string {
  const cols = PX_COL.map((w, i) => (i + 1 === COLUMNA_OCULTA ? '' : `.k${i + 1}{width:${S(w)}}`)).join('');
  return `
@page{size:letter portrait;margin:.75in .25in}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.pg{--s:${ESCALA.toFixed(5)};position:relative;width:8in;height:9.5in;overflow:hidden;break-after:page;page-break-after:always;background:#fff}
.pg:last-child{break-after:auto;page-break-after:auto}
.hoja{position:relative;width:${S(ANCHO_NATURAL)}}
.mf{border-collapse:collapse;table-layout:fixed;width:${S(ANCHO_NATURAL)};background:#fff}
${cols}
.mf td{padding:0 ${S(2)};margin:0;overflow:visible;white-space:nowrap;line-height:1.12;vertical-align:bottom;font-size:${S(11 * (96 / 72))};font-family:'Aptos Narrow','Arial Narrow',Arial,Helvetica,sans-serif}
.mf td.e{overflow:hidden}
.mf td.ar{font-family:Arial,Helvetica,sans-serif}
.mf td.s10{font-size:${S(10 * (96 / 72))}}
.mf td.s14{font-size:${S(14 * (96 / 72))}}
.mf td.s20{font-size:${S(20 * (96 / 72))};line-height:1.05}
.mf td.b{font-weight:700}
.mf td.l{text-align:left}
.mf td.c{text-align:center}
.mf td.m{vertical-align:middle}
.mf td.w{white-space:normal}
.mf td.am{background:#ffff00}
.mf td.lt{border-left:1px solid #000}.mf td.lm{border-left:2px solid #000}
.mf td.tt{border-top:1px solid #000}.mf td.tm{border-top:2px solid #000}
.mf td.rt{border-right:1px solid #000}.mf td.rm{border-right:2px solid #000}
.mf td.bt{border-bottom:1px solid #000}.mf td.bm{border-bottom:2px solid #000}
${[15, 23.25, 15.75].map((h) => `.mf tr.h${String(h).replace('.', '_')}{height:${S((h * 96) / 72)}}`).join('')}
.logo{position:absolute;display:block;object-fit:contain}
@media screen{
  html{background:#cfcac0}
  body{padding:18px 0}
  .pg{margin:0 auto 18px;padding:.75in .25in;width:calc(8in + .5in);height:calc(9.5in + 1.5in);box-shadow:0 2px 12px rgba(0,0,0,.28)}
}
`;
}

function celdaHtml(p: Pagina, r: number, c: number, mapaCombina: Map<string, Rango>, mapaCelda: Map<string, Celda>): string {
  const clave = `${r},${c}`;
  const rg = mapaCombina.get(clave);
  if (rg && (rg.r1 !== r || rg.c1 !== c)) return '';
  if (c === COLUMNA_OCULTA && !rg) return '';
  const r2 = rg?.r2 ?? r;
  const c2 = rg?.c2 ?? c;
  const visibles = (a: number, b: number) => {
    let n = 0;
    for (let k = a; k <= b; k++) if (k !== COLUMNA_OCULTA) n++;
    return n;
  };
  const colspan = visibles(c, c2);
  const rowspan = r2 - r + 1;
  const bs = (r0: number, c0: number): string => p.bordes[r0 - 1]?.[c0 - 1] ?? '....';
  const lado = (ch: string | undefined, pref: string): string => (ch === 'M' ? `${pref}m` : ch === 't' ? `${pref}t` : '');
  const clases: string[] = [
    lado(bs(r, c)[0], 'l'),
    lado(bs(r, c)[1], 't'),
    lado(bs(r2, c2 === COLUMNA_OCULTA ? c2 + 1 : c2)[2], 'r'),
    lado(bs(r2, c2 === COLUMNA_OCULTA ? c2 + 1 : c2)[3], 'b'),
  ];
  const ce = mapaCelda.get(clave);
  let contenido = '';
  let estilo = '';
  if (ce) {
    clases.push(ce.f === 'ar' ? 'ar' : '', ce.tam === 10 ? 's10' : ce.tam === 14 ? 's14' : ce.tam === 20 ? 's20' : '', ce.b ? 'b' : '', ce.h ?? '', ce.va ?? '', ce.w ? 'w' : '', ce.amarillo ? 'am' : '', ce.encoger ? 'e' : '');
    contenido = esc(ce.texto ?? String(ce.valor));
    if (ce.encoger && contenido.length) {
      // «Reducir hasta ajustar»: el texto largo se achica para caber en su celda (mínimo 55 %).
      let ancho = 0;
      for (let k = c; k <= c2; k++) if (k !== COLUMNA_OCULTA) ancho += PX_COL[k - 1] ?? 0;
      const f = Math.max(0.55, Math.min(1, (ancho - 6) / (contenido.length * 0.7 * 11 * (96 / 72))));
      if (f < 1) estilo = ` style="font-size:calc(var(--s)*${(11 * (96 / 72) * f).toFixed(2)}px)"`;
    }
  } else if (!clases.some(Boolean)) {
    return `<td${colspan > 1 ? ` colspan="${colspan}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''}></td>`;
  }
  return `<td${colspan > 1 ? ` colspan="${colspan}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''} class="${clases.filter(Boolean).join(' ')}"${estilo}>${contenido}</td>`;
}

/** Posición y tamaño (px naturales) del logo de la empresa y de la caja del logo de la aerolínea (E3:F5). */
function cajaLogoAerolinea(): { x: number; y: number; w: number; h: number } {
  const x = PX_COL.slice(0, 4).reduce((a, b) => a + b, 0);
  const y = PX_FILA(1) + PX_FILA(2);
  return { x, y, w: (PX_COL[4] ?? 0) + (PX_COL[5] ?? 0), h: PX_FILA(3) + PX_FILA(4) + PX_FILA(5) };
}

const esquinas = (x: number, y: number, w: number, h: number): string => `left:${S(x)};top:${S(y)};width:${S(w)};height:${S(h)}`;

function paginaHtml(m: Manifiesto, p: Pagina): string {
  const mapaCombina = new Map<string, Rango>();
  for (const ref of p.merges) {
    const rg = rangoDe(ref);
    for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) mapaCombina.set(`${r},${c}`, rg);
  }
  const mapaCelda = new Map<string, Celda>();
  for (const ce of p.celdas) mapaCelda.set(`${ce.r},${ce.c}`, ce);
  const filas: string[] = [];
  for (let r = 1; r <= FILAS; r++) {
    const clase = `h${String(alturaFila(r)).replace('.', '_')}`;
    let tds = '';
    for (let c = 1; c <= 12; c++) tds += celdaHtml(p, r, c, mapaCombina, mapaCelda);
    filas.push(`<tr class="${clase}">${tds}</tr>`);
  }
  const colgroup = `<colgroup>${PX_COL.map((_, i) => (i + 1 === COLUMNA_OCULTA ? '' : `<col class="k${i + 1}">`)).join('')}</colgroup>`;
  const cj = cajaLogoAerolinea();
  const src = m.logo?.dataUrl ?? m.logoUrl ?? '';
  let logoAero = '';
  if (src) {
    const pad = 3;
    logoAero = `<img class="logo" alt="${esc(m.aerolinea)}" src="${esc(src)}" style="${esquinas(cj.x + pad, cj.y + pad, cj.w - pad * 2, cj.h - pad * 2)}">`;
  }
  const logoEmpresa = `<img class="logo" alt="" src="${LOGO_EMPRESA_PNG}" style="${esquinas(PX_COL[0]! + 15, 3, LOGO_EMPRESA_ANCHO, LOGO_EMPRESA_ALTO)}">`;
  return `<section class="pg"><div class="hoja"><table class="mf">${colgroup}<tbody>${filas.join('')}</tbody></table>${logoEmpresa}${logoAero}</div></section>`;
}

/**
 * HTML de impresión del manifiesto, autocontenido y sin scripts: carta vertical, márgenes de la
 * plantilla, 42 renglones por página (encabezado repetido y totales en la última).
 */
export function htmlManifiesto(m: Manifiesto): string {
  const paginas = armarPaginas(m);
  const titulo = `Manifiesto ${m.vuelo.trim() || m.aerolinea.trim()}${m.fecha ? ` ${m.fecha}` : ''}`.trim();
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titulo)}</title><style>${cssManifiesto()}</style></head><body>${paginas.map((p) => paginaHtml(m, p)).join('')}</body></html>`;
}

/** Cuántas páginas tendrá el documento. */
export const numeroPaginas = (m: Manifiesto): number => paginasDe(m.guias).length;

/* ───────────── Exportador 2: Excel ───────────── */

export const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const NEGRO = { argb: 'FF000000' };
const estiloLinea = (ch: string | undefined): { style: 'thin' | 'medium'; color: { argb: string } } | undefined => (ch === 'M' ? { style: 'medium', color: NEGRO } : ch === 't' ? { style: 'thin', color: NEGRO } : undefined);

/** Dónde cae un punto (px desde A1) como ancla de Excel (columna y fila fraccionarias, base 0). */
function ancla(x: number, y: number): { col: number; row: number } {
  let col = 0;
  let rest = x;
  while (col < 11 && rest >= (PX_COL[col] ?? 0) && col + 1 !== COLUMNA_OCULTA) {
    rest -= PX_COL[col] ?? 0;
    col += 1;
  }
  let row = 0;
  let resty = y;
  while (row < FILAS && resty >= PX_FILA(row + 1)) {
    resty -= PX_FILA(row + 1);
    row += 1;
  }
  return { col: col + rest / (PX_COL[col] ?? 1), row: row + resty / PX_FILA(row + 1) };
}

type WorkbookCtor = new () => import('exceljs').Workbook;

/**
 * Excel con la estructura de la plantilla: mismas celdas, combinaciones, anchos (K oculta),
 * alturas, bordes, fuentes, relleno amarillo y formato de impresión (carta vertical, 1 página,
 * márgenes 0,25" / 0,75", sin cuadrícula). Una hoja por cada 42 guías.
 * Se arma con exceljs en el navegador; el logo de la aerolínea se incrusta si `m.logo` viene
 * descargado y, si no, el nombre queda como texto en E3.
 */
export async function xlsxManifiesto(m: Manifiesto): Promise<Blob> {
  const mod = (await import('exceljs')) as unknown as { default?: { Workbook: WorkbookCtor }; Workbook?: WorkbookCtor };
  const Workbook = (mod.default?.Workbook ?? mod.Workbook) as WorkbookCtor;
  const wb = new Workbook();
  wb.creator = 'Cortex';
  wb.created = new Date();
  const paginas = armarPaginas(m);
  const idEmpresa = wb.addImage({ base64: LOGO_EMPRESA_PNG, extension: 'png' });
  const idAero = m.logo ? wb.addImage({ base64: m.logo.dataUrl, extension: /^data:image\/jpe?g/i.test(m.logo.dataUrl) ? 'jpeg' : 'png' }) : null;

  paginas.forEach((p, i) => {
    const ws = wb.addWorksheet(nombreHoja(i), {
      views: [{ showGridLines: false, zoomScale: 100 }],
      properties: { defaultRowHeight: 15, defaultColWidth: 12.63 },
      pageSetup: {
        paperSize: 1 as never,
        orientation: 'portrait',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 1,
        scale: 100,
        horizontalCentered: false,
        verticalCentered: false,
        margins: { left: 0.25, right: 0.25, top: 0.75, bottom: 0.75, header: 0, footer: 0 },
        printArea: `A1:L${FILAS}`,
      },
    });
    ANCHOS_COLUMNA.forEach((w, k) => {
      const col = ws.getColumn(k + 1);
      col.width = w;
      if (k + 1 === COLUMNA_OCULTA) col.hidden = true;
    });
    for (let r = 1; r <= FILAS; r++) ws.getRow(r).height = alturaFila(r);

    // Bordes y relleno de cada celda de A1:L64
    const mapaCelda = new Map<string, Celda>();
    for (const ce of p.celdas) mapaCelda.set(`${ce.r},${ce.c}`, ce);
    for (let r = 1; r <= FILAS; r++) {
      for (let c = 1; c <= 12; c++) {
        const cell = ws.getCell(r, c);
        const b = p.bordes[r - 1]?.[c - 1] ?? '....';
        const border: Partial<import('exceljs').Borders> = {};
        const l = estiloLinea(b[0]);
        const t = estiloLinea(b[1]);
        const rr = estiloLinea(b[2]);
        const bb = estiloLinea(b[3]);
        if (l) border.left = l;
        if (t) border.top = t;
        if (rr) border.right = rr;
        if (bb) border.bottom = bb;
        if (Object.keys(border).length) cell.border = border;
        const ce = mapaCelda.get(`${r},${c}`);
        cell.font = { name: ce?.f === 'ar' ? 'Arial' : 'Aptos Narrow', size: ce?.tam ?? 11, bold: !!ce?.b, color: NEGRO };
      }
    }
    // Valores y estilo de lo escrito
    for (const ce of p.celdas) {
      const cell = ws.getCell(ce.r, ce.c);
      cell.value = ce.formula ? { formula: ce.formula, result: typeof ce.valor === 'number' ? ce.valor : undefined } : ce.valor;
      if (ce.fmt) cell.numFmt = ce.fmt;
      cell.alignment = {
        horizontal: ce.h === 'l' ? 'left' : ce.h === 'c' ? 'center' : undefined,
        vertical: ce.va === 'm' ? 'middle' : undefined,
        wrapText: ce.w || undefined,
        shrinkToFit: ce.encoger || undefined,
      };
      if (ce.amarillo) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' }, bgColor: { argb: 'FFFFFF00' } };
    }
    // Combinaciones sin copiar el estilo del primero (cada borde queda como en la plantilla)
    for (const ref of p.merges) ws.mergeCellsWithoutStyle(ref);

    // Logos: el de la empresa (B1) y el de la aerolínea (E3:F5)
    ws.addImage(idEmpresa, { tl: { col: 1 + 15 / (PX_COL[1] ?? 64), row: 0 } as never, ext: { width: LOGO_EMPRESA_ANCHO, height: LOGO_EMPRESA_ALTO }, editAs: 'oneCell' });
    if (idAero !== null && m.logo) {
      const cj = cajaLogoAerolinea();
      const esc_ = Math.min((cj.w - 6) / m.logo.ancho, (cj.h - 6) / m.logo.alto);
      const w = Math.max(1, Math.round(m.logo.ancho * esc_));
      const h = Math.max(1, Math.round(m.logo.alto * esc_));
      ws.addImage(idAero, { tl: ancla(cj.x + (cj.w - w) / 2, cj.y + (cj.h - h) / 2) as never, ext: { width: w, height: h }, editAs: 'oneCell' });
    }
  });

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf as ArrayBuffer], { type: MIME_XLSX });
}

/* ───────────── Pegar y leer ───────────── */

const ENCABEZADOS_GUIA = /^(guia|guía|awb|airwaybill|numero de guia|número de guía|hawb|mawb|waybill)/i;

/**
 * Texto copiado de Excel (columnas separadas por tabulación: guía, paquetes, peso, naturaleza,
 * consignatario) → renglones. Acepta también «;» o dos o más espacios; ignora un encabezado.
 */
export function guiasDesdeTexto(texto: string): GuiaManifiesto[] {
  const out: GuiaManifiesto[] = [];
  const lineas = texto.split(/\r?\n/).filter((l) => l.trim());
  lineas.forEach((linea, i) => {
    const celdas = (linea.includes('\t') ? linea.split('\t') : linea.includes(';') ? linea.split(';') : linea.trim().split(/\s{2,}/)).map((s) => s.trim().replace(/^"(.*)"$/, '$1'));
    if (i === 0 && ENCABEZADOS_GUIA.test(celdas[0] ?? '')) return;
    const [guia = '', paquetes = '', peso = '', naturaleza = '', consignatario = ''] = celdas;
    if (!guia && !paquetes && !peso && !naturaleza && !consignatario) return;
    out.push({ guia, paquetes, peso, naturaleza, consignatario: celdas.slice(4).join(' ').trim() || consignatario });
  });
  return out;
}

/** Descarga un logo y lo deja como PNG/JPG en data URL (las imágenes SVG se pasan a PNG). null si no se puede. */
export async function cargarLogo(url: string): Promise<LogoImagen | null> {
  if (!url || typeof document === 'undefined' || typeof fetch === 'undefined') return null;
  try {
    const resp = await fetch(url, { mode: 'cors' });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const crudo = await new Promise<string>((ok, mal) => {
      const fr = new FileReader();
      fr.onload = () => ok(String(fr.result));
      fr.onerror = () => mal(new Error('lectura'));
      fr.readAsDataURL(blob);
    });
    const img = await new Promise<HTMLImageElement>((ok, mal) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => mal(new Error('imagen'));
      i.src = crudo;
    });
    const ancho = img.naturalWidth || 300;
    const alto = img.naturalHeight || Math.round(ancho / 3);
    if (/^data:image\/(png|jpe?g)/i.test(crudo) && ancho <= 700) return { dataUrl: crudo, ancho, alto };
    const lienzo = document.createElement('canvas');
    const k = Math.min(1, 600 / ancho);
    lienzo.width = Math.max(1, Math.round(ancho * k));
    lienzo.height = Math.max(1, Math.round(alto * k));
    const g = lienzo.getContext('2d');
    if (!g) return null;
    g.drawImage(img, 0, 0, lienzo.width, lienzo.height);
    return { dataUrl: lienzo.toDataURL('image/png'), ancho: lienzo.width, alto: lienzo.height };
  } catch {
    return null;
  }
}

/** El logo (data URI incrustado) de la aerolínea de la lista, si el nombre la reconoce. */
export const logoDe = (aerolinea: string): string => aerolineaManifiesto(aerolinea)?.logo ?? '';

/** El logo incrustado listo para usar en la impresión y en Excel (sin descargar nada), o null si no es de la lista. */
export function logoImagenDe(aerolinea: string): LogoImagen | null {
  const a = aerolineaManifiesto(aerolinea);
  return a ? (LOGOS_AEROLINEA[a.clave] ?? null) : null;
}
