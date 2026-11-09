import { useMemo, useState } from 'react';
import { cortex } from '@cortex/app-sdk';
import { AlertTriangle, ArrowRight, CheckCircle2, Clock3, FileCheck2, Inbox, Plane, RefreshCw, ShieldAlert } from 'lucide-react';
import { RESPALDO_VIVO_MS, aAtencion, aEvento, aVuelo, traerTodo, useCarga, useRol } from '../lib/datos';
import type { Atencion, Evento, Vuelo } from '../lib/datos';
import { ESTADOS_VUELO, TONO_VUELO, tono } from '../lib/estados';
import { fechaLarga, hhmm, kg, minTxt } from '../lib/formato';
import { difMinutos, horaAhora, hoyBogota, minutosHasta, sumarDias } from '../lib/tiempo';
import { Pista } from '../lib/Piezas';
import { aTramite, esActivo, esDocumental, semaforo, useAhora } from '../lib/documental';
import type { Tramite } from '../lib/documental';
import { CuentaRegresiva, porVencimiento } from '../lib/PiezasDoc';
import { Boton, Chip, ES_VIVO, ErrorCaja, Estado, Frase, Metrica, Pantalla, Tarjeta } from '../lib/ui';

/**
 * TABLERO — inicio del supervisor, documental y gerencia.
 * Línea de tiempo del día, estado de cada vuelo, retrasos, diferencias fuera de
 * margen, atenciones por aprobar y eventos críticos. Se actualiza en vivo.
 */

const CADA = RESPALDO_VIVO_MS;

interface Datos {
  vuelos: Vuelo[];
  enAtencion: Atencion[];
  porAprobar: Atencion[];
  fueraMargen: Atencion[];
  eventos: Evento[];
  /** null = la tabla de trámites todavía no existe (datos sin aplicar). */
  tramites: Tramite[] | null;
}

async function cargar(): Promise<Datos> {
  const [vs, ea, pa, rec, ev, trs] = await Promise.all([
    traerTodo('vuelos', { order: { field: 'fecha', dir: 'desc' } }, 500),
    cortex.tables.query('atenciones', { where: { estado: 'En atención' }, limit: 100 }),
    cortex.tables.query('atenciones', { where: { estado: 'Por aprobar' }, limit: 100 }),
    cortex.tables.query('atenciones', { order: { field: 'created_at', dir: 'desc' }, limit: 150 }),
    cortex.tables.query('eventos_operacion', { where: { estado: 'Abierto' }, limit: 100 }),
    traerTodo('tramites_dian', { order: { field: 'created_at', dir: 'desc' } }, 400).then((r) => r.map(aTramite)).catch((): Tramite[] | null => null),
  ]);
  return {
    vuelos: vs.map(aVuelo),
    enAtencion: ea.rows.map(aAtencion),
    porAprobar: pa.rows.map(aAtencion),
    fueraMargen: rec.rows.map(aAtencion).filter((a) => (a.fueraDeMargen || a.fueraDeZona) && a.estado !== 'Aprobada'),
    eventos: ev.rows.map(aEvento),
    tramites: trs,
  };
}

const irA = (screen: string, prefill?: Record<string, string | number>) => void cortex.nav.go({ screen, prefill }).catch(() => undefined);

/** Minutos de retraso de la hora estimada actual frente a la programada. */
const retraso = (v: Vuelo): number => (v.hora && v.horaActual ? (difMinutos(v.hora, v.horaActual) ?? 0) : 0);

