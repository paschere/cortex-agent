import { useMemo, useState } from 'react';
import { cortex } from '@cortex/app-sdk';
import { AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronUp, MessageSquareWarning, RefreshCw, X } from 'lucide-react';
import { aAtencion, aEquipo, traerTodo, useAcciones, useCarga } from '../lib/datos';
import type { Atencion, Equipo } from '../lib/datos';
import { Medidor } from '../lib/Piezas';
import { TONO_ATENCION, tono } from '../lib/estados';
import { cop, dinero, fechaCorta, hhmm, kg, num } from '../lib/formato';
import { Adjuntos, Boton, Campo, Chip, ErrorCaja, Estado, Frase, Hoja, Metrica, Pantalla, Segmentos, Tabla, Tarjeta, useOperacion } from '../lib/ui';

/**
 * POR APROBAR — el supervisor revisa cada atención cerrada: diferencias contra el
 * margen, fotos, equipos y costo. Aprobar, Rechazar (con motivo) o Pedir corrección (con nota).
 */

interface Datos {
  atenciones: Atencion[];
  equipos: Equipo[];
}

async function cargar(): Promise<Datos> {
  const [as, es] = await Promise.all([
    cortex.tables.query('atenciones', { order: { field: 'created_at', dir: 'desc' }, limit: 200 }),
    traerTodo('equipos_usados', { order: { field: 'created_at', dir: 'desc' } }, 1000).catch(() => []),
  ]);
  return { atenciones: as.rows.map(aAtencion), equipos: es.map(aEquipo) };
}

type Decision = { a: Atencion; tipo: 'rechazar' | 'devolver' };

