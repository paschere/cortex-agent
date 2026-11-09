import { useMemo } from 'react';
import { cortex } from '@cortex/app-sdk';
import type { SdkRow } from '@cortex/app-sdk';
import { ArrowRight, BellRing, ClipboardCheck, FileWarning, Inbox, RefreshCw, Timer, TriangleAlert } from 'lucide-react';
import { RESPALDO_VIVO_MS, aGuia, aPrealerta, cargarVuelos, traerTodo, useCarga } from '../lib/datos';
import type { Guia, Prealerta, Vuelo } from '../lib/datos';
import { fechaCorta, fechaLarga, num } from '../lib/formato';
import { normNombre } from '../lib/manifiesto';
import { hoyBogota, sumarDias } from '../lib/tiempo';
import { REQUERIDO, aAviso, aPlazo, aTramite, esActivo, faltantesDe, hayCampo, hayTabla, leerEsquema, semaforo, useAhora } from '../lib/documental';
import type { AvisoCliente, Esquema, Plazo, Tramite } from '../lib/documental';
import { CuentaRegresiva, FaltaAplicar, porVencimiento } from '../lib/PiezasDoc';
import { Boton, Chip, ErrorCaja, Estado, Frase, Metrica, Pantalla, Tarjeta } from '../lib/ui';

/**
 * BANDEJA — el día del documental, en una sola pantalla: trámites por vencer con cuenta
 * regresiva, prealertas sin vuelo, vuelos sin manifiesto, inconsistencias sin reportar,
 * avisos por enviar y guías que todavía no se pueden prefacturar. Cada tarjeta lleva a
 * resolver. Se actualiza sola cada 30 segundos. Nada se manda a la DIAN desde aquí.
 */

interface Datos {
  esq: Esquema;
  vuelos: Vuelo[];
  tramites: Tramite[] | null;
  plazos: Plazo[];
  sinVuelo: Prealerta[] | null;
  avisos: AvisoCliente[] | null;
  noListas: Guia[] | null;
}

