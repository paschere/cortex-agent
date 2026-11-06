import { useEffect, useMemo, useRef, useState } from 'react';
import { cortex } from '@cortex/app-sdk';
import { ClipboardPaste, FileScan, Plus, Trash2 } from 'lucide-react';
import type { Guia, Prealerta, Vuelo } from './datos';
import { MAX_ESCANEO, reducirImagen } from './archivos';
import { TIPOS_GUIA } from './estados';
import { N, kg, num } from './formato';
import { desdeTexto, evaluar, faltantes, renglonDePrealerta, renglonesDe } from './manifiesto';
import type { Cruce, EstadoCruce, Renglon } from './manifiesto';
import { Boton, Chip, ErrorCaja, SelectorArchivo, Tabla, avisar, mensajeDe } from './ui';
import type { Tono } from './estados';

/**
 * MANIFIESTO INTELIGENTE
 * 1) Foto o PDF del manifiesto → `docs.scan` lee los renglones.
 * 2) Cada guía se cruza por número (sin espacios ni guiones, mayúsculas) con las prealertas
 *    y se marca: coincide / diferencia de kilos / sobrante; y las prealertas que no vinieron
 *    quedan como faltantes.
 * 3) El documental revisa y corrige en una tabla editable.
 * 4) Se crean las guías del vuelo (prefacturación, vuelo + prealerta) y el documento queda
 *    guardado en los documentos del vuelo.
 */

const TONO_CRUCE: Record<EstadoCruce, Tono> = {
  coincide: 'good',
  diferencia: 'warn',
  sobrante: 'accent',
  repetida: 'bad',
  ya_esta: 'quiet',
};
const TEXTO_CRUCE: Record<EstadoCruce, string> = {
  coincide: 'Coincide',
  diferencia: 'Difiere en kilos',
  sobrante: 'Sobrante',
  repetida: 'Repetida',
  ya_esta: 'Ya cargada',
};

type Fase = 'inicio' | 'leyendo' | 'revision' | 'guardando' | 'hecho';

