import { useEffect, useMemo, useRef, useState } from 'react';
import { cortex } from '@cortex/app-sdk';
import { ArrowRight, Clock, FileScan, FileSpreadsheet, Pencil, Plane, Plus, Search, X } from 'lucide-react';
import { aAtencion, aEvento, cargarVuelos, porRelacion, useAcciones, useCarga, useRol } from '../lib/datos';
import type { Vuelo } from '../lib/datos';
import { Etapas, TarjetaEmbarque } from '../lib/Piezas';
import { LineaVuelo } from '../lib/LineaVuelo';
import { TONO_VUELO, tono } from '../lib/estados';
import { N, fechaCorta, hhmm, kg, num } from '../lib/formato';
import { horaAhora, hoyBogota, minutosHasta, sumarDias } from '../lib/tiempo';
import { puedeEditarDoc, useEsquema } from '../lib/documental';
import { NuevoDesdeManifiesto } from '../lib/ManifiestoVuelo';
import { ManifiestoNuevo } from '../lib/ManifiestoNuevo';
import { aerolineaDe, aprenderAerolineas, codigoAerolinea } from '../lib/aerolineas';
import { Boton, Campo, Chip, ES_VIVO, ErrorCaja, Estado, Hoja, Numero, Pantalla, Segmentos, confirmar, useOperacion } from '../lib/ui';
import { useGuardado } from '../lib/guardado';

/**
 * VUELOS — el documental crea y edita lo esperado de cada vuelo y marca
 * En camino / Demorado / Llegó (la posición también se anota aquí).
 */

type Filtro = 'hoy' | 'manana' | 'abiertos' | 'todos' | 'fecha';

const irA = (screen: string, prefill?: Record<string, string | number>) => void cortex.nav.go({ screen, prefill }).catch(() => undefined);