/** Una lectura que puede fallar sin tumbar la pantalla: null = no disponible. */
async function intento<T>(ok: boolean, fn: () => Promise<T>): Promise<T | null> {
  if (!ok) return null;
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function cargar(): Promise<Datos> {
  const esq = await leerEsquema();
  const [vuelos, tramites, plazos, pre, avisos, guias] = await Promise.all([
    cargarVuelos(300),
    intento(hayTabla(esq, 'tramites_dian'), () => traerTodo('tramites_dian', { order: { field: 'created_at', dir: 'desc' } }, 600)),
    intento(hayTabla(esq, 'plazos_dian'), () => traerTodo('plazos_dian', {}, 100)),
    intento(true, async (): Promise<SdkRow[]> => {
      if (hayCampo(esq, 'prealertas', 'estado_cruce')) {
        const r = await cortex.tables.query('prealertas', { where: { estado_cruce: 'Sin vuelo' }, order: { field: 'created_at', dir: 'desc' }, limit: 300 });
        return r.rows;
      }
      const r = await cortex.tables.query('prealertas', { order: { field: 'created_at', dir: 'desc' }, limit: 300 });
      return r.rows;
    }),
    intento(hayTabla(esq, 'avisos_cliente'), async () => (await cortex.tables.query('avisos_cliente', { where: { estado: 'Por enviar' }, limit: 300 })).rows),
    intento(hayCampo(esq, 'prefacturacion', 'lista_prefactura'), async () => (await cortex.tables.query('prefacturacion', { where: { lista_prefactura: 'No' }, limit: 500 })).rows),
  ]);
  return {
    esq,
    vuelos: vuelos,
    tramites: tramites ? tramites.map(aTramite) : null,
    plazos: (plazos ?? []).map(aPlazo),
    sinVuelo: pre ? pre.map(aPrealerta).filter((p) => !p.vueloId && p.estado !== 'Duplicada') : null,
    avisos: avisos ? avisos.map(aAviso) : null,
    noListas: guias ? guias.map(aGuia).filter((g) => g.etapa !== 'Prefacturada') : null,
  };
}

const irA = (screen: string, prefill?: Record<string, string | number>) => void cortex.nav.go({ screen, prefill }).catch(() => undefined);

/** Máximo de renglones por tarjeta antes de «ver todo». */
const TOPE = 6;

export default function Bandeja() {
  const hoy = hoyBogota();
  const { data, loading, error, refresh } = useCarga(cargar, [], RESPALDO_VIVO_MS, ['vuelos', 'prealertas', 'prefacturacion', 'tramites_dian', 'avisos_cliente']);
  const ahora = useAhora(15_000);

  const d = data;
  const vuelosPorId = useMemo(() => new Map((d?.vuelos ?? []).map((v) => [v.id, v])), [d]);
  const avisarDe = useMemo(() => new Map((d?.plazos ?? []).map((p) => [normNombre(p.tramite), p.avisarHorasAntes])), [d]);
  const horas = (t: Tramite) => avisarDe.get(normNombre(t.tramite)) ?? 3;

  const activos = useMemo(() => (d?.tramites ?? []).filter(esActivo).sort(porVencimiento), [d]);
  const urgentes = activos.filter((t) => {
    const s = semaforo(t, ahora, horas(t));
    return s.vencido || s.porVencer;
  });

  const abiertos = useMemo(() => (d?.vuelos ?? []).filter((v) => !['Cerrado', 'Cancelado'].includes(v.estado) && v.fecha >= sumarDias(hoy, -14)), [d, hoy]);
  const sinManifiesto = useMemo(
    () => abiertos.filter((v) => ['', 'Sin prealertas', 'Prealertado'].includes(v.estadoDocumental) && !v.manifiestoArchivo.length).sort((a, b) => a.fecha.localeCompare(b.fecha)),
    [abiertos],
  );
  const informePresentado = useMemo(() => {
    const s = new Set<string>();
    for (const t of d?.tramites ?? []) if (t.estado === 'Presentado' && /informe/i.test(t.tramite) && !/justific/i.test(t.tramite)) s.add(t.vueloId);
    return s;
  }, [d]);
  const sinReportar = useMemo(() => (d?.vuelos ?? []).filter((v) => v.inconsistencias > 0 && !informePresentado.has(v.id) && v.estado !== 'Cancelado'), [d, informePresentado]);
  const noListasPorVuelo = useMemo(() => {
    const m = new Map<string, Guia[]>();
    for (const g of d?.noListas ?? []) m.set(g.vueloId, [...(m.get(g.vueloId) ?? []), g]);
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [d]);

  const faltan = d ? faltantesDe(d.esq, { tramites_dian: REQUERIDO.tramites_dian ?? [], avisos_cliente: REQUERIDO.avisos_cliente ?? [] }) : [];
  const nombreVuelo = (id: string) => vuelosPorId.get(id)?.numero ?? 'Vuelo';

  return (
    <Pantalla
      titulo="Bandeja"
      sub={`${fechaLarga(hoy)} · tu día documental, se actualiza solo cada 30 segundos`}
      acciones={
        <Boton onClick={() => void refresh()} icono={<RefreshCw size={16} />}>
          Actualizar
        </Boton>
      }
    >
      {error && d ? <ErrorCaja mensaje={`No se pudo actualizar: ${error}`} reintentar={() => void refresh()} /> : null}
      <FaltaAplicar faltan={faltan} />

      {d ? (
        <Frase tono={urgentes.some((t) => semaforo(t, ahora, horas(t)).vencido) ? 'bad' : urgentes.length || sinReportar.length ? 'warn' : 'good'}>
          {(() => {
            const vencidos = urgentes.filter((t) => semaforo(t, ahora, horas(t)).vencido).length;
            const total = urgentes.length + (d.sinVuelo?.length ?? 0) + sinManifiesto.length + sinReportar.length + (d.avisos?.length ?? 0) + noListasPorVuelo.length;
            if (!total) return 'Tu bandeja está al día: nada por hacer ahora.';
            return (
              <>
                Tienes <b>{total} {total === 1 ? 'cosa' : 'cosas'} por hacer</b>
                {urgentes.length ? <>; lo más urgente: <b>{urgentes.length} {urgentes.length === 1 ? 'trámite por vencer' : 'trámites por vencer'}</b>{vencidos ? <> ({vencidos} ya vencido{vencidos === 1 ? '' : 's'})</> : null}</> : null}.
              </>
            );
          })()}
        </Frase>
      ) : null}

      <div className="oc-kpis">
        <Metrica etiqueta="Trámites por vencer" valor={d?.tramites ? urgentes.length : '—'} tono={urgentes.length ? 'bad' : undefined} pista={d?.tramites ? `${num(activos.length)} activos` : 'Sin datos aplicados'} />
        <Metrica etiqueta="Prealertas sin vuelo" valor={d?.sinVuelo ? d.sinVuelo.length : '—'} tono={d?.sinVuelo?.length ? 'warn' : undefined} />
        <Metrica etiqueta="Vuelos sin manifiesto" valor={sinManifiesto.length} tono={sinManifiesto.length ? 'warn' : undefined} />
        <Metrica etiqueta="Inconsistencias sin reportar" valor={sinReportar.length} tono={sinReportar.length ? 'bad' : undefined} />
        <Metrica etiqueta="Avisos por enviar" valor={d?.avisos ? d.avisos.length : '—'} tono={d?.avisos?.length ? 'info' : undefined} />
        <Metrica etiqueta="Guías no listas" valor={d?.noListas ? d.noListas.length : '—'} tono={d?.noListas?.length ? 'warn' : undefined} />
      </div>

      <Estado cargando={loading} error={error} vacio={!d} tituloVacio="No se pudo cargar la bandeja" reintentar={() => void refresh()}>
        <div className="oc-sec">
          <Tarjeta
            titulo="Trámites por vencer"
            icono={<Timer size={18} />}
            tono={urgentes.length ? 'alerta' : undefined}
            derecha={
              <Boton chico tono="suave" onClick={() => irA('tramites')} icono={<ArrowRight size={15} />}>
                Ver todos
              </Boton>
            }
          >
            {!d?.tramites ? (
              <p className="oc-sub">Los trámites aparecerán aquí cuando se apliquen los datos nuevos.</p>
            ) : !activos.length ? (
              <p className="oc-sub">No hay trámites activos. Se crean solos cuando un vuelo aterriza o termina el descargue.</p>
            ) : (
              <ul className="oc-lista">
                {activos.slice(0, TOPE).map((t) => {
                  const s = semaforo(t, ahora, horas(t));
                  return (
                    <li key={t.id} className={`oc-item ${s.vencido ? 'bad' : s.porVencer ? 'hot' : ''}`}>
                      <div className="oc-item-top">
                        <span>
                          <strong>{t.tramite}</strong> <span className="oc-sub">· {t.vuelo || nombreVuelo(t.vueloId)}</span>
                        </span>
                        <CuentaRegresiva t={t} ahora={ahora} avisarHoras={horas(t)} />
                      </div>
                      <div className="oc-btns">
                        <Boton chico tono={s.vencido || s.porVencer ? 'primario' : undefined} onClick={() => irA('vuelo', { vuelo: t.vueloId, tab: 'tramites' })}>
                          Resolver
                        </Boton>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {activos.length > TOPE ? <p className="oc-sub" style={{ marginTop: 8 }}>y {activos.length - TOPE} más en Trámites DIAN.</p> : null}
          </Tarjeta>
        </div>

        <div className="oc-grid oc-g2 oc-sec">
          <Tarjeta
            titulo="Prealertas sin vuelo"
            icono={<Inbox size={18} />}
            derecha={
              <Boton chico tono="suave" onClick={() => irA('prealertas')} icono={<ArrowRight size={15} />}>
                Ir a prealertas
              </Boton>
            }
          >
            {!d?.sinVuelo ? (
              <p className="oc-sub">No se pudieron leer las prealertas.</p>
            ) : !d.sinVuelo.length ? (
              <p className="oc-sub">Todas las prealertas tienen vuelo.</p>
            ) : (
              <ul className="oc-lista">
                {d.sinVuelo.slice(0, TOPE).map((p) => (
                  <li key={p.id} className="oc-item">
                    <div className="oc-item-top">
                      <span>
                        <b className="oc-mono">{p.guia}</b> <span className="oc-sub">{p.cliente}</span>
                      </span>
                      <Chip tono="warn">{p.numeroVuelo || 'Sin número de vuelo'}</Chip>
                    </div>
                    <div className="oc-btns">
                      <Boton chico onClick={() => irA('prealertas', { estado: 'Sin vuelo' })}>
                        Enlazar a un vuelo
                      </Boton>
                    </div>
                  </li>
                ))}
                {d.sinVuelo.length > TOPE ? <li className="oc-sub">y {d.sinVuelo.length - TOPE} más.</li> : null}
              </ul>
            )}
          </Tarjeta>

          <Tarjeta titulo="Vuelos sin manifiesto" icono={<FileWarning size={18} />}>
            {!sinManifiesto.length ? (
              <p className="oc-sub">Todos los vuelos abiertos ya tienen su manifiesto.</p>
            ) : (
              <ul className="oc-lista">
                {sinManifiesto.slice(0, TOPE).map((v) => (
                  <li key={v.id} className="oc-item">
                    <div className="oc-item-top">
                      <span>
                        <strong>{v.numero}</strong> <span className="oc-sub">{fechaCorta(v.fecha)} · {v.aerolinea}</span>
                      </span>
                      <Chip tono="neutral">{v.estadoDocumental || 'Sin prealertas'}</Chip>
                    </div>
                    <div className="oc-btns">
                      <Boton chico onClick={() => irA('vuelo', { vuelo: v.id, tab: 'guias' })}>
                        Cargar manifiesto
                      </Boton>
                    </div>
                  </li>
                ))}
                {sinManifiesto.length > TOPE ? <li className="oc-sub">y {sinManifiesto.length - TOPE} más.</li> : null}
              </ul>
            )}
          </Tarjeta>
        </div>

        <div className="oc-grid oc-g2 oc-sec">
          <Tarjeta titulo="Inconsistencias sin reportar" icono={<TriangleAlert size={18} />} tono={sinReportar.length ? 'aviso' : undefined}>
            {!sinReportar.length ? (
              <p className="oc-sub">No hay inconsistencias pendientes de informe.</p>
            ) : (
              <ul className="oc-lista">
                {sinReportar.slice(0, TOPE).map((v) => (
                  <li key={v.id} className="oc-item hot">
                    <div className="oc-item-top">
                      <strong>{v.numero}</strong>
                      <Chip tono="bad">{num(v.inconsistencias)} inconsistencias</Chip>
                    </div>
                    <div className="oc-btns">
                      <Boton chico tono="primario" onClick={() => irA('vuelo', { vuelo: v.id, tab: 'tramites' })}>
                        Armar el informe
                      </Boton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Tarjeta>

          <Tarjeta titulo="Avisos por enviar" icono={<BellRing size={18} />}>
            {!d?.avisos ? (
              <p className="oc-sub">Los avisos aparecerán aquí cuando se apliquen los datos nuevos.</p>
            ) : !d.avisos.length ? (
              <p className="oc-sub">No hay avisos pendientes.</p>
            ) : (
              <ul className="oc-lista">
                {d.avisos.slice(0, TOPE).map((a) => (
                  <li key={a.id} className="oc-item">
                    <div className="oc-item-top">
                      <span>
                        <strong>{a.cliente || 'Cliente'}</strong> <span className="oc-sub">· {a.tipo}</span>
                      </span>
                      <Chip tono="warn">{a.canal || 'Por enviar'}</Chip>
                    </div>
                    <div className="oc-btns">
                      <Boton chico onClick={() => irA('vuelo', { vuelo: a.vueloId, tab: 'avisos' })}>
                        Enviar aviso
                      </Boton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Tarjeta>
        </div>

        <div className="oc-sec">
          <Tarjeta titulo="Guías no listas para prefacturar" icono={<ClipboardCheck size={18} />}>
            {!d?.noListas ? (
              <p className="oc-sub">Se verá cuando se apliquen los datos nuevos de prefacturación.</p>
            ) : !noListasPorVuelo.length ? (
              <p className="oc-sub">Todas las guías cruzadas están listas.</p>
            ) : (
              <ul className="oc-lista">
                {noListasPorVuelo.slice(0, TOPE).map(([vid, gs]) => (
                  <li key={vid} className="oc-item">
                    <div className="oc-item-top">
                      <span>
                        <strong>{nombreVuelo(vid)}</strong> <span className="oc-sub">· {num(gs.length)} {gs.length === 1 ? 'guía' : 'guías'}</span>
                      </span>
                      <Boton chico onClick={() => irA('vuelo', { vuelo: vid, tab: 'guias' })}>
                        Resolver
                      </Boton>
                    </div>
                    <div className="oc-meta">
                      {gs.slice(0, 3).map((g) => (
                        <span key={g.id}>
                          {g.guia}: {g.falta || 'revisar'}
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Tarjeta>
        </div>
      </Estado>
    </Pantalla>
  );
}
