import { useEffect, useMemo, useRef, useState } from 'react';
import { cortex } from '@cortex/app-sdk';
import { AlertTriangle, Camera, CheckCircle2, ClipboardList, Clock, MapPin, Minus, Pencil, Play, Plane, Plus, Truck, Wrench } from 'lucide-react';
import { Dictado } from '../lib/dictado';
import { aAtencion, aEquipo, aEvento, aTarifa, aVuelo, porRelacion, traerTodo, useCarga, useRol } from '../lib/datos';
import { isoBogota, msDeIso, useEsquema } from '../lib/documental';
import type { Esquema } from '../lib/documental';
import { TONO_TAREA, cargarTareas, equiposDeTarea, esMia, eventosDeTarea, registrarEvento, terminarTarea } from '../lib/tareas';
import type { Tarea } from '../lib/tareas';
import type { Atencion, Equipo, Evento, Tarifa, Vuelo } from '../lib/datos';
import { Medidor } from '../lib/Piezas';
import { TIPOS_EVENTO, TONO_ATENCION, TONO_VUELO, tono } from '../lib/estados';
import { N, cronometro, dinero, hhmm, kg, num } from '../lib/formato';
import { horaAhora, hoyBogota, minutosHasta, textoMinutos } from '../lib/tiempo';
import { Adjuntos, Boton, Campo, Chip, ES_VIVO, Cargando, ErrorCaja, Hoja, Numero, Pantalla, Paso, SelectorArchivo, Tarjeta, avisar, confirmar, mensajeDe, subirArchivo, useOperacion } from '../lib/ui';

/**
 * EN CAMPO — pantalla del operario, hecha para el teléfono y para leerse al sol.
 * Vuelos por tomar → Tomar → atención en curso (cronómetro, real vs esperado en vivo,
 * equipos con foto obligatoria, eventos rápidos, novedades por voz, fotos) → Cerrar.
 * Sondeo cada 15 s; los formularios no se pisan con el sondeo.
 */

const CADA = 15_000;

interface Datos {
  vuelos: Vuelo[];
  atenciones: Atencion[];
  tareas: Tarea[];
}

async function cargar(): Promise<Datos> {
  const [vs, as, tareas] = await Promise.all([
    traerTodo('vuelos', { order: { field: 'fecha', dir: 'desc' } }, 200),
    cortex.tables.query('atenciones', { order: { field: 'created_at', dir: 'desc' }, limit: 40 }),
    cargarTareas(200),
  ]);
  return { vuelos: vs.map(aVuelo), atenciones: as.rows.map(aAtencion), tareas };
}

function useAhora(ms = 1000): number {
  const [t, setT] = useState(Date.now());
  useEffect(() => {
    const i = setInterval(() => setT(Date.now()), ms);
    return () => clearInterval(i);
  }, [ms]);
  return t;
}

