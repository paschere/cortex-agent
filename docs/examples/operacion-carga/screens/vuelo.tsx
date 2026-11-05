import { useCallback, useEffect, useMemo, useState } from 'react';
import { cortex } from '@cortex/app-sdk';
import { ArrowLeft, FileText, Pencil, Plus, Search } from 'lucide-react';
import {
  T,
  aAtencion,
  aEquipo,
  aEvento,
  aGuia,
  aPrealerta,
  aVuelo,
  cargarVuelos,
  porRelacion,
  traerTodo,
  useAcciones,
  useCarga,
} from '../lib/datos';
import type { Atencion, Equipo, Evento, Guia, Prealerta, Vuelo } from '../lib/datos';
import { ManifiestoInteligente } from '../lib/ManifiestoInteligente';
import { Etapas, TarjetaEmbarque } from '../lib/Piezas';
import { PARCIALES, TIPOS_GUIA, TONO_ATENCION, TONO_EVENTO, TONO_ETAPA, TONO_VUELO, fueraDeMargen, tono } from '../lib/estados';
import type { Tono } from '../lib/estados';
import { N, cop, dinero, fechaCorta, hay, hhmm, kg, minTxt, num } from '../lib/formato';
import { prealertasDelVuelo } from '../lib/manifiesto';
import { parametro } from '../lib/ruta';
import {
  Adjuntos,
  Boton,
  Campo,
  Chip,
  ES_VIVO,
  ErrorCaja,
  Estado,
  Hoja,
  Numero,
  Pantalla,
  SelectorArchivo,
  Tabla,
  Tarjeta,
  confirmar,
  subirArchivo,
  useOperacion,
} from '../lib/ui';
import { Medidor } from '../lib/Piezas';

/**
 * VUELO — detalle de un vuelo: tarjeta de embarque, esperado vs recibido, guías,
 * prealertas cruzadas, documentos, atención y equipos, eventos y línea de tiempo.
 * El manifiesto inteligente convierte una foto o PDF en las guías del vuelo.
 */

interface Todo {
  vuelo: Vuelo;
  guias: Guia[];
  atenciones: Atencion[];
  equipos: Equipo[];
  eventos: Evento[];
  prealertas: Prealerta[];
}

async function cargar(id: string): Promise<Todo> {
  const fila = await cortex.tables.get('vuelos', id);
  const [gs, as, ev, pre] = await Promise.all([
    porRelacion('prefacturacion', 'vuelo', id),
    porRelacion('atenciones', 'vuelo', id),
    porRelacion('eventos_operacion', 'vuelo', id),
    traerTodo('prealertas', { order: { field: 'created_at', dir: 'desc' } }, 1000).catch(() => []),
  ]);
  const atenciones = as.map(aAtencion);
  let equipos: Equipo[] = [];
  if (atenciones.length) {
    const ids = new Set(atenciones.map((a) => a.id));
    const todos = await traerTodo('equipos_usados', { order: { field: 'created_at', dir: 'desc' } }, 1000).catch(() => []);
    equipos = todos.map(aEquipo).filter((e) => ids.has(e.atencionId));
  }
  return {
    vuelo: aVuelo(fila),
    guias: gs.map(aGuia),
    atenciones,
    equipos,
    eventos: ev.map(aEvento),
    prealertas: pre.map(aPrealerta),
  };
}

const irA = (screen: string, prefill?: Record<string, string | number>) => void cortex.nav.go({ screen, prefill }).catch(() => undefined);

export default function VueloPantalla() {
  const [id, setId] = useState(parametro('vuelo') || parametro('id'));
  if (!id) return <Selector onElegir={setId} />;
  return <Detalle id={id} onVolver={() => setId('')} />;
}

