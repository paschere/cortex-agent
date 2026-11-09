import type { SdkLocation, SdkRow } from '@cortex/app-sdk';
import { aAtencion, aEvento, aGuia } from './datos';
import type { Atencion, Evento, Guia, Vuelo } from './datos';
import { msBogota } from './documental';
import { hoyBogota } from './tiempo';
import type { Tarea } from './tareas';
import type { Tono } from './estados';

/**
 * CENTRO DE ATENCIÓN — lógica pura: objetivos, novedades del día, atenciones con cronómetro por etapa
 * y operarios en turno. La pantalla (screens/centro.tsx) solo pinta lo que sale de aquí.
 */

/** TODOS los tiempos objetivo del centro viven aquí (minutos). */
export const OBJETIVOS = {
  /** Aterrizó y nadie lo ha tomado: pasado esto se pone rojo. */
  sinTomarMin: 10,
  /** Atención en proceso (tomado → cierre). */
  atencionMin: 90,
  /** Cerrada por el operario y todavía sin aprobar el supervisor. */
  aprobarMin: 60,
  /** Tarea asignada y sin iniciar. */
  tareaSinIniciarMin: 15,
  /** Tarea en curso. */
  tareaMin: 60,
  /** Una novedad CRÍTICA que nadie ha visto en este tiempo se marca «Escalada» (igual que la regla del servidor). */
  escalaCriticaMin: 10,
  /** Fracción del objetivo desde la cual el cronómetro pasa a ámbar. */
  avisoFraccion: 0.75,
  /** Ubicación más vieja que esto se considera «sin señal reciente». */
  ubicacionVieja: 10,
} as const;

export type Filtro = 'criticas' | 'sinver' | 'vuelos' | 'tareas' | 'todo';
export const FILTROS: { id: Filtro; texto: string }[] = [
  { id: 'criticas', texto: 'Críticas' },
  { id: 'sinver', texto: 'Sin ver' },
  { id: 'vuelos', texto: 'Vuelos' },
  { id: 'tareas', texto: 'Tareas' },
  { id: 'todo', texto: 'Todo' },
];

/* ───────────── Tiempos ───────────── */