export default function Tablero() {
  const hoy = hoyBogota();
  const { data, loading, error, refresh } = useCarga(cargar, [], CADA, ['vuelos', 'atenciones', 'eventos_operacion', 'tramites_dian']);
  const { rol } = useRol();
  const ahora = useAhora(15_000);

  const vuelosHoy = useMemo(
    () => (data?.vuelos ?? []).filter((v) => v.fecha === hoy).sort((a, b) => (a.horaActual || '99').localeCompare(b.horaActual || '99')),
    [data, hoy],
  );
  const abiertosAntes = useMemo(
    () => (data?.vuelos ?? []).filter((v) => v.fecha < hoy && !['Cerrado', 'Cancelado'].includes(v.estado)),
    [data, hoy],
  );
  const conteo = useMemo(() => {
    const c: Record<string, number> = {};
    for (const v of [...vuelosHoy, ...abiertosAntes]) c[v.estado] = (c[v.estado] ?? 0) + 1;
    return c;
  }, [vuelosHoy, abiertosAntes]);

  const retrasados = useMemo(
    () =>
      [...vuelosHoy, ...abiertosAntes].filter((v) => {
        if (['Cerrado', 'Cancelado', 'Recibido', 'En atención'].includes(v.estado)) return false;
        const min = minutosHasta(v.fecha, v.horaActual);
        const sinLlegar = ['Programado', 'En camino', 'Demorado'].includes(v.estado);
        return v.estado === 'Demorado' || retraso(v) >= 15 || (sinLlegar && min !== null && min < -15);
      }),
    [vuelosHoy, abiertosAntes],
  );

  const ultimosDias = useMemo(() => {
    const dias = Array.from({ length: 7 }, (_, i) => sumarDias(hoy, i - 6));
    const cuenta = (f: (v: Vuelo) => boolean) => dias.map((d) => (data?.vuelos ?? []).filter((v) => v.fecha === d && f(v)).length);
    return { vuelos: cuenta(() => true), kilos: dias.map((d) => (data?.vuelos ?? []).filter((v) => v.fecha === d).reduce((a, v) => a + (v.kilosRec ?? 0), 0)) };
  }, [data, hoy]);
  const sinTomar = [...vuelosHoy, ...abiertosAntes].filter((v) => v.estado === 'Aterrizó');
  const criticos = (data?.eventos ?? []).filter((e) => e.critico);
  const horaTxt = horaAhora();
  const vacio = !data;
  const activos = (data?.tramites ?? []).filter(esActivo).sort(porVencimiento);
  const urgentes = activos.filter((t) => {
    const x = semaforo(t, ahora);
    return x.vencido || x.porVencer;
  });
  const conInconsistencias = (data?.vuelos ?? []).filter((v) => v.inconsistencias > 0 && v.estado !== 'Cancelado');

  const [filtro, setFiltro] = useState<Filtro>('todos');
  const enAtencionHoy = vuelosHoy.filter((v) => v.estado === 'En atención');
  const visibles = useMemo(() => {
    const todos = [...abiertosAntes, ...vuelosHoy];
    if (filtro === 'sin-tomar') return todos.filter((v) => v.estado === 'Aterrizó');
    if (filtro === 'en-atencion') return todos.filter((v) => v.estado === 'En atención');
    if (filtro === 'atrasados') return retrasados;
    return null;
  }, [filtro, vuelosHoy, abiertosAntes, retrasados]);
  const alternar = (f: Filtro) => setFiltro((x) => (x === f ? 'todos' : f));
  const atrasados = retrasados.length;
  const partes: string[] = [];
  void partes;
  const hayExcepcion = atrasados + sinTomar.length + criticos.length + (data?.porAprobar.length ?? 0) > 0;
  const costoHoy = 0;
  void costoHoy;

  return (
    <Pantalla
      titulo="Tablero"
      sub={fechaLarga(hoy)}
      acciones={
        <>
          {esDocumental(rol) ? (
            <Boton tono="primario" onClick={() => irA('bandeja')} icono={<Inbox size={16} />}>
              Ir a mi bandeja
            </Boton>
          ) : null}
          <Boton onClick={() => void refresh()} icono={<RefreshCw size={16} />}>
            Actualizar
          </Boton>
        </>
      }
    >
      {error && data ? <ErrorCaja mensaje={`No se pudo actualizar: ${error}`} reintentar={() => void refresh()} /> : null}

      {data ? (
        <Frase tono={atrasados || sinTomar.length || criticos.length ? 'bad' : data.porAprobar.length ? 'warn' : 'good'} icono={hayExcepcion ? <AlertTriangle size={20} /> : <CheckCircle2 size={20} />}>
          Hoy: <b>{vuelosHoy.length} {vuelosHoy.length === 1 ? 'vuelo' : 'vuelos'}</b>
          {atrasados ? <>, <b>{atrasados} {atrasados === 1 ? 'atrasado' : 'atrasados'}</b></> : ', ninguno atrasado'}
          {sinTomar.length ? <>, <b>{sinTomar.length} sin tomar</b></> : null}
          {data.porAprobar.length ? <>, <b>{data.porAprobar.length} por aprobar</b></> : null}
          {criticos.length ? <>, <b>{criticos.length} {criticos.length === 1 ? 'evento crítico' : 'eventos críticos'}</b></> : null}.
          {!hayExcepcion ? ' Todo en orden.' : ' Toca una cifra para ver cuáles.'}
        </Frase>
      ) : null}

      <div className="oc-kpis" style={{ marginTop: error && data ? 14 : 0 }}>
        <Metrica etiqueta="Vuelos de hoy" valor={vuelosHoy.length} spark={ultimosDias.vuelos} pista="Últimos 7 días" onClick={() => setFiltro('todos')} activo={filtro === 'todos'} />
        <Metrica etiqueta="Atrasados" valor={atrasados} tono={atrasados ? 'bad' : undefined} onClick={() => alternar('atrasados')} activo={filtro === 'atrasados'} pista={atrasados ? 'Ver cuáles' : 'Todo en hora'} />
        <Metrica etiqueta="Sin tomar" valor={sinTomar.length} tono={sinTomar.length ? 'bad' : undefined} onClick={() => alternar('sin-tomar')} activo={filtro === 'sin-tomar'} pista="Aterrizaron" />
        <Metrica etiqueta="En atención" valor={data?.enAtencion.length ?? 0} tono="info" onClick={() => alternar('en-atencion')} activo={filtro === 'en-atencion'} />
        <Metrica etiqueta="Por aprobar" valor={data?.porAprobar.length ?? 0} tono={data?.porAprobar.length ? 'warn' : undefined} onClick={() => irA('aprobar')} pista="Abrir la cola" />
        <Metrica etiqueta="Críticos abiertos" valor={criticos.length} tono={criticos.length ? 'bad' : undefined} onClick={() => irA('eventos')} pista="Abrir eventos" />
      </div>

      {visibles ? (
        <div className="oc-sec">
          <Tarjeta titulo={filtro === 'sin-tomar' ? 'Aterrizaron y nadie los ha tomado' : filtro === 'en-atencion' ? 'En atención ahora' : 'Vuelos atrasados'} derecha={<Boton chico tono="suave" onClick={() => setFiltro('todos')}>Quitar filtro</Boton>}>
            {!visibles.length ? <p className="oc-sub">Ninguno por ahora.</p> : <ul className="oc-lista">{visibles.map((v) => <FilaVuelo key={v.id} v={v} anterior={v.fecha < hoy} resaltar={retrasados.includes(v) || v.estado === 'Aterrizó'} />)}</ul>}
          </Tarjeta>
        </div>
      ) : null}

      <div className="oc-sec">
        <h2>
          <Plane size={20} /> Gantt del día
        </h2>
        <Estado
          cargando={loading}
          error={error}
          vacio={vacio || (!vuelosHoy.length && !abiertosAntes.length)}
          tituloVacio="No hay vuelos para hoy"
          textoVacio={<p>Cuando el documental cree los vuelos del día, aparecerán aquí por hora.</p>}
          reintentar={() => void refresh()}
        >
          {vuelosHoy.length ? <Pista vuelos={vuelosHoy} onAbrir={(v) => irA('vuelo', { vuelo: v.id })} /> : null}
          <div style={{ height: 14 }} />
          <Tarjeta titulo="Vuelo por vuelo" derecha={<span className="oc-sub">{enAtencionHoy.length ? `${enAtencionHoy.length} en atención` : 'Nada en atención'}</span>}>
            <ul className="oc-lista">
              {abiertosAntes.map((v) => (
                <FilaVuelo key={v.id} v={v} anterior resaltar />
              ))}
              {lineaConAhora(vuelosHoy, horaTxt).map((x) =>
                x.ahora ? (
                  <li key="ahora" className="oc-ahora-linea" aria-label={`Ahora ${horaTxt}`}>
                    AHORA {horaTxt}
                  </li>
                ) : (
                  <FilaVuelo key={x.v.id} v={x.v} resaltar={retrasados.includes(x.v) || x.v.estado === 'Aterrizó'} />
                ),
              )}
            </ul>
          </Tarjeta>
        </Estado>
      </div>

      {data?.tramites ? (
        <div className="oc-sec">
          <Tarjeta
            titulo="Resumen documental"
            icono={<FileCheck2 size={18} />}
            tono={urgentes.length || conInconsistencias.length ? 'aviso' : undefined}
            derecha={
              <Boton chico tono={esDocumental(rol) ? 'primario' : 'suave'} onClick={() => irA(esDocumental(rol) ? 'bandeja' : 'tramites')} icono={<ArrowRight size={15} />}>
                {esDocumental(rol) ? 'Ir a la bandeja' : 'Ver trámites'}
              </Boton>
            }
          >
            <div className="oc-grid oc-g2">
              <div>
                <h3>Trámites por vencer</h3>
                {!urgentes.length ? (
                  <p className="oc-sub">{activos.length ? `${activos.length} activos, ninguno por vencer.` : 'Sin trámites activos.'}</p>
                ) : (
                  <ul className="oc-lista" style={{ marginTop: 8 }}>
                    {urgentes.slice(0, 4).map((t) => {
                      const x = semaforo(t, ahora);
                      return (
                        <li key={t.id}>
                          <button type="button" className={`oc-fila ${x.vencido ? 'bad' : 'hot'}`} onClick={() => irA('vuelo', { vuelo: t.vueloId, tab: 'tramites' })}>
                            <span className="h"><Clock3 size={18} /></span>
                            <span className="t"><b>{t.tramite}</b><small>{t.vuelo}</small></span>
                            <span className="d"><CuentaRegresiva t={t} ahora={ahora} /></span>
                            <span className="sig"><ArrowRight size={14} /> {x.vencido ? 'Presentar ya' : 'Presentar antes del vencimiento'}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              <div>
                <h3>Inconsistencias</h3>
                {!conInconsistencias.length ? (
                  <p className="oc-sub">Ningún vuelo con inconsistencias en el cruce.</p>
                ) : (
                  <ul className="oc-lista" style={{ marginTop: 8 }}>
                    {conInconsistencias.slice(0, 4).map((v) => (
                      <li key={v.id}>
                        <button type="button" className="oc-fila bad" onClick={() => irA('vuelo', { vuelo: v.id, tab: 'guias' })}>
                          <span className="h"><AlertTriangle size={18} /></span>
                          <span className="t"><b>{v.numero}</b><small>{v.aerolinea}</small></span>
                          <span className="d"><Chip tono="bad">{v.inconsistencias} inconsistencias</Chip></span>
                          <span className="sig"><ArrowRight size={14} /> Revisar el cruce de guías</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Tarjeta>
        </div>
      ) : data && esDocumental(rol) ? (
        <div className="oc-sec">
          <div className="oc-aviso" role="status">
            Falta aplicar los datos del documental (trámites DIAN, avisos, plazos). La bandeja funciona con lo que ya existe.
          </div>
        </div>
      ) : null}

      <div className="oc-grid oc-g2 oc-sec">
        <Tarjeta
          titulo="Por aprobar"
          derecha={
            data?.porAprobar.length ? (
              <Boton chico tono="suave" onClick={() => irA('aprobar')} icono={<ArrowRight size={15} />}>
                Revisar
              </Boton>
            ) : undefined
          }
        >
          {!data?.porAprobar.length ? (
            <p className="oc-sub">No hay atenciones esperando aprobación.</p>
          ) : (
            <ul className="oc-lista">
              {data.porAprobar.map((a) => (
                <li key={a.id}>
                  <button type="button" className={`oc-fila ${a.fueraDeMargen || a.fueraDeZona ? 'bad' : ''}`} onClick={() => irA('aprobar')}>
                    <span className="h" style={{ fontSize: 14 }}>{a.vuelo}</span>
                    <span className="t"><b>{a.operario}</b><small>Dif. kilos {a.difKilos === null ? '—' : kg(a.difKilos)}</small></span>
                    <span className="d">
                      {a.fueraDeMargen ? <Chip tono="bad">Fuera de margen</Chip> : <Chip tono="good">Dentro del margen</Chip>}
                      {a.fueraDeZona ? <Chip tono="bad">Fuera de zona</Chip> : null}
                    </span>
                    <span className="sig"><ArrowRight size={14} /> Revisar y aprobar</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Tarjeta>

        <Tarjeta titulo="Eventos críticos abiertos" icono={<ShieldAlert size={18} />} tono={criticos.length ? 'alerta' : undefined}>
          {!criticos.length ? (
            <p className="oc-sub">Sin eventos críticos abiertos.</p>
          ) : (
            <ul className="oc-lista">
              {criticos.map((e) => (
                <li key={e.id}>
                  <button type="button" className="oc-fila bad" onClick={() => irA('eventos')}>
                    <span className="h" style={{ fontSize: 14 }}>{hhmm(e.hora)}</span>
                    <span className="t"><b>{e.tipo}{e.vuelo ? ` · ${e.vuelo}` : ''}</b><small>{e.descripcion}</small></span>
                    <span className="d"><Chip tono="bad">Crítico</Chip></span>
                    <span className="sig"><ArrowRight size={14} /> Revisar y resolver · {e.operario}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Tarjeta>
      </div>

      {data?.fueraMargen.length ? (
        <div className="oc-sec">
          <Tarjeta titulo="Diferencias fuera de margen o de zona">
            <ul className="oc-lista">
              {data.fueraMargen.map((a) => (
                <li key={a.id} className="oc-item bad">
                  <div className="oc-item-top">
                    <strong>{a.vuelo}</strong>
                    <span className="oc-chips">
                      {a.fueraDeMargen ? <Chip tono="bad">Fuera de margen</Chip> : null}
                      {a.fueraDeZona ? <Chip tono="bad">Fuera de zona</Chip> : null}
                    </span>
                  </div>
                  <div className="oc-meta">
                    <span>{a.operario}</span>
                    <span>Kilos: {a.difKilos === null ? '—' : kg(a.difKilos)}</span>
                    <span>Pallets: {a.difPallets ?? '—'}</span>
                    <span>{a.estado}</span>
                  </div>
                </li>
              ))}
            </ul>
          </Tarjeta>
        </div>
      ) : null}
    </Pantalla>
  );
}

type Filtro = 'todos' | 'atrasados' | 'sin-tomar' | 'en-atencion';

/** Mezcla el marcador «Ahora» en la lista de vuelos del día ordenada por hora. */
function lineaConAhora(vs: Vuelo[], ahora: string): ({ v: Vuelo; ahora?: false } | { ahora: true })[] {
  const out: ({ v: Vuelo; ahora?: false } | { ahora: true })[] = [];
  let puesto = false;
  for (const v of vs) {
    if (!puesto && v.horaActual && hhmm(v.horaActual) > ahora) {
      out.push({ ahora: true });
      puesto = true;
    }
    out.push({ v });
  }
  if (!puesto && vs.length) out.push({ ahora: true });
  return out;
}

function FilaVuelo({ v, anterior, resaltar }: { v: Vuelo; anterior?: boolean; resaltar?: boolean }) {
  const r = retraso(v);
  const sig = SIGUIENTE[v.estado];
  const tomar = v.estado === 'Aterrizó';
  const cls = resaltar ? (tomar || v.estado === 'Demorado' || r >= 15 ? 'bad' : 'hot') : v.estado === 'Cerrado' || v.estado === 'Recibido' ? 'normal' : '';
  return (
    <li>
      <button type="button" className={`oc-fila ${cls}`} onClick={() => irA('vuelo', { vuelo: v.id })}>
        <span className="h">{anterior ? fechaLarga(v.fecha).slice(0, 8) : hhmm(v.horaActual) || '—'}</span>
        <span className="t">
          <b>{v.numero}</b>
          <small>
            {[v.aerolinea, v.origen, v.posicion ? `Posición ${v.posicion}` : '', v.kilosEsp > 0 ? kg(v.kilosEsp) : '', v.atendidoPor ? `Atiende ${v.atendidoPor}` : ''].filter(Boolean).join(' · ')}
          </small>
        </span>
        <span className="d">
          {r >= 5 ? <Chip tono="warn">+{minTxt(r)}</Chip> : null}
          <Chip tono={tono(TONO_VUELO, v.estado)} vivo={ES_VIVO.has(v.estado)}>{v.estado}</Chip>
        </span>
        {sig && cls !== 'normal' ? (
          <span className="sig">
            <ArrowRight size={14} /> {tomar && v.llegadaHora ? `Aterrizó ${hhmm(v.llegadaHora)} · ${sig}` : sig}
          </span>
        ) : null}
      </button>
    </li>
  );
}

/** Qué sigue en cada estado del vuelo. */
const SIGUIENTE: Record<string, string> = {
  Programado: 'Esperar llegada',
  'En camino': 'Preparar posición y operarios',
  Demorado: 'Avisar al operario de turno la nueva hora',
  Aterrizó: 'Un operario debe tomarlo',
  'En atención': 'Seguir el conteo',
  Recibido: 'Aprobar y cerrar',
};
