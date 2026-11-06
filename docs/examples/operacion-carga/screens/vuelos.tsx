import { useEffect, useMemo, useRef, useState } from 'react';
import { cortex } from '@cortex/app-sdk';
import { Clock, FileScan, Pencil, Plane, Plus, Search } from 'lucide-react';
import { cargarVuelos, useAcciones, useCarga, useRol } from '../lib/datos';
import type { Vuelo } from '../lib/datos';
import { TONO_VUELO, tono } from '../lib/estados';
import { N, fechaCorta, hhmm, kg, num } from '../lib/formato';
import { horaAhora, hoyBogota, sumarDias } from '../lib/tiempo';
import { puedeEditarDoc, useEsquema } from '../lib/documental';
import { NuevoDesdeManifiesto } from '../lib/ManifiestoVuelo';
import { aerolineaDe, aprenderAerolineas, codigoAerolinea } from '../lib/aerolineas';
import { Boton, Campo, Chip, ErrorCaja, Estado, Hoja, Numero, Pantalla, Segmentos, confirmar, useOperacion } from '../lib/ui';

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
  const [filtro, setFiltro] = useState<Filtro>('hoy');
  const [fecha, setFecha] = useState(hoy);
  const [q, setQ] = useState('');
  const [editando, setEditando] = useState<Vuelo | 'nuevo' | null>(null);
  const [demora, setDemora] = useState<Vuelo | null>(null);
  const [desdeManifiesto, setDesdeManifiesto] = useState(false);
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
            <Boton tono="primario" onClick={() => setDesdeManifiesto(true)} icono={<FileScan size={18} />}>
              Nuevo vuelo desde manifiesto
            </Boton>
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
            Crea el primero con «Nuevo vuelo»: número, fecha, hora estimada y lo esperado.
          </p>
        }
        reintentar={() => void refresh()}
      >
        <ul className="oc-lista" style={{ marginTop: op.error ? 14 : 0 }}>
          {lista.map((v) => {
            const puedeCamino = acc.tiene('en_camino') && ['Programado', 'Demorado'].includes(v.estado);
            const puedeDemora = acc.tiene('demorado') && ['Programado', 'En camino'].includes(v.estado);
            const puedeLlego = acc.tiene('llego') && ['Programado', 'En camino', 'Demorado'].includes(v.estado);
            return (
              <li key={v.id} className="oc-item">
                <div className="oc-item-top">
                  <span>
                    <span className="oc-hora">{hhmm(v.horaActual) || '—'}</span>
                    <strong>{v.numero}</strong>
                    <span className="oc-sub"> · {[v.aerolinea, v.origen].filter(Boolean).join(' · ')}</span>
                  </span>
                  <Chip tono={tono(TONO_VUELO, v.estado)}>{v.estado}</Chip>
                </div>
                <div className="oc-meta">
                  <span>{fechaCorta(v.fecha)}</span>
                  {v.hora && v.horaActual && hhmm(v.hora) !== hhmm(v.horaActual) ? <span>Programado {hhmm(v.hora)}</span> : null}
                  <span>{v.posicion ? `Posición ${v.posicion}` : 'Sin posición'}</span>
                  <span>{kg(v.kilosEsp)}</span>
                  <span>{num(v.palletsEsp)} pallets</span>
                  <span>{num(v.piezasEsp)} piezas</span>
                  {v.atendidoPor ? <span>Atiende {v.atendidoPor}</span> : null}
                </div>
                <div className="oc-btns">
                  <Boton chico onClick={() => irA('vuelo', { vuelo: v.id })} icono={<Plane size={15} />}>
                    Abrir
                  </Boton>
                  <Boton chico onClick={() => setEditando(v)} icono={<Pencil size={15} />}>
                    Editar
                  </Boton>
                  {puedeCamino ? (
                    <Boton chico disabled={op.ocupado} onClick={() => void accion(v, 'en_camino', 'En camino')}>
                      En camino
                    </Boton>
                  ) : null}
                  {puedeDemora ? (
                    <Boton chico tono="aviso" disabled={op.ocupado} onClick={() => setDemora(v)} icono={<Clock size={15} />}>
                      Demorado
                    </Boton>
                  ) : null}
                  {puedeLlego ? (
                    <Boton chico tono="ok" disabled={op.ocupado} onClick={() => void accion(v, 'llego', 'Llegó', `¿Confirmas que ${v.numero} aterrizó? Se avisa a los operarios de turno.`)}>
                      Llegó
                    </Boton>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </Estado>

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