export default function EnCampo() {
  const { id: miId, ref: miRef, nombre } = useRol();
  const esq = useEsquema();
  const hoy = hoyBogota();
  const { data, loading, error, refresh } = useCarga(cargar, [], CADA);
  const op = useOperacion();
  const [zona, setZona] = useState<string | null>(null);

  const vuelosPorId = useMemo(() => new Map((data?.vuelos ?? []).map((v) => [v.id, v])), [data]);
  const enCurso = (data?.atenciones ?? []).filter((a) => a.estado === 'En atención' && (!miId || !a.operarioId || a.operarioId === miId));
  const recientes = (data?.atenciones ?? []).filter((a) => a.estado !== 'En atención').slice(0, 8);
  // Mis tareas: las asignadas a mí (abiertas) y los vuelos que me asignaron y aún no atiendo.
  const misTareas = (data?.tareas ?? []).filter((t) => (t.estado === 'Asignada' || t.estado === 'En curso') && esMia(t.asignadosIds, miRef));
  const misVuelos = (data?.vuelos ?? []).filter((v) => esMia(v.asignadosIds, miRef) && ['Programado', 'En camino', 'Demorado', 'Aterrizó'].includes(v.estado));
  const idsMisVuelos = new Set(misVuelos.map((v) => v.id));
  const tareasHechas = (data?.tareas ?? []).filter((t) => t.estado === 'Terminada' && esMia(t.asignadosIds, miRef)).slice(0, 5);
  // Un vuelo asignado a otros no se muestra para tomar; sin asignados lo toma quien llegue.
  const porTomar = (data?.vuelos ?? []).filter((v) => v.estado === 'Aterrizó' && !idsMisVuelos.has(v.id) && (!v.asignadosIds.length || esMia(v.asignadosIds, miRef))).sort((a, b) => (a.llegadaHora || '').localeCompare(b.llegadaHora || ''));
  const proximos = (data?.vuelos ?? [])
    .filter((v) => v.fecha === hoy && ['Programado', 'En camino', 'Demorado'].includes(v.estado) && !idsMisVuelos.has(v.id))
    .sort((a, b) => (a.horaActual || '99').localeCompare(b.horaActual || '99'))
    .slice(0, 6);

  const tomar = async (v: Vuelo) => {
    const ok = await op.correr(async () => {
      // La ubicación sirve para decir si estás dentro de la zona; el servidor la registra al tomar.
      const ub = await cortex.location.current().catch(() => null);
      setZona(ub ? (ub.zone ?? (ub.inside === false ? 'Fuera de las zonas' : null)) : null);
      await cortex.tables.action('vuelos', v.id, 'tomar');
    }, `Tomaste ${v.numero}.`);
    if (ok) {
      await refresh();
      // La atención se crea sola al tomar: se vuelve a mirar un par de veces.
      setTimeout(() => void refresh(), 1500);
      setTimeout(() => void refresh(), 4000);
    }
  };

  return (
    <Pantalla clase="campo" titulo="En campo" sub={nombre ? `Hola, ${nombre.split(' ')[0]}. Se actualiza solo.` : 'Se actualiza solo.'}>
      {op.error ? <ErrorCaja mensaje={op.error} /> : null}
      {error && data ? <ErrorCaja mensaje={`Sin señal para actualizar. ${error}`} reintentar={() => void refresh()} /> : null}
      {zona ? (
        <p className="oc-sub" style={{ marginBottom: 12 }}>
          <MapPin size={14} style={{ verticalAlign: -2 }} /> Ubicación al tomar: {zona}
        </p>
      ) : null}

      {loading && !data ? <Cargando /> : null}
      {error && !data ? <ErrorCaja mensaje={error} reintentar={() => void refresh()} /> : null}

      {enCurso.map((a) => (
        <AtencionActiva key={a.id} a={a} vuelo={vuelosPorId.get(a.vueloId)} onCambio={refresh} />
      ))}

      {misTareas.length || misVuelos.length || tareasHechas.length ? (
        <div className="oc-sec" style={{ marginTop: enCurso.length ? 28 : 0 }}>
          <h2><ClipboardList size={22} /> Mis tareas</h2>
          <div style={{ display: 'grid', gap: 14 }}>
            {misTareas.map((t) => <TareaActiva key={t.id} t={t} esq={esq} onCambio={refresh} />)}
            {misVuelos.map((v) => (
              <div key={v.id} className={`oc-item ${v.estado === 'Aterrizó' ? 'hot' : ''}`}>
                <div className="oc-item-top">
                  <span><span className="oc-sub">Te asignaron el vuelo</span><br /><strong className="oc-mono" style={{ fontSize: 24 }}>{v.numero}</strong></span>
                  <Chip tono={tono(TONO_VUELO, v.estado)} vivo={ES_VIVO.has(v.estado)}>{v.estado === 'Aterrizó' ? `Aterrizó ${hhmm(v.llegadaHora)}` : v.estado}</Chip>
                </div>
                <div className="oc-meta" style={{ fontSize: 17 }}>
                  <span>{v.aerolinea}</span>
                  <span>{hhmm(v.horaActual) ? `Hora ${hhmm(v.horaActual)}` : ''}</span>
                  <span><b>Posición {v.posicion || '—'}</b></span>
                  <span>{kg(v.kilosEsp)}</span>
                </div>
                {v.estado === 'Aterrizó' ? (
                  <Boton grande tono="senal" disabled={op.ocupado} onClick={() => void tomar(v)} icono={<Truck size={24} />}>
                    {op.ocupado ? 'Tomando…' : 'Tomar este vuelo'}
                  </Boton>
                ) : <p className="oc-sub" style={{ fontSize: 16 }}>{textoMinutos(minutosHasta(v.fecha, v.horaActual))}. Cuando aterrice podrás tomarlo aquí.</p>}
              </div>
            ))}
            {!misTareas.length && !misVuelos.length ? <Tarjeta><p className="oc-sub" style={{ fontSize: 17 }}>No tienes tareas pendientes.</p></Tarjeta> : null}
            {tareasHechas.length ? (
              <div>
                <p className="oc-sub" style={{ margin: '4px 0 8px' }}>Terminadas hace poco</p>
                <ul className="oc-lista">
                  {tareasHechas.map((t) => (
                    <li key={t.id} className="oc-item">
                      <div className="oc-item-top"><b>{t.titulo}</b><Chip tono="good">Terminada</Chip></div>
                      <div className="oc-meta"><span>{t.duracionMin === null ? '' : `${t.duracionMin} min`}</span><span>{dinero(t.costoTotal, 'COP')}</span></div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="oc-sec" style={{ marginTop: enCurso.length || misTareas.length ? 28 : 0 }}>
        <h2>
          <Plane size={22} /> Vuelos por tomar
        </h2>
        {!loading || data ? (
          porTomar.length ? (
            <ul className="oc-lista">
              {porTomar.map((v) => (
                <li key={v.id} className="oc-item hot">
                  <div className="oc-item-top">
                    <strong className="oc-mono" style={{ fontSize: 24 }}>{v.numero}</strong>
                    <Chip tono="accent" vivo>Aterrizó {hhmm(v.llegadaHora)}</Chip>
                  </div>
                  <div className="oc-meta" style={{ fontSize: 17 }}>
                    <span>{v.aerolinea}</span>
                    <span><b>Posición {v.posicion || '—'}</b></span>
                    <span>{kg(v.kilosEsp)}</span>
                    <span>{num(v.palletsEsp)} pallets</span>
                    <span>{num(v.piezasEsp)} piezas</span>
                  </div>
                  <Boton grande tono="senal" disabled={op.ocupado} onClick={() => void tomar(v)} icono={<Truck size={24} />}>
                    {op.ocupado ? 'Tomando…' : 'Tomar este vuelo'}
                  </Boton>
                </li>
              ))}
            </ul>
          ) : (
            <Tarjeta>
              <p className="oc-sub" style={{ fontSize: 17 }}>Ningún vuelo espera atención ahora. Cuando aterrice uno, te llega el aviso y aparece aquí.</p>
            </Tarjeta>
          )
        ) : null}
      </div>

      {proximos.length ? (
        <div className="oc-sec">
          <h2><Clock size={22} /> Llegan hoy</h2>
          <ul className="oc-lista">
            {proximos.map((v) => (
              <li key={v.id} className="oc-item">
                <div className="oc-item-top">
                  <span><span className="oc-hora">{hhmm(v.horaActual) || '—'}</span><b className="oc-mono">{v.numero}</b></span>
                  <Chip tono={tono(TONO_VUELO, v.estado)} vivo={ES_VIVO.has(v.estado)}>{v.estado}</Chip>
                </div>
                <div className="oc-meta">
                  <span>{textoMinutos(minutosHasta(v.fecha, v.horaActual))}</span>
                  <span>Posición {v.posicion || 'sin asignar'}</span>
                  <span>{kg(v.kilosEsp)}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {recientes.length ? (
        <div className="oc-sec">
          <h2>Mis atenciones recientes</h2>
          <ul className="oc-lista">
            {recientes.map((a) => (
              <li key={a.id} className="oc-item">
                <div className="oc-item-top">
                  <b>{a.vuelo}</b>
                  <Chip tono={tono(TONO_ATENCION, a.estado)}>{a.estado}</Chip>
                </div>
                <div className="oc-meta">
                  <span>{a.kilosRec === null ? 'Sin kilos' : kg(a.kilosRec)}</span>
                  {a.fueraDeMargen ? <span style={{ color: 'var(--malo)', fontWeight: 700 }}>Fuera de margen</span> : null}
                </div>
                {a.motivoRechazo ? <div className="oc-aviso">Motivo del rechazo: {a.motivoRechazo}</div> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Pantalla>
  );
}

/* ───────────── Atención en curso ───────────── */

function AtencionActiva({ a, vuelo, onCambio }: { a: Atencion; vuelo?: Vuelo; onCambio: () => Promise<void> }) {
  const ahora = useAhora();
  const op = useOperacion();
  const guardado = useOperacion();
  const inicial = useRef(a.id);
  const [horaFin, setHoraFin] = useState(hhmm(a.horaFin));
  const [kilos, setKilos] = useState(a.kilosRec === null ? '' : String(a.kilosRec));
  const [pallets, setPallets] = useState(a.palletsRec === null ? '' : String(a.palletsRec));
  const [piezas, setPiezas] = useState(a.piezasRec === null ? '' : String(a.piezasRec));
  const [novedades, setNovedades] = useState(a.novedades);
  const [sucio, setSucio] = useState(false);
  const [evento, setEvento] = useState<string | null>(null);
  const [hecho, setHecho] = useState(false);

  // Si cambió la atención (otra distinta), se reinicia el formulario; el sondeo no lo toca.
  useEffect(() => {
    if (inicial.current === a.id) return;
    inicial.current = a.id;
    setHoraFin(hhmm(a.horaFin));
    setKilos(a.kilosRec === null ? '' : String(a.kilosRec));
    setPallets(a.palletsRec === null ? '' : String(a.palletsRec));
    setPiezas(a.piezasRec === null ? '' : String(a.piezasRec));
    setNovedades(a.novedades);
    setSucio(false);
  }, [a]);

  const eq = useCarga(async () => (await porRelacion('equipos_usados', 'atencion', a.id)).map(aEquipo), [a.id], 30_000);
  const ev = useCarga(async () => (await porRelacion('eventos_operacion', 'atencion', a.id)).map(aEvento), [a.id], 30_000);
  const tarifas = useCarga(async () => (await traerTodo('tarifas_proveedores', {}, 600)).map(aTarifa), []);

  const inicioMs = Date.parse(`${a.fecha || hoyBogota()}T${hhmm(a.horaInicio) || '00:00'}:00-05:00`);
  const seg = Number.isFinite(inicioMs) ? (ahora - inicioMs) / 1000 : 0;

  const esp = {
    kilos: a.kilosEsp || vuelo?.kilosEsp || 0,
    pallets: a.palletsEsp || vuelo?.palletsEsp || 0,
    piezas: a.piezasEsp || vuelo?.piezasEsp || 0,
    pct: a.margenKilos || vuelo?.margenKilos || 0,
    mp: a.margenPallets || vuelo?.margenPallets || 0,
  };
  const kReal = kilos.trim() ? N(kilos) : null;
  const pReal = pallets.trim() ? N(pallets) : null;
  const sinFoto = (eq.data ?? []).filter((e) => !e.foto.length);
  const pzReal = piezas.trim() ? N(piezas) : null;
  const cuadra = pReal !== null && pReal === esp.pallets && (!esp.piezas || pzReal === esp.piezas) && (kReal === null || Math.abs(kReal - esp.kilos) <= (esp.kilos * esp.pct) / 100);

  const marcar = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setSucio(true);
  };

  const campos = () => {
    const v: Record<string, unknown> = {};
    if (horaFin) v.hora_fin = horaFin;
    if (kilos.trim()) v.kilos_recibidos = N(kilos);
    if (pallets.trim()) v.pallets_recibidos = N(pallets);
    if (piezas.trim()) v.piezas_recibidas = N(piezas);
    if (novedades.trim() !== a.novedades.trim()) v.novedades = novedades.trim();
    return v;
  };

  const guardar = async (silencioso = false) => {
    const v = campos();
    if (!Object.keys(v).length) return true;
    const ok = await guardado.correr(() => cortex.tables.update('atenciones', a.id, v), silencioso ? undefined : 'Guardado.');
    if (ok) setSucio(false);
    return ok;
  };

  // Guarda solo, sin avisos, un momento después del último cambio (también al usar − / +).
  // biome-ignore lint/correctness/useExhaustiveDependencies: depende de los valores que se guardan.
  useEffect(() => {
    if (!sucio) return;
    const t = setTimeout(() => void guardar(true), 1200);
    return () => clearTimeout(t);
  }, [sucio, kilos, pallets, piezas, horaFin, novedades]);

  const cerrar = async () => {
    if (!pallets.trim()) return avisar('Anota los pallets recibidos para cerrar.');
    if (sinFoto.length) return avisar('Cada equipo necesita su foto. Agrégala antes de cerrar.');
    const hf = horaFin || horaAhora();
    if (!(await confirmar('¿Cerrar la atención? Se envía al supervisor para aprobación.', 'Cerrar atención'))) return;
    const ok = await op.correr(async () => {
      setHoraFin(hf);
      await cortex.tables.update('atenciones', a.id, { ...campos(), hora_fin: hf });
      await cortex.tables.action('atenciones', a.id, 'cerrar');
    }, 'Atención cerrada. Quedó por aprobar.');
    if (ok) {
      setHecho(true);
      await onCambio();
    }
  };

  if (hecho) {
    return (
      <Tarjeta tono="ok">
        <p style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 20 }}>
          <CheckCircle2 /> Atención de {a.vuelo} enviada a aprobación.
        </p>
      </Tarjeta>
    );
  }

  return (
    <div>
      {a.notaCorreccion ? (
        <div className="oc-card alerta" style={{ marginBottom: 14 }}>
          <h2 style={{ color: 'var(--malo)', display: 'flex', gap: 8, alignItems: 'center' }}>
            <AlertTriangle /> Te pidieron una corrección
          </h2>
          <p style={{ fontSize: 20, marginTop: 6 }}>{a.notaCorreccion}</p>
        </div>
      ) : null}

      <Tarjeta>
        <div className="oc-item-top">
          <span>
            <span className="oc-sub">Atendiendo</span>
            <div className="oc-mono" style={{ fontSize: 30, fontWeight: 700 }}>{a.vuelo}</div>
          </span>
          <Chip tono="info" vivo>En atención</Chip>
        </div>
        <div className="oc-reloj" aria-live="off" style={{ margin: '12px 0 4px' }}>{cronometro(seg)}</div>
        <p className="oc-sub" style={{ textAlign: 'center' }}>Desde las {hhmm(a.horaInicio) || '—'}</p>
        {a.fueraDeZona ? <div className="oc-aviso" style={{ marginTop: 10 }}>Quedó marcado un registro fuera de zona.</div> : null}
      </Tarjeta>

      <div className="oc-asistente" style={{ marginTop: 22 }}><span className="n">1</span><h2>Lo que recibiste</h2></div>
      <Tarjeta>
        <div className="oc-form">
          <div className="oc-conteo" aria-live="polite">
            <Celda etiqueta="Pallets" esperado={esp.pallets} real={pReal} margen={esp.mp} />
            <Celda etiqueta="Piezas" esperado={esp.piezas} real={piezas.trim() ? N(piezas) : null} margen={0} />
            <Celda etiqueta="Kilos" esperado={esp.kilos} real={kReal} margen={(esp.kilos * esp.pct) / 100} formato={(n) => num(n)} />
          </div>
          {cuadra ? (
            <div className="oc-celebra oc-card tight" role="status" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="oc-celebra-ico"><CheckCircle2 size={22} /></span>
              <span style={{ fontWeight: 700, fontSize: 19 }}>¡Cuadró! Sin diferencias con lo esperado.</span>
            </div>
          ) : null}
          <Paso etiqueta="Pallets *" valor={pallets} onChange={marcar(setPallets)} onBlur={() => void guardar(true)} esperado={esp.pallets ? num(esp.pallets) : undefined} />
          <Paso etiqueta="Piezas" valor={piezas} onChange={marcar(setPiezas)} onBlur={() => void guardar(true)} esperado={esp.piezas ? num(esp.piezas) : undefined} />
          <Paso etiqueta="Kilos" valor={kilos} onChange={marcar(setKilos)} onBlur={() => void guardar(true)} paso={50} unidad="kg" esperado={esp.kilos ? num(esp.kilos) : undefined} />
          <Medidor titulo="Kilos frente al margen" esperado={esp.kilos} real={kReal} margen={(esp.kilos * esp.pct) / 100} formato={(n) => kg(n)} />
          <div className="oc-fila2" style={{ alignItems: 'end' }}>
            <Campo etiqueta="Hora de fin">
              <input type="time" value={horaFin} onChange={(e) => marcar(setHoraFin)(e.target.value)} onBlur={() => sucio && void guardar(true)} />
            </Campo>
            <Boton onClick={() => marcar(setHoraFin)(horaAhora())}>Ahora ({horaAhora()})</Boton>
          </div>
        </div>
      </Tarjeta>

      <div className="oc-asistente" style={{ marginTop: 22 }}><span className="n">2</span><h2>Equipos usados</h2></div>
      <Tarjeta>
        <EquiposPanel a={a} tarifas={tarifas.data ?? []} cargandoTarifas={tarifas.loading} equipos={eq.data ?? []} cargando={eq.loading} error={eq.error} onCambio={eq.refresh} />
      </Tarjeta>

      <div className="oc-asistente" style={{ marginTop: 22 }}><span className="n">3</span><h2>Eventos</h2></div>
      <Tarjeta>
        <p className="oc-sub" style={{ marginBottom: 10 }}>Un toque para dejar constancia de lo que pasa en plataforma.</p>
        <div className="oc-botonera">
          {TIPOS_EVENTO.map((t) => (
            <Boton key={t} onClick={() => setEvento(t)}>{t}</Boton>
          ))}
        </div>
        <EventosLista eventos={ev.data ?? []} cargando={ev.loading} />
      </Tarjeta>

      <div className="oc-asistente" style={{ marginTop: 22 }}><span className="n">4</span><h2>Novedades y fotos</h2></div>
      <Tarjeta>
        <div className="oc-form">
          <Campo etiqueta="Novedades">
            <textarea value={novedades} onChange={(e) => marcar(setNovedades)(e.target.value)} onBlur={() => sucio && void guardar(true)} rows={4} placeholder="Cajas rotas, faltantes, mojado…" />
          </Campo>
          <div className="oc-btns">
            <Dictado grande onTexto={(t) => marcar(setNovedades)(novedades ? `${novedades} ${t}` : t)} />
          </div>
          <Adjuntos lista={a.fotos} />
          <SelectorArchivo
            etiqueta="Tomar foto de la carga"
            camara="environment"
            multiple
            disabled={guardado.ocupado}
            onArchivos={(fs) =>
              void guardado
                .correr(async () => {
                  for (const f of fs) await subirArchivo(f, { table: 'atenciones', id: a.id, field: 'fotos' });
                }, 'Foto guardada.')
                .then(() => onCambio())
            }
          />
        </div>
      </Tarjeta>

      {guardado.error ? <div style={{ marginTop: 14 }}><ErrorCaja mensaje={guardado.error} /></div> : null}
      {op.error ? <div style={{ marginTop: 14 }}><ErrorCaja mensaje={op.error} /></div> : null}

      <div className="oc-accion-fija">
        {sinFoto.length ? <p className="oc-sub" style={{ color: 'var(--malo)', fontWeight: 700, marginBottom: 6 }}>Falta la foto de {sinFoto.length} equipo(s).</p> : null}
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: sucio ? '1fr 2fr' : '1fr' }}>
          {sucio ? <Boton onClick={() => void guardar()} disabled={guardado.ocupado || op.ocupado}>{guardado.ocupado ? 'Guardando…' : 'Guardar'}</Boton> : null}
          <Boton grande tono="primario" disabled={op.ocupado || guardado.ocupado} onClick={() => void cerrar()} icono={<CheckCircle2 size={26} />}>
            {op.ocupado ? 'Cerrando…' : 'Cerrar atención'}
          </Boton>
        </div>
      </div>

      {evento ? (
        <EventoRapido
          tipo={evento}
          a={a}
          onCerrar={() => setEvento(null)}
          onListo={async () => {
            setEvento(null);
            await ev.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/* ───────────── Equipos ───────────── */

function EquiposPanel({
  a,
  tarifas,
  cargandoTarifas,
  equipos,
  cargando,
  error,
  onCambio,
}: {
  a: Atencion;
  tarifas: Tarifa[];
  cargandoTarifas: boolean;
  equipos: Equipo[];
  cargando: boolean;
  error: string | null;
  onCambio: () => Promise<void>;
}) {
  const [nombre, setNombre] = useState('');
  const [tarifaId, setTarifaId] = useState('');
  const [cant, setCant] = useState(1);
  const [foto, setFoto] = useState<File | null>(null);
  const op = useOperacion();
  const nombres = useMemo(() => [...new Set(tarifas.map((t) => t.equipo))].sort(), [tarifas]);
  const opciones = tarifas.filter((t) => t.equipo === nombre);
  const t = tarifas.find((x) => x.id === tarifaId);
  const total = t ? t.tarifa * cant : 0;

  const agregar = async () => {
    if (!t || !foto) return;
    const ok = await op.correr(async () => {
      const fila = await cortex.tables.insert('equipos_usados', { atencion: a.id, tarifa: t.id, cantidad: cant });
      try {
        await subirArchivo(foto, { table: 'equipos_usados', id: fila.id, field: 'foto' });
      } catch (e) {
        await onCambio();
        throw new Error(`El equipo quedó anotado pero la foto no subió (${mensajeDe(e)}). Vuelve a tomarla en la lista de abajo.`);
      }
    }, 'Equipo agregado con su foto.');
    if (ok) {
      setNombre('');
      setTarifaId('');
      setCant(1);
      setFoto(null);
    }
    await onCambio();
  };

  const cambiarCantidad = async (e: Equipo, n: number) => {
    if (n < 1) return;
    await op.correr(() => cortex.tables.update('equipos_usados', e.id, { cantidad: n }));
    await onCambio();
  };

  return (
    <div className="oc-form">
      {cargando && !equipos.length ? <p className="oc-sub">Cargando equipos…</p> : null}
      {error && !equipos.length ? <ErrorCaja mensaje={error} /> : null}
      {equipos.length ? (
        <ul className="oc-lista">
          {equipos.map((e) => (
            <li key={e.id} className={`oc-item ${e.foto.length ? '' : 'bad'}`}>
              <div className="oc-item-top">
                <b>{e.equipo || 'Equipo'}</b>
                <span>{dinero(e.tarifa * e.cantidad || e.costoTotal, e.moneda)}</span>
              </div>
              <div className="oc-meta"><span>{e.proveedor}</span><span>{dinero(e.tarifa, e.moneda)} c/u</span></div>
              <div className="oc-paso">
                <button type="button" onClick={() => void cambiarCantidad(e, e.cantidad - 1)} aria-label="Menos"><Minus /></button>
                <b style={{ fontSize: 24, minWidth: 40, textAlign: 'center' }}>{num(e.cantidad)}</b>
                <button type="button" onClick={() => void cambiarCantidad(e, e.cantidad + 1)} aria-label="Más"><Plus /></button>
              </div>
              {e.foto.length ? (
                <Adjuntos lista={e.foto} />
              ) : (
                <SelectorArchivo
                  etiqueta="Falta la foto: tomarla"
                  camara="environment"
                  onArchivos={(fs) =>
                    fs[0] &&
                    void op.correr(() => subirArchivo(fs[0] as File, { table: 'equipos_usados', id: e.id, field: 'foto' }), 'Foto guardada.').then(() => onCambio())
                  }
                />
              )}
            </li>
          ))}
        </ul>
      ) : !cargando ? (
        <p className="oc-sub">Todavía no anotaste equipos.</p>
      ) : null}

      <h3>Agregar un equipo</h3>
      {cargandoTarifas && !tarifas.length ? <p className="oc-sub">Cargando tarifas…</p> : null}
      {!cargandoTarifas && !tarifas.length ? <div className="oc-aviso">No hay tarifas cargadas. Pídele al supervisor que las agregue en Costos.</div> : null}
      <Campo etiqueta="Equipo">
        <select value={nombre} onChange={(e) => { setNombre(e.target.value); setTarifaId(''); }}>
          <option value="">Elige el equipo…</option>
          {nombres.map((n) => <option key={n}>{n}</option>)}
        </select>
      </Campo>
      {nombre ? (
        <Campo etiqueta="Proveedor">
          <select value={tarifaId} onChange={(e) => setTarifaId(e.target.value)}>
            <option value="">Elige el proveedor…</option>
            {opciones.map((o) => <option key={o.id} value={o.id}>{o.proveedor} · {dinero(o.tarifa, o.moneda)}</option>)}
          </select>
        </Campo>
      ) : null}
      {t ? (
        <>
          <Campo etiqueta="Cantidad">
            <div className="oc-paso">
              <button type="button" onClick={() => setCant((c) => Math.max(1, c - 1))} aria-label="Menos"><Minus /></button>
              <input type="text" inputMode="numeric" value={cant} onChange={(e) => setCant(Math.max(1, Math.floor(N(e.target.value)) || 1))} />
              <button type="button" onClick={() => setCant((c) => c + 1)} aria-label="Más"><Plus /></button>
            </div>
          </Campo>
          <p style={{ fontSize: 20 }}>Costo: <b>{dinero(total, t.moneda)}</b> <span className="oc-sub">({cant} × {dinero(t.tarifa, t.moneda)})</span></p>
          <div className="oc-btns">
            <SelectorArchivo etiqueta={foto ? 'Cambiar foto' : 'Foto del equipo (obligatoria)'} camara="environment" tono={foto ? undefined : 'primario'} onArchivos={(fs) => setFoto(fs[0] ?? null)} />
            {foto ? <Chip tono="good"><Camera size={14} /> Foto lista</Chip> : null}
          </div>
          <Boton grande tono="primario" disabled={!foto || op.ocupado} onClick={() => void agregar()}>
            {op.ocupado ? 'Guardando…' : foto ? 'Agregar equipo' : 'Primero toma la foto'}
          </Boton>
        </>
      ) : null}
      {op.error ? <ErrorCaja mensaje={op.error} /> : null}
    </div>
  );
}

/* ───────────── Eventos ───────────── */

function EventosLista({ eventos, cargando }: { eventos: Evento[]; cargando: boolean }) {
  if (cargando && !eventos.length) return null;
  if (!eventos.length) return null;
  return (
    <ul className="oc-lista" style={{ marginTop: 14 }}>
      {eventos.map((e) => (
        <li key={e.id} className={`oc-item ${e.critico ? 'bad' : ''}`}>
          <div className="oc-item-top"><b>{e.tipo}</b><span className="oc-mono">{hhmm(e.hora)}</span></div>
          <p>{e.descripcion}</p>
          {e.fueraDeZona ? <Chip tono="bad">Fuera de zona</Chip> : null}
        </li>
      ))}
    </ul>
  );
}

const CON_EQUIPO = new Set(['Tanqueo de combustible', 'Equipo varado', 'Daño o incidente']);

function EventoRapido({ tipo, a, onCerrar, onListo }: { tipo: string; a: Atencion; onCerrar: () => void; onListo: () => void | Promise<void> }) {
  const [desc, setDesc] = useState('');
  const [equipo, setEquipo] = useState('');
  const [proveedor, setProveedor] = useState('');
  const [costo, setCosto] = useState('');
  const [fotos, setFotos] = useState<File[]>([]);
  const op = useOperacion();
  const conEquipo = CON_EQUIPO.has(tipo);

  const registrar = async () => {
    const ok = await op.correr(async () => {
      const fila = await cortex.tables.insert('eventos_operacion', {
        tipo,
        descripcion: desc.trim() || tipo,
        vuelo: a.vueloId || undefined,
        atencion: a.id,
        ...(equipo.trim() ? { equipo: equipo.trim() } : {}),
        ...(proveedor.trim() ? { proveedor: proveedor.trim() } : {}),
        ...(costo.trim() ? { costo: N(costo) } : {}),
      });
      for (const f of fotos) await subirArchivo(f, { table: 'eventos_operacion', id: fila.id, field: 'fotos' });
    }, `${tipo}: registrado.`);
    if (ok) await onListo();
  };

  return (
    <Hoja titulo={tipo} onCerrar={onCerrar}>
      <div className="oc-form campo">
        <Campo etiqueta="¿Qué pasó? (opcional)">
          <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} placeholder={tipo} />
        </Campo>
        <div><Dictado grande onTexto={(t) => setDesc((d) => (d ? `${d} ${t}` : t))} /></div>
        {conEquipo ? (
          <>
            <div className="oc-fila2">
              <Campo etiqueta="Equipo"><input type="text" value={equipo} onChange={(e) => setEquipo(e.target.value)} /></Campo>
              <Campo etiqueta="Proveedor"><input type="text" value={proveedor} onChange={(e) => setProveedor(e.target.value)} /></Campo>
            </div>
            <Campo etiqueta="Costo en pesos (si costó)"><Numero valor={costo} onChange={setCosto} placeholder="0" /></Campo>
          </>
        ) : null}
        <div className="oc-btns">
          <SelectorArchivo etiqueta={fotos.length ? `${fotos.length} foto(s)` : 'Agregar foto'} camara="environment" multiple onArchivos={(fs) => setFotos((p) => [...p, ...fs])} />
        </div>
        {op.error ? <ErrorCaja mensaje={op.error} /> : null}
        <Boton grande tono="primario" disabled={op.ocupado} onClick={() => void registrar()}>
          {op.ocupado ? 'Registrando…' : 'Registrar'}
        </Boton>
      </div>
    </Hoja>
  );
}


/* ───────────── Tarea asignada ───────────── */

type Hoja_ = 'proceso' | 'equipo' | 'fin';

/** Una tarea mía: Iniciar → En proceso → Usé un equipo → Terminar, con botones grandes. */
function TareaActiva({ t, esq, onCambio }: { t: Tarea; esq: Esquema; onCambio: () => Promise<void> }) {
  const ahora = useAhora();
  const op = useOperacion();
  const [hoja, setHoja] = useState<Hoja_ | null>(null);
  const [terminada, setTerminada] = useState<string | null>(null);
  const eq = useCarga(() => equiposDeTarea(t.id), [t.id, t.estado], 30_000);
  const ev = useCarga(() => eventosDeTarea(t.id), [t.id, t.estado], 30_000);
  const enCurso = t.estado === 'En curso';
  const ini = msDeIso(t.inicio);
  const seg = enCurso && ini ? (ahora - ini) / 1000 : 0;
  const equipos = eq.data ?? [];
  const eventos = ev.data ?? [];
  const costoEq = equipos.reduce((s, e) => s + (e.costoCop || (e.moneda === 'COP' ? e.tarifa * e.cantidad : 0)), 0);

  const refrescar = async () => {
    await Promise.all([eq.refresh(), ev.refresh(), onCambio()]);
  };

  const iniciar = async () => {
    const ok = await op.correr(async () => {
      await cortex.tables.update('tareas_operacion', t.id, { estado: 'En curso', inicio: isoBogota(Date.now()) });
      await registrarEvento(esq, { tipo: 'Inicio', tarea: t, descripcion: `Inicia: ${t.titulo}` }).catch(() => undefined);
    }, 'Tarea iniciada.');
    if (ok) await refrescar();
  };

  if (terminada) {
    return (
      <Tarjeta tono="ok">
        <p style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 20 }}><CheckCircle2 /> {terminada}</p>
      </Tarjeta>
    );
  }

  return (
    <div className={`oc-card oc-tarea ${t.prioridad === 'Urgente' ? 'alerta' : ''}`}>
      <div className="oc-item-top">
        <span>
          <span className="oc-sub">{t.tipo}{t.prioridad === 'Urgente' ? ' · URGENTE' : ''}</span>
          <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.2 }}>{t.titulo}</div>
        </span>
        <Chip tono={TONO_TAREA[t.estado] ?? 'neutral'} vivo={enCurso}>{t.estado}</Chip>
      </div>
      {t.desde || t.hasta ? (
        <p style={{ fontSize: 20, margin: '10px 0 2px' }}><MapPin size={18} style={{ verticalAlign: -3 }} /> <b>{t.desde || '—'}</b> → <b>{t.hasta || '—'}</b></p>
      ) : null}
      <div className="oc-meta" style={{ fontSize: 17 }}>
        {t.vuelo ? <span><Plane size={15} style={{ verticalAlign: -2 }} /> {t.vuelo}</span> : null}
        {t.paraHora ? <span>Para las {hhmm(t.paraHora)}</span> : null}
      </div>
      {t.descripcion ? <p style={{ marginTop: 8, fontSize: 18 }}>{t.descripcion}</p> : null}

      {enCurso ? (
        <>
          <div className="oc-reloj" style={{ margin: '14px 0 2px' }}>{cronometro(seg)}</div>
          <p className="oc-sub" style={{ textAlign: 'center' }}>Desde las {ini ? hhmm(new Date(ini).toISOString()) : '—'}{costoEq ? ` · equipos ${dinero(costoEq, 'COP')}` : ''}</p>
        </>
      ) : null}

      {op.error ? <div style={{ marginTop: 12 }}><ErrorCaja mensaje={op.error} /></div> : null}

      <div className="oc-pasos" style={{ marginTop: 14 }}>
        {!enCurso ? (
          <Boton grande tono="senal" disabled={op.ocupado} onClick={() => void iniciar()} icono={<Play size={26} />}>{op.ocupado ? 'Iniciando…' : 'Iniciar'}</Boton>
        ) : (
          <>
            <Boton grande onClick={() => setHoja('proceso')} icono={<Pencil size={24} />}>En proceso: nota, foto o voz</Boton>
            <Boton grande onClick={() => setHoja('equipo')} icono={<Wrench size={24} />}>Usé un equipo</Boton>
            <Boton grande tono="ok" onClick={() => setHoja('fin')} icono={<CheckCircle2 size={26} />}>Terminar</Boton>
          </>
        )}
      </div>

      {enCurso && equipos.length ? (
        <ul className="oc-lista" style={{ marginTop: 14 }}>
          {equipos.map((e) => (
            <li key={e.id} className={`oc-item ${e.foto.length ? '' : 'bad'}`}>
              <div className="oc-item-top"><b>{e.equipo || 'Equipo'} × {num(e.cantidad)}</b><span>{dinero(e.costoCop || e.tarifa * e.cantidad, e.moneda === 'COP' || e.costoCop ? 'COP' : e.moneda)}</span></div>
              {e.foto.length ? <Adjuntos lista={e.foto} /> : <span className="oc-sub">Sin foto</span>}
            </li>
          ))}
        </ul>
      ) : null}
      {enCurso && eventos.length ? (
        <ul className="oc-lista" style={{ marginTop: 14 }}>
          {eventos.map((e) => (
            <li key={e.id} className="oc-item">
              <div className="oc-item-top"><b>{e.tipo}</b><span className="oc-mono">{hhmm(e.hora)}</span></div>
              {e.descripcion && e.descripcion !== e.tipo ? <p>{e.descripcion}</p> : null}
              {e.costo ? <span className="oc-sub">Gasto {dinero(e.costo, 'COP')}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {hoja === 'proceso' ? <ProcesoTarea t={t} esq={esq} onCerrar={() => setHoja(null)} onListo={async () => { setHoja(null); await refrescar(); }} /> : null}
      {hoja === 'equipo' ? <EquipoTarea t={t} esq={esq} onCerrar={() => setHoja(null)} onListo={async () => { setHoja(null); await refrescar(); }} /> : null}
      {hoja === 'fin' ? (
        <FinTarea
          t={t}
          esq={esq}
          sinFoto={equipos.filter((e) => !e.foto.length).length}
          onCerrar={() => setHoja(null)}
          onListo={async (msg) => { setHoja(null); setTerminada(msg); await onCambio(); }}
        />
      ) : null}
    </div>
  );
}

function ProcesoTarea({ t, esq, onCerrar, onListo }: { t: Tarea; esq: Esquema; onCerrar: () => void; onListo: () => void | Promise<void> }) {
  const [nota, setNota] = useState('');
  const [gasto, setGasto] = useState('');
  const [fotos, setFotos] = useState<File[]>([]);
  const op = useOperacion();
  return (
    <Hoja titulo="En proceso" onCerrar={onCerrar}>
      <div className="oc-form campo">
        <Campo etiqueta="¿Cómo va? (opcional)">
          <textarea value={nota} onChange={(e) => setNota(e.target.value)} rows={3} placeholder="Ya recogí, voy hacia la bodega…" />
        </Campo>
        <div><Dictado grande onTexto={(x) => setNota((d) => (d ? `${d} ${x}` : x))} /></div>
        <Campo etiqueta="Gasto en pesos (si hubo: parqueadero, flete…)"><Numero valor={gasto} onChange={setGasto} placeholder="0" /></Campo>
        <div className="oc-btns">
          <SelectorArchivo etiqueta={fotos.length ? `${fotos.length} foto(s)` : 'Agregar foto'} camara="environment" multiple onArchivos={(fs) => setFotos((p) => [...p, ...fs])} />
        </div>
        {op.error ? <ErrorCaja mensaje={op.error} /> : null}
        <Boton grande tono="primario" disabled={op.ocupado} onClick={async () => {
          const ok = await op.correr(() => registrarEvento(esq, { tipo: 'En proceso', tarea: t, descripcion: nota, costo: gasto.trim() ? N(gasto) : undefined, fotos }), 'Registrado.');
          if (ok) await onListo();
        }}>{op.ocupado ? 'Guardando…' : 'Guardar'}</Boton>
      </div>
    </Hoja>
  );
}

function EquipoTarea({ t, esq, onCerrar, onListo }: { t: Tarea; esq: Esquema; onCerrar: () => void; onListo: () => void | Promise<void> }) {
  const tarifas = useCarga(async () => (await traerTodo('tarifas_proveedores', {}, 600)).map(aTarifa), []);
  const [nombre, setNombre] = useState('');
  const [tarifaId, setTarifaId] = useState('');
  const [cant, setCant] = useState(1);
  const [foto, setFoto] = useState<File | null>(null);
  const op = useOperacion();
  const lista = tarifas.data ?? [];
  const nombres = useMemo(() => [...new Set(lista.map((x) => x.equipo))].sort(), [lista]);
  const opciones = lista.filter((x) => x.equipo === nombre);
  const tf = lista.find((x) => x.id === tarifaId);
  const total = tf ? tf.tarifa * cant : 0;

  const agregar = async () => {
    if (!tf || !foto) return;
    const ok = await op.correr(async () => {
      // Igual que en la atención: el servidor calcula el costo en pesos al crear la fila.
      const fila = await cortex.tables.insert('equipos_usados', { tarea: t.id, tarifa: tf.id, cantidad: cant });
      try {
        await subirArchivo(foto, { table: 'equipos_usados', id: fila.id, field: 'foto' });
      } catch (e) {
        await registrarEvento(esq, { tipo: 'Uso de equipo', tarea: t, descripcion: `${tf.equipo} × ${cant}`, equipo: tf.equipo, proveedor: tf.proveedor }).catch(() => undefined);
        throw new Error(`El equipo quedó anotado pero la foto no subió (${mensajeDe(e)}). Tómala de nuevo desde la lista.`);
      }
      await registrarEvento(esq, { tipo: 'Uso de equipo', tarea: t, descripcion: `${tf.equipo} × ${cant}`, equipo: tf.equipo, proveedor: tf.proveedor });
    }, 'Equipo agregado con su foto.');
    if (ok) await onListo();
  };

  return (
    <Hoja titulo="Usé un equipo" onCerrar={onCerrar}>
      <div className="oc-form campo">
        {tarifas.loading && !lista.length ? <p className="oc-sub">Cargando tarifas…</p> : null}
        {!tarifas.loading && !lista.length ? <div className="oc-aviso">No hay tarifas cargadas. Pídele al supervisor que las agregue en Costos.</div> : null}
        <Campo etiqueta="Equipo">
          <select value={nombre} onChange={(e) => { setNombre(e.target.value); setTarifaId(''); }}>
            <option value="">Elige el equipo…</option>
            {nombres.map((n) => <option key={n}>{n}</option>)}
          </select>
        </Campo>
        {nombre ? (
          <Campo etiqueta="Proveedor">
            <select value={tarifaId} onChange={(e) => setTarifaId(e.target.value)}>
              <option value="">Elige el proveedor…</option>
              {opciones.map((o) => <option key={o.id} value={o.id}>{o.proveedor} · {dinero(o.tarifa, o.moneda)}</option>)}
            </select>
          </Campo>
        ) : null}
        {tf ? (
          <>
            <Campo etiqueta="Cantidad">
              <div className="oc-paso">
                <button type="button" onClick={() => setCant((c) => Math.max(1, c - 1))} aria-label="Menos"><Minus /></button>
                <input type="text" inputMode="numeric" value={cant} onChange={(e) => setCant(Math.max(1, Math.floor(N(e.target.value)) || 1))} />
                <button type="button" onClick={() => setCant((c) => c + 1)} aria-label="Más"><Plus /></button>
              </div>
            </Campo>
            <p style={{ fontSize: 20 }}>Costo: <b>{dinero(total, tf.moneda)}</b> <span className="oc-sub">({cant} × {dinero(tf.tarifa, tf.moneda)})</span></p>
            <div className="oc-btns">
              <SelectorArchivo etiqueta={foto ? 'Cambiar foto' : 'Foto del equipo (obligatoria)'} camara="environment" tono={foto ? undefined : 'primario'} onArchivos={(fs) => setFoto(fs[0] ?? null)} />
              {foto ? <Chip tono="good"><Camera size={14} /> Foto lista</Chip> : null}
            </div>
          </>
        ) : null}
        {op.error ? <ErrorCaja mensaje={op.error} /> : null}
        <Boton grande tono="primario" disabled={!tf || !foto || op.ocupado} onClick={() => void agregar()}>
          {op.ocupado ? 'Guardando…' : !tf ? 'Elige equipo y proveedor' : foto ? 'Agregar equipo' : 'Primero toma la foto'}
        </Boton>
      </div>
    </Hoja>
  );
}

function FinTarea({ t, esq, sinFoto, onCerrar, onListo }: { t: Tarea; esq: Esquema; sinFoto: number; onCerrar: () => void; onListo: (mensaje: string) => void | Promise<void> }) {
  const [notas, setNotas] = useState('');
  const [fotos, setFotos] = useState<File[]>([]);
  const op = useOperacion();
  return (
    <Hoja titulo="Terminar tarea" onCerrar={onCerrar}>
      <div className="oc-form campo">
        {sinFoto ? <div className="oc-aviso">Falta la foto de {sinFoto} equipo(s). Agrégala desde la lista antes de terminar.</div> : null}
        <Campo etiqueta="Notas de cierre (opcional)">
          <textarea value={notas} onChange={(e) => setNotas(e.target.value)} rows={3} placeholder="Entregado a… / quedó en…" />
        </Campo>
        <div><Dictado grande onTexto={(x) => setNotas((d) => (d ? `${d} ${x}` : x))} /></div>
        <div className="oc-btns">
          <SelectorArchivo etiqueta={fotos.length ? `${fotos.length} foto(s)` : 'Agregar foto'} camara="environment" multiple onArchivos={(fs) => setFotos((p) => [...p, ...fs])} />
        </div>
        {op.error ? <ErrorCaja mensaje={op.error} /> : null}
        <Boton grande tono="ok" disabled={op.ocupado || sinFoto > 0} icono={<CheckCircle2 size={26} />} onClick={async () => {
          if (!(await confirmar('¿Terminar la tarea?', 'Terminar'))) return;
          let mensaje = '';
          const ok = await op.correr(async () => {
            const c = await terminarTarea(esq, t, notas, fotos);
            mensaje = `Terminaste «${t.titulo}»: ${c.duracionMin} min${c.costoTotal ? ` · ${dinero(c.costoTotal, 'COP')}` : ''}.`;
          });
          if (ok) {
            avisar(mensaje);
            await onListo(mensaje);
          }
        }}>{op.ocupado ? 'Terminando…' : 'Terminar tarea'}</Boton>
      </div>
    </Hoja>
  );
}

/** Una celda del conteo: esperado contra real, con la diferencia dicha en palabras y color. */
function Celda({ etiqueta, esperado, real, margen, formato = (n: number) => num(n) }: { etiqueta: string; esperado: number; real: number | null; margen: number; formato?: (n: number) => string }) {
  if (!esperado && real === null) return <div className="c vacio"><small>{etiqueta}</small><b>—</b><span>Sin dato</span></div>;
  const dif = real === null ? null : real - esperado;
  const ok = dif !== null && Math.abs(dif) <= margen + 1e-9;
  const cls = dif === null ? 'vacio' : ok ? 'ok' : 'bad';
  return (
    <div className={`c ${cls}`}>
      <small>{etiqueta}</small>
      <b>{real === null ? formato(esperado) : formato(real)}</b>
      <span>{dif === null ? 'esperado' : dif === 0 ? '✓ cuadra' : `${dif > 0 ? 'sobran' : 'faltan'} ${formato(Math.abs(dif))}${ok ? ' (en margen)' : ''}`}</span>
    </div>
  );
}