export function ManifiestoInteligente({
  vuelo,
  existentes,
  prealertas,
  clientes,
  extra,
  onExtraUsado,
  onListo,
  campoArchivo = 'documentos',
  onEscaneo,
}: {
  vuelo: Vuelo;
  existentes: Guia[];
  /** Todas las prealertas (el cruce usa las de cualquier vuelo para marcar «sobrante» solo si no existen). */
  prealertas: Prealerta[];
  clientes: { id: string; label: string }[];
  /** Prealertas que otro panel pide agregar a la revisión. */
  extra: Prealerta[];
  onExtraUsado: () => void;
  onListo: () => void | Promise<void>;
  /** Campo de archivos del vuelo donde se guarda el manifiesto. */
  campoArchivo?: string;
  /** Avisa el encabezado leído para que la pantalla rellene lo vacío del vuelo. */
  onEscaneo?: (fields: Record<string, string | number>, rows: Record<string, string | number>[], archivo: File) => void;
}) {
  const [fase, setFase] = useState<Fase>('inicio');
  const [archivo, setArchivo] = useState<File | null>(null);
  const [renglones, setRenglones] = useState<Renglon[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [pegando, setPegando] = useState(false);
  const [texto, setTexto] = useState('');
  const [progreso, setProgreso] = useState('');
  const [fallidas, setFallidas] = useState<string[]>([]);
  const docSubido = useRef(false);

  const ctx = useMemo(() => ({ prealertas, existentes, clientes }), [prealertas, existentes, clientes]);
  const cruces: Cruce[] = useMemo(() => evaluar(renglones, ctx), [renglones, ctx]);

  // Prealertas del mismo vuelo (para marcar faltantes).
  const delVuelo = useMemo(() => {
    const n = vuelo.numero.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return prealertas.filter((p) => p.numeroVuelo.toUpperCase().replace(/[^A-Z0-9]/g, '') === n && (!p.fecha || p.fecha === vuelo.fecha));
  }, [prealertas, vuelo.numero, vuelo.fecha]);
  const faltan = useMemo(() => faltantes(renglones, delVuelo, existentes), [renglones, delVuelo, existentes]);

  useEffect(() => {
    if (!extra.length) return;
    setRenglones((prev) => {
      const ya = new Set(prev.map((r) => r.prealertaId));
      return [...prev, ...extra.filter((p) => !ya.has(p.id)).map(renglonDePrealerta)];
    });
    setFase('revision');
    onExtraUsado();
  }, [extra, onExtraUsado]);

  const escanear = async (f: File) => {
    setError(null);
    setAviso(null);
    setFase('leyendo');
    try {
      const listo = await reducirImagen(f);
      if (listo.size > MAX_ESCANEO) {
        throw new Error('El archivo pesa más de 4 MB. Toma la foto de nuevo (más cerca, con buena luz) o pega la lista.');
      }
      setArchivo(listo);
      const r = await cortex.docs.scan(listo, { kind: 'manifiesto', rows: true });
      onEscaneo?.(r.fields, r.rows, listo);
      const rs = renglonesDe(r.rows, ctx);
      if (!rs.length) {
        setAviso('No se encontraron guías en el documento. Revisa que se vea completo y nítido, o agrégalas a mano / pega la lista.');
      }
      setRenglones(rs);
      setFase('revision');
    } catch (e) {
      setError(mensajeDe(e));
      setFase('inicio');
    }
  };

  const pegar = () => {
    const rs = renglonesDe(desdeTexto(texto), ctx);
    if (!rs.length) {
      setError('No se reconoció ninguna guía. Escribe una por línea: guía, piezas y kilos.');
      return;
    }
    setError(null);
    setRenglones((p) => [...p, ...rs]);
    setPegando(false);
    setTexto('');
    setFase('revision');
  };

  const cambiar = (k: string, cambios: Partial<Renglon>) => setRenglones((p) => p.map((r) => (r.k === k ? { ...r, ...cambios } : r)));
  const quitar = (k: string) => setRenglones((p) => p.filter((r) => r.k !== k));
  const agregarVacio = () => {
    setRenglones((p) => [...p, { k: `n${Date.now().toString(36)}${p.length}`, incluir: true, guia: '', tipo: '', madre: '', cliente: '', piezas: '', kilos: '', pallets: '' }]);
    setFase('revision');
  };

  const elegidos = renglones.map((r, i) => ({ r, c: cruces[i] as Cruce })).filter((x) => x.r.incluir);
  const sinGuia = elegidos.filter((x) => !x.r.guia.trim()).length;
  const sinCliente = elegidos.filter((x) => x.r.guia.trim() && !x.c.clienteId).length;
  const conteo = (e: EstadoCruce) => cruces.filter((c) => c.estado === e).length;
  const totalKilos = elegidos.reduce((a, x) => a + N(x.r.kilos), 0);
  const bloqueado = !elegidos.length || sinGuia > 0 || sinCliente > 0;

  const crear = async () => {
    setError(null);
    setFallidas([]);
    setFase('guardando');
    const malas: string[] = [];
    const hechas = new Set<string>();
    let i = 0;
    for (const { r, c } of elegidos) {
      i += 1;
      setProgreso(`Creando guía ${i} de ${elegidos.length}…`);
      try {
        await cortex.tables.insert('prefacturacion', {
          guia: r.guia.trim(),
          cliente: c.clienteId,
          vuelo: vuelo.id,
          ...(c.prealerta ? { prealerta: c.prealerta.id } : {}),
          ...(r.tipo ? { tipo_guia: r.tipo } : {}),
          ...(r.madre ? { guia_madre: r.madre.trim() } : {}),
          ...(r.piezas ? { piezas_esperadas: N(r.piezas) } : {}),
          ...(r.kilos ? { kilos_esperados: N(r.kilos) } : {}),
          ...(r.pallets ? { pallets_esperados: N(r.pallets) } : {}),
        });
        hechas.add(r.k);
      } catch (e) {
        malas.push(`${r.guia}: ${mensajeDe(e)}`);
      }
    }
    if (archivo && !docSubido.current && hechas.size) {
      setProgreso('Guardando el documento en el vuelo…');
      try {
        await cortex.files.upload(archivo, { table: 'vuelos', id: vuelo.id, field: campoArchivo, name: archivo.name });
        docSubido.current = true;
      } catch (e) {
        malas.push(`Documento: ${mensajeDe(e)}`);
      }
    }
    setRenglones((p) => p.filter((r) => !hechas.has(r.k)));
    setFallidas(malas);
    if (hechas.size) avisar(`${hechas.size} guías creadas en ${vuelo.numero}.`);
    await onListo();
    setFase(malas.length ? 'revision' : 'hecho');
  };

  const reiniciar = () => {
    setFase('inicio');
    setRenglones([]);
    setArchivo(null);
    setFallidas([]);
    setError(null);
    setAviso(null);
    docSubido.current = false;
  };

  if (fase === 'hecho') {
    return (
      <div className="oc-ok">
        <p>
          <b>Listo.</b> Las guías quedaron en el vuelo{archivo && docSubido.current ? ' y el documento se guardó en sus documentos' : ''}.
        </p>
        <div style={{ marginTop: 10 }}>
          <Boton chico onClick={reiniciar}>
            Cargar otro manifiesto
          </Boton>
        </div>
      </div>
    );
  }

  if (fase === 'inicio' || fase === 'leyendo') {
    return (
      <div className="oc-form">
        <p className="oc-sub">
          Toma una foto del manifiesto o sube el PDF (hasta 4 MB). Se leen las guías, se cruzan con las prealertas y tú revisas antes de crear nada.
        </p>
        {error ? <ErrorCaja mensaje={error} /> : null}
        <div className="oc-btns">
          <SelectorArchivo etiqueta="Fotografiar manifiesto" camara="environment" tono="primario" disabled={fase === 'leyendo'} onArchivos={(f) => f[0] && void escanear(f[0])} />
          <SelectorArchivo etiqueta="Subir foto o PDF" accept="image/*,application/pdf" disabled={fase === 'leyendo'} onArchivos={(f) => f[0] && void escanear(f[0])} />
          <Boton onClick={() => setPegando((p) => !p)} icono={<ClipboardPaste size={18} />}>
            Pegar lista
          </Boton>
          <Boton tono="suave" onClick={agregarVacio} icono={<Plus size={18} />}>
            Agregar a mano
          </Boton>
        </div>
        {fase === 'leyendo' ? (
          <>
            <div className="oc-escaner" aria-hidden="true" />
            <div className="oc-aviso" role="status">
              <FileScan size={16} style={{ verticalAlign: -3 }} /> Escaneando el documento… puede tardar unos segundos.
            </div>
          </>
        ) : null}
        {pegando ? <Pegar texto={texto} setTexto={setTexto} onAgregar={pegar} /> : null}
      </div>
    );
  }

  return (
    <div className="oc-form">
      {aviso ? <div className="oc-aviso">{aviso}</div> : null}
      {error ? <ErrorCaja mensaje={error} /> : null}
      {fallidas.length ? (
        <div className="oc-error" role="alert">
          <div>
            <b>No se pudo crear:</b>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {fallidas.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            <p style={{ marginTop: 6 }}>Las demás ya quedaron creadas. Corrige y vuelve a intentar con las que siguen aquí.</p>
          </div>
        </div>
      ) : null}

      <div className="oc-chips">
        <Chip tono="good">{conteo('coincide')} coinciden</Chip>
        <Chip tono="warn">{conteo('diferencia')} con diferencia de kilos</Chip>
        <Chip tono="accent">{conteo('sobrante')} sobrantes</Chip>
        {conteo('repetida') + conteo('ya_esta') ? <Chip tono="bad">{conteo('repetida') + conteo('ya_esta')} repetidas o ya cargadas</Chip> : null}
        <Chip tono={faltan.length ? 'warn' : 'good'}>{faltan.length} faltantes en el manifiesto</Chip>
      </div>

      <Tabla
        columnas={[{ t: 'Crear' }, { t: 'Cruce' }, { t: 'Guía' }, { t: 'Tipo' }, { t: 'Guía madre' }, { t: 'Cliente' }, { t: 'Piezas', n: true }, { t: 'Kilos', n: true }, { t: 'Pallets', n: true }, { t: '' }]}
        pie={
          <tr>
            <td colSpan={7}>
              {elegidos.length} de {renglones.length} guías a crear
            </td>
            <td className="n" colSpan={3}>
              {kg(totalKilos)}
            </td>
          </tr>
        }
      >
        {renglones.map((r, i) => {
          const c = cruces[i] as Cruce;
          return (
            <tr key={r.k} className={r.incluir ? '' : 'sin'}>
              <td>
                <input type="checkbox" checked={r.incluir} onChange={(e) => cambiar(r.k, { incluir: e.target.checked })} aria-label="Crear esta guía" style={{ width: 22, height: 22, minHeight: 0, minWidth: 0 }} />
              </td>
              <td title={c.nota}>
                <Chip tono={TONO_CRUCE[c.estado]}>{TEXTO_CRUCE[c.estado]}</Chip>
                {c.estado === 'diferencia' ? <div className="oc-sub">{c.nota}</div> : null}
              </td>
              <td>
                <input type="text" value={r.guia} onChange={(e) => cambiar(r.k, { guia: e.target.value.toUpperCase() })} aria-label="Guía" />
              </td>
              <td>
                <select value={r.tipo} onChange={(e) => cambiar(r.k, { tipo: e.target.value })} aria-label="Tipo de guía">
                  <option value="">—</option>
                  {TIPOS_GUIA.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </td>
              <td>
                <input type="text" value={r.madre} onChange={(e) => cambiar(r.k, { madre: e.target.value.toUpperCase() })} aria-label="Guía madre" />
              </td>
              <td>
                <input type="text" list="oc-clientes" value={r.cliente} onChange={(e) => cambiar(r.k, { cliente: e.target.value })} aria-label="Cliente" style={{ minWidth: 170 }} />
                {r.incluir && r.guia && !c.clienteId ? <div style={{ color: 'var(--malo)', fontSize: 13 }}>Elige un cliente de la lista</div> : null}
              </td>
              <td className="n">
                <input type="text" inputMode="decimal" value={r.piezas} onChange={(e) => cambiar(r.k, { piezas: e.target.value })} aria-label="Piezas" style={{ minWidth: 70, textAlign: 'right' }} />
              </td>
              <td className="n">
                <input type="text" inputMode="decimal" value={r.kilos} onChange={(e) => cambiar(r.k, { kilos: e.target.value })} aria-label="Kilos" style={{ minWidth: 90, textAlign: 'right' }} />
              </td>
              <td className="n">
                <input type="text" inputMode="decimal" value={r.pallets} onChange={(e) => cambiar(r.k, { pallets: e.target.value })} aria-label="Pallets" style={{ minWidth: 70, textAlign: 'right' }} />
              </td>
              <td>
                <Boton chico tono="suave" onClick={() => quitar(r.k)} aria-label="Quitar renglón" icono={<Trash2 size={16} />} />
              </td>
            </tr>
          );
        })}
      </Tabla>
      <datalist id="oc-clientes">
        {clientes.map((c) => (
          <option key={c.id} value={c.label} />
        ))}
      </datalist>

      {faltan.length ? (
        <div className="oc-card aviso tight">
          <h3>Prealertas de este vuelo que no vienen en el manifiesto</h3>
          <ul className="oc-lista" style={{ marginTop: 8 }}>
            {faltan.map((p) => (
              <li key={p.id} className="oc-item-top">
                <span>
                  <b>{p.guia}</b> <span className="oc-sub">{[p.cliente, p.kilos ? kg(p.kilos) : '', p.piezas ? `${num(p.piezas)} piezas` : ''].filter(Boolean).join(' · ')}</span>
                </span>
                <Boton chico onClick={() => setRenglones((prev) => [...prev, renglonDePrealerta(p)])}>
                  Agregar al vuelo
                </Boton>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {sinCliente > 0 ? <p className="oc-sub">Faltan clientes en {sinCliente} guía(s): cada guía necesita un cliente de la lista para poder crearse.</p> : null}
      {sinGuia > 0 ? <p className="oc-sub">Hay {sinGuia} renglón(es) sin número de guía.</p> : null}

      {pegando ? <Pegar texto={texto} setTexto={setTexto} onAgregar={pegar} /> : null}

      <div className="oc-btns">
        <Boton tono="primario" disabled={bloqueado || fase === 'guardando'} onClick={() => void crear()}>
          {fase === 'guardando' ? progreso || 'Creando…' : `Crear ${elegidos.length} guías en ${vuelo.numero}`}
        </Boton>
        <Boton onClick={agregarVacio} icono={<Plus size={18} />} disabled={fase === 'guardando'}>
          Agregar renglón
        </Boton>
        <Boton onClick={() => setPegando((p) => !p)} icono={<ClipboardPaste size={18} />} disabled={fase === 'guardando'}>
          Pegar lista
        </Boton>
        <Boton tono="suave" onClick={reiniciar} disabled={fase === 'guardando'}>
          Empezar de nuevo
        </Boton>
      </div>
    </div>
  );
}

function Pegar({ texto, setTexto, onAgregar }: { texto: string; setTexto: (t: string) => void; onAgregar: () => void }) {
  return (
    <div className="oc-form">
      <textarea
        className="oc-pegar"
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        placeholder={'Una guía por línea. Opcional: piezas y kilos.\n176-12345678\t12\t340,5\n176-12345690\t3\t80'}
        rows={6}
      />
      <div>
        <Boton onClick={onAgregar} disabled={!texto.trim()}>
          Agregar a la revisión
        </Boton>
      </div>
    </div>
  );
}