export default function Vuelos() {
  const hoy = hoyBogota();
  const { data, loading, error, refresh } = useCarga(() => cargarVuelos(500), [], 30_000);
  const acc = useAcciones('vuelos');
  const [filtro, setFiltro] = useGuardado<Filtro>('vuelos-filtro', 'hoy');
  const [fecha, setFecha] = useState(hoy);
  const [q, setQ] = useState('');
  const [editando, setEditando] = useState<Vuelo | 'nuevo' | null>(null);
  const [demora, setDemora] = useState<Vuelo | null>(null);
  const [desdeManifiesto, setDesdeManifiesto] = useState(false);
  const [manifiestoNuevo, setManifiestoNuevo] = useState(false);
  const [selId, setSelId] = useState<string | null>(null);
  const ancha = useAncha();
  const sel = (data ?? []).find((v) => v.id === selId) ?? null;
  const esq = useEsquema();
  const { rol } = useRol();
  const op = useOperacion();

  const lista = useMemo(() => {
    const todos = data ?? [];
    const qn = q.trim().toLowerCase();
    return todos
      .filter((v) => {
        if (filtro === 'hoy') return v.fecha === hoy;
        if (filtro === 'manana') return v.fecha === sumarDias(hoy, 1);
        if (filtro === 'fecha') return v.fecha === fecha;
        if (filtro === 'abiertos') return !['Cerrado', 'Cancelado'].includes(v.estado);
        return true;
      })
      .filter((v) => !qn || `${v.numero} ${v.aerolinea} ${v.origen}`.toLowerCase().includes(qn))
      .sort((a, b) => a.fecha.localeCompare(b.fecha) || (a.horaActual || '').localeCompare(b.horaActual || ''));
  }, [data, filtro, fecha, q, hoy]);

  const aerolineas = useMemo(() => [...new Set((data ?? []).map((v) => v.aerolinea).filter(Boolean))].sort(), [data]);
  const aprendidas = useMemo(() => aprenderAerolineas((data ?? []).map((v) => ({ numero: v.numero, aerolinea: v.aerolinea }))), [data]);

  const accion = async (v: Vuelo, clave: string, texto: string, confirma?: string) => {
    if (confirma && !(await confirmar(confirma, texto))) return;
    const ok = await op.correr(() => cortex.tables.action('vuelos', v.id, clave), `${v.numero}: ${texto}`);
    if (ok) await refresh();
  };

  return (
    <Pantalla
      titulo="Vuelos"
      sub="Lo esperado de cada vuelo, su posición y su estado."
      acciones={
        <>
          {puedeEditarDoc(rol) ? (
            <>
              <Boton tono="primario" onClick={() => setManifiestoNuevo(true)} icono={<FileSpreadsheet size={18} />}>
                Nuevo manifiesto
              </Boton>
              <Boton onClick={() => setDesdeManifiesto(true)} icono={<FileScan size={18} />}>
                Nuevo vuelo desde manifiesto
              </Boton>
            </>
          ) : null}
          <Boton onClick={() => setEditando('nuevo')} icono={<Plus size={18} />}>
            Nuevo vuelo
          </Boton>
        </>
      }
    >
      <div className="oc-form" style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <Segmentos
            valor={filtro}
            onChange={setFiltro}
            opciones={[
              { id: 'hoy', texto: 'Hoy' },
              { id: 'manana', texto: 'Mañana' },
              { id: 'fecha', texto: 'Otra fecha' },
              { id: 'abiertos', texto: 'Abiertos' },
              { id: 'todos', texto: 'Todos' },
            ]}
          />
          {filtro === 'fecha' ? (
            <div style={{ maxWidth: 190 }}>
              <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} aria-label="Fecha" />
            </div>
          ) : null}
          <div style={{ flex: '1 1 200px', position: 'relative', maxWidth: 340 }}>
            <input type="search" placeholder="Buscar vuelo o aerolínea" value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 38 }} />
            <Search size={16} style={{ position: 'absolute', left: 12, top: 15, color: 'var(--suave)' }} />
          </div>
        </div>
      </div>

      {op.error ? <ErrorCaja mensaje={op.error} /> : null}

      <Estado
        cargando={loading}
        error={error}
        vacio={!lista.length}
        tituloVacio={data && !data.length ? 'Todavía no hay vuelos' : 'No hay vuelos con ese filtro'}
        textoVacio={
          <p>
            Empieza con «Nuevo manifiesto»: aerolínea, vuelo, fecha y las guías; o crea el vuelo a mano con «Nuevo vuelo».
          </p>
        }
        reintentar={() => void refresh()}
      >
        <div className={`oc-maestro ${sel && ancha ? 'con-panel' : ''}`} style={{ marginTop: op.error ? 14 : 0 }}>
          <ul className="oc-lista">
            {lista.map((v) => {
              const tarde = ['Programado', 'En camino', 'Demorado'].includes(v.estado) && (v.estado === 'Demorado' || (minutosHasta(v.fecha, v.horaActual) ?? 0) < -15);
              const cls = v.estado === 'Aterrizó' || tarde ? 'bad' : ['Cerrado', 'Recibido'].includes(v.estado) ? 'normal' : '';
              return (
                <li key={v.id}>
                  <button type="button" className={`oc-fila ${cls} ${sel?.id === v.id ? 'sel' : ''}`} onClick={() => setSelId(v.id)} aria-pressed={sel?.id === v.id}>
                    <span className="h">{hhmm(v.horaActual) || '—'}</span>
                    <span className="t">
                      <b>{v.numero}</b>
                      <small>
                        {[v.aerolinea, v.origen, fechaCorta(v.fecha), v.posicion ? `Posición ${v.posicion}` : 'Sin posición', kg(v.kilosEsp), `${num(v.palletsEsp)} pallets`, `${num(v.piezasEsp)} piezas`, v.atendidoPor ? `Atiende ${v.atendidoPor}` : ''].filter(Boolean).join(' · ')}
                      </small>
                    </span>
                    <span className="d">
                      {v.hora && v.horaActual && hhmm(v.hora) !== hhmm(v.horaActual) ? <Chip tono="warn">Era {hhmm(v.hora)}</Chip> : null}
                      <Chip tono={tono(TONO_VUELO, v.estado)} vivo={ES_VIVO.has(v.estado)}>{v.estado}</Chip>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {sel && ancha ? (
            <aside className="oc-panel" aria-label={`Vuelo ${sel.numero}`}>
              <PanelVuelo v={sel} acc={acc} ocupado={op.ocupado} onCerrar={() => setSelId(null)} onEditar={() => setEditando(sel)} onDemora={() => setDemora(sel)} onAccion={(c, t, m) => void accion(sel, c, t, m)} />
            </aside>
          ) : null}
        </div>
      </Estado>

      {sel && !ancha ? (
        <Hoja titulo={sel.numero} onCerrar={() => setSelId(null)}>
          <PanelVuelo v={sel} acc={acc} ocupado={op.ocupado} onEditar={() => { setSelId(null); setEditando(sel); }} onDemora={() => { setSelId(null); setDemora(sel); }} onAccion={(c, t, m) => { setSelId(null); void accion(sel, c, t, m); }} />
        </Hoja>
      ) : null}

      {editando ? (
        <FormVuelo
          vuelo={editando === 'nuevo' ? null : editando}
          aerolineas={aerolineas}
          aprendidas={aprendidas}
          onCerrar={() => setEditando(null)}
          onGuardado={async (id, nuevo) => {
            setEditando(null);
            await refresh();
            if (nuevo && id) irA('vuelo', { vuelo: id });
          }}
        />
      ) : null}

      {manifiestoNuevo ? (
        <ManifiestoNuevo
          vuelos={data ?? []}
          esq={esq}
          onCerrar={() => {
            setManifiestoNuevo(false);
            void refresh();
          }}
          onGuardado={async () => {
            await refresh();
          }}
        />
      ) : null}

      {desdeManifiesto ? (
        <NuevoDesdeManifiesto
          vuelos={data ?? []}
          esq={esq}
          onCerrar={() => setDesdeManifiesto(false)}
          onListo={async (id) => {
            setDesdeManifiesto(false);
            await refresh();
            if (id) irA('vuelo', { vuelo: id, tab: 'guias' });
          }}
        />
      ) : null}

      {demora ? (
        <Hoja titulo={`Demorar ${demora.numero}`} onCerrar={() => setDemora(null)}>
          <Demora
            vuelo={demora}
            onListo={async () => {
              setDemora(null);
              await refresh();
            }}
          />
        </Hoja>
      ) : null}
    </Pantalla>
  );
}

/** ¿La pantalla es ancha? (panel lateral en escritorio, hoja en móvil). */
function useAncha(): boolean {
  const [a, setA] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 1100);
  useEffect(() => {
    const f = () => setA(window.innerWidth >= 1100);
    window.addEventListener('resize', f);
    return () => window.removeEventListener('resize', f);
  }, []);
  return a;
}

/** Vista rápida del vuelo: tarjeta de embarque, etapas, línea de tiempo y acciones de estado. */
function PanelVuelo({
  v,
  acc,
  ocupado,
  onCerrar,
  onEditar,
  onDemora,
  onAccion,
}: {
  v: Vuelo;
  acc: { tiene: (c: string) => boolean };
  ocupado: boolean;
  onCerrar?: () => void;
  onEditar: () => void;
  onDemora: () => void;
  onAccion: (clave: string, texto: string, confirma?: string) => void;
}) {
  const det = useCarga(async () => {
    const [as, ev] = await Promise.all([porRelacion('atenciones', 'vuelo', v.id).catch(() => []), porRelacion('eventos_operacion', 'vuelo', v.id).catch(() => [])]);
    return { atenciones: as.map(aAtencion), eventos: ev.map(aEvento) };
  }, [v.id]);
  const puedeCamino = acc.tiene('en_camino') && ['Programado', 'Demorado'].includes(v.estado);
  const puedeDemora = acc.tiene('demorado') && ['Programado', 'En camino'].includes(v.estado);
  const puedeLlego = acc.tiene('llego') && ['Programado', 'En camino', 'Demorado'].includes(v.estado);
  return (
    <div className="oc-form">
      {onCerrar ? (
        <div className="oc-panel-top">
          <h2>Vista rápida</h2>
          <Boton chico tono="suave" onClick={onCerrar} aria-label="Cerrar el panel" icono={<X size={18} />} />
        </div>
      ) : null}
      <TarjetaEmbarque v={v} />
      <Etapas estado={v.estado} />
      <div className="oc-btns">
        <Boton tono="primario" onClick={() => irA('vuelo', { vuelo: v.id })} icono={<ArrowRight size={16} />}>
          Abrir ficha completa
        </Boton>
        <Boton onClick={onEditar} icono={<Pencil size={15} />}>
          Editar
        </Boton>
      </div>
      {puedeCamino || puedeDemora || puedeLlego ? (
        <div className="oc-btns">
          {puedeCamino ? <Boton disabled={ocupado} onClick={() => onAccion('en_camino', 'En camino')}>Marcar en camino</Boton> : null}
          {puedeDemora ? <Boton tono="aviso" disabled={ocupado} onClick={onDemora} icono={<Clock size={15} />}>Demorado</Boton> : null}
          {puedeLlego ? <Boton tono="ok" disabled={ocupado} onClick={() => onAccion('llego', 'Llegó', `¿Confirmas que ${v.numero} aterrizó? Se avisa a los operarios de turno.`)}>Llegó</Boton> : null}
        </div>
      ) : null}
      <div>
        <h3 style={{ marginBottom: 6 }}>Qué ha pasado</h3>
        {det.data ? <LineaVuelo v={v} atenciones={det.data.atenciones} eventos={det.data.eventos} /> : <p className="oc-sub">Cargando…</p>}
      </div>
    </div>
  );
}

function Demora({ vuelo, onListo }: { vuelo: Vuelo; onListo: () => void | Promise<void> }) {
  const [hora, setHora] = useState(hhmm(vuelo.horaActual) || horaAhora());
  const op = useOperacion();
  return (
    <div className="oc-form">
      <Campo etiqueta="Nueva hora estimada de llegada" ayuda="Los operarios y el tablero verán esta hora.">
        <input type="time" value={hora} onChange={(e) => setHora(e.target.value)} />
      </Campo>
      {op.error ? <ErrorCaja mensaje={op.error} /> : null}
      <Boton
        tono="aviso"
        disabled={op.ocupado}
        onClick={async () => {
          const ok = await op.correr(async () => {
            if (hora && hora !== hhmm(vuelo.horaActual)) await cortex.tables.update('vuelos', vuelo.id, { hora_estimada_actual: hora });
            await cortex.tables.action('vuelos', vuelo.id, 'demorado');
          }, `${vuelo.numero}: Demorado`);
          if (ok) await onListo();
        }}
      >
        {op.ocupado ? 'Guardando…' : 'Marcar demorado'}
      </Boton>
    </div>
  );
}

function FormVuelo({
  vuelo,
  aerolineas,
  aprendidas,
  onCerrar,
  onGuardado,
}: {
  vuelo: Vuelo | null;
  aerolineas: string[];
  aprendidas: Record<string, string>;
  onCerrar: () => void;
  onGuardado: (id: string | null, nuevo: boolean) => void | Promise<void>;
}) {
  const [f, setF] = useState({
    numero: vuelo?.numero ?? '',
    fecha: vuelo?.fecha ?? hoyBogota(),
    hora: hhmm(vuelo?.hora),
    horaActual: hhmm(vuelo?.horaActual),
    posicion: vuelo?.posicion ?? '',
    aerolinea: vuelo?.aerolinea ?? '',
    origen: vuelo?.origen ?? '',
    kilos: vuelo ? String(vuelo.kilosEsp || '') : '',
    pallets: vuelo ? String(vuelo.palletsEsp || '') : '',
    piezas: vuelo ? String(vuelo.piezasEsp || '') : '',
    margenKilos: vuelo ? String(vuelo.margenKilos || '') : '',
    margenPallets: vuelo ? String(vuelo.margenPallets || '') : '',
    obs: vuelo?.observaciones ?? '',
  });
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  // Lo aprendido de las prealertas se suma a lo de los vuelos (lo de los vuelos manda).
  const [dePrealertas, setDePrealertas] = useState<Record<string, string>>({});
  useEffect(() => {
    let vivo = true;
    cortex.tables
      .query('prealertas', { limit: 500 })
      .then((r) => {
        if (!vivo) return;
        setDePrealertas(
          aprenderAerolineas(
            r.rows.map((x) => ({ numero: String(x.values.numero_vuelo ?? ''), aerolinea: String(x.values.aerolinea ?? '') })),
          ),
        );
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, []);
  // La aerolínea se llena sola mientras la persona no la haya escrito a mano.
  const aeroAuto = useRef(!vuelo?.aerolinea);
  const [aeroSugerida, setAeroSugerida] = useState('');
  const cambiarNumero = (v: string) => {
    const nombre = aerolineaDe(v, { ...dePrealertas, ...aprendidas });
    setF((p) => ({ ...p, numero: v, aerolinea: aeroAuto.current && nombre ? nombre : aeroAuto.current && !codigoAerolinea(v) ? '' : p.aerolinea }));
    setAeroSugerida(aeroAuto.current && nombre ? codigoAerolinea(v) ?? '' : '');
  };
  const op = useOperacion();
  const falta = !f.numero.trim() ? 'Escribe el número de vuelo.' : !f.aerolinea.trim() ? 'Escribe la aerolínea.' : !f.fecha ? 'Elige la fecha.' : '';

  const guardar = async () => {
    if (falta) return;
    const valores: Record<string, unknown> = {
      numero_vuelo: f.numero.trim().toUpperCase(),
      fecha: f.fecha,
      hora_estimada: f.hora || undefined,
      posicion: f.posicion.trim() || undefined,
      aerolinea: f.aerolinea.trim(),
      origen: f.origen.trim() || undefined,
      kilos_esperados: f.kilos ? N(f.kilos) : undefined,
      pallets_esperados: f.pallets ? N(f.pallets) : undefined,
      piezas_esperadas: f.piezas ? N(f.piezas) : undefined,
      margen_kilos_pct: f.margenKilos ? N(f.margenKilos) : undefined,
      margen_pallets: f.margenPallets ? N(f.margenPallets) : undefined,
      observaciones: f.obs.trim() || undefined,
    };
    if (vuelo && f.horaActual) valores.hora_estimada_actual = f.horaActual;
    if (!vuelo) valores.estado = 'Programado';
    let id: string | null = vuelo?.id ?? null;
    const ok = await op.correr(async () => {
      if (vuelo) {
        const cambios = Object.fromEntries(Object.entries(valores).filter(([, v]) => v !== undefined));
        await cortex.tables.update('vuelos', vuelo.id, cambios);
      } else {
        const limpio = Object.fromEntries(Object.entries(valores).filter(([, v]) => v !== undefined));
        const r = await cortex.tables.insert('vuelos', limpio);
        id = r.id;
      }
    }, vuelo ? 'Vuelo actualizado.' : 'Vuelo creado. Ahora agrégale las guías.');
    if (ok) await onGuardado(id, !vuelo);
  };

  return (
    <Hoja titulo={vuelo ? `Editar ${vuelo.numero}` : 'Nuevo vuelo'} onCerrar={onCerrar}>
      <div className="oc-form">
        <div className="oc-fila2">
          <Campo etiqueta="Número de vuelo">
            <input type="text" value={f.numero} onChange={(e) => cambiarNumero(e.target.value.toUpperCase())} placeholder="Ej. AV 123, LA8044" autoCapitalize="characters" />
          </Campo>
          <Campo etiqueta="Fecha">
            <input type="date" value={f.fecha} onChange={(e) => set('fecha')(e.target.value)} />
          </Campo>
        </div>
        <div className="oc-fila2">
          <Campo etiqueta="Aerolínea" ayuda={aeroSugerida ? `Según el código ${aeroSugerida}` : undefined}>
            <input
              type="text"
              list="oc-aerolineas"
              value={f.aerolinea}
              onChange={(e) => {
                aeroAuto.current = e.target.value.trim() === '';
                setAeroSugerida('');
                set('aerolinea')(e.target.value);
              }}
            />
            <datalist id="oc-aerolineas">
              {aerolineas.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </Campo>
          <Campo etiqueta="Origen">
            <input type="text" value={f.origen} onChange={(e) => set('origen')(e.target.value)} />
          </Campo>
        </div>
        <div className="oc-fila3">
          <Campo etiqueta="Hora estimada">
            <input type="time" value={f.hora} onChange={(e) => set('hora')(e.target.value)} />
          </Campo>
          {vuelo ? (
            <Campo etiqueta="Hora estimada actual">
              <input type="time" value={f.horaActual} onChange={(e) => set('horaActual')(e.target.value)} />
            </Campo>
          ) : null}
          <Campo etiqueta="Posición">
            <input type="text" value={f.posicion} onChange={(e) => set('posicion')(e.target.value)} placeholder="Ej. 12" />
          </Campo>
        </div>
        <div className="oc-fila3">
          <Campo etiqueta="Kilos esperados">
            <Numero valor={f.kilos} onChange={set('kilos')} />
          </Campo>
          <Campo etiqueta="Pallets esperados">
            <Numero valor={f.pallets} onChange={set('pallets')} />
          </Campo>
          <Campo etiqueta="Piezas esperadas">
            <Numero valor={f.piezas} onChange={set('piezas')} />
          </Campo>
        </div>
        <div className="oc-fila2">
          <Campo etiqueta="Margen de kilos (%)" ayuda="Diferencia tolerada sobre lo esperado.">
            <Numero valor={f.margenKilos} onChange={set('margenKilos')} />
          </Campo>
          <Campo etiqueta="Margen de pallets" ayuda="Pallets de diferencia tolerados.">
            <Numero valor={f.margenPallets} onChange={set('margenPallets')} />
          </Campo>
        </div>
        <Campo etiqueta="Observaciones">
          <textarea value={f.obs} onChange={(e) => set('obs')(e.target.value)} />
        </Campo>
        {falta ? <p className="oc-sub">{falta}</p> : null}
        {op.error ? <ErrorCaja mensaje={op.error} /> : null}
        <Boton tono="primario" disabled={op.ocupado || !!falta} onClick={() => void guardar()}>
          {op.ocupado ? 'Guardando…' : vuelo ? 'Guardar cambios' : 'Crear vuelo'}
        </Boton>
      </div>
    </Hoja>
  );
}
