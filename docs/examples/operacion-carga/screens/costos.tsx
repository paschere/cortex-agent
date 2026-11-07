import { useMemo, useState } from 'react';
import { cortex } from '@cortex/app-sdk';
import { Download, Pencil, Plus, Wallet } from 'lucide-react';
import { exportarCsv } from '../lib/csv';
import { aAtencion, aEquipo, aEvento, aTarifa, aVuelo, traerTodo, useCarga, useOpciones } from '../lib/datos';
import type { Atencion, Equipo, Evento, Tarifa, Vuelo } from '../lib/datos';
import { Area, Barras } from '../lib/graficos';
import { EQUIPOS_TARIFA, PROVEEDORES, TONO_COSTO, tono } from '../lib/estados';
import { N, cop, dinero, fechaCorta, hhmm, num } from '../lib/formato';
import { hoyBogota, inicioMes, sumarDias } from '../lib/tiempo';
import { PanelTareas } from '../lib/PiezasTareas';
import { cargarTareas } from '../lib/tareas';
import type { Tarea } from '../lib/tareas';
import { Boton, Campo, Chip, ErrorCaja, Delta, Estado, Frase, Hoja, Metrica, Numero, Pantalla, Segmentos, Tabla, Tarjeta, avisar, useOperacion } from '../lib/ui';

/**
 * COSTOS — por pagar a proveedores (Probable → Aprobado → Anulado), tarifario editable,
 * costo por vuelo / aerolínea / proveedor y exportar a Excel (CSV con tildes).
 */

interface Datos {
  equipos: Equipo[];
  eventos: Evento[];
  atenciones: Atencion[];
  vuelos: Vuelo[];
  tarifas: Tarifa[];
  tareas: Tarea[];
}

async function cargar(): Promise<Datos> {
  const [es, ev, as, vs, ts, tareas] = await Promise.all([
    traerTodo('equipos_usados', { order: { field: 'created_at', dir: 'desc' } }, 1500),
    traerTodo('eventos_operacion', { order: { field: 'created_at', dir: 'desc' } }, 1000),
    traerTodo('atenciones', { order: { field: 'created_at', dir: 'desc' } }, 1000),
    traerTodo('vuelos', { order: { field: 'fecha', dir: 'desc' } }, 1000),
    traerTodo('tarifas_proveedores', {}, 600),
    cargarTareas(1000),
  ]);
  return { equipos: es.map(aEquipo), eventos: ev.map(aEvento), atenciones: as.map(aAtencion), vuelos: vs.map(aVuelo), tarifas: ts.map(aTarifa), tareas };
}

type Pestana = 'pagar' | 'vuelos' | 'tareas' | 'tarifario' | 'exportar';

export default function Costos() {
  const { data, loading, error, refresh } = useCarga(cargar, [], 60_000);
  const [tab, setTab] = useState<Pestana>('pagar');
  return (
    <Pantalla titulo="Costos" sub="Lo que se debe a proveedores, el tarifario y lo que cuesta cada vuelo.">
      <div style={{ marginBottom: 18 }}>
        <Segmentos
          valor={tab}
          onChange={setTab}
          opciones={[{ id: 'pagar', texto: 'Por pagar' }, { id: 'vuelos', texto: 'Por vuelo' }, { id: 'tareas', texto: 'Tareas' }, { id: 'tarifario', texto: 'Tarifario' }, { id: 'exportar', texto: 'Exportar' }]}
        />
      </div>
      <Estado cargando={loading} error={error} vacio={!data} tituloVacio="Sin datos" reintentar={() => void refresh()}>
        {data ? (
          tab === 'pagar' ? <PorPagar d={data} /> : tab === 'vuelos' ? <PorVuelo d={data} /> : tab === 'tareas' ? <PanelTareas tareas={data.tareas} /> : tab === 'tarifario' ? <Tarifario d={data} onCambio={refresh} /> : <Exportar d={data} />
        ) : null}
      </Estado>
    </Pantalla>
  );
}

