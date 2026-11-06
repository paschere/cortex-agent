import { useMemo } from 'react';
import { cortex } from '@cortex/app-sdk';
import { AlertTriangle, ArrowRight, FileCheck2, Inbox, Plane, RefreshCw, ShieldAlert } from 'lucide-react';
import { aAtencion, aEvento, aVuelo, traerTodo, useCarga, useRol } from '../lib/datos';
import type { Atencion, Evento, Vuelo } from '../lib/datos';
import { ESTADOS_VUELO, TONO_VUELO, tono } from '../lib/estados';
import { fechaLarga, hhmm, kg, minTxt } from '../lib/formato';
import { difMinutos, horaAhora, hoyBogota, minutosHasta, sumarDias } from '../lib/tiempo';
import { Pista } from '../lib/Piezas';
import { aTramite, esActivo, esDocumental, semaforo, useAhora } from '../lib/documental';
import type { Tramite } from '../lib/documental';
import { CuentaRegresiva, porVencimiento } from '../lib/PiezasDoc';
import { Boton, Chip, ES_VIVO, ErrorCaja, Estado, Metrica, Pantalla, Tarjeta } from '../lib/ui';

/**
 * TABLERO — inicio del supervisor, documental y gerencia.
 * Línea de tiempo del día, estado de cada vuelo, retrasos, diferencias fuera de
 * margen, atenciones por aprobar y eventos críticos. Se actualiza solo cada 20 s.
 */

