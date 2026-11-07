import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { cortex } from '@cortex/app-sdk';
import { ArrowRight, Ban, Box, Clock, Hand, Plane, Repeat, Send, Truck, UserCheck, UserCog, Zap } from 'lucide-react';
import { Dictado } from '../lib/dictado';
import { aVuelo, traerTodo, useCarga, useRol } from '../lib/datos';
import type { Vuelo } from '../lib/datos';
import { CargaCtx, SelectorOperarios } from '../lib/PiezasTareas';
import { faltantesDe, hayCampo, hayTabla, hace, soloExistentes, useAhora, useEsquema } from '../lib/documental';
import { TONO_VUELO, tono } from '../lib/estados';
import { cop, cronometro, hhmm, minTxt } from '../lib/formato';
import { PLANTILLAS, REQUERIDO_TAREAS, TONO_TAREA, cargarTareas, lugaresUsados, nombresDe, usePersonas } from '../lib/tareas';
import type { Persona, Tarea } from '../lib/tareas';
import { msDeIso } from '../lib/documental';
import { horaAhora, hoyBogota } from '../lib/tiempo';
import { Boton, Campo, Chip, ES_VIVO, ErrorCaja, Estado, Hoja, Pantalla, Segmentos, Tarjeta, avisar, confirmar, useOperacion } from '../lib/ui';

/**
 * ASIGNAR — el supervisor (o el documental) crea una tarea en ~10 s: plantilla, de dónde a
 * dónde, a quién (los de turno primero), prioridad y para cuándo. Debajo, el tablero de tareas
 * y los vuelos por asignar. Se actualiza solo cada 15 s.
 */

const CADA = 15_000;

interface Datos {
  tareas: Tarea[];
  vuelos: Vuelo[];
}

async function cargar(): Promise<Datos> {
  const [tareas, vs] = await Promise.all([cargarTareas(400), traerTodo('vuelos', { order: { field: 'fecha', dir: 'desc' } }, 200).catch(() => [])]);
  return { tareas, vuelos: vs.map(aVuelo) };
}

const ICONO: Record<string, ReactNode> = {
  Recoger: <Hand size={22} />,
  Entregar: <Box size={22} />,
  Traslado: <Truck size={22} />,
  'Apoyo a vuelo': <Plane size={22} />,
};

const AYUDA_TITULO: Record<string, string> = {
  Recoger: 'Ej.: recoger pallet de flores',
  Entregar: 'Ej.: entregar documentos al agente',
  Traslado: 'Ej.: pasar carga de la bodega 2 a la 4',
  'Apoyo a vuelo': 'Ej.: apoyar descargue del vuelo',
};