export default function Aprobar() {
  const { data, loading, error, refresh } = useCarga(cargar, [], 30_000);
  const acc = useAcciones('atenciones');
  const op = useOperacion();
  const [vista, setVista] = useState<'pendientes' | 'resueltas'>('pendientes');
  const [decision, setDecision] = useState<Decision | null>(null);

  const pendientes = useMemo(() => (data?.atenciones ?? []).filter((a) => a.estado === 'Por aprobar').sort((x, y) => Number(y.fueraDeMargen || y.fueraDeZona) - Number(x.fueraDeMargen || x.fueraDeZona)), [data]);
  const resueltas = useMemo(() => (data?.atenciones ?? []).filter((a) => a.estado === 'Aprobada' || a.estado === 'Rechazada').slice(0, 25), [data]);
  const lista = vista === 'pendientes' ? pendientes : resueltas;
  const equiposDe = (id: string) => (data?.equipos ?? []).filter((e) => e.atencionId === id);
  const costoDe = (a: Atencion) => a.costoEquipos || equiposDe(a.id).reduce((t, e) => t + (e.costoCop || e.porPagar), 0);
  const totalCosto = pendientes.reduce((t, a) => t + costoDe(a), 0);
  const [abiertas, setAbiertas] = useState<Record<string, boolean>>({});

  const aprobar = async (a: Atencion) => {
    const ok = await op.correr(() => cortex.tables.action('atenciones', a.id, 'aprobar'), `${a.vuelo}: aprobada.`);
    if (ok) await refresh();
  };

  return (
    <Pantalla
      titulo="Por aprobar"
      sub="Revisa lo que cerraron los operarios antes de dar el vuelo por cerrado."
      acciones={<Boton onClick={() => void refresh()} icono={<RefreshCw size={16} />}>Actualizar</Boton>}
    >
      {data ? (
        <Frase tono={pendientes.some((a) => a.fueraDeMargen || a.fueraDeZona) ? 'bad' : pendientes.length ? 'warn' : 'good'} icono={pendientes.length ? <AlertTriangle size={20} /> : <CheckCircle2 size={20} />}>
          {pendientes.length ? <><b>{pendientes.length} {pendientes.length === 1 ? 'atención espera' : 'atenciones esperan'}</b> tu decisión{pendientes.some((a) => a.fueraDeMargen || a.fueraDeZona) ? <>; <b>{pendientes.filter((a) => a.fueraDeMargen || a.fueraDeZona).length} con diferencias fuera de margen o zona</b> van primero</> : ', todas dentro del margen'}.</> : 'Todo al día: no hay atenciones por aprobar.'}
        </Frase>
      ) : null}
      <div className="oc-kpis">
        <Metrica etiqueta="Por aprobar" valor={pendientes.length} tono={pendientes.length ? 'warn' : undefined} />
        <Metrica etiqueta="Con diferencias fuera de margen" valor={pendientes.filter((a) => a.fueraDeMargen).length} tono={pendientes.some((a) => a.fueraDeMargen) ? 'bad' : undefined} />
        <Metrica etiqueta="Costo de equipos por aprobar" valor={cop(totalCosto)} />
      </div>

      <div style={{ margin: '22px 0 16px' }}>
        <Segmentos valor={vista} onChange={setVista} opciones={[{ id: 'pendientes', texto: `Pendientes (${pendientes.length})` }, { id: 'resueltas', texto: 'Resueltas recientes' }]} />
      </div>

      {op.error ? <ErrorCaja mensaje={op.error} /> : null}

      <Estado
        cargando={loading}
        error={error}
        vacio={!lista.length}
        tituloVacio={vista === 'pendientes' ? 'Todo al día' : 'Aún no hay atenciones resueltas'}
        textoVacio={<p>{vista === 'pendientes' ? 'No hay atenciones esperando aprobación. Cuando un operario cierre una, aparecerá aquí.' : 'Las aprobadas y rechazadas se verán aquí.'}</p>}
        reintentar={() => void refresh()}
      >
        <div style={{ display: 'grid', gap: 16, marginTop: op.error ? 14 : 0 }}>
          {lista.map((a) => {
            const eq = equiposDe(a.id);
            const pend = a.estado === 'Por aprobar';
            return (
              <Tarjeta
                key={a.id}
                titulo={
                  <span>
                    <span className="oc-mono">{a.vuelo}</span> <span className="oc-sub" style={{ fontWeight: 400 }}>· {a.operario} · {fechaCorta(a.fecha)}</span>
                  </span>
                }
                derecha={
                  <span className="oc-chips">
                    <Chip tono={tono(TONO_ATENCION, a.estado)}>{a.estado}</Chip>
                    {a.fueraDeMargen ? <Chip tono="bad">Fuera de margen</Chip> : <Chip tono="good">Dentro del margen</Chip>}
                    {a.fueraDeZona ? <Chip tono="bad">Fuera de zona</Chip> : null}
                  </span>
                }
                tono={a.fueraDeMargen || a.fueraDeZona ? 'alerta' : undefined}
              >
                <p className="oc-resumen-dif">
                  <b className={a.fueraDeMargen ? 'bad' : 'ok'}>{a.difKilos === null ? 'Sin kilos' : `${a.difKilos > 0 ? '+' : a.difKilos < 0 ? '−' : ''}${num(Math.abs(a.difKilos), 1)} kg`}</b>
                  <span>{a.difPiezas ? `${a.difPiezas > 0 ? '+' : '−'}${Math.abs(a.difPiezas)} piezas` : 'piezas completas'}</span>
                  <span>{eq.length} {eq.length === 1 ? 'equipo' : 'equipos'} · {cop(costoDe(a))}</span>
                  {eq.some((e) => !e.foto.length) ? <Chip tono="warn">Equipos sin foto</Chip> : null}
                </p>
                <div className="oc-grid oc-g2">
                  <div className="oc-form">
                    <Medidor titulo="Kilos" esperado={a.kilosEsp} real={a.kilosRec} margen={(a.kilosEsp * a.margenKilos) / 100} formato={(n) => kg(n)} />
                    <Medidor titulo="Pallets" esperado={a.palletsEsp} real={a.palletsRec} margen={a.margenPallets} formato={(n) => num(n)} />
                    <p className="oc-sub">
                      Piezas: {num(a.piezasEsp)} esperadas · {a.piezasRec === null ? 'sin registrar' : `${num(a.piezasRec)} recibidas`}
                    </p>
                  </div>
                  <dl className="oc-pares" style={{ alignContent: 'start' }}>
                    <dt>Horario</dt><dd className="oc-mono">{hhmm(a.horaInicio) || '—'} → {hhmm(a.horaFin) || '—'}</dd>
                    <dt>Zona inicio</dt><dd>{a.zonaInicio || '—'}</dd>
                    <dt>Zona cierre</dt><dd>{a.zonaCierre || '—'}</dd>
                    
                  </dl>
                </div>

                {pend && !(a.fueraDeMargen || a.fueraDeZona) ? <Boton chico tono="suave" onClick={() => setAbiertas((o) => ({ ...o, [a.id]: !o[a.id] }))} icono={abiertas[a.id] ? <ChevronUp size={15} /> : <ChevronDown size={15} />}>{abiertas[a.id] ? 'Ocultar equipos y fotos' : 'Ver equipos y fotos'}</Boton> : null}
                <div hidden={pend && !(a.fueraDeMargen || a.fueraDeZona) && !abiertas[a.id]}>
                {a.novedades ? <p style={{ marginTop: 12 }}><b>Novedades:</b> {a.novedades}</p> : null}
                {a.notaCorreccion ? <div className="oc-aviso" style={{ marginTop: 12 }}>Corrección pedida: {a.notaCorreccion}</div> : null}
                {a.motivoRechazo ? <div className="oc-error" style={{ marginTop: 12 }}>Motivo del rechazo: {a.motivoRechazo}</div> : null}

                {a.fotos.length ? (
                  <div style={{ marginTop: 12 }}>
                    <h3 style={{ marginBottom: 6 }}>Fotos de la carga</h3>
                    <Adjuntos lista={a.fotos} />
                  </div>
                ) : null}

                <div style={{ marginTop: 12 }}>
                  <h3 style={{ marginBottom: 6 }}>Equipos usados</h3>
                  {!eq.length ? (
                    <p className="oc-sub">No registró equipos.</p>
                  ) : (
                    <Tabla columnas={[{ t: 'Equipo' }, { t: 'Cant.', n: true }, { t: 'Tarifa', n: true }, { t: 'Costo (COP)', n: true }, { t: 'Foto' }]}>
                      {eq.map((e) => (
                        <tr key={e.id}>
                          <td>{e.equipo}<div className="oc-sub">{e.proveedor}</div></td>
                          <td className="n">{num(e.cantidad)}</td>
                          <td className="n">{dinero(e.tarifa, e.moneda)}</td>
                          <td className="n">{cop(e.costoCop || e.porPagar)}</td>
                          <td>{e.foto.length ? <Adjuntos lista={e.foto} /> : <Chip tono="bad">Sin foto</Chip>}</td>
                        </tr>
                      ))}
                    </Tabla>
                  )}
                </div>

                </div>
                {pend ? (
                  <div className="oc-decidir">
                    {acc.tiene('aprobar') ? (
                      <Boton tono="ok" disabled={op.ocupado} onClick={() => void aprobar(a)} icono={<Check size={18} />}>Aprobar</Boton>
                    ) : null}
                    {acc.tiene('devolver') ? (
                      <Boton tono="aviso" disabled={op.ocupado} onClick={() => setDecision({ a, tipo: 'devolver' })} icono={<MessageSquareWarning size={18} />}>Pedir corrección</Boton>
                    ) : null}
                    {acc.tiene('rechazar') ? (
                      <Boton tono="malo" disabled={op.ocupado} onClick={() => setDecision({ a, tipo: 'rechazar' })} icono={<X size={18} />}>Rechazar</Boton>
                    ) : null}
                  </div>
                ) : null}
              </Tarjeta>
            );
          })}
        </div>
      </Estado>

      {decision ? (
        <Motivo
          decision={decision}
          onCerrar={() => setDecision(null)}
          onListo={async () => {
            setDecision(null);
            await refresh();
          }}
        />
      ) : null}
    </Pantalla>
  );
}