/** «hace 12 s», «hace 4 min», «hace 2 h»: corre segundo a segundo bajo el minuto. */
export function haceTxt(seg: number): string {
  const s = Math.max(0, Math.floor(seg));
  if (s < 60) return `hace ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `hace ${h} h ${m % 60 ? `${m % 60} min` : ''}`.trim() : `hace ${Math.floor(h / 24)} d`;
}

/** mm:ss (o h:mm:ss) de un cronómetro. */
export function reloj(seg: number): string {
  const s = Math.max(0, Math.floor(seg));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

/** Tono de un cronómetro frente a su objetivo: bien, ámbar cerca, rojo vencido. */
export function tonoCrono(minTranscurridos: number, objetivoMin: number): Tono {
  if (minTranscurridos >= objetivoMin) return 'bad';
  if (minTranscurridos >= objetivoMin * OBJETIVOS.avisoFraccion) return 'warn';
  return 'good';
}

const msDe = (iso: string): number | null => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/* ───────────── Novedades (feed) ───────────── */

export type FuenteNovedad = 'evento' | 'atencion' | 'guia';

export interface Novedad {
  clave: string;
  fuente: FuenteNovedad;
  /** Tabla donde vive (para escribir «lo vi»). */
  tabla: string;
  id: string;
  titulo: string;
  detalle: string;
  vueloId: string;
  vuelo: string;
  tareaId: string;
  quien: string;
  critico: boolean;
  at: number;
  vistoPor: string;
  vistoEn: string;
  tomadoPor: string;
  escalado: boolean;
  /** Ya resuelto: no cuenta como pendiente. */
  cerrada: boolean;
  /** ¿Se puede guardar «lo vi» en la base? (solo los eventos). */
  persiste: boolean;
  evento?: Evento;
}

const hayTexto = (s: string): boolean => s.trim() !== '' && !/^(no|ninguna?|n\/a|-|—)$/i.test(s.trim());

function deEvento(r: SdkRow, hoy: string): Novedad | null {
  const e = aEvento(r);
  const at = msDe(r.created_at) ?? 0;
  const esHoy = e.fecha === hoy || hoyBogota(at) === hoy;
  if (!esHoy && !(e.critico && e.estado !== 'Resuelto')) return null;
  return {
    clave: `ev:${e.id}`,
    fuente: 'evento',
    tabla: 'eventos_operacion',
    id: e.id,
    titulo: e.tipo || 'Evento',
    detalle: e.descripcion,
    vueloId: e.vueloId,
    vuelo: e.vuelo,
    tareaId: e.tareaId,
    quien: e.operario,
    critico: e.critico,
    at,
    vistoPor: e.vistoPor || (e.estado !== 'Abierto' ? 'Supervisor' : ''),
    vistoEn: e.vistoEn,
    tomadoPor: e.tomadoPor,
    escalado: e.escalado,
    cerrada: e.estado === 'Resuelto',
    persiste: true,
    evento: e,
  };
}

function deAtencion(a: Atencion, r: SdkRow, hoy: string): Novedad | null {
  if (!hayTexto(a.novedades)) return null;
  const at = msDe(r.updated_at) ?? msDe(a.creada) ?? 0;
  if (hoyBogota(at) !== hoy && a.fecha !== hoy) return null;
  return {
    clave: `at:${a.id}`,
    fuente: 'atencion',
    tabla: 'atenciones',
    id: a.id,
    titulo: `Novedad en la atención de ${a.vuelo || 'un vuelo'}`,
    detalle: a.novedades,
    vueloId: a.vueloId,
    vuelo: a.vuelo,
    tareaId: '',
    quien: a.operario,
    critico: false,
    at,
    vistoPor: '',
    vistoEn: '',
    tomadoPor: '',
    escalado: false,
    cerrada: a.estado === 'Aprobada',
    persiste: false,
  };
}

function deGuia(g: Guia, r: SdkRow, vuelosHoy: Map<string, Vuelo>, hoy: string): Novedad | null {
  if (!hayTexto(g.novedad)) return null;
  const v = vuelosHoy.get(g.vueloId);
  const at = msDe(r.updated_at) ?? msDe(r.created_at) ?? 0;
  if (!v && hoyBogota(at) !== hoy) return null;
  return {
    clave: `gu:${g.id}`,
    fuente: 'guia',
    tabla: 'prefacturacion',
    id: g.id,
    titulo: `Novedad en la guía ${g.guia}`,
    detalle: g.novedad,
    vueloId: g.vueloId,
    vuelo: v?.numero ?? '',
    tareaId: '',
    quien: g.cliente,
    critico: false,
    at,
    vistoPor: '',
    vistoEn: '',
    tomadoPor: '',
    escalado: false,
    cerrada: false,
    persiste: false,
  };
}

export interface DatosCentro {
  vuelos: Vuelo[];
  atenciones: Atencion[];
  tareas: Tarea[];
  novedades: Novedad[];
}

/** Novedades de hoy de las tres fuentes, de la más nueva a la más vieja. */
export function armarNovedades(evRows: SdkRow[], atRows: SdkRow[], guRows: SdkRow[], vuelos: Vuelo[], hoy = hoyBogota()): Novedad[] {
  const vuelosHoy = new Map(vuelos.filter((v) => v.fecha === hoy).map((v) => [v.id, v]));
  const out: Novedad[] = [];
  for (const r of evRows) {
    const n = deEvento(r, hoy);
    if (n) out.push(n);
  }
  for (const r of atRows) {
    const n = deAtencion(aAtencion(r), r, hoy);
    if (n) out.push(n);
  }
  for (const r of guRows) {
    const n = deGuia(aGuia(r), r, vuelosHoy, hoy);
    if (n) out.push(n);
  }
  return out.sort((a, b) => b.at - a.at);
}

export const esVisto = (n: Novedad, vistasLocal: ReadonlySet<string>): boolean => !!n.vistoPor || vistasLocal.has(n.clave);

/** Crítica que nadie vio en `escalaCriticaMin` minutos (o ya marcada por la regla del servidor). */
export function estaEscalada(n: Novedad, ahora: number, vistasLocal: ReadonlySet<string>): boolean {
  if (!n.critico || n.cerrada || esVisto(n, vistasLocal)) return false;
  return n.escalado || (ahora - n.at) / 60_000 >= OBJETIVOS.escalaCriticaMin;
}

export function pasaFiltro(n: Novedad, f: Filtro, vistasLocal: ReadonlySet<string>): boolean {
  switch (f) {
    case 'criticas':
      return n.critico;
    case 'sinver':
      return !esVisto(n, vistasLocal) && !n.cerrada;
    case 'vuelos':
      return !!n.vueloId && !n.tareaId;
    case 'tareas':
      return !!n.tareaId;
    default:
      return true;
  }
}

/* ───────────── Atenciones activas con cronómetro por etapa ───────────── */

export const ETAPAS = ['Llegó', 'Tomado', 'En proceso', 'Cerrado'] as const;

export interface TramoEtapa {
  etapa: (typeof ETAPAS)[number];
  /** 'hecha' (con duración fija), 'actual' (cronómetro vivo) o 'falta'. */
  estado: 'hecha' | 'actual' | 'falta';
  /** Duración cerrada en segundos (etapas hechas). */
  segundos: number | null;
}

export interface Activa {
  clave: string;
  tipo: 'vuelo' | 'tarea';
  id: string;
  vueloId: string;
  titulo: string;
  sub: string;
  quien: string;
  /** Índice de ETAPAS donde está ahora. */
  etapa: number;
  /** Desde cuándo está en la etapa actual (ms). */
  desde: number;
  objetivoMin: number;
  /** Texto de lo que se espera: «Debe tomarlo un operario». */
  siguiente: string;
  tramos: TramoEtapa[];
}

function tramos(etapa: number, t: { llego: number | null; tomado: number | null; cierre: number | null; ahora: number }): TramoEtapa[] {
  const dur = (a: number | null, b: number | null) => (a !== null && b !== null && b >= a ? Math.round((b - a) / 1000) : null);
  return ETAPAS.map((nombre, i): TramoEtapa => {
    const estado = i < etapa ? 'hecha' : i === etapa ? 'actual' : 'falta';
    let segundos: number | null = null;
    if (estado === 'hecha') {
      if (i === 0) segundos = dur(t.llego, t.tomado ?? t.cierre);
      else if (i === 2) segundos = dur(t.tomado, t.cierre ?? t.ahora);
      else segundos = null;
    }
    return { etapa: nombre, estado, segundos };
  });
}

export function armarActivas(vuelos: Vuelo[], atenciones: Atencion[], tareas: Tarea[], ahora: number): Activa[] {
  const out: Activa[] = [];
  const hoy = hoyBogota(ahora);
  for (const v of vuelos) {
    if (!['Aterrizó', 'En atención', 'Recibido'].includes(v.estado)) continue;
    if (v.fecha && v.fecha < hoy && v.estado === 'Recibido') continue;
    const llego = msBogota(v.fecha, v.llegadaHora) ?? msBogota(v.fecha, v.horaActual);
    const tomado = msBogota(v.fecha, v.tomadoHora);
    const cierre = msBogota(v.fecha, v.cierreHora);
    const at = atenciones.find((a) => a.vueloId === v.id && a.estado !== 'Rechazada');
    const etapa = v.estado === 'Aterrizó' ? 0 : v.estado === 'En atención' ? 2 : 3;
    const desde = etapa === 0 ? (llego ?? ahora) : etapa === 2 ? (tomado ?? (at ? msBogota(at.fecha, at.horaInicio) : null) ?? llego ?? ahora) : (cierre ?? tomado ?? ahora);
    out.push({
      clave: `v:${v.id}`,
      tipo: 'vuelo',
      id: v.id,
      vueloId: v.id,
      titulo: v.numero,
      sub: [v.aerolinea, v.posicion ? `Posición ${v.posicion}` : ''].filter(Boolean).join(' · '),
      quien: v.atendidoPor || at?.operario || '',
      etapa,
      desde,
      objetivoMin: etapa === 0 ? OBJETIVOS.sinTomarMin : etapa === 2 ? OBJETIVOS.atencionMin : OBJETIVOS.aprobarMin,
      siguiente: etapa === 0 ? 'Un operario debe tomarlo' : etapa === 2 ? 'Contando la carga' : 'Falta que el supervisor la apruebe',
      tramos: tramos(etapa, { llego, tomado, cierre, ahora }),
    });
  }
  for (const t of tareas) {
    if (t.estado !== 'Asignada' && t.estado !== 'En curso') continue;
    const creado = msDe(t.creado) ?? ahora;
    const ini = msDe(t.inicio);
    const etapa = t.estado === 'Asignada' ? 0 : 2;
    out.push({
      clave: `t:${t.id}`,
      tipo: 'tarea',
      id: t.id,
      vueloId: t.vueloId,
      titulo: t.titulo,
      sub: [t.tipo, t.desde && t.hasta ? `${t.desde} → ${t.hasta}` : '', t.prioridad === 'Urgente' ? 'URGENTE' : ''].filter(Boolean).join(' · '),
      quien: t.asignados,
      etapa,
      desde: etapa === 0 ? creado : (ini ?? creado),
      objetivoMin: etapa === 0 ? OBJETIVOS.tareaSinIniciarMin : OBJETIVOS.tareaMin,
      siguiente: etapa === 0 ? 'Nadie la ha iniciado' : 'En curso',
      tramos: tramos(etapa, { llego: creado, tomado: ini, cierre: null, ahora }),
    });
  }
  // Primero lo más pasado de su objetivo.
  return out.sort((a, b) => (ahora - b.desde) / 60_000 / b.objetivoMin - (ahora - a.desde) / 60_000 / a.objetivoMin);
}

/* ───────────── Operarios en turno ───────────── */

export interface PersonaTurno {
  ref: string;
  name: string;
  onShift: boolean;
}

export interface OperarioAhora {
  clave: string;
  nombre: string;
  /** Qué hace ahora: «Atendiendo AV123», «Tarea: Recoger X», «En turno, libre». */
  haciendo: string;
  detalle: string;
  /** Desde cuándo (ms) o null si está libre. */
  desde: number | null;
  vueloId: string;
  ocupado: boolean;
  /** Última ubicación. */
  lugar: string;
  lugarAt: number | null;
}

const sinPrefijo = (ref: string): string => ref.replace(/^[um]:/, '');
const mismo = (a: string, b: string): boolean => !!a && !!b && (sinPrefijo(a) === sinPrefijo(b) || a.trim().toLowerCase() === b.trim().toLowerCase());

export function armarOperarios(personas: PersonaTurno[], vuelos: Vuelo[], atenciones: Atencion[], tareas: Tarea[], ubicaciones: SdkLocation[], ahora: number): OperarioAhora[] {
  type Base = { clave: string; nombre: string; refs: string[] };
  const base = new Map<string, Base>();
  const poner = (nombre: string, ref: string) => {
    const k = ref ? sinPrefijo(ref) : nombre.trim().toLowerCase();
    if (!k) return;
    const prev = base.get(k);
    if (prev) {
      if (ref && !prev.refs.includes(ref)) prev.refs.push(ref);
    } else base.set(k, { clave: k, nombre: nombre || 'Operario', refs: ref ? [ref] : [] });
  };
  for (const p of personas) if (p.onShift) poner(p.name, p.ref);
  // También quien está haciendo algo, aunque la lista de personas no llegue (rol sin permiso para verla).
  for (const a of atenciones) if (a.estado === 'En atención') poner(a.operario, a.operarioId);
  for (const t of tareas)
    if (t.estado === 'En curso') {
      const nombres = t.asignados.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
      t.asignadosIds.forEach((r, i) => poner(nombres[i] ?? nombres[0] ?? 'Operario', r));
    }
  const filas: OperarioAhora[] = [];
  for (const b of base.values()) {
    const quien = (id: string, nombre: string) => b.refs.some((r) => mismo(r, id)) || mismo(nombre, b.nombre);
    const at = atenciones.find((a) => a.estado === 'En atención' && quien(a.operarioId, a.operario));
    const ta = tareas.find((t) => t.estado === 'En curso' && (t.asignadosIds.some((r) => b.refs.some((x) => mismo(x, r))) || t.asignados.toLowerCase().includes(b.nombre.toLowerCase())));
    const loc = ubicaciones.find((l) => b.refs.some((r) => mismo(r, l.userId)) || mismo(l.name, b.nombre));
    const lugarAt = loc ? msDe(loc.at) : null;
    const place = (loc as { place?: string } | undefined)?.place ?? '';
    let haciendo = 'En turno, libre';
    let detalle = '';
    let desde: number | null = null;
    let vueloId = '';
    if (at) {
      const v = vuelos.find((x) => x.id === at.vueloId);
      haciendo = `Atendiendo ${at.vuelo || v?.numero || 'un vuelo'}`;
      detalle = [v?.aerolinea, v?.posicion ? `Posición ${v.posicion}` : ''].filter(Boolean).join(' · ');
      desde = msBogota(at.fecha, at.horaInicio) ?? (v ? msBogota(v.fecha, v.tomadoHora) : null);
      vueloId = at.vueloId;
    } else if (ta) {
      haciendo = `Tarea: ${ta.titulo}`;
      detalle = ta.desde && ta.hasta ? `${ta.desde} → ${ta.hasta}` : ta.tipo;
      desde = msDe(ta.inicio) ?? msDe(ta.creado);
      vueloId = ta.vueloId;
    }
    filas.push({
      clave: b.clave,
      nombre: b.nombre,
      haciendo,
      detalle,
      desde,
      vueloId,
      ocupado: !!(at || ta),
      lugar: loc ? (place || `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`) : '',
      lugarAt,
    });
  }
  void ahora;
  return filas.sort((a, b) => Number(b.ocupado) - Number(a.ocupado) || a.nombre.localeCompare(b.nombre));
}