const CADA = 20_000;

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
  const { data, loading, error, refresh } = useCarga(cargar, [], CADA);
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

  return (
    <Pantalla
      titulo="Tablero"
      sub={`${fechaLarga(hoy)} · se actualiza solo cada 20 segundos`}
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

      <div className="oc-kpis" style={{ marginTop: error && data ? 14 : 0 }}>
        <Metrica etiqueta="Vuelos de hoy" valor={vuelosHoy.length} spark={ultimosDias.vuelos} pista="Últimos 7 días" />
        <Metrica etiqueta="Sin tomar (aterrizaron)" valor={sinTomar.length} tono={sinTomar.length ? 'bad' : undefined} />
        <Metrica etiqueta="En atención" valor={data?.enAtencion.length ?? 0} tono="info" />
        <Metrica etiqueta="Por aprobar" valor={data?.porAprobar.length ?? 0} tono={data?.porAprobar.length ? 'warn' : undefined} />
        <Metrica etiqueta="Fuera de margen o zona" valor={data?.fueraMargen.length ?? 0} tono={data?.fueraMargen.length ? 'bad' : undefined} />
        <Metrica etiqueta="Eventos críticos abiertos" valor={criticos.length} tono={criticos.length ? 'bad' : undefined} />
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
                    {urgentes.slice(0, 4).map((t) => (
                      <li key={t.id} className="oc-item hot">
                        <div className="oc-item-top">
                          <span>
                            <strong>{t.tramite}</strong> <span className="oc-sub">· {t.vuelo}</span>
                          </span>
                          <CuentaRegresiva t={t} ahora={ahora} />
                        </div>
                        <div className="oc-btns">
                          <Boton chico onClick={() => irA('vuelo', { vuelo: t.vueloId, tab: 'tramites' })}>
                            Abrir
                          </Boton>
                        </div>
                      </li>
                    ))}
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
                      <li key={v.id} className="oc-item bad">
                        <div className="oc-item-top">
                          <strong>{v.numero}</strong>
                          <Chip tono="bad">{v.inconsistencias} inconsistencias</Chip>
                        </div>
                        <div className="oc-btns">
                          <Boton chico onClick={() => irA('vuelo', { vuelo: v.id, tab: 'guias' })}>
                            Revisar cruce
                          </Boton>
                        </div>
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

      <div className="oc-sec">
        <div className="oc-chips" aria-label="Vuelos por estado">
          {ESTADOS_VUELO.filter((e) => conteo[e]).map((e) => (
            <Chip key={e} tono={tono(TONO_VUELO, e)}>
              {e} · {conteo[e]}
            </Chip>
          ))}
          {!Object.keys(conteo).length && !loading ? <span className="oc-sub">Ningún vuelo abierto.</span> : null}
        </div>
      </div>

      <div className="oc-sec">
        <h2>
          <Plane size={20} /> Línea de tiempo del día
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
          <Tarjeta titulo="Detalle del día">
            <ol className="oc-linea">
              {abiertosAntes.map((v) => (
                <FilaVuelo key={v.id} v={v} anterior />
              ))}
              {lineaConAhora(vuelosHoy, horaTxt).map((x) =>
                x.ahora ? (
                  <li key="ahora" className="ahora">
                    Ahora · {horaTxt}
                  </li>
                ) : (
                  <FilaVuelo key={x.v.id} v={x.v} />
                ),
              )}
            </ol>
          </Tarjeta>
        </Estado>
      </div>

      <div className="oc-grid oc-g2 oc-sec">
        <Tarjeta titulo="Retrasos" icono={<AlertTriangle size={18} />} tono={retrasados.length ? 'aviso' : undefined}>
          {!retrasados.length ? (
            <p className="oc-sub">Todo en hora. Ningún vuelo con más de 15 minutos de retraso.</p>
          ) : (
            <ul className="oc-lista">
              {retrasados.map((v) => (
                <li key={v.id} className="oc-item hot">
                  <div className="oc-item-top">
                    <strong>{v.numero}</strong>
                    <Chip tono={tono(TONO_VUELO, v.estado)}>{v.estado}</Chip>
                  </div>
                  <div className="oc-meta">
                    <span>
                      Programado {hhmm(v.hora) || '—'} · ahora {hhmm(v.horaActual) || '—'}
                    </span>
                    <span>{retraso(v) > 0 ? `+${minTxt(retraso(v))}` : minTxt(minutosHasta(v.fecha, v.horaActual))}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Tarjeta>

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
                <li key={a.id} className="oc-item">
                  <div className="oc-item-top">
                    <strong>{a.vuelo}</strong>
                    <span className="oc-chips">
                      {a.fueraDeMargen ? <Chip tono="bad">Fuera de margen</Chip> : <Chip tono="good">Dentro del margen</Chip>}
                      {a.fueraDeZona ? <Chip tono="bad">Fuera de zona</Chip> : null}
                    </span>
                  </div>
                  <div className="oc-meta">
                    <span>{a.operario}</span>
                    <span>Dif. kilos {a.difKilos === null ? '—' : kg(a.difKilos)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Tarjeta>
      </div>

      <div className="oc-grid oc-g2 oc-sec">
        <Tarjeta titulo="Diferencias fuera de margen o de zona">
          {!data?.fueraMargen.length ? (
            <p className="oc-sub">Ninguna por revisar.</p>
          ) : (
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
          )}
        </Tarjeta>

        <Tarjeta titulo="Eventos críticos abiertos" icono={<ShieldAlert size={18} />} tono={criticos.length ? 'alerta' : undefined}>
          {!criticos.length ? (
            <p className="oc-sub">Sin eventos críticos abiertos.</p>
          ) : (
            <ul className="oc-lista">
              {criticos.map((e) => (
                <li key={e.id} className="oc-item bad">
                  <div className="oc-item-top">
                    <strong>{e.tipo}</strong>
                    <span className="oc-sub">{hhmm(e.hora)}</span>
                  </div>
                  <p>{e.descripcion}</p>
                  <div className="oc-meta">
                    <span>{e.operario}</span>
                    {e.vuelo ? <span>{e.vuelo}</span> : null}
                    {e.equipo ? <span>{e.equipo}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {criticos.length ? (
            <div style={{ marginTop: 12 }}>
              <Boton chico onClick={() => irA('eventos')}>
                Ir a eventos
              </Boton>
            </div>
          ) : null}
        </Tarjeta>
      </div>
    </Pantalla>
  );
}

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

function FilaVuelo({ v, anterior }: { v: Vuelo; anterior?: boolean }) {
  const r = retraso(v);
  return (
    <li className={tono(TONO_VUELO, v.estado)}>
      <div className="oc-item" style={{ marginBottom: 0 }}>
        <div className="oc-item-top">
          <span>
            <span className="oc-hora">{anterior ? fechaLarga(v.fecha).slice(0, 12) : hhmm(v.horaActual) || '—'}</span>
            <strong>{v.numero}</strong>
            <span className="oc-sub"> · {[v.aerolinea, v.origen].filter(Boolean).join(' · ')}</span>
          </span>
          <Chip tono={tono(TONO_VUELO, v.estado)} vivo={ES_VIVO.has(v.estado)}>{v.estado}</Chip>
        </div>
        <div className="oc-meta">
          {r >= 5 ? <span style={{ color: 'var(--aviso)', fontWeight: 700 }}>Retraso +{minTxt(r)}</span> : null}
          {v.posicion ? <span>Posición {v.posicion}</span> : <span>Sin posición</span>}
          {v.kilosEsp > 0 ? <span>{kg(v.kilosEsp)} esperados</span> : null}
          {v.atendidoPor ? <span>Atiende {v.atendidoPor}</span> : null}
          {v.estado === 'Aterrizó' && v.llegadaHora ? <span>Aterrizó {hhmm(v.llegadaHora)}</span> : null}
        </div>
        <div className="oc-btns">
          <Boton chico onClick={() => irA('vuelo', { vuelo: v.id })}>
            Abrir vuelo
          </Boton>
        </div>
      </div>
    </li>
  );
}