/* ───────────── Por pagar ───────────── */

function PorPagar({ d }: { d: Datos }) {
  const [estado, setEstado] = useState<'todos' | 'Probable' | 'Aprobado' | 'Anulado'>('todos');
  const [prov, setProv] = useState('');
  const conEstado = d.equipos.filter((e) => e.estadoCosto);
  const suma = (xs: Equipo[]) => xs.reduce((s, e) => s + e.porPagar, 0);
  const probable = suma(conEstado.filter((e) => e.estadoCosto === 'Probable'));
  const aprobado = suma(conEstado.filter((e) => e.estadoCosto === 'Aprobado'));
  const hoy = hoyBogota();
  const mesAct = hoy.slice(0, 7);
  const finPrev = sumarDias(inicioMes(hoy), -1);
  const diaTope = Math.min(Number(hoy.slice(8)), Number(finPrev.slice(8)));
  const enMes = (e: Equipo, mes: string, tope?: number) => e.creado.slice(0, 7) === mes && (!tope || Number(e.creado.slice(8, 10)) <= tope);
  const mesActual = suma(conEstado.filter((e) => e.estadoCosto !== 'Anulado' && enMes(e, mesAct)));
  const mesPrevio = suma(conEstado.filter((e) => e.estadoCosto !== 'Anulado' && enMes(e, finPrev.slice(0, 7), diaTope)));
  const gastos = d.eventos.filter((e) => e.costo > 0);
  const totalGastos = gastos.reduce((s, e) => s + e.costo, 0);

  const porProv = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of conEstado.filter((x) => x.estadoCosto !== 'Anulado')) m.set(e.proveedor || 'Sin proveedor', (m.get(e.proveedor || 'Sin proveedor') ?? 0) + e.porPagar);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([etiqueta, valor]) => ({ etiqueta, valor }));
  }, [conEstado]);
  const porAt = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of conEstado.filter((x) => x.estadoCosto !== 'Anulado')) m.set(e.atencion || 'Sin atención', (m.get(e.atencion || 'Sin atención') ?? 0) + e.porPagar);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([etiqueta, valor]) => ({ etiqueta, valor }));
  }, [conEstado]);

  const proveedores = [...new Set(conEstado.map((e) => e.proveedor).filter(Boolean))].sort();
  const lista = conEstado.filter((e) => (estado === 'todos' || e.estadoCosto === estado) && (!prov || e.proveedor === prov));

  return (
    <>
      <Frase icono={<Wallet size={20} />} tono={probable > 0 ? 'warn' : 'good'}>
        Se deben <b>{cop(probable + aprobado)}</b> a proveedores
        {probable > 0 ? <>, de los cuales <b>{cop(probable)}</b> {probable === probable + aprobado ? 'todavía' : 'aún'} no están aprobados</> : ', todo aprobado'}
        {mesPrevio > 0 ? <>. Este mes llevan <b>{cop(mesActual)}</b> ({mesActual >= mesPrevio ? '+' : '−'}{Math.abs(Math.round(((mesActual - mesPrevio) / mesPrevio) * 100))} % frente al mes pasado a la misma fecha)</> : null}.
      </Frase>
      <div className="oc-kpis oc-kpis-q">
        <Metrica etiqueta="¿Cuánto debemos pagar?" valor={cop(probable + aprobado)} pista={<><span>Probable + aprobado</span><br /><Delta actual={mesActual} previo={mesPrevio || null} mejorSiBaja /></>} />
        <Metrica etiqueta="¿Cuánto falta por aprobar?" valor={cop(probable)} tono={probable ? 'warn' : 'good'} pista="Equipos en estado probable" />
        <Metrica etiqueta="¿Cuánto ya está aprobado?" valor={cop(aprobado)} tono="good" />
        <Metrica etiqueta="¿Cuánto salió en gastos de eventos?" valor={cop(totalGastos)} pista="Combustible, arreglos…" />
      </div>

      <div className="oc-grid oc-g2 oc-sec">
        <Tarjeta titulo="Por pagar por proveedor">
          {porProv.length ? <Barras datos={porProv} formato={cop} /> : <p className="oc-sub">Sin costos de equipos todavía.</p>}
        </Tarjeta>
        <Tarjeta titulo="Por pagar por atención">
          {porAt.length ? <Barras datos={porAt} formato={cop} /> : <p className="oc-sub">Sin costos de equipos todavía.</p>}
        </Tarjeta>
      </div>

      <div className="oc-sec">
        <h2 style={{ marginBottom: 12 }}>Equipos usados</h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <Segmentos valor={estado} onChange={setEstado} opciones={[{ id: 'todos', texto: 'Todos' }, { id: 'Probable', texto: 'Probable' }, { id: 'Aprobado', texto: 'Aprobado' }, { id: 'Anulado', texto: 'Anulado' }]} />
          <div style={{ maxWidth: 220 }}>
            <select value={prov} onChange={(e) => setProv(e.target.value)} aria-label="Proveedor">
              <option value="">Todos los proveedores</option>
              {proveedores.map((p) => <option key={p}>{p}</option>)}
            </select>
          </div>
        </div>
        {!lista.length ? (
          <div className="oc-vacio"><strong>Nada por pagar con ese filtro</strong>Los equipos aparecen aquí cuando un operario cierra una atención.</div>
        ) : (
          <Tabla columnas={[{ t: 'Atención' }, { t: 'Equipo' }, { t: 'Proveedor' }, { t: 'Cant.', n: true }, { t: 'Tarifa', n: true }, { t: 'Por pagar', n: true }, { t: 'Estado' }]}>
            {lista.slice(0, 200).map((e) => (
              <tr key={e.id} className={e.estadoCosto === 'Anulado' ? 'sin' : ''}>
                <td>{e.atencion}</td>
                <td>{e.equipo}</td>
                <td>{e.proveedor}</td>
                <td className="n">{num(e.cantidad)}</td>
                <td className="n">{dinero(e.tarifa, e.moneda)}</td>
                <td className="n"><b>{cop(e.porPagar)}</b></td>
                <td><Chip tono={tono(TONO_COSTO, e.estadoCosto)}>{e.estadoCosto}</Chip></td>
              </tr>
            ))}
          </Tabla>
        )}
      </div>

      <div className="oc-sec">
        <h2 style={{ marginBottom: 12 }}>Gastos de eventos</h2>
        {!gastos.length ? (
          <div className="oc-vacio"><strong>Sin gastos de eventos</strong>Los tanqueos y arreglos con costo aparecen aquí.</div>
        ) : (
          <Tabla columnas={[{ t: 'Fecha' }, { t: 'Tipo' }, { t: 'Equipo' }, { t: 'Proveedor' }, { t: 'Costo', n: true }, { t: 'Vuelo' }, { t: 'Operario' }]}>
            {gastos.slice(0, 100).map((e) => (
              <tr key={e.id}>
                <td>{fechaCorta(e.fecha)}</td><td>{e.tipo}</td><td>{e.equipo}</td><td>{e.proveedor}</td>
                <td className="n"><b>{cop(e.costo)}</b></td><td>{e.vuelo}</td><td>{e.operario}</td>
              </tr>
            ))}
          </Tabla>
        )}
      </div>
    </>
  );
}