function Motivo({ decision, onCerrar, onListo }: { decision: Decision; onCerrar: () => void; onListo: () => void | Promise<void> }) {
  const rechazo = decision.tipo === 'rechazar';
  const [texto, setTexto] = useState('');
  const op = useOperacion();
  const { a } = decision;
  return (
    <Hoja titulo={rechazo ? `Rechazar ${a.vuelo}` : `Pedir corrección en ${a.vuelo}`} onCerrar={onCerrar}>
      <div className="oc-form">
        <Campo
          etiqueta={rechazo ? 'Motivo del rechazo' : 'Qué debe corregir el operario'}
          ayuda={rechazo ? 'Los equipos de esta atención no se pagan.' : 'La atención vuelve al operario y le llega un aviso con tu nota.'}
        >
          <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={4} autoFocus />
        </Campo>
        {op.error ? <ErrorCaja mensaje={op.error} /> : null}
        <Boton
          tono={rechazo ? 'malo' : 'aviso'}
          disabled={op.ocupado || !texto.trim()}
          onClick={async () => {
            const ok = await op.correr(async () => {
              await cortex.tables.update('atenciones', a.id, rechazo ? { motivo_rechazo: texto.trim() } : { nota_correccion: texto.trim() });
              await cortex.tables.action('atenciones', a.id, decision.tipo);
            }, rechazo ? 'Atención rechazada.' : 'Corrección pedida al operario.');
            if (ok) await onListo();
          }}
        >
          {op.ocupado ? 'Enviando…' : rechazo ? 'Rechazar atención' : 'Pedir corrección'}
        </Boton>
      </div>
    </Hoja>
  );
}
