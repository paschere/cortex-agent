import { useMemo, useState } from 'react';
import { cortex } from '@cortex/app-sdk';
import { Pencil, Plane, Plus, Search } from 'lucide-react';
import { traerTodo, useCarga, useRol } from '../lib/datos';
import { N, fechaHora } from '../lib/formato';
import { normNombre } from '../lib/manifiesto';
import { DESDE, ESQUEMA_VACIO, REQUERIDO, TONO_TRAMITE, aPlazo, aTramite, esActivo, faltantesDe, hayTabla, leerEsquema, puedeEditarDoc, semaforo, useAhora } from '../lib/documental';
import type { Plazo, Tramite } from '../lib/documental';
import { CuentaRegresiva, FaltaAplicar, porVencimiento } from '../lib/PiezasDoc';
import { Boton, Campo, Chip, ErrorCaja, Estado, Hoja, Metrica, Numero, Pantalla, Segmentos, Tarjeta, confirmar, useOperacion } from '../lib/ui';

/**
 * TRÁMITES — todos los trámites de la DIAN de todos los vuelos con semáforo y cuenta regresiva,
 * y el editor de los plazos (nada de plazos escritos en código: se cambian aquí).
 * Cortex no presenta nada ante la DIAN: aquí se ve qué toca presentar y cuándo vence.
 */

type Filtro = 'activos' | 'vencidos' | 'presentados' | 'todos';

const irA = (screen: string, prefill?: Record<string, string | number>) => void cortex.nav.go({ screen, prefill }).catch(() => undefined);

interface Datos {
  esq: Awaited<ReturnType<typeof leerEsquema>>;
  tramites: Tramite[];
  plazos: Plazo[];
}

async function cargar(): Promise<Datos> {
  const esq = await leerEsquema();
  const [ts, ps] = await Promise.all([
    hayTabla(esq, 'tramites_dian') ? traerTodo('tramites_dian', { order: { field: 'created_at', dir: 'desc' } }, 1000).catch(() => []) : Promise.resolve([]),
    hayTabla(esq, 'plazos_dian') ? traerTodo('plazos_dian', {}, 200).catch(() => []) : Promise.resolve([]),
  ]);
  return { esq, tramites: ts.map(aTramite), plazos: ps.map(aPlazo) };
}