/* ───────────── Por vuelo / aerolínea / proveedor ───────────── */

function PorVuelo({ d }: { d: Datos }) {
  const [por, setPor] = useState<'vuelo' | 'aerolinea' | 'proveedor' | 'dia'>('vuelo');
  const vueloDe = useMemo(() => new Map(d.vuelos.map((v) => [v.id, v])), [d.vuelos]);
  const filas = useMemo(() => {
    const m = new Map<string, number>();
    const sumar = (k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
    if (por === 'proveedor') {
      for (const e of d.equipos.filter((x) => x.estadoCosto !== 'Anulado')) sumar(e.proveedor || 'Sin proveedor', e.costoCop || e.porPagar);
    } else {
      for (const a of d.atenciones.filter((x) => x.estado !== 'Rechazada')) {
        const v = vueloDe.get(a.vueloId);
        sumar(por === 'vuelo' ? a.vuelo : por === 'aerolinea' ? v?.aerolinea || 'Sin aerolínea' : (v?.fecha ?? a.fecha ?? 'Sin fecha').slice(0, 10), a.costoEquipos);
      }
    }
    const arr = [...m.entries()].map(([etiqueta, valor]) => ({ etiqueta, valor }));
    return por === 'dia' ? arr.sort((a, b) => a.etiqueta.localeCompare(b.etiqueta)).slice(-30).map((x) => ({ ...x, etiqueta: x.etiqueta.slice(8) })) : arr.sort((a, b) => b.valor - a.valor);
  }, [d, por, vueloDe]);
  const total = filas.reduce((s, f) => s + f.valor, 0);
  return (
    <>
      <div className="oc-kpis" style={{ marginBottom: 18 }}>
        <Metrica etiqueta="Costo de equipos" valor={cop(total)} />
        <Metrica etiqueta="Atenciones con costo" valor={d.atenciones.filter((a) => a.costoEquipos > 0).length} />
      </div>
      <Segmentos valor={por} onChange={setPor} opciones={[{ id: 'vuelo', texto: 'Por vuelo' }, { id: 'aerolinea', texto: 'Por aerolínea' }, { id: 'proveedor', texto: 'Por proveedor' }, { id: 'dia', texto: 'Por día' }]} />
      <div style={{ marginTop: 16 }}>
        <Tarjeta>
          {!filas.length || total === 0 ? (
            <p className="oc-sub">Todavía no hay costos para agrupar.</p>
          ) : por === 'dia' ? (
            <Area datos={filas} formato={cop} />
          ) : (
            <Barras datos={filas.slice(0, 20)} formato={cop} />
          )}
        </Tarjeta>
      </div>
    </>
  );
}

/* ───────────── Tarifario ───────────── */

function Tarifario({ d, onCambio }: { d: Datos; onCambio: () => Promise<void> }) {
  const [q, setQ] = useState('');
  const [editar, setEditar] = useState<Tarifa | 'nueva' | null>(null);
  const lista = d.tarifas.filter((t) => !q.trim() || `${t.equipo} ${t.proveedor}`.toLowerCase().includes(q.trim().toLowerCase())).sort((a, b) => a.equipo.localeCompare(b.equipo) || a.proveedor.localeCompare(b.proveedor));
  return (
    <>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14, justifyContent: 'space-between' }}>
        <div style={{ flex: '1 1 220px', maxWidth: 340 }}><input type="search" placeholder="Buscar equipo o proveedor" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Boton tono="primario" onClick={() => setEditar('nueva')} icono={<Plus size={18} />}>Nueva tarifa</Boton>
      </div>
      {!lista.length ? (
        <div className="oc-vacio"><strong>{d.tarifas.length ? 'Ninguna tarifa coincide' : 'El tarifario está vacío'}</strong>Agrega la primera con «Nueva tarifa».</div>
      ) : (
        <Tabla columnas={[{ t: 'Equipo' }, { t: 'Proveedor' }, { t: 'Moneda' }, { t: 'Tarifa', n: true }, { t: '' }]}>
          {lista.map((t) => (
            <tr key={t.id}>
              <td><b>{t.equipo}</b></td><td>{t.proveedor}</td><td>{t.moneda}</td>
              <td className="n"><b>{dinero(t.tarifa, t.moneda)}</b></td>
              <td><Boton chico tono="suave" onClick={() => setEditar(t)} aria-label="Editar" icono={<Pencil size={15} />} /></td>
            </tr>
          ))}
        </Tabla>
      )}
      {editar ? <FormTarifa t={editar === 'nueva' ? null : editar} onCerrar={() => setEditar(null)} onListo={async () => { setEditar(null); await onCambio(); }} /> : null}
    </>
  );
}