export default function Asignar() {
  const { data, loading, error, refresh } = useCarga(cargar, [], CADA);
  const esq = useEsquema();
  const ops = usePersonas(['operario']);
  const falta = faltantesDe(esq, REQUERIDO_TAREAS);
  const sinTabla = esq.listo && !hayTabla(esq, 'tareas_operacion');
  const lugares = useMemo(() => lugaresUsados(data?.tareas ?? []), [data]);
  // Carga de cada operario: tareas abiertas + vuelos que le asignaron y siguen sin cerrarse.
  const cargaPor = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of data?.tareas ?? []) if (t.estado === 'Asignada' || t.estado === 'En curso') for (const r of t.asignadosIds) m[r] = (m[r] ?? 0) + 1;
    for (const v of data?.vuelos ?? []) if (!['Recibido', 'Cerrado', 'Cancelado'].includes(v.estado) && v.fecha === hoyBogota()) for (const r of v.asignadosIds) m[r] = (m[r] ?? 0) + 1;
    return m;
  }, [data]);

  return (
    <Pantalla titulo="Asignar" sub="Crea una tarea en segundos, elige quién la hace y mira cómo van.">
      <CargaCtx.Provider value={cargaPor}>
      {sinTabla ? (
        <div className="oc-aviso" style={{ marginBottom: 16 }}>Todavía falta aplicar los datos de tareas ({falta.join('; ') || 'tabla tareas_operacion'}). Pídele al administrador que los aplique; mientras tanto solo puedes asignar vuelos.</div>
      ) : falta.length ? (
        <div className="oc-aviso" style={{ marginBottom: 16 }}>Faltan datos por aplicar: {falta.join('; ')}. Algunas cosas se guardan sin ellos.</div>
      ) : null}
      {ops.faltaActualizar ? <div className="oc-aviso" style={{ marginBottom: 16 }}>Falta actualizar Cortex para ver la lista de operarios. Cuando se actualice aparecerá aquí sin tocar nada más.</div> : null}
      {ops.error ? <ErrorCaja mensaje={`No se pudo leer la lista de operarios. ${ops.error}`} /> : null}

      {sinTabla ? null : <NuevaTarea personas={ops.personas} cargandoPersonas={ops.cargando} lugares={lugares} vuelos={data?.vuelos ?? []} onCreada={refresh} />}

      {sinTabla ? null : (
        <div className="oc-sec">
          <h2><UserCheck size={22} /> Tareas</h2>
          <Estado cargando={loading} error={error} vacio={!data} tituloVacio="Sin datos" reintentar={() => void refresh()}>
            {data ? <Tablero tareas={data.tareas} personas={ops.personas} onCambio={refresh} /> : null}
          </Estado>
        </div>
      )}

      <div className="oc-sec">
        <h2><Plane size={22} /> Vuelos por asignar</h2>
        {!esq.listo || hayCampo(esq, 'vuelos', 'asignados_ids') ? (
          <VuelosPorAsignar vuelos={data?.vuelos ?? []} cargando={loading && !data} personas={ops.personas} onCambio={refresh} />
        ) : (
          <div className="oc-aviso">Falta aplicar los campos de asignación en vuelos (asignados_ids, asignados).</div>
        )}
      </div>
      </CargaCtx.Provider>
    </Pantalla>
  );
}

/* ───────────── Crear tarea ───────────── */

type Cuando = 'ya' | 'hoy' | 'otro';