export default function Tramites() {
  const { rol } = useRol();
  const { data, loading, error, refresh } = useCarga(cargar, [], 30_000);
  const ahora = useAhora(15_000);
  const [filtro, setFiltro] = useState<Filtro>('activos');
  const [q, setQ] = useState('');
  const [plazo, setPlazo] = useState<Plazo | 'nuevo' | null>(null);
  const puede = puedeEditarDoc(rol);

  const esq = data?.esq ?? ESQUEMA_VACIO;
  const faltan = faltantesDe(esq, { tramites_dian: REQUERIDO.tramites_dian ?? [], plazos_dian: REQUERIDO.plazos_dian ?? [] });
  const avisar = useMemo(() => new Map((data?.plazos ?? []).map((p) => [normNombre(p.tramite), p.avisarHorasAntes])), [data]);
  const horasAviso = (t: Tramite) => avisar.get(normNombre(t.tramite)) ?? 3;

  const todos = data?.tramites ?? [];
  const estado = (t: Tramite) => semaforo(t, ahora, horasAviso(t));
  const vencidos = todos.filter((t) => esActivo(t) && estado(t).vencido);
  const porVencer = todos.filter((t) => esActivo(t) && estado(t).porVencer);
  const activos = todos.filter(esActivo);
  const presentados = todos.filter((t) => t.estado === 'Presentado');

  const lista = useMemo(() => {
    const qn = normNombre(q);
    const base = filtro === 'activos' ? activos : filtro === 'vencidos' ? vencidos : filtro === 'presentados' ? presentados : todos;
    return base.filter((t) => !qn || normNombre(`${t.vuelo} ${t.tramite} ${t.radicado}`).includes(qn)).sort(filtro === 'presentados' || filtro === 'todos' ? (a, b) => (b.venceMs ?? 0) - (a.venceMs ?? 0) : porVencimiento);
    // biome-ignore lint/correctness/useExhaustiveDependencies: depende de `ahora` a través de los filtros.
  }, [todos, filtro, q, ahora]);

  return (
    <Pantalla
      titulo="Trámites DIAN"
      sub="Qué hay que presentar, de qué vuelo y cuánto falta. Cortex no envía nada a la DIAN: tú lo cargas en MUISCA."
    >
      <FaltaAplicar faltan={faltan} />

      <div className="oc-kpis">
        <Metrica etiqueta="Vencidos" valor={vencidos.length} tono={vencidos.length ? 'bad' : undefined} />
        <Metrica etiqueta="Por vencer" valor={porVencer.length} tono={porVencer.length ? 'warn' : undefined} pista="Dentro de su ventana de aviso" />
        <Metrica etiqueta="Activos" valor={activos.length} tono="info" />
        <Metrica etiqueta="Presentados" valor={presentados.length} tono="good" />
      </div>

      <div className="oc-sec">
        <div className="oc-form" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <Segmentos
              valor={filtro}
              onChange={setFiltro}
              opciones={[
                { id: 'activos', texto: 'Activos' },
                { id: 'vencidos', texto: 'Vencidos' },
                { id: 'presentados', texto: 'Presentados' },
                { id: 'todos', texto: 'Todos' },
              ]}
            />
            <div style={{ flex: '1 1 200px', position: 'relative', maxWidth: 340 }}>
              <input type="search" placeholder="Buscar vuelo, trámite o radicado" value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 38 }} />
              <Search size={16} style={{ position: 'absolute', left: 12, top: 15, color: 'var(--suave)' }} />
            </div>
          </div>
        </div>

        <Estado
          cargando={loading}
          error={error}
          vacio={!lista.length}
          tituloVacio={filtro === 'vencidos' ? 'Nada vencido' : 'No hay trámites con ese filtro'}
          textoVacio={<p>Los trámites se crean solos cuando un vuelo aterriza o termina el descargue.</p>}
          reintentar={() => void refresh()}
        >
          <ul className="oc-lista">
            {lista.map((t) => {
              const s = estado(t);
              return (
                <li key={t.id} className={`oc-item ${s.vencido ? 'bad' : s.porVencer ? 'hot' : ''}`}>
                  <div className="oc-item-top">
                    <span>
                      <strong>{t.tramite}</strong> <span className="oc-sub">· {t.vuelo || 'Sin vuelo'}</span>
                    </span>
                    <span className="oc-chips">
                      <CuentaRegresiva t={t} ahora={ahora} avisarHoras={horasAviso(t)} />
                      <Chip tono={s.vencido && esActivo(t) ? 'bad' : TONO_TRAMITE[t.estado] ?? 'neutral'}>{s.vencido && esActivo(t) ? 'Vencido' : t.estado}</Chip>
                    </span>
                  </div>
                  <div className="oc-meta">
                    {t.desdeEvento ? <span>Desde: {t.desdeEvento}</span> : null}
                    {t.inicio ? <span>Inicio {fechaHora(t.inicio)}</span> : null}
                    {t.vence ? <span>Vence {fechaHora(t.vence)}</span> : null}
                    {t.radicado ? <span>Radicado {t.radicado}</span> : null}
                    {t.presentadoPor ? <span>Presentó {t.presentadoPor}</span> : null}
                  </div>
                  <div className="oc-btns">
                    {t.vueloId ? (
                      <Boton chico onClick={() => irA('vuelo', { vuelo: t.vueloId })} icono={<Plane size={15} />}>
                        Abrir vuelo
                      </Boton>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </Estado>
      </div>

      {hayTabla(esq, 'plazos_dian') ? (
        <div className="oc-sec">
          <h2>Plazos configurables</h2>
          <Tarjeta
            derecha={
              puede ? (
                <Boton chico onClick={() => setPlazo('nuevo')} icono={<Plus size={15} />}>
                  Nuevo plazo
                </Boton>
              ) : undefined
            }
            titulo={`${data?.plazos.length ?? 0} plazos`}
          >
            {!data?.plazos.length ? (
              <p className="oc-sub">Todavía no hay plazos. Sin ellos no se crean trámites.</p>
            ) : (
              <ul className="oc-lista">
                {data.plazos.map((p) => (
                  <li key={p.id} className="oc-item">
                    <div className="oc-item-top">
                      <strong>{p.tramite}</strong>
                      <span className="oc-chips">
                        <Chip tono={p.activo ? 'good' : 'quiet'}>{p.activo ? 'Activo' : 'Apagado'}</Chip>
                        {puede ? <Boton chico tono="suave" aria-label="Editar plazo" onClick={() => setPlazo(p)} icono={<Pencil size={15} />} /> : null}
                      </span>
                    </div>
                    <div className="oc-meta">
                      <span>
                        {p.horas} h desde «{p.desde || '—'}»
                      </span>
                      <span>Aviso {p.avisarHorasAntes} h antes</span>
                    </div>
                    {p.descripcion ? <p className="oc-sub">{p.descripcion}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </Tarjeta>
        </div>
      ) : null}

      {plazo ? (
        <FormPlazo
          plazo={plazo === 'nuevo' ? null : plazo}
          onCerrar={() => setPlazo(null)}
          onGuardado={async () => {
            setPlazo(null);
            await refresh();
          }}
        />
      ) : null}
    </Pantalla>
  );
}

function FormPlazo({ plazo, onCerrar, onGuardado }: { plazo: Plazo | null; onCerrar: () => void; onGuardado: () => void | Promise<void> }) {
  const [f, setF] = useState({
    tramite: plazo?.tramite ?? '',
    desde: plazo?.desde || 'Llegada',
    horas: plazo ? String(plazo.horas) : '',
    aviso: plazo ? String(plazo.avisarHorasAntes) : '',
    activo: plazo ? plazo.activo : true,
    descripcion: plazo?.descripcion ?? '',
  });
  const op = useOperacion();
  const falta = !f.tramite.trim() ? 'Escribe el nombre del trámite.' : !f.horas || N(f.horas) <= 0 ? 'Escribe las horas del plazo.' : '';

  const guardar = async () => {
    const valores = {
      tramite: f.tramite.trim(),
      desde: f.desde,
      horas: N(f.horas),
      avisar_horas_antes: f.aviso ? N(f.aviso) : 0,
      activo: f.activo ? 'Sí' : 'No',
      descripcion: f.descripcion.trim(),
    };
    const ok = await op.correr(async () => {
      if (plazo) await cortex.tables.update('plazos_dian', plazo.id, valores);
      else await cortex.tables.insert('plazos_dian', valores);
    }, plazo ? 'Plazo actualizado.' : 'Plazo creado.');
    if (ok) await onGuardado();
  };

  return (
    <Hoja titulo={plazo ? `Plazo: ${plazo.tramite}` : 'Nuevo plazo'} onCerrar={onCerrar}>
      <div className="oc-form">
        <Campo etiqueta="Trámite">
          <input type="text" value={f.tramite} onChange={(e) => setF({ ...f, tramite: e.target.value })} />
        </Campo>
        <Campo etiqueta="El reloj arranca desde" ayuda="El evento del vuelo desde el que se cuentan las horas.">
          <select value={f.desde} onChange={(e) => setF({ ...f, desde: e.target.value })}>
            {DESDE.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </Campo>
        <div className="oc-fila2">
          <Campo etiqueta="Plazo (horas)">
            <Numero valor={f.horas} onChange={(v) => setF({ ...f, horas: v })} />
          </Campo>
          <Campo etiqueta="Avisar (horas antes)">
            <Numero valor={f.aviso} onChange={(v) => setF({ ...f, aviso: v })} />
          </Campo>
        </div>
        <Campo etiqueta="Estado">
          <Segmentos valor={f.activo ? 'si' : 'no'} onChange={(v) => setF({ ...f, activo: v === 'si' })} opciones={[{ id: 'si', texto: 'Activo' }, { id: 'no', texto: 'Apagado' }]} />
        </Campo>
        <Campo etiqueta="Qué es y dónde se hace">
          <textarea value={f.descripcion} onChange={(e) => setF({ ...f, descripcion: e.target.value })} />
        </Campo>
        {falta ? <p className="oc-sub">{falta}</p> : null}
        {op.error ? <ErrorCaja mensaje={op.error} /> : null}
        <Boton
          tono="primario"
          disabled={op.ocupado || !!falta}
          onClick={async () => {
            if (plazo && !plazo.activo !== !f.activo && !f.activo && !(await confirmar('Al apagar el plazo ya no se crearán trámites nuevos con él.', 'Apagar'))) return;
            await guardar();
          }}
        >
          {op.ocupado ? 'Guardando…' : 'Guardar'}
        </Boton>
      </div>
    </Hoja>
  );
}
