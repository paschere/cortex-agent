import { useEffect, useRef, useState } from 'react';
import { cortex } from '@cortex/app-sdk';
import type { SdkRow, SdkTable } from '@cortex/app-sdk';
import { T, aGuia, archivos, porRelacion, relId, useCarga } from './datos';
import type { Archivo, Guia, Prealerta, Vuelo } from './datos';
import type { Tono } from './estados';
import { N, fechaHora, hay, hhmm, kg, num } from './formato';
import { normGuia, normNombre } from './manifiesto';

/**
 * LÓGICA DEL DOCUMENTAL (v3). Nada aquí habla con la DIAN: se calculan plazos, se cruzan
 * prealerta ↔ manifiesto ↔ recibido y se arman borradores y avisos. La persona carga y envía.
 */

/* ───────────── Esquema: ¿ya se aplicaron los datos nuevos? ───────────── */

export interface Esquema {
  /** false mientras se lee o si el servidor no respondió (se asume todo presente). */
  listo: boolean;
  tablas: Map<string, Set<string>>;
}

export const ESQUEMA_VACIO: Esquema = { listo: false, tablas: new Map() };

export function aEsquema(ts: SdkTable[]): Esquema {
  const tablas = new Map<string, Set<string>>();
  for (const t of ts) {
    const campos = new Set(t.fields.map((f) => f.key));
    tablas.set(t.id, campos);
    tablas.set(t.name, campos);
  }
  return { listo: true, tablas };
}

export async function leerEsquema(): Promise<Esquema> {
  try {
    return aEsquema(await cortex.tables.list());
  } catch {
    return ESQUEMA_VACIO;
  }
}

/** ¿Existe la tabla? Si no se pudo leer el esquema se asume que sí (el servidor responderá claro). */
export const hayTabla = (e: Esquema, t: string): boolean => !e.listo || e.tablas.has(t);
export const hayCampo = (e: Esquema, t: string, c: string): boolean => !e.listo || (e.tablas.get(t)?.has(c) ?? false);

/** Deja solo los valores cuyos campos existen (así un campo nuevo sin aplicar no tumba la escritura). */
export function soloExistentes(e: Esquema, tabla: string, valores: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(valores)) if (v !== undefined && hayCampo(e, tabla, k)) out[k] = v;
  return out;
}

export function useEsquema(): Esquema {
  const { data } = useCarga(leerEsquema, []);
  return data ?? ESQUEMA_VACIO;
}

/** Tablas y campos del plan que faltan en el servidor (texto legible). */
export const REQUERIDO: Record<string, string[]> = {
  plazos_dian: ['tramite', 'desde', 'horas', 'avisar_horas_antes', 'activo', 'descripcion'],
  tramites_dian: ['vuelo', 'tramite', 'desde_evento', 'inicio', 'vence', 'estado', 'presentado_por', 'presentado_en', 'numero_radicado', 'soporte', 'borrador', 'notas'],
  avisos_cliente: ['vuelo', 'guia', 'cliente', 'tipo', 'canal', 'mensaje', 'estado', 'enviado_por', 'enviado_en', 'enlace_documentos'],
};

/** Lo que falta aplicar para que una pantalla funcione completa. */
export function faltantesDe(e: Esquema, necesarias: Record<string, string[]>): string[] {
  if (!e.listo) return [];
  const out: string[] = [];
  for (const [t, campos] of Object.entries(necesarias)) {
    const have = e.tablas.get(t);
    if (!have) out.push(`tabla ${t}`);
    else {
      const sin = campos.filter((c) => !have.has(c));
      if (sin.length) out.push(`${t}: ${sin.join(', ')}`);
    }
  }
  return out;
}

/* ───────────── Rol y hora ───────────── */

/** Puede crear y editar lo documental (gerencia y operario solo miran). */
export const puedeEditarDoc = (rol: string): boolean => rol !== 'gerencia' && rol !== 'operario';
export const esDocumental = (rol: string): boolean => rol === 'documental';