function NuevaTarea({ personas, cargandoPersonas, lugares, vuelos, onCreada }: { personas: Persona[]; cargandoPersonas: boolean; lugares: string[]; vuelos: Vuelo[]; onCreada: () => Promise<void> }) {
  const { nombre } = useRol();
  const esq = useEsquema();
  const op = useOperacion();
  const [tipo, setTipo] = useState<string>('Recoger');
  const [titulo, setTitulo] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [detalle, setDetalle] = useState('');
  const [refs, setRefs] = useState<string[]>([]);
  const [urgente, setUrgente] = useState<'Normal' | 'Urgente'>('Normal');
  const [cuando, setCuando] = useState<Cuando>('ya');
  const [hora, setHora] = useState(horaAhora());
  const [fecha, setFecha] = useState(hoyBogota());
  const [vueloId, setVueloId] = useState('');
  const [mas, setMas] = useState(false);

  const vuelosAbiertos = useMemo(() => vuelos.filter((v) => !['Cerrado', 'Cancelado'].includes(v.estado)).sort((a, b) => (b.fecha + b.horaActual).localeCompare(a.fecha + a.horaActual)).slice(0, 40), [vuelos]);
  const nombrePor = useMemo(() => new Map(personas.map((p) => [p.ref, p.name])), [personas]);
  const sugerido = [tipo, desde.trim() && hasta.trim() ? `${desde.trim()} → ${hasta.trim()}` : desde.trim() || hasta.trim()].filter(Boolean).join(': ');
  const necesitaVuelo = tipo === 'Apoyo a vuelo';

  const crear = async () => {
    if (!refs.length) return avisar('Escoge al menos un operario.');
    const nombres = refs.map((r) => nombrePor.get(r) ?? r);
    const valores = soloExistentes(esq, 'tareas_operacion', {
      titulo: titulo.trim() || sugerido || tipo,
      tipo,
      descripcion: detalle.trim() || undefined,
      desde: desde.trim() || undefined,
      hasta: hasta.trim() || undefined,
      vuelo: vueloId || undefined,
      asignados_ids: refs.join(','),
      asignados: nombres.join(', '),
      prioridad: urgente,
      para_fecha: cuando === 'otro' ? fecha : hoyBogota(),
      para_hora: cuando === 'ya' ? horaAhora() : hora,
      estado: 'Asignada',
      creada_por: nombre || undefined,
    });
    const ok = await op.correr(() => cortex.tables.insert('tareas_operacion', valores), `Tarea creada para ${nombres.join(', ')}.`);
    if (ok) {
      setTitulo('');
      setDesde('');
      setHasta('');
      setDetalle('');
      setRefs([]);
      setUrgente('Normal');
      setCuando('ya');
      setVueloId('');
      await onCreada();
    }
  };

  return (
    <Tarjeta titulo="Nueva tarea" icono={<Zap size={20} />}>
      <div className="oc-form">
        <div className="oc-plant" role="group" aria-label="Plantilla">
          {PLANTILLAS.map((p) => (
            <button key={p} type="button" aria-pressed={tipo === p} onClick={() => setTipo(p)}>
              {ICONO[p]}
              {p}
            </button>
          ))}
        </div>

        <Campo etiqueta="¿Qué hay que hacer?" ayuda={titulo.trim() ? undefined : sugerido ? `Si lo dejas vacío se llamará «${sugerido}».` : undefined}>
          <input type="text" value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder={AYUDA_TITULO[tipo] ?? ''} />
        </Campo>

        <div className="oc-fila2">
          <Campo etiqueta={tipo === 'Entregar' ? 'Sale de' : 'Desde'}>
            <input type="text" list="oc-lugares" value={desde} onChange={(e) => setDesde(e.target.value)} placeholder="Lugar de origen" autoComplete="off" />
          </Campo>
          <Campo etiqueta={tipo === 'Recoger' ? 'Llevar a' : 'Hasta'}>
            <input type="text" list="oc-lugares" value={hasta} onChange={(e) => setHasta(e.target.value)} placeholder="Lugar de destino" autoComplete="off" />
          </Campo>
        </div>
        <datalist id="oc-lugares">
          {lugares.slice(0, 40).map((l) => <option key={l} value={l} />)}
        </datalist>
        {lugares.length ? (
          <div className="oc-chips" aria-label="Lugares usados">
            {lugares.slice(0, 8).map((l) => (
              <button key={l} type="button" className="oc-btn chico suave" onClick={() => (!desde.trim() ? setDesde(l) : setHasta(l))}>
                {l}
              </button>
            ))}
          </div>
        ) : null}

        <Campo etiqueta="¿Quién la hace?">
          {cargandoPersonas && !personas.length ? <p className="oc-sub">Cargando operarios…</p> : null}
          {!cargandoPersonas && !personas.length ? <p className="oc-sub">No hay operarios para escoger todavía.</p> : null}
          <SelectorOperarios personas={personas} valor={refs} onChange={setRefs} />
        </Campo>

        <div className="oc-fila2">
          <Campo etiqueta="Prioridad">
            <Segmentos valor={urgente} onChange={setUrgente} opciones={[{ id: 'Normal', texto: 'Normal' }, { id: 'Urgente', texto: 'Urgente' }]} />
          </Campo>
          <Campo etiqueta="¿Para cuándo?">
            <Segmentos valor={cuando} onChange={setCuando} opciones={[{ id: 'ya', texto: 'Ya' }, { id: 'hoy', texto: 'Hoy a las…' }, { id: 'otro', texto: 'Otro día' }]} />
          </Campo>
        </div>
        {cuando !== 'ya' ? (
          <div className="oc-fila2">
            {cuando === 'otro' ? <Campo etiqueta="Fecha"><input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} /></Campo> : null}
            <Campo etiqueta="Hora"><input type="time" value={hora} onChange={(e) => setHora(e.target.value)} /></Campo>
          </div>
        ) : null}

        {mas || necesitaVuelo || vueloId ? (
          <>
            <Campo etiqueta={necesitaVuelo ? 'Vuelo' : 'Vuelo (opcional)'}>
              <select value={vueloId} onChange={(e) => setVueloId(e.target.value)}>
                <option value="">Sin vuelo</option>
                {vuelosAbiertos.map((v) => <option key={v.id} value={v.id}>{v.numero} · {v.fecha.slice(5)} {hhmm(v.horaActual)} · {v.estado}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Detalle (opcional)">
              <textarea value={detalle} onChange={(e) => setDetalle(e.target.value)} rows={2} placeholder="Qué recoger, a quién preguntar, cuidados…" />
              <div className="oc-btns" style={{ marginTop: 6 }}><Dictado onTexto={(t) => setDetalle((d) => (d ? `${d} ${t}` : t))} /></div>
            </Campo>
          </>
        ) : (
          <div><Boton chico tono="suave" onClick={() => setMas(true)}>+ Vuelo y detalle</Boton></div>
        )}

        {op.error ? <ErrorCaja mensaje={op.error} /> : null}
        <Boton tono="primario" grande disabled={op.ocupado || !refs.length} onClick={() => void crear()} icono={<Send size={20} />}>
          {op.ocupado ? 'Creando…' : refs.length ? 'Crear y avisar' : 'Escoge a quién se la asignas'}
        </Boton>
      </div>
    </Tarjeta>
  );
}

/* ───────────── Tablero ───────────── */

function Tablero({ tareas, personas, onCambio }: { tareas: Tarea[]; personas: Persona[]; onCambio: () => Promise<void> }) {
  const hoy = hoyBogota();
  const ahora = useAhora(1000);
  const [reasignar, setReasignar] = useState<Tarea | null>(null);
  const op = useOperacion();
  const asignadas = tareas.filter((t) => t.estado === 'Asignada').sort((a, b) => Number(b.prioridad === 'Urgente') - Number(a.prioridad === 'Urgente') || a.creado.localeCompare(b.creado));
  const enCurso = tareas.filter((t) => t.estado === 'En curso');
  const terminadas = tareas.filter((t) => t.estado === 'Terminada' && (t.fin || t.creado).slice(0, 10) === hoy);

  const cancelar = async (t: Tarea) => {
    if (!(await confirmar(`¿Cancelar «${t.titulo}»? Se le avisa a quien la tenía.`, 'Cancelar tarea', true))) return;
    const ok = await op.correr(() => cortex.tables.update('tareas_operacion', t.id, { estado: 'Cancelada' }), 'Tarea cancelada.');
    if (ok) await onCambio();
  };

  const col = (titulo: string, xs: Tarea[], vacio: string) => (
    <div className="oc-col-t">
      <h3>{titulo} <Chip tono={xs.length ? 'neutral' : 'quiet'}>{xs.length}</Chip></h3>
      {xs.length ? xs.map((t) => <TarjetaTarea key={t.id} t={t} ahora={ahora} onReasignar={() => setReasignar(t)} onCancelar={() => void cancelar(t)} />) : <p className="oc-sub">{vacio}</p>}
    </div>
  );

  return (
    <>
      {op.error ? <ErrorCaja mensaje={op.error} /> : null}
      <div className="oc-tab-t">
        {col('Asignadas', asignadas, 'Nada esperando.')}
        {col('En curso', enCurso, 'Nadie está en una tarea ahora.')}
        {col('Terminadas hoy', terminadas, 'Aún no se termina ninguna hoy.')}
      </div>
      {reasignar ? <Reasignar tarea={reasignar} personas={personas} onCerrar={() => setReasignar(null)} onListo={async () => { setReasignar(null); await onCambio(); }} /> : null}
    </>
  );
}

function TarjetaTarea({ t, ahora, onReasignar, onCancelar }: { t: Tarea; ahora: number; onReasignar: () => void; onCancelar: () => void }) {
  const ini = msDeIso(t.inicio);
  const espera = msDeIso(t.creado);
  const activa = t.estado === 'Asignada' || t.estado === 'En curso';
  return (
    <div className={`oc-item oc-tarea ${t.prioridad === 'Urgente' && activa ? 'hot' : ''}`}>
      <div className="oc-item-top">
        <strong>{t.titulo}</strong>
        <Chip tono={TONO_TAREA[t.estado] ?? 'neutral'} vivo={t.estado === 'En curso'}>{t.estado}</Chip>
      </div>
      <div className="oc-meta">
        <span>{t.tipo}</span>
        {t.prioridad === 'Urgente' ? <span style={{ color: 'var(--malo)', fontWeight: 700 }}>Urgente</span> : null}
        {t.desde || t.hasta ? <span>{t.desde || '—'} <ArrowRight size={12} style={{ verticalAlign: -1 }} /> {t.hasta || '—'}</span> : null}
        {t.vuelo ? <span><Plane size={12} style={{ verticalAlign: -1 }} /> {t.vuelo}</span> : null}
      </div>
      <div className="oc-meta">
        <span><UserCheck size={13} style={{ verticalAlign: -2 }} /> {nombresDe(t).join(', ') || 'Sin asignar'}</span>
      </div>
      <div className="oc-meta">
        {t.estado === 'En curso' && ini ? <span className="oc-reloj-s"><Clock size={13} style={{ verticalAlign: -2 }} /> {cronometro((ahora - ini) / 1000)}</span> : null}
        {t.estado === 'Asignada' && espera ? <span>Esperando hace {minTxt(Math.max(0, Math.round((ahora - espera) / 60_000)))}</span> : null}
        {t.estado === 'Asignada' && t.paraHora ? <span>Para {t.paraFecha === hoyBogota() ? 'hoy' : t.paraFecha} {hhmm(t.paraHora)}</span> : null}
        {t.estado === 'Terminada' ? <span>{minTxt(t.duracionMin)} · <b>{cop(t.costoTotal)}</b></span> : null}
        {t.estado === 'Terminada' && t.fin ? <span>{hace(t.fin, ahora)}</span> : null}
      </div>
      {activa ? (
        <div className="oc-btns">
          <Boton chico onClick={onReasignar} icono={<Repeat size={15} />}>Reasignar</Boton>
          <Boton chico tono="suave" onClick={onCancelar} icono={<Ban size={15} />}>Cancelar</Boton>
        </div>
      ) : null}
    </div>
  );
}

function Reasignar({ tarea, personas, onCerrar, onListo }: { tarea: Tarea; personas: Persona[]; onCerrar: () => void; onListo: () => void | Promise<void> }) {
  const [refs, setRefs] = useState<string[]>(tarea.asignadosIds);
  const op = useOperacion();
  const previos = useMemo(() => Object.fromEntries(tarea.asignadosIds.map((r, i) => [r, nombresDe(tarea)[i] ?? r])), [tarea]);
  const nombrePor = new Map(personas.map((p) => [p.ref, p.name]));
  return (
    <Hoja titulo={`Reasignar: ${tarea.titulo}`} onCerrar={onCerrar}>
      <div className="oc-form">
        <SelectorOperarios personas={personas} valor={refs} onChange={setRefs} nombresPrevios={previos} />
        {op.error ? <ErrorCaja mensaje={op.error} /> : null}
        <Boton tono="primario" grande disabled={op.ocupado || !refs.length} onClick={async () => {
          const ok = await op.correr(
            () => cortex.tables.update('tareas_operacion', tarea.id, { asignados_ids: refs.join(','), asignados: refs.map((r) => nombrePor.get(r) ?? previos[r] ?? r).join(', ') }),
            'Tarea reasignada.',
          );
          if (ok) await onListo();
        }}>{op.ocupado ? 'Guardando…' : 'Guardar'}</Boton>
      </div>
    </Hoja>
  );
}

/* ───────────── Vuelos por asignar ───────────── */

function VuelosPorAsignar({ vuelos, cargando, personas, onCambio }: { vuelos: Vuelo[]; cargando: boolean; personas: Persona[]; onCambio: () => Promise<void> }) {
  const hoy = hoyBogota();
  const [vuelo, setVuelo] = useState<Vuelo | null>(null);
  const lista = vuelos
    .filter((v) => ['Programado', 'En camino', 'Demorado', 'Aterrizó'].includes(v.estado) && v.fecha >= hoy)
    .sort((a, b) => (a.fecha + (a.horaActual || '99')).localeCompare(b.fecha + (b.horaActual || '99')))
    .slice(0, 30);
  return (
    <>
      {cargando ? <p className="oc-sub">Cargando vuelos…</p> : null}
      {!cargando && !lista.length ? <Tarjeta><p className="oc-sub">No hay vuelos próximos por asignar.</p></Tarjeta> : null}
      <ul className="oc-lista">
        {lista.map((v) => (
          <li key={v.id} className="oc-item">
            <div className="oc-item-top">
              <span><span className="oc-hora">{hhmm(v.horaActual) || '—'}</span><b className="oc-mono">{v.numero}</b> <span className="oc-sub">{v.fecha === hoy ? 'hoy' : v.fecha}</span></span>
              <Chip tono={tono(TONO_VUELO, v.estado)} vivo={ES_VIVO.has(v.estado)}>{v.estado}</Chip>
            </div>
            <div className="oc-item-top">
              <span className="oc-meta"><span>{v.aerolinea}</span><span>{v.asignados ? <><UserCheck size={13} style={{ verticalAlign: -2 }} /> {v.asignados}</> : 'Lo toma el primero que llegue'}</span></span>
              <Boton chico tono={v.asignados ? undefined : 'primario'} onClick={() => setVuelo(v)} icono={<UserCog size={15} />}>{v.asignados ? 'Cambiar' : 'Asignar'}</Boton>
            </div>
          </li>
        ))}
      </ul>
      {vuelo ? <AsignarVuelo vuelo={vuelo} personas={personas} onCerrar={() => setVuelo(null)} onListo={async () => { setVuelo(null); await onCambio(); }} /> : null}
    </>
  );
}

function AsignarVuelo({ vuelo, personas, onCerrar, onListo }: { vuelo: Vuelo; personas: Persona[]; onCerrar: () => void; onListo: () => void | Promise<void> }) {
  const [refs, setRefs] = useState<string[]>(vuelo.asignadosIds);
  const op = useOperacion();
  const previos = useMemo(() => Object.fromEntries(vuelo.asignadosIds.map((r, i) => [r, vuelo.asignados.split(/[,;]/).map((x) => x.trim())[i] ?? r])), [vuelo]);
  const nombrePor = new Map(personas.map((p) => [p.ref, p.name]));
  return (
    <Hoja titulo={`Vuelo ${vuelo.numero}: quién lo atiende`} onCerrar={onCerrar}>
      <div className="oc-form">
        <p className="oc-sub">Solo las personas que escojas podrán tomar este vuelo. Sin nadie escogido, lo toma el primero que llegue.</p>
        <SelectorOperarios personas={personas} valor={refs} onChange={setRefs} nombresPrevios={previos} />
        {op.error ? <ErrorCaja mensaje={op.error} /> : null}
        <Boton tono="primario" grande disabled={op.ocupado} onClick={async () => {
          const ok = await op.correr(
            () => cortex.tables.update('vuelos', vuelo.id, { asignados_ids: refs.join(','), asignados: refs.map((r) => nombrePor.get(r) ?? previos[r] ?? r).join(', ') }),
            refs.length ? 'Vuelo asignado.' : 'Vuelo sin asignar: lo toma el primero.',
          );
          if (ok) await onListo();
        }}>{op.ocupado ? 'Guardando…' : refs.length ? 'Guardar' : 'Dejar sin asignar'}</Boton>
      </div>
    </Hoja>
  );
}