function Selector({ onElegir }: { onElegir: (id: string) => void }) {
  const { data, loading, error, refresh } = useCarga(() => cargarVuelos(120), []);
  const [q, setQ] = useState('');
  const lista = (data ?? []).filter((v) => !q.trim() || `${v.numero} ${v.aerolinea}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Pantalla titulo="Vuelo" sub="Elige el vuelo que quieres ver.">
      <div style={{ maxWidth: 360, marginBottom: 16 }}>
        <input type="search" placeholder="Buscar vuelo o aerolínea" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Estado cargando={loading} error={error} vacio={!lista.length} tituloVacio="No hay vuelos" textoVacio={<p>Crea uno en la pantalla Vuelos.</p>} reintentar={() => void refresh()}>
        <ul className="oc-lista">
          {lista.map((v) => (
            <li key={v.id} className="oc-item">
              <div className="oc-item-top">
                <span>
                  <b className="oc-mono">{v.numero}</b> <span className="oc-sub">{fechaCorta(v.fecha)} · {v.aerolinea}</span>
                </span>
                <Chip tono={tono(TONO_VUELO, v.estado)} vivo={ES_VIVO.has(v.estado)}>{v.estado}</Chip>
              </div>
              <div className="oc-btns">
                <Boton chico onClick={() => onElegir(v.id)}>Abrir</Boton>
              </div>
            </li>
          ))}
        </ul>
      </Estado>
    </Pantalla>
  );
}

function Detalle({ id, onVolver }: { id: string; onVolver: () => void }) {
  const { data, loading, error, refresh } = useCarga(() => cargar(id), [id], 30_000);
  const acc = useAcciones('vuelos');
  const op = useOperacion();
  const [extra, setExtra] = useState<Prealerta[]>([]);
  const [guiaForm, setGuiaForm] = useState<Guia | 'nueva' | null>(null);
  const [clientes, setClientes] = useState<{ id: string; label: string }[]>([]);
  const [clientesCargados, setClientesCargados] = useState(false);

  const cargarClientes = useCallback(async () => {
    if (clientesCargados) return;
    setClientesCargados(true);
    try {
      const rows = await traerTodo('clientes_facturacion', {}, 1500);
      setClientes(rows.map((r) => ({ id: r.id, label: T(r.values.nombre) || T(r.values.razon_social) || r.label })));
    } catch {
      /* sin clientes no se puede crear: la revisión lo avisa */
    }
  }, [clientesCargados]);

  useEffect(() => {
    void cargarClientes();
  }, [cargarClientes]);

  const v = data?.vuelo;
  const pdv = useMemo(() => (data && v ? prealertasDelVuelo(data.prealertas, v.numero, v.fecha) : []), [data, v]);

  if (error && !data) {
    return (
      <Pantalla titulo="Vuelo" acciones={<Boton onClick={onVolver} icono={<ArrowLeft size={16} />}>Otros vuelos</Boton>}>
        <ErrorCaja mensaje={error} reintentar={() => void refresh()} />
      </Pantalla>
    );
  }
  if (!data || !v) {
    return (
      <Pantalla titulo="Vuelo">
        <Estado cargando={loading} error={error} vacio tituloVacio="No se encontró el vuelo" textoVacio={<p>Puede que lo hayan borrado o que tu rol no lo vea.</p>}>
          <span />
        </Estado>
      </Pantalla>
    );
  }

  const accion = async (clave: string, texto: string, confirma?: string) => {
    if (confirma && !(await confirmar(confirma, texto))) return;
    const ok = await op.correr(() => cortex.tables.action('vuelos', v.id, clave), `${v.numero}: ${texto}`);
    if (ok) await refresh();
  };

  const m = fueraDeMargen({
    kilosEsp: v.kilosEsp,
    kilosRec: v.kilosRec,
    palletsEsp: v.palletsEsp,
    palletsRec: v.palletsRec,
    margenKilosPct: v.margenKilos,
    margenPallets: v.margenPallets,
  });
  const idsGuias = new Set(data.guias.map((g) => g.prealertaId));
  const faltanPre = pdv.filter((p) => !idsGuias.has(p.id) && !data.guias.some((g) => g.guia.replace(/[\s-]/g, '').toUpperCase() === p.guia.replace(/[\s-]/g, '').toUpperCase()));
  const sumaKilosGuias = data.guias.reduce((a, g) => a + g.kilosEsp, 0);

  const botonesEstado = (
    <div className="oc-btns">
      {acc.tiene('en_camino') && ['Programado', 'Demorado'].includes(v.estado) ? (
        <Boton chico disabled={op.ocupado} onClick={() => void accion('en_camino', 'En camino')}>En camino</Boton>
      ) : null}
      {acc.tiene('demorado') && ['Programado', 'En camino'].includes(v.estado) ? (
        <Boton chico tono="aviso" disabled={op.ocupado} onClick={() => void accion('demorado', 'Demorado')}>Demorado</Boton>
      ) : null}
      {acc.tiene('llego') && ['Programado', 'En camino', 'Demorado'].includes(v.estado) ? (
        <Boton chico tono="ok" disabled={op.ocupado} onClick={() => void accion('llego', 'Llegó', `¿Confirmas que ${v.numero} aterrizó? Se avisa a los operarios de turno.`)}>Llegó</Boton>
      ) : null}
    </div>
  );

  return (
    <Pantalla
      titulo={`Vuelo ${v.numero}`}
      sub={`${fechaCorta(v.fecha)} · ${v.aerolinea}`}
      acciones={<Boton onClick={onVolver} icono={<ArrowLeft size={16} />}>Otros vuelos</Boton>}
    >
      {op.error ? <ErrorCaja mensaje={op.error} /> : null}
      <TarjetaEmbarque v={v} acciones={botonesEstado} />
      <div style={{ margin: '16px 0 4px' }}>
        <Etapas estado={v.estado} />
      </div>

      <div className="oc-sec oc-grid oc-g2">
        <Tarjeta titulo="Esperado y recibido">
          <div className="oc-form">
            <Medidor titulo="Kilos" esperado={v.kilosEsp} real={v.kilosRec} margen={(v.kilosEsp * v.margenKilos) / 100} formato={(n) => kg(n)} />
            <Medidor titulo="Pallets" esperado={v.palletsEsp} real={v.palletsRec} margen={v.margenPallets} formato={(n) => num(n)} />
            <dl className="oc-pares">
              <dt>Piezas</dt>
              <dd>
                {num(v.piezasEsp)} esperadas · {v.piezasRec === null ? 'sin registrar' : `${num(v.piezasRec)} recibidas`}
              </dd>
              <dt>Margen</dt>
              <dd>
                {num(v.margenKilos, 1)} % en kilos · {num(v.margenPallets)} pallets
              </dd>
              {m.kilos || m.pallets ? (
                <>
                  <dt>Alerta</dt>
                  <dd className="oc-dif bad">Diferencia fuera del margen</dd>
                </>
              ) : null}
            </dl>
          </div>
        </Tarjeta>

        <Tarjeta titulo="Tiempos y atención">
          <dl className="oc-pares">
            <dt>Aterrizó</dt>
            <dd>{hhmm(v.llegadaHora) || '—'}</dd>
            <dt>Tomado</dt>
            <dd>{v.atendidoPor ? `${hhmm(v.tomadoHora)} · ${v.atendidoPor}` : '—'}</dd>
            <dt>Aviso → toma</dt>
            <dd>{minTxt(v.minToma)}</dd>
            <dt>Atención</dt>
            <dd>{minTxt(v.minAtencion)}</dd>
            <dt>Total</dt>
            <dd>{minTxt(v.minTotal)}</dd>
            <dt>Zona al tomarlo</dt>
            <dd>
              {v.zonaToma || '—'} {v.fueraZonaToma === 'Sí' ? <Chip tono="bad">Fuera de zona</Chip> : null}
            </dd>
          </dl>
          {v.observaciones ? <p className="oc-sub" style={{ marginTop: 10 }}>{v.observaciones}</p> : null}
        </Tarjeta>
      </div>

      <div className="oc-sec">
        <h2>Manifiesto inteligente</h2>
        <Tarjeta>
          <ManifiestoInteligente
            vuelo={v}
            existentes={data.guias}
            prealertas={data.prealertas}
            clientes={clientes}
            extra={extra}
            onExtraUsado={() => setExtra([])}
            onListo={refresh}
          />
        </Tarjeta>
      </div>

      <div className="oc-sec">
        <h2>Guías del vuelo</h2>
        <Tarjeta
          derecha={
            <Boton chico onClick={() => { void cargarClientes(); setGuiaForm('nueva'); }} icono={<Plus size={15} />}>Agregar guía</Boton>
          }
          titulo={`${data.guias.length} guías · ${kg(sumaKilosGuias)}`}
        >
          {!data.guias.length ? (
            <p className="oc-sub">Aún no hay guías. Escanea el manifiesto arriba, pega la lista o agrégalas a mano.</p>
          ) : (
            <Tabla
              columnas={[{ t: 'Guía' }, { t: 'Tipo' }, { t: 'Cliente' }, { t: 'Piezas', n: true }, { t: 'Kilos', n: true }, { t: 'Recibido (kg)', n: true }, { t: 'Etapa' }, { t: '' }]}
              pie={
                <tr>
                  <td colSpan={3}>Total</td>
                  <td className="n">{num(data.guias.reduce((a, g) => a + g.piezasEsp, 0))}</td>
                  <td className="n">{kg(sumaKilosGuias)}</td>
                  <td className="n">{kg(data.guias.reduce((a, g) => a + (g.kilosRec ?? 0), 0))}</td>
                  <td colSpan={2} />
                </tr>
              }
            >
              {data.guias.map((g) => (
                <tr key={g.id}>
                  <td className="oc-mono"><b>{g.guia}</b>{g.madre ? <div className="oc-sub">Madre {g.madre}</div> : null}</td>
                  <td>{g.tipo || '—'}</td>
                  <td>{g.cliente || '—'}</td>
                  <td className="n">{num(g.piezasEsp)}</td>
                  <td className="n">{num(g.kilosEsp, 1)}</td>
                  <td className="n">
                    {g.kilosRec === null ? '—' : num(g.kilosRec, 1)}
                    {g.novedad ? <div style={{ color: 'var(--malo)', fontSize: 12 }}>{g.novedad}</div> : null}
                  </td>
                  <td>{g.etapa ? <Chip tono={tono(TONO_ETAPA, g.etapa)}>{g.etapa}</Chip> : '—'}</td>
                  <td><Boton chico tono="suave" onClick={() => { void cargarClientes(); setGuiaForm(g); }} aria-label="Editar guía" icono={<Pencil size={15} />} /></td>
                </tr>
              ))}
            </Tabla>
          )}
        </Tarjeta>
      </div>

      <div className="oc-sec">
        <h2>Prealertas cruzadas</h2>
        <Tarjeta>
          <p className="oc-sub" style={{ marginBottom: 10 }}>
            Prealertas con el número de vuelo {v.numero}: {pdv.length - faltanPre.length} ya están como guía, {faltanPre.length} faltan por asociar.
          </p>
          {faltanPre.length ? (
            <ul className="oc-lista">
              {faltanPre.map((p) => (
                <li key={p.id} className="oc-item hot">
                  <div className="oc-item-top">
                    <span><b className="oc-mono">{p.guia}</b> <span className="oc-sub">{p.cliente}</span></span>
                    <Boton chico onClick={() => { void cargarClientes(); setExtra([p]); }}>Agregar al vuelo</Boton>
                  </div>
                  <div className="oc-meta">
                    <span>{kg(p.kilos)}</span>
                    <span>{num(p.piezas)} piezas</span>
                    {p.estado === 'Duplicada' ? <Chip tono="bad">Duplicada</Chip> : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="oc-sub">No hay prealertas pendientes de asociar a este vuelo.</p>
          )}
          <BuscarPrealertas onAsociar={(p) => { void cargarClientes(); setExtra([p]); }} />
        </Tarjeta>
      </div>

      <div className="oc-sec">
        <h2>Documentos</h2>
        <Tarjeta>
          <Adjuntos lista={v.documentos} />
          {!v.documentos.length ? <p className="oc-sub">Sin documentos todavía.</p> : null}
          <div className="oc-btns" style={{ marginTop: 12 }}>
            <SelectorArchivo
              etiqueta="Adjuntar documento"
              accept="image/*,application/pdf,.xlsx,.xls,.csv"
              multiple
              disabled={op.ocupado}
              onArchivos={(fs) =>
                void op
                  .correr(async () => {
                    for (const f of fs) await subirArchivo(f, { table: 'vuelos', id: v.id, field: 'documentos' });
                  }, 'Documento guardado en el vuelo.')
                  .then((ok) => (ok ? refresh() : undefined))
              }
            />
            {v.carpeta ? (
              <a className="oc-btn" href={v.carpeta} target="_blank" rel="noreferrer">
                <FileText size={18} /> Carpeta de Drive
              </a>
            ) : null}
          </div>
        </Tarjeta>
      </div>

      <div className="oc-sec">
        <h2>Atención y equipos</h2>
        {!data.atenciones.length ? (
          <Tarjeta><p className="oc-sub">Este vuelo todavía no tiene atención. Se crea sola cuando un operario lo toma.</p></Tarjeta>
        ) : (
          data.atenciones.map((a) => {
            const eq = data.equipos.filter((e) => e.atencionId === a.id);
            return (
              <Tarjeta key={a.id} titulo={`${a.operario || 'Sin operario'} · ${fechaCorta(a.fecha)}`} derecha={<Chip tono={tono(TONO_ATENCION, a.estado)} vivo={ES_VIVO.has(a.estado)}>{a.estado}</Chip>}>
                <dl className="oc-pares">
                  <dt>Horario</dt><dd>{hhmm(a.horaInicio) || '—'} → {hhmm(a.horaFin) || '—'}</dd>
                  <dt>Kilos</dt><dd>{a.kilosRec === null ? 'sin registrar' : `${kg(a.kilosRec)} (dif. ${a.difKilos === null ? '—' : kg(a.difKilos)})`}</dd>
                  <dt>Pallets</dt><dd>{a.palletsRec === null ? 'sin registrar' : `${num(a.palletsRec)} (dif. ${a.difPallets ?? '—'})`}</dd>
                  <dt>Margen</dt><dd>{a.fueraDeMargen ? <Chip tono="bad">Fuera de margen</Chip> : <Chip tono="good">Dentro</Chip>} {a.fueraDeZona ? <Chip tono="bad">Fuera de zona</Chip> : null}</dd>
                  <dt>Costo de equipos</dt><dd>{cop(a.costoEquipos)}</dd>
                </dl>
                {a.novedades ? <p style={{ margin: '10px 0' }}>{a.novedades}</p> : null}
                {a.notaCorreccion ? <div className="oc-aviso" style={{ margin: '10px 0' }}>Corrección pedida: {a.notaCorreccion}</div> : null}
                <Adjuntos lista={a.fotos} />
                {eq.length ? (
                  <div style={{ marginTop: 12 }}>
                    <Tabla columnas={[{ t: 'Equipo' }, { t: 'Cant.', n: true }, { t: 'Tarifa', n: true }, { t: 'Por pagar', n: true }, { t: 'Foto' }]}>
                      {eq.map((e) => (
                        <tr key={e.id}>
                          <td>{e.equipo}<div className="oc-sub">{e.proveedor}</div></td>
                          <td className="n">{num(e.cantidad)}</td>
                          <td className="n">{dinero(e.tarifa, e.moneda)}</td>
                          <td className="n">{cop(e.porPagar || e.costoCop)}</td>
                          <td><Adjuntos lista={e.foto} /></td>
                        </tr>
                      ))}
                    </Tabla>
                  </div>
                ) : null}
              </Tarjeta>
            );
          })
        )}
      </div>

      <div className="oc-sec oc-grid oc-g2">
        <Tarjeta titulo="Eventos del vuelo">
          {!data.eventos.length ? (
            <p className="oc-sub">Sin eventos registrados.</p>
          ) : (
            <ul className="oc-lista">
              {data.eventos.map((e) => (
                <li key={e.id} className={`oc-item ${e.critico ? 'bad' : ''}`}>
                  <div className="oc-item-top">
                    <b>{e.tipo}</b>
                    <Chip tono={tono(TONO_EVENTO, e.estado)}>{e.estado}</Chip>
                  </div>
                  <p>{e.descripcion}</p>
                  <div className="oc-meta"><span>{hhmm(e.hora)}</span><span>{e.operario}</span>{e.costo ? <span>{cop(e.costo)}</span> : null}</div>
                  <Adjuntos lista={e.fotos} />
                </li>
              ))}
            </ul>
          )}
          <div style={{ marginTop: 12 }}>
            <Boton chico onClick={() => irA('eventos', { vuelo: v.id })}>Registrar evento</Boton>
          </div>
        </Tarjeta>

        <Tarjeta titulo="Línea de tiempo del vuelo">
          <LineaVuelo v={v} atenciones={data.atenciones} eventos={data.eventos} />
        </Tarjeta>
      </div>

      {guiaForm ? (
        <FormGuia
          guia={guiaForm === 'nueva' ? null : guiaForm}
          vuelo={v}
          clientes={clientes}
          onCerrar={() => setGuiaForm(null)}
          onGuardado={async () => {
            setGuiaForm(null);
            await refresh();
          }}
        />
      ) : null}
    </Pantalla>
  );
}

function BuscarPrealertas({ onAsociar }: { onAsociar: (p: Prealerta) => void }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<Prealerta[] | null>(null);
  const op = useOperacion();
  const buscar = () =>
    void op.correr(async () => {
      if (!q.trim()) return;
      const r = await cortex.tables.query('prealertas', { search: q.trim(), limit: 20 });
      setRes(r.rows.map(aPrealerta));
    });
  return (
    <div style={{ marginTop: 16 }}>
      <Campo etiqueta="Buscar otra prealerta por guía o cliente">
        <div style={{ display: 'flex', gap: 8 }}>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && buscar()} placeholder="Número de guía" />
          <Boton onClick={buscar} disabled={op.ocupado} icono={<Search size={16} />}>Buscar</Boton>
        </div>
      </Campo>
      {op.error ? <ErrorCaja mensaje={op.error} /> : null}
      {res && !res.length ? <p className="oc-sub" style={{ marginTop: 8 }}>No hay prealertas con ese texto.</p> : null}
      {res?.length ? (
        <ul className="oc-lista" style={{ marginTop: 10 }}>
          {res.map((p) => (
            <li key={p.id} className="oc-item-top">
              <span><b className="oc-mono">{p.guia}</b> <span className="oc-sub">{[p.cliente, p.numeroVuelo, p.kilos ? kg(p.kilos) : ''].filter(Boolean).join(' · ')}</span></span>
              <Boton chico onClick={() => onAsociar(p)}>Asociar a este vuelo</Boton>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function FormGuia({
  guia,
  vuelo,
  clientes,
  onCerrar,
  onGuardado,
}: {
  guia: Guia | null;
  vuelo: Vuelo;
  clientes: { id: string; label: string }[];
  onCerrar: () => void;
  onGuardado: () => void | Promise<void>;
}) {
  const [f, setF] = useState({
    guia: guia?.guia ?? '',
    tipo: guia?.tipo ?? '',
    madre: guia?.madre ?? '',
    cliente: guia?.cliente ?? '',
    parciales: guia?.parciales ?? '',
    piezas: guia ? String(guia.piezasEsp || '') : '',
    kilos: guia ? String(guia.kilosEsp || '') : '',
    pallets: guia ? String(guia.palletsEsp || '') : '',
    piezasRec: guia?.piezasRec != null ? String(guia.piezasRec) : '',
    kilosRec: guia?.kilosRec != null ? String(guia.kilosRec) : '',
    palletsRec: guia?.palletsRec != null ? String(guia.palletsRec) : '',
    novedad: guia?.novedad ?? '',
  });
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const op = useOperacion();
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  const clienteId = clientes.find((c) => norm(c.label) === norm(f.cliente))?.id ?? (guia && norm(guia.cliente) === norm(f.cliente) ? guia.clienteId : '');

  const guardar = async () => {
    const num_ = (s: string) => (hay(s) && s !== '' ? N(s) : undefined);
    const val: Record<string, unknown> = {
      guia: f.guia.trim().toUpperCase(),
      tipo_guia: f.tipo || undefined,
      guia_madre: f.madre.trim() || undefined,
      parciales: f.parciales || undefined,
      piezas_esperadas: num_(f.piezas),
      kilos_esperados: num_(f.kilos),
      pallets_esperados: num_(f.pallets),
      piezas_recibidas: num_(f.piezasRec),
      kilos_recibidos: num_(f.kilosRec),
      pallets_recibidos: num_(f.palletsRec),
      novedad_guia: f.novedad.trim() || undefined,
    };
    if (clienteId) val.cliente = clienteId;
    const limpio = Object.fromEntries(Object.entries(val).filter(([, x]) => x !== undefined));
    const ok = await op.correr(async () => {
      if (guia) {
        // Solo lo que cambió: así un rol que no puede tocar lo esperado puede guardar lo recibido.
        const antes: Record<string, unknown> = {
          guia: guia.guia, tipo_guia: guia.tipo || undefined, guia_madre: guia.madre || undefined, parciales: guia.parciales || undefined,
          piezas_esperadas: guia.piezasEsp || undefined, kilos_esperados: guia.kilosEsp || undefined, pallets_esperados: guia.palletsEsp || undefined,
          piezas_recibidas: guia.piezasRec ?? undefined, kilos_recibidos: guia.kilosRec ?? undefined, pallets_recibidos: guia.palletsRec ?? undefined,
          novedad_guia: guia.novedad || undefined, cliente: guia.clienteId,
        };
        const cambios = Object.fromEntries(Object.entries(limpio).filter(([k, x]) => antes[k] !== x));
        if (!Object.keys(cambios).length) return;
        await cortex.tables.update('prefacturacion', guia.id, cambios);
      } else {
        if (!clienteId) throw new Error('Elige un cliente de la lista.');
        await cortex.tables.insert('prefacturacion', { ...limpio, vuelo: vuelo.id });
      }
    }, guia ? 'Guía actualizada.' : 'Guía agregada al vuelo.');
    if (ok) await onGuardado();
  };

  return (
    <Hoja titulo={guia ? `Guía ${guia.guia}` : 'Agregar guía'} onCerrar={onCerrar}>
      <div className="oc-form">
        <Campo etiqueta="Número de guía">
          <input type="text" value={f.guia} onChange={(e) => set('guia')(e.target.value)} />
        </Campo>
        <div className="oc-fila2">
          <Campo etiqueta="Tipo de guía">
            <select value={f.tipo} onChange={(e) => set('tipo')(e.target.value)}>
              <option value="">—</option>
              {TIPOS_GUIA.map((t) => <option key={t}>{t}</option>)}
            </select>
          </Campo>
          <Campo etiqueta="Guía madre">
            <input type="text" value={f.madre} onChange={(e) => set('madre')(e.target.value)} />
          </Campo>
        </div>
        <div className="oc-fila2">
          <Campo etiqueta="Cliente" ayuda={f.cliente && !clienteId ? 'Elige un cliente de la lista.' : undefined}>
            <input type="text" list="oc-clientes-f" value={f.cliente} onChange={(e) => set('cliente')(e.target.value)} />
            <datalist id="oc-clientes-f">{clientes.map((c) => <option key={c.id} value={c.label} />)}</datalist>
          </Campo>
          <Campo etiqueta="Parcial">
            <select value={f.parciales} onChange={(e) => set('parciales')(e.target.value)}>
              <option value="">—</option>
              {PARCIALES.map((t) => <option key={t}>{t}</option>)}
            </select>
          </Campo>
        </div>
        <h3>Esperado</h3>
        <div className="oc-fila3">
          <Campo etiqueta="Piezas"><Numero valor={f.piezas} onChange={set('piezas')} /></Campo>
          <Campo etiqueta="Kilos"><Numero valor={f.kilos} onChange={set('kilos')} /></Campo>
          <Campo etiqueta="Pallets"><Numero valor={f.pallets} onChange={set('pallets')} /></Campo>
        </div>
        {guia ? (
          <>
            <h3>Recibido</h3>
            <div className="oc-fila3">
              <Campo etiqueta="Piezas"><Numero valor={f.piezasRec} onChange={set('piezasRec')} /></Campo>
              <Campo etiqueta="Kilos"><Numero valor={f.kilosRec} onChange={set('kilosRec')} /></Campo>
              <Campo etiqueta="Pallets"><Numero valor={f.palletsRec} onChange={set('palletsRec')} /></Campo>
            </div>
            <Campo etiqueta="Novedad de la guía">
              <input type="text" value={f.novedad} onChange={(e) => set('novedad')(e.target.value)} />
            </Campo>
          </>
        ) : null}
        {op.error ? <ErrorCaja mensaje={op.error} /> : null}
        <Boton tono="primario" disabled={op.ocupado || !f.guia.trim()} onClick={() => void guardar()}>
          {op.ocupado ? 'Guardando…' : 'Guardar'}
        </Boton>
      </div>
    </Hoja>
  );
}

function LineaVuelo({ v, atenciones, eventos }: { v: Vuelo; atenciones: Atencion[]; eventos: Evento[] }) {
  const pasos: { h: string; texto: string; t: Tono }[] = [];
  if (v.llegadaHora) pasos.push({ h: hhmm(v.llegadaHora), texto: 'Aterrizó', t: 'accent' });
  if (v.tomadoHora) pasos.push({ h: hhmm(v.tomadoHora), texto: `Tomado por ${v.atendidoPor || 'un operario'}${v.fueraZonaToma === 'Sí' ? ' (fuera de zona)' : ''}`, t: v.fueraZonaToma === 'Sí' ? 'bad' : 'info' });
  for (const a of atenciones) {
    if (a.horaFin) pasos.push({ h: hhmm(a.horaFin), texto: `Fin de la atención de ${a.operario}`, t: 'good' });
  }
  for (const e of eventos) if (e.hora) pasos.push({ h: hhmm(e.hora), texto: `${e.tipo}${e.critico ? ' (crítico)' : ''}`, t: e.critico ? 'bad' : 'warn' });
  if (v.cierreHora) pasos.push({ h: hhmm(v.cierreHora), texto: 'Recibido', t: 'good' });
  pasos.sort((a, b) => a.h.localeCompare(b.h));
  if (!pasos.length) return <p className="oc-sub">Aún no hay movimientos. Se irán llenando cuando el vuelo aterrice y lo tomen.</p>;
  return (
    <ol className="oc-linea">
      {pasos.map((p, i) => (
        <li key={`${p.h}-${i}`} className={p.t}>
          <span className="oc-hora">{p.h}</span>
          {p.texto}
        </li>
      ))}
    </ol>
  );
}