function FormTarifa({ t, onCerrar, onListo }: { t: Tarifa | null; onCerrar: () => void; onListo: () => void | Promise<void> }) {
  const equipos = useOpciones('tarifas_proveedores', 'equipo', EQUIPOS_TARIFA);
  const provs = useOpciones('tarifas_proveedores', 'proveedor', PROVEEDORES);
  const monedas = useOpciones('tarifas_proveedores', 'moneda', ['USD', 'COP']);
  const [equipo, setEquipo] = useState(t?.equipo ?? '');
  const [prov, setProv] = useState(t?.proveedor ?? '');
  const [moneda, setMoneda] = useState(t?.moneda ?? 'COP');
  const [valor, setValor] = useState(t ? String(t.tarifa) : '');
  const op = useOperacion();
  return (
    <Hoja titulo={t ? 'Editar tarifa' : 'Nueva tarifa'} onCerrar={onCerrar}>
      <div className="oc-form">
        <Campo etiqueta="Equipo o servicio"><select value={equipo} onChange={(e) => setEquipo(e.target.value)}><option value="">Elige…</option>{equipos.map((x) => <option key={x}>{x}</option>)}</select></Campo>
        <Campo etiqueta="Proveedor"><select value={prov} onChange={(e) => setProv(e.target.value)}><option value="">Elige…</option>{provs.map((x) => <option key={x}>{x}</option>)}</select></Campo>
        <div className="oc-fila2">
          <Campo etiqueta="Moneda"><select value={moneda} onChange={(e) => setMoneda(e.target.value)}>{monedas.map((x) => <option key={x}>{x}</option>)}</select></Campo>
          <Campo etiqueta="Tarifa unitaria"><Numero valor={valor} onChange={setValor} /></Campo>
        </div>
        {op.error ? <ErrorCaja mensaje={op.error} /> : null}
        <Boton tono="primario" disabled={op.ocupado || !equipo || !prov || !valor.trim()} onClick={async () => {
          const v = { equipo, proveedor: prov, moneda, tarifa: N(valor) };
          const ok = await op.correr(() => (t ? cortex.tables.update('tarifas_proveedores', t.id, v) : cortex.tables.insert('tarifas_proveedores', v)), 'Tarifa guardada.');
          if (ok) await onListo();
        }}>{op.ocupado ? 'Guardando…' : 'Guardar tarifa'}</Boton>
      </div>
    </Hoja>
  );
}