/** Hora actual que se refresca sola (para las cuentas regresivas). */
export function useAhora(cadaMs = 20_000): number {
  const [ahora, setAhora] = useState(Date.now());
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    ref.current = setInterval(() => setAhora(Date.now()), cadaMs);
    return () => {
      if (ref.current) clearInterval(ref.current);
    };
  }, [cadaMs]);
  return ahora;
}

const BOGOTA_MS = -5 * 3600_000;

/** ISO con zona de Bogotá (-05:00) a partir de un instante. */
export const isoBogota = (ms: number): string => `${new Date(ms + BOGOTA_MS).toISOString().slice(0, 19)}-05:00`;

/** Instante (ms) de una fecha AAAA-MM-DD y una hora HH:MM de Bogotá; null si no se puede. */
export function msBogota(fecha: string, hora: string): number | null {
  const h = /^(\d{1,2}):(\d{2})/.exec(hora);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !h) return null;
  const t = Date.parse(`${fecha}T${String(h[1]).padStart(2, '0')}:${h[2]}:00-05:00`);
  return Number.isNaN(t) ? null : t;
}

export const msDeIso = (v: unknown): number | null => {
  if (!hay(v)) return null;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
};

/** «3 h 20 min» desde milisegundos (sin signo). */
export function duracion(ms: number): string {
  const min = Math.max(0, Math.round(Math.abs(ms) / 60_000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

/* ───────────── Trámites DIAN ───────────── */

export interface Plazo {
  id: string;
  tramite: string;
  desde: string;
  horas: number;
  avisarHorasAntes: number;
  activo: boolean;
  descripcion: string;
}

export function aPlazo(r: SdkRow): Plazo {
  const v = r.values;
  const act = T(v.activo);
  return {
    id: r.id,
    tramite: T(v.tramite) || r.label,
    desde: T(v.desde),
    horas: N(v.horas),
    avisarHorasAntes: N(v.avisar_horas_antes),
    activo: act !== 'No',
    descripcion: T(v.descripcion),
  };
}

export const DESDE = ['Llegada', 'Fin de descargue', 'Informe presentado'] as const;
export const ESTADOS_TRAMITE = ['Pendiente', 'En curso', 'Presentado', 'Vencido', 'No aplica'] as const;

export interface Tramite {
  id: string;
  vueloId: string;
  vuelo: string;
  tramite: string;
  desdeEvento: string;
  inicio: string;
  vence: string;
  venceMs: number | null;
  estado: string;
  presentadoPor: string;
  presentadoEn: string;
  radicado: string;
  soporte: Archivo[];
  borrador: string;
  notas: string;
}

export function aTramite(r: SdkRow): Tramite {
  const v = r.values;
  return {
    id: r.id,
    vueloId: relId(v.vuelo),
    vuelo: T(v.vuelo),
    tramite: T(v.tramite) || r.label,
    desdeEvento: T(v.desde_evento),
    inicio: T(v.inicio),
    vence: T(v.vence),
    venceMs: msDeIso(v.vence),
    estado: T(v.estado) || 'Pendiente',
    presentadoPor: T(v.presentado_por),
    presentadoEn: T(v.presentado_en),
    radicado: T(v.numero_radicado),
    soporte: archivos(v.soporte),
    borrador: T(v.borrador),
    notas: T(v.notas),
  };
}

export const TONO_TRAMITE: Record<string, Tono> = {
  Pendiente: 'neutral',
  'En curso': 'info',
  Presentado: 'good',
  Vencido: 'bad',
  'No aplica': 'quiet',
};

export const esActivo = (t: Tramite): boolean => t.estado === 'Pendiente' || t.estado === 'En curso' || t.estado === 'Vencido';

export interface Semaforo {
  tono: Tono;
  /** «faltan 3 h 20 min» / «vencido hace 2 h» / «presentado». */
  texto: string;
  vencido: boolean;
  porVencer: boolean;
}

/** Semáforo y cuenta regresiva de un trámite. `avisar` son las horas de aviso del plazo (por omisión 3). */
export function semaforo(t: Tramite, ahora: number, avisarHoras = 3): Semaforo {
  if (t.estado === 'Presentado') return { tono: 'good', texto: 'Presentado', vencido: false, porVencer: false };
  if (t.estado === 'No aplica') return { tono: 'quiet', texto: 'No aplica', vencido: false, porVencer: false };
  if (t.venceMs === null) return { tono: 'neutral', texto: 'Sin fecha de vencimiento', vencido: false, porVencer: false };
  const falta = t.venceMs - ahora;
  if (falta < 0) return { tono: 'bad', texto: `Vencido hace ${duracion(falta)}`, vencido: true, porVencer: false };
  const porVencer = falta <= avisarHoras * 3600_000;
  return { tono: porVencer ? 'warn' : 'info', texto: `Faltan ${duracion(falta)}`, vencido: false, porVencer };
}

const normT = (s: string): string => normNombre(s);

const ESTADOS_ATERRIZADO = new Set(['Aterrizó', 'En atención', 'Recibido', 'Cerrado']);

/** Cuándo llegó el vuelo (ms) o null si todavía no se sabe. */
export function llegadaMs(v: Vuelo): number | null {
  const hora = v.llegadaHora || (ESTADOS_ATERRIZADO.has(v.estado) ? v.horaReal || v.horaActual : '');
  if (!hora || !v.fecha) return null;
  if (!v.llegadaHora && !ESTADOS_ATERRIZADO.has(v.estado)) return null;
  return msBogota(v.fecha, hhmm(hora));
}

export const finDescargueMs = (v: Vuelo): number | null => (v.finDescargueFecha && v.finDescargueHora ? msBogota(v.finDescargueFecha, hhmm(v.finDescargueHora)) : null);

/** Cuándo se presentó el informe del vuelo (ms), tomado del trámite «Informe…» presentado. */
export function informePresentadoMs(tramites: Tramite[]): number | null {
  const t = tramites.find((x) => x.estado === 'Presentado' && /informe/i.test(x.tramite) && !/justific/i.test(x.tramite) && x.presentadoEn);
  return t ? msDeIso(t.presentadoEn) : null;
}

/** El inicio del reloj de un plazo para este vuelo, o null si el evento todavía no ocurrió. */
export function inicioDePlazo(p: Plazo, v: Vuelo, tramites: Tramite[]): number | null {
  if (p.desde === 'Llegada') return llegadaMs(v);
  if (p.desde === 'Fin de descargue') return finDescargueMs(v);
  if (p.desde === 'Informe presentado') return informePresentadoMs(tramites);
  return null;
}

/**
 * Crea los trámites que faltan de un vuelo según `plazos_dian` (activos, cuyo evento ya ocurrió),
 * con inicio y vence en hora de Bogotá. Idempotente por vuelo + trámite: vuelve a leer lo que ya
 * existe justo antes de escribir. Devuelve cuántos creó.
 */
export async function asegurarTramites(v: Vuelo, plazos: Plazo[], esq: Esquema): Promise<number> {
  if (!hayTabla(esq, 'tramites_dian') || !plazos.length) return 0;
  const filas = await porRelacion('tramites_dian', 'vuelo', v.id).catch(() => [] as SdkRow[]);
  const existentes = filas.map((r) => aTramite(r));
  let creados = 0;
  for (const p of plazos) {
    if (!p.activo || !p.tramite) continue;
    if (existentes.some((t) => normT(t.tramite) === normT(p.tramite))) continue;
    const ini = inicioDePlazo(p, v, existentes);
    if (ini === null) continue;
    const vence = ini + p.horas * 3600_000;
    const fila = await cortex.tables.insert('tramites_dian', soloExistentes(esq, 'tramites_dian', {
      vuelo: v.id,
      tramite: p.tramite,
      desde_evento: p.desde,
      inicio: isoBogota(ini),
      vence: isoBogota(vence),
      estado: vence < Date.now() ? 'Vencido' : 'Pendiente',
    }));
    existentes.push(aTramite(fila));
    creados += 1;
  }
  return creados;
}

/* ───────────── Cruce de tres vías ───────────── */

export type EstadoCruceDoc = 'Coincide' | 'Faltante' | 'Sobrante' | 'Diferencia';

export interface FilaCruce {
  guia: string;
  clave: string;
  cliente: string;
  clienteId: string;
  pre: Prealerta | null;
  g: Guia | null;
  estado: EstadoCruceDoc;
  /** Qué falló, en palabras para una persona. */
  notas: string[];
  kilosPre: number | null;
  kilosMan: number | null;
  kilosRec: number | null;
  piezasPre: number | null;
  piezasMan: number | null;
  piezasRec: number | null;
}

const difiere = (a: number | null, b: number | null): boolean => a !== null && b !== null && a > 0 && b > 0 && Math.abs(a - b) > Math.max(0.5, Math.max(a, b) * 0.005);
const dato = (n: number): number | null => (n > 0 ? n : null);

/**
 * Cruza por número de guía (normalizado): prealerta ↔ manifiesto (las guías del vuelo) ↔ recibido.
 * «Recibido» solo cuenta si hay datos; falta recibido solo se marca cuando el vuelo ya se recibió.
 */
export function cruzarTresVias(prealertas: Prealerta[], guias: Guia[], vuelo: Vuelo): FilaCruce[] {
  const filas = new Map<string, { pre: Prealerta | null; g: Guia | null }>();
  for (const p of prealertas) {
    if (p.estado === 'Duplicada') continue;
    const k = normGuia(p.guia);
    if (!k) continue;
    filas.set(k, { pre: p, g: filas.get(k)?.g ?? null });
  }
  for (const g of guias) {
    const k = normGuia(g.guia);
    if (!k) continue;
    filas.set(k, { pre: filas.get(k)?.pre ?? null, g });
  }
  const recibido = ['Recibido', 'Cerrado'].includes(vuelo.estado);
  const out: FilaCruce[] = [];
  for (const [clave, { pre, g }] of filas) {
    const notas: string[] = [];
    let estado: EstadoCruceDoc = 'Coincide';
    const kilosPre = pre ? dato(pre.kilos) : null;
    const kilosMan = g ? dato(g.kilosEsp) : null;
    const kilosRec = g && g.kilosRec !== null ? g.kilosRec : null;
    const piezasPre = pre ? dato(pre.piezas) : null;
    const piezasMan = g ? dato(g.piezasEsp) : null;
    const piezasRec = g && g.piezasRec !== null ? g.piezasRec : null;
    if (pre && !g) {
      estado = 'Faltante';
      notas.push('Está prealertada pero no viene en el manifiesto');
    } else if (g && !pre) {
      estado = 'Sobrante';
      notas.push('Viene en el manifiesto pero no estaba prealertada');
    } else {
      if (difiere(kilosPre, kilosMan)) notas.push(`Kilos: prealerta ${num(kilosPre ?? 0, 1)} · manifiesto ${num(kilosMan ?? 0, 1)}`);
      if (difiere(piezasPre, piezasMan)) notas.push(`Piezas: prealerta ${num(piezasPre ?? 0)} · manifiesto ${num(piezasMan ?? 0)}`);
    }
    if (g) {
      if (kilosRec !== null && difiere(kilosMan, kilosRec)) notas.push(`Kilos: manifiesto ${num(kilosMan ?? 0, 1)} · recibido ${num(kilosRec, 1)}`);
      if (piezasRec !== null && difiere(piezasMan, piezasRec)) notas.push(`Piezas: manifiesto ${num(piezasMan ?? 0)} · recibido ${num(piezasRec)}`);
      if (recibido && kilosRec === null && piezasRec === null) {
        estado = estado === 'Coincide' ? 'Faltante' : estado;
        notas.push('No se registró lo recibido');
      }
    }
    if (estado === 'Coincide' && notas.length) estado = 'Diferencia';
    out.push({
      guia: g?.guia || pre?.guia || clave,
      clave,
      cliente: g?.cliente || pre?.cliente || '',
      clienteId: g?.clienteId || '',
      pre,
      g,
      estado,
      notas,
      kilosPre,
      kilosMan,
      kilosRec,
      piezasPre,
      piezasMan,
      piezasRec,
    });
  }
  return out.sort((a, b) => Number(a.estado === 'Coincide') - Number(b.estado === 'Coincide') || a.guia.localeCompare(b.guia));
}

export const TONO_CRUCE_DOC: Record<string, Tono> = {
  Coincide: 'good',
  'En vuelo': 'info',
  'Sin vuelo': 'warn',
  Faltante: 'warn',
  Sobrante: 'accent',
  Diferencia: 'bad',
};

export const ESTADOS_CRUCE = ['Sin vuelo', 'En vuelo', 'Coincide', 'Faltante', 'Sobrante', 'Diferencia'] as const;
export const CANALES_PREALERTA = ['Correo', 'WhatsApp', 'Hoja MERFLEX', 'Formulario cliente', 'Escaneo'] as const;

export interface ResumenCruce {
  total: number;
  coinciden: number;
  faltantes: number;
  sobrantes: number;
  diferencias: number;
  inconsistencias: number;
}

export function resumenCruce(filas: FilaCruce[]): ResumenCruce {
  const c = (e: EstadoCruceDoc) => filas.filter((f) => f.estado === e).length;
  const r = { total: filas.length, coinciden: c('Coincide'), faltantes: c('Faltante'), sobrantes: c('Sobrante'), diferencias: c('Diferencia'), inconsistencias: 0 };
  r.inconsistencias = r.faltantes + r.sobrantes + r.diferencias;
  return r;
}

/** Qué le falta a una guía para poder prefacturarse ('' si nada). */
export function faltaParaPrefacturar(f: FilaCruce): string {
  if (!f.g) return 'No viene en el manifiesto';
  const falta: string[] = [];
  if (!f.clienteId && !f.cliente) falta.push('cliente');
  if (f.estado === 'Sobrante') falta.push('prealerta');
  if (f.estado === 'Diferencia') falta.push('aclarar diferencia');
  if (f.estado === 'Faltante') falta.push('recibido');
  if (f.kilosRec === null && !falta.includes('recibido')) falta.push('recibido');
  return falta.length ? `Falta: ${falta.join(', ')}` : '';
}

/** Estado documental del vuelo a partir del cruce y los trámites. */
export function estadoDocumentalDe(nPre: number, nGuias: number, cruce: ResumenCruce | null, todasListas: boolean): string {
  if (!nPre && !nGuias) return 'Sin prealertas';
  if (!nGuias) return 'Prealertado';
  if (!cruce) return 'Manifiesto cargado';
  if (cruce.inconsistencias > 0) return 'Con inconsistencias';
  return todasListas ? 'Listo' : 'Cruzado';
}

/**
 * Guarda el resultado del cruce: estado_cruce en prealertas y guías, lista_prefactura / falta
 * en guías y estado_documental / inconsistencias en el vuelo. Solo escribe lo que cambió y lo que existe.
 */
export async function aplicarCruce(vuelo: Vuelo, filas: FilaCruce[], esq: Esquema): Promise<{ escritos: number }> {
  let escritos = 0;
  for (const f of filas) {
    if (f.pre && f.pre.estadoCruce !== f.estado && hayCampo(esq, 'prealertas', 'estado_cruce')) {
      const vals = soloExistentes(esq, 'prealertas', { estado_cruce: f.estado, vuelo: vuelo.id });
      await cortex.tables.update('prealertas', f.pre.id, vals);
      escritos += 1;
    }
    if (f.g) {
      const falta = faltaParaPrefacturar(f);
      const lista = !falta && f.estado === 'Coincide' ? 'Sí' : 'No';
      const cambios: Record<string, unknown> = {};
      if (f.g.estadoCruce !== f.estado) cambios.estado_cruce = f.estado;
      if (f.g.listaPrefactura !== lista) cambios.lista_prefactura = lista;
      if (f.g.falta !== falta) cambios.falta = falta;
      const vals = soloExistentes(esq, 'prefacturacion', cambios);
      if (Object.keys(vals).length) {
        await cortex.tables.update('prefacturacion', f.g.id, vals);
        escritos += 1;
      }
    }
  }
  const r = resumenCruce(filas);
  const todasListas = filas.length > 0 && filas.every((f) => !f.g || (f.estado === 'Coincide' && !faltaParaPrefacturar(f)));
  const estadoDoc = estadoDocumentalDe(filas.filter((f) => f.pre).length, filas.filter((f) => f.g).length, filas.length ? r : null, todasListas);
  const cambiosVuelo: Record<string, unknown> = {};
  if (vuelo.estadoDocumental !== estadoDoc) cambiosVuelo.estado_documental = estadoDoc;
  if (vuelo.inconsistencias !== r.inconsistencias) cambiosVuelo.inconsistencias = r.inconsistencias;
  const valsV = soloExistentes(esq, 'vuelos', cambiosVuelo);
  if (Object.keys(valsV).length) {
    await cortex.tables.update('vuelos', vuelo.id, valsV);
    escritos += 1;
  }
  return { escritos };
}

/** Texto base del informe de descargue e inconsistencias (la IA lo pule; si no responde, este sirve). */
export function textoInforme(vuelo: Vuelo, filas: FilaCruce[], tramite = 'Informe de descargue e inconsistencias'): string {
  const r = resumenCruce(filas);
  const lineas = [
    `${tramite.toUpperCase()} (BORRADOR)`,
    '',
    `Vuelo: ${vuelo.numero}${vuelo.aerolinea ? ` · ${vuelo.aerolinea}` : ''}`,
    `Fecha: ${vuelo.fecha}`,
    vuelo.manifiestoNumero ? `Manifiesto: ${vuelo.manifiestoNumero}` : '',
    vuelo.matricula ? `Matrícula: ${vuelo.matricula}` : '',
    `Origen: ${vuelo.origen || '—'}  Destino: ${vuelo.destino || 'BOG'}`,
    vuelo.finDescargueFecha ? `Fin de descargue: ${vuelo.finDescargueFecha} ${hhmm(vuelo.finDescargueHora)}` : '',
    '',
    `Guías cruzadas: ${r.total} · coinciden ${r.coinciden} · faltantes ${r.faltantes} · sobrantes ${r.sobrantes} · diferencias ${r.diferencias}`,
    '',
    r.inconsistencias ? 'Inconsistencias encontradas:' : 'No se encontraron inconsistencias.',
  ].filter((x, i, a) => x !== '' || a[i - 1] !== '');
  for (const f of filas.filter((x) => x.estado !== 'Coincide')) {
    lineas.push(`- Guía ${f.guia}${f.cliente ? ` (${f.cliente})` : ''}: ${f.estado.toLowerCase()}. ${f.notas.join('; ')}.`);
  }
  return lineas.join('\n');
}

/** Pide a la IA el informe a partir de los hechos; si falla, devuelve el texto base. Siempre es un borrador. */
export async function armarBorrador(vuelo: Vuelo, filas: FilaCruce[], tramite = 'Informe de descargue e inconsistencias'): Promise<{ texto: string; conIa: boolean }> {
  const base = textoInforme(vuelo, filas, tramite);
  try {
    const datos = {
      vuelo: { numero: vuelo.numero, aerolinea: vuelo.aerolinea, fecha: vuelo.fecha, origen: vuelo.origen, destino: vuelo.destino || 'BOG', matricula: vuelo.matricula, manifiesto: vuelo.manifiestoNumero, fin_descargue: `${vuelo.finDescargueFecha} ${hhmm(vuelo.finDescargueHora)}`.trim() },
      resumen: resumenCruce(filas),
      inconsistencias: filas
        .filter((f) => f.estado !== 'Coincide')
        .map((f) => ({ guia: f.guia, cliente: f.cliente, estado: f.estado, detalle: f.notas, kilos_prealerta: f.kilosPre, kilos_manifiesto: f.kilosMan, kilos_recibido: f.kilosRec, piezas_prealerta: f.piezasPre, piezas_manifiesto: f.piezasMan, piezas_recibido: f.piezasRec })),
    };
    const texto = await cortex.ai.ask(
      `Redacta en español, en tono formal y breve, el borrador del trámite «${tramite}» de este vuelo de carga, para que una persona lo revise y lo copie al servicio de la DIAN (MUISCA). Usa SOLO los datos entregados, no inventes cifras ni guías. Estructura: encabezado del vuelo, resumen de cifras, lista de inconsistencias por guía (faltante, sobrante o diferencia, con las cantidades), y una línea final que diga que el detalle se soporta con el manifiesto y los registros de recepción. Responde solo con el texto, sin comentarios.`,
      datos,
    );
    const limpio = String(texto ?? '').trim();
    return limpio.length > 60 ? { texto: limpio, conIa: true } : { texto: base, conIa: false };
  } catch {
    return { texto: base, conIa: false };
  }
}

/* ───────────── Avisos al cliente ───────────── */

export const TIPOS_AVISO = ['Llegada', 'Novedad', 'Diferencia de peso', 'Faltante', 'Sobrante', 'Documento faltante', 'Otro'] as const;
export const CANALES_AVISO = ['WhatsApp', 'Correo', 'Llamada'] as const;
export const ESTADOS_AVISO = ['Por enviar', 'Enviado', 'Respondido'] as const;
export const TONO_AVISO: Record<string, Tono> = { 'Por enviar': 'warn', Enviado: 'info', Respondido: 'good' };

export interface AvisoCliente {
  id: string;
  vueloId: string;
  guiaId: string;
  guia: string;
  clienteId: string;
  cliente: string;
  tipo: string;
  canal: string;
  mensaje: string;
  estado: string;
  enviadoPor: string;
  enviadoEn: string;
  enlace: string;
}

export function aAviso(r: SdkRow): AvisoCliente {
  const v = r.values;
  return {
    id: r.id,
    vueloId: relId(v.vuelo),
    guiaId: relId(v.guia),
    guia: T(v.guia),
    clienteId: relId(v.cliente),
    cliente: T(v.cliente),
    tipo: T(v.tipo),
    canal: T(v.canal),
    mensaje: T(v.mensaje),
    estado: T(v.estado) || 'Por enviar',
    enviadoPor: T(v.enviado_por),
    enviadoEn: T(v.enviado_en),
    enlace: T(v.enlace_documentos),
  };
}

export interface ClienteContacto {
  id: string;
  nombre: string;
  whatsapp: string;
  correo: string;
  contacto: string;
}

export function aContacto(r: SdkRow): ClienteContacto {
  const v = r.values;
  return { id: r.id, nombre: T(v.nombre) || T(v.razon_social) || r.label, whatsapp: T(v.whatsapp), correo: T(v.correo), contacto: T(v.contacto) };
}

/** Número para wa.me: solo dígitos y con indicativo de Colombia si trae 10 dígitos. '' si no sirve. */
export function numeroWa(s: string): string {
  let d = s.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('3')) d = `57${d}`;
  return d.length >= 11 && d.length <= 15 ? d : '';
}

export const enlaceWa = (num_: string, mensaje: string): string => `https://wa.me/${num_}?text=${encodeURIComponent(mensaje)}`;

export interface SugerenciaAviso {
  clienteId: string;
  cliente: string;
  tipo: (typeof TIPOS_AVISO)[number];
  guias: FilaCruce[];
  mensaje: string;
}

const verbo = (e: string) => (e === 'Faltante' ? 'no llegó' : e === 'Sobrante' ? 'llegó sin prealerta' : 'llegó con diferencia');

/** Un mensaje por cliente según el cruce: si hay problemas se avisa el más grave; si no, la llegada. */
export function sugerirAvisos(filas: FilaCruce[], vuelo: Vuelo, contactos: ClienteContacto[]): SugerenciaAviso[] {
  const porCliente = new Map<string, FilaCruce[]>();
  for (const f of filas) {
    if (!f.g) continue;
    const k = f.clienteId || normNombre(f.cliente);
    if (!k) continue;
    porCliente.set(k, [...(porCliente.get(k) ?? []), f]);
  }
  const out: SugerenciaAviso[] = [];
  for (const [, gs] of porCliente) {
    const primero = gs[0] as FilaCruce;
    const c = contactos.find((x) => x.id === primero.clienteId) ?? contactos.find((x) => normNombre(x.nombre) === normNombre(primero.cliente));
    const nombre = c?.contacto || c?.nombre || primero.cliente;
    const malas = gs.filter((f) => f.estado !== 'Coincide');
    let tipo: SugerenciaAviso['tipo'] = 'Llegada';
    if (malas.some((f) => f.estado === 'Faltante')) tipo = 'Faltante';
    else if (malas.some((f) => f.estado === 'Diferencia')) tipo = 'Diferencia de peso';
    else if (malas.some((f) => f.estado === 'Sobrante')) tipo = 'Sobrante';
    const vuelotxt = `${vuelo.numero}${vuelo.aerolinea ? ` (${vuelo.aerolinea})` : ''} del ${vuelo.fecha}`;
    const lineas = [`Hola ${nombre}, le escribimos de Groundflex sobre el vuelo ${vuelotxt}.`];
    if (!malas.length) {
      lineas.push(`Su carga llegó: ${gs.map((f) => `guía ${f.guia}${f.kilosRec ?? f.kilosMan ? ` (${kg(f.kilosRec ?? f.kilosMan ?? 0)})` : ''}`).join(', ')}.`);
    } else {
      lineas.push('Encontramos novedades con su carga:');
      for (const f of malas) lineas.push(`- Guía ${f.guia}: ${verbo(f.estado)}. ${f.notas.join('; ')}.`);
      const ok = gs.filter((f) => f.estado === 'Coincide');
      if (ok.length) lineas.push(`El resto llegó conforme: ${ok.map((f) => f.guia).join(', ')}.`);
    }
    lineas.push('Quedamos atentos a sus comentarios.');
    out.push({ clienteId: primero.clienteId, cliente: c?.nombre || primero.cliente, tipo, guias: gs, mensaje: lineas.join('\n') });
  }
  return out.sort((a, b) => Number(b.tipo !== 'Llegada') - Number(a.tipo !== 'Llegada') || a.cliente.localeCompare(b.cliente));
}

/** Texto para pedir al cliente los documentos que faltan. */
export function textoPedirDocumentos(cliente: string, vuelo: Vuelo, guias: string[], enlace: string): string {
  return [
    `Hola ${cliente}, para continuar con el trámite de su carga del vuelo ${vuelo.numero} (${vuelo.fecha}) necesitamos los documentos de las guías ${guias.join(', ')}: factura comercial, lista de empaque y documento de transporte.`,
    enlace ? `Puede enviarlos aquí: ${enlace}` : 'Puede responder a este mensaje con los archivos.',
    'Gracias por su ayuda.',
  ].join('\n');
}

/** Copia al portapapeles; el marco puede bloquearlo, entonces se prueba el método antiguo. */
export async function copiar(texto: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = texto;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Nombres de fila → guías normalizadas de las guías del vuelo (para cruzar con avisos). */
export const guiasDe = (rows: SdkRow[]): Guia[] => rows.map(aGuia);

/** Texto de «hace X» entre un ISO y ahora. */
export function hace(iso: string, ahora = Date.now()): string {
  const t = msDeIso(iso);
  if (t === null) return '';
  const d = ahora - t;
  return d >= 0 ? `hace ${duracion(d)}` : `en ${duracion(d)}`;
}

export const fechaHoraBogota = (iso: string): string => fechaHora(iso);