/* ───────────── Exportar ───────────── */

function Exportar({ d }: { d: Datos }) {
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const descargas: { id: string; titulo: string; detalle: string; n: number; armar: () => [string[], (string | number)[][]] }[] = [
    {
      id: 'atenciones', titulo: 'Atenciones', detalle: 'Vuelo, operario, estado, kilos, pallets y costo de equipos', n: d.atenciones.length,
      armar: () => [['Vuelo', 'Operario', 'Estado', 'Fecha', 'Hora inicio', 'Hora fin', 'Kilos esperados', 'Kilos recibidos', 'Pallets recibidos', 'Fuera de margen', 'Fuera de zona', 'Costo equipos (COP)'],
        d.atenciones.map((a) => [a.vuelo, a.operario, a.estado, a.fecha, hhmm(a.horaInicio), hhmm(a.horaFin), a.kilosEsp, a.kilosRec ?? '', a.palletsRec ?? '', a.fueraDeMargen ? 'Sí' : 'No', a.fueraDeZona ? 'Sí' : 'No', a.costoEquipos])],
    },
    {
      id: 'vuelos', titulo: 'Vuelos', detalle: 'Número, fecha, aerolínea, estado, esperado y recibido, tiempos', n: d.vuelos.length,
      armar: () => [['Vuelo', 'Fecha', 'Hora estimada', 'Aerolínea', 'Origen', 'Estado', 'Kilos esperados', 'Kilos recibidos', 'Pallets esperados', 'Pallets recibidos', 'Min aviso a toma', 'Min atención', 'Min total'],
        d.vuelos.map((v) => [v.numero, v.fecha, hhmm(v.hora), v.aerolinea, v.origen, v.estado, v.kilosEsp, v.kilosRec ?? '', v.palletsEsp, v.palletsRec ?? '', v.minToma ?? '', v.minAtencion ?? '', v.minTotal ?? ''])],
    },
    {
      id: 'equipos', titulo: 'Equipos por pagar', detalle: 'Equipo, proveedor, cantidad, tarifa, por pagar y estado', n: d.equipos.length,
      armar: () => [['Atención', 'Equipo', 'Proveedor', 'Cantidad', 'Moneda', 'Tarifa', 'Por pagar (COP)', 'Estado del costo'],
        d.equipos.map((e) => [e.atencion, e.equipo, e.proveedor, e.cantidad, e.moneda, e.tarifa, e.porPagar, e.estadoCosto])],
    },
    {
      id: 'gastos', titulo: 'Gastos de eventos', detalle: 'Tanqueos, arreglos y otros eventos con costo', n: d.eventos.filter((e) => e.costo > 0).length,
      armar: () => [['Fecha', 'Tipo', 'Equipo', 'Proveedor', 'Costo (COP)', 'Vuelo', 'Operario', 'Descripción'],
        d.eventos.filter((e) => e.costo > 0).map((e) => [e.fecha, e.tipo, e.equipo, e.proveedor, e.costo, e.vuelo, e.operario, e.descripcion])],
    },
    {
      id: 'tareas', titulo: 'Tareas', detalle: 'Tipo, quién, desde y hasta, tiempo y costo de cada tarea', n: d.tareas.length,
      armar: () => [['Tarea', 'Tipo', 'Estado', 'Asignados', 'Desde', 'Hasta', 'Vuelo', 'Inicio', 'Fin', 'Duración (min)', 'Equipos (COP)', 'Otros (COP)', 'Total (COP)'],
        d.tareas.map((t) => [t.titulo, t.tipo, t.estado, t.asignados, t.desde, t.hasta, t.vuelo, t.inicio, t.fin, t.duracionMin ?? '', t.costoEquipos, t.costoOtros, t.costoTotal])],
    },
    {
      id: 'tarifas', titulo: 'Tarifario', detalle: 'Tarifas por equipo y proveedor', n: d.tarifas.length,
      armar: () => [['Equipo', 'Proveedor', 'Moneda', 'Tarifa'], d.tarifas.map((t) => [t.equipo, t.proveedor, t.moneda, t.tarifa])],
    },
  ];
  return (
    <>
      <p className="oc-sub" style={{ marginBottom: 14 }}>Se descarga un archivo CSV que Excel abre directo, con tildes y separado por «;».</p>
      {error ? <ErrorCaja mensaje={error} /> : null}
      <div className="oc-grid oc-g2" style={{ marginTop: error ? 14 : 0 }}>
        {descargas.map((x) => (
          <Tarjeta key={x.id} titulo={x.titulo}>
            <p className="oc-sub" style={{ marginBottom: 12 }}>{x.detalle}. {num(x.n)} filas.</p>
            <Boton
              disabled={!x.n || ocupado !== null}
              icono={<Download size={17} />}
              onClick={async () => {
                setOcupado(x.id);
                setError(null);
                try {
                  const [cols, filas] = x.armar();
                  await exportarCsv(`operacion-${x.id}`, cols, filas);
                  avisar('Archivo descargado.');
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'No se pudo descargar.');
                } finally {
                  setOcupado(null);
                }
              }}
            >
              {ocupado === x.id ? 'Preparando…' : x.n ? 'Descargar para Excel' : 'Sin datos'}
            </Boton>
          </Tarjeta>
        ))}
      </div>
    </>
  );
}

