import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent } from 'react';
import { cortex } from '@cortex/app-sdk';
import { AlertTriangle, Check, CheckCircle2, ClipboardPaste, FileText, Pencil, Plane, Plus, Search, Send, Trash2, UploadCloud, X } from 'lucide-react';
import { aerolineaDe } from '../lib/aerolineas';
import { Boton, Campo, Chip, Cargando, ErrorCaja, Hoja, Vacio, avisar, mensajeDe } from '../lib/portal-ui';
import {
  CANAL_PORTAL,
  FORM_VACIO,
  aFechaIso,
  aNumero,
  cambios,
  estadoCliente,
  fechaLinda,
  leerPegado,
  normGuia,
  num,
  referenciaDe,
  revisarGuia,
  traerMisPrealertas,
  valoresDe,
} from '../lib/portal-datos';
import type { FormPrealerta, Prealerta } from '../lib/portal-datos';
import '../lib/portal.css';

/**
 * MIS PREALERTAS — la pantalla de un cliente de FUERA (rol «cliente», usuario externo).
 *
 * Qué hace: crear una prealerta en segundos (guía, vuelo, fecha, piezas, kilos y su documento),
 * cargar varias pegando desde Excel y seguir el estado de las suyas.
 *
 * Qué NO hace, a propósito: no lee vuelos, tareas, costos ni eventos; solo la tabla `prealertas`,
 * y el servidor la filtra por SU cliente (`cliente = $user.cliente`) y al crear escribe ese cliente
 * él mismo. Esta pantalla no manda ni lee el cliente: si lo mandara, el servidor lo rechazaría.
 * El estado que ve (Recibida → Cruzada con vuelo → Carga recibida / Con novedad) sale de `estado_cruce`.
 */

type Vista = 'lista' | 'nueva' | 'lote';

const FILTROS = [
  { id: 'todas', texto: 'Todas' },
  { id: 'curso', texto: 'En camino' },
  { id: 'recibidas', texto: 'Recibidas' },
  { id: 'novedad', texto: 'Con novedad' },
] as const;
type Filtro = (typeof FILTROS)[number]['id'];

const PASOS = ['Recibida', 'Cruzada con vuelo', 'Carga recibida'];

function usePortal() {
  const [cliente, setCliente] = useState<string | null>(null);
  const [lista, setLista] = useState<Prealerta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const vivo = useRef(true);
  const refrescar = useCallback(async () => {
    try {
      const [me, filas] = await Promise.all([cortex.user.me(), traerMisPrealertas()]);
      if (!vivo.current) return;
      setCliente((me.attributes?.cliente ?? '').trim());
      setLista(filas);
      setError(null);
    } catch (e) {
      if (vivo.current) setError(mensajeDe(e));
    } finally {
      if (vivo.current) setCargando(false);
    }
  }, []);
  useEffect(() => {
    vivo.current = true;
    void refrescar();
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refrescar();
    }, 60_000);
    return () => {
      vivo.current = false;
      clearInterval(t);
    };
  }, [refrescar]);
  return { cliente, lista, error, cargando, refrescar };
}

export default function Portal() {
  const { cliente, lista, error, cargando, refrescar } = usePortal();
  const [vista, setVista] = useState<Vista | null>(null);
  const [detalle, setDetalle] = useState<Prealerta | null>(null);
  const [hecha, setHecha] = useState<{ ref: string; guia: string; documento: 'si' | 'no' | 'fallo'; aviso?: string }[]>([]);

  const mis = lista ?? [];
  const actual: Vista = vista ?? (lista && lista.length === 0 ? 'nueva' : 'lista');
  const guiasMias = useMemo(() => new Set(mis.filter((p) => p.estado !== 'Duplicada').map((p) => normGuia(p.guia))), [mis]);

  const sinCliente = !cargando && !error && cliente === '';

  return (
    <div className="oc pc">
      <div className="oc-wrap pc-wrap">
        <header className="pc-head">
          <div className="pc-marca" aria-hidden="true">
            <Plane size={22} />
          </div>
          <div>
            <p className="pc-kicker">Prealertas de carga</p>
            <h1>Mis prealertas</h1>
            {cliente ? <p className="pc-sub">{cliente}</p> : null}
          </div>
        </header>

        {error && !lista ? <ErrorCaja mensaje={error} reintentar={() => void refrescar()} /> : null}
        {sinCliente ? (
          <ErrorCaja mensaje="Tu usuario todavía no tiene un cliente asignado, así que no puedes ver ni enviar prealertas. Escríbele a tu contacto en la operación para que lo configure." />
        ) : null}

        <nav className="pc-tabs" aria-label="Secciones">
          <button type="button" className={actual === 'lista' ? 'on' : ''} aria-current={actual === 'lista'} onClick={() => setVista('lista')}>
            Mis prealertas{lista ? <b>{lista.length}</b> : null}
          </button>
          <button type="button" className={actual === 'nueva' ? 'on' : ''} aria-current={actual === 'nueva'} onClick={() => setVista('nueva')}>
            <Plus size={16} /> Nueva
          </button>
          <button type="button" className={actual === 'lote' ? 'on' : ''} aria-current={actual === 'lote'} onClick={() => setVista('lote')}>
            <ClipboardPaste size={16} /> En lote
          </button>
        </nav>

        {actual === 'nueva' ? (
          <NuevaPrealerta
            existentes={guiasMias}
            bloqueado={sinCliente}
            hecha={hecha[0] ?? null}
            onCreada={(h) => {
              setHecha([h]);
              void refrescar();
            }}
            onOtra={() => setHecha([])}
            onVer={() => setVista('lista')}
          />
        ) : null}
        {actual === 'lote' ? <Lote existentes={guiasMias} bloqueado={sinCliente} onTerminado={() => void refrescar()} onVer={() => setVista('lista')} /> : null}
        {actual === 'lista' ? <Lista lista={mis} cargando={cargando && !lista} onAbrir={setDetalle} onNueva={() => setVista('nueva')} /> : null}
      </div>

      {detalle ? (
        <Detalle
          p={mis.find((x) => x.id === detalle.id) ?? detalle}
          onCerrar={() => setDetalle(null)}
          onCambio={async () => {
            await refrescar();
          }}
        />
      ) : null}
    </div>
  );
}

/* ───────────── Lista ───────────── */

function Lista({ lista, cargando, onAbrir, onNueva }: { lista: Prealerta[]; cargando: boolean; onAbrir: (p: Prealerta) => void; onNueva: () => void }) {
  const [q, setQ] = useState('');
  const [filtro, setFiltro] = useState<Filtro>('todas');
  const repetidas = useMemo(() => {
    const cuenta = new Map<string, number>();
    for (const p of lista) if (p.estado !== 'Duplicada') cuenta.set(normGuia(p.guia), (cuenta.get(normGuia(p.guia)) ?? 0) + 1);
    return new Set([...cuenta].filter(([, n]) => n > 1).map(([g]) => g));
  }, [lista]);
  const conteo = useMemo(() => {
    const c = { todas: lista.length, curso: 0, recibidas: 0, novedad: 0 };
    for (const p of lista) {
      const e = estadoCliente(p);
      if (e.novedad) c.novedad++;
      else if (e.paso === 3) c.recibidas++;
      else if (!e.cancelada) c.curso++;
    }
    return c;
  }, [lista]);
  const visibles = useMemo(() => {
    const nq = normGuia(q);
    const tq = q.trim().toLowerCase();
    return lista.filter((p) => {
      const e = estadoCliente(p);
      if (filtro === 'curso' && (e.paso === 3 || e.cancelada)) return false;
      if (filtro === 'recibidas' && (e.paso !== 3 || e.novedad)) return false;
      if (filtro === 'novedad' && !e.novedad) return false;
      if (!q.trim()) return true;
      return normGuia(p.guia).includes(nq) || (tq.length > 1 && `${p.numeroVuelo} ${p.origen} ${p.descripcion}`.toLowerCase().includes(tq));
    });
  }, [lista, q, filtro]);

  if (cargando) return <Cargando filas={4} />;
  if (!lista.length)
    return (
      <Vacio titulo="Aún no has enviado prealertas">
        <p>Avísanos qué carga viene en camino y la tendremos lista a su llegada.</p>
        <div style={{ marginTop: 14 }}>
          <Boton tono="primario" icono={<Plus size={18} />} onClick={onNueva}>
            Nueva prealerta
          </Boton>
        </div>
      </Vacio>
    );

  return (
    <section>
      <div className="pc-busca">
        <Search size={18} aria-hidden="true" />
        <input type="search" inputMode="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por guía (176-12345675), vuelo u origen" aria-label="Buscar prealertas" />
        {q ? (
          <button type="button" onClick={() => setQ('')} aria-label="Borrar búsqueda">
            <X size={16} />
          </button>
        ) : null}
      </div>
      <div className="pc-filtros" role="group" aria-label="Filtrar por estado">
        {FILTROS.map((f) => (
          <button key={f.id} type="button" aria-pressed={filtro === f.id} onClick={() => setFiltro(f.id)}>
            {f.texto} <b>{conteo[f.id]}</b>
          </button>
        ))}
      </div>
      {repetidas.size ? (
        <p className="pc-nota aviso" role="status">
          <AlertTriangle size={16} aria-hidden="true" /> Tienes {repetidas.size === 1 ? 'una guía repetida' : `${repetidas.size} guías repetidas`}. Las marcamos en la lista.
        </p>
      ) : null}
      {!visibles.length ? (
        <Vacio titulo="No encontramos prealertas con ese filtro">
          <p>Prueba con otra guía o quita el filtro.</p>
        </Vacio>
      ) : (
        <ul className="pc-lista">
          {visibles.map((p) => {
            const e = estadoCliente(p);
            return (
              <li key={p.id}>
                <button type="button" className={`pc-fila ${e.novedad ? 'novedad' : ''}`} onClick={() => onAbrir(p)} aria-label={`Guía ${p.guia}, ${e.texto}`}>
                  <span className="pc-fila-top">
                    <strong className="pc-guia">{p.guia}</strong>
                    <span className="pc-chips">
                      {repetidas.has(normGuia(p.guia)) && p.estado !== 'Duplicada' ? <Chip tono="warn">Repetida</Chip> : null}
                      <Chip tono={e.tono}>{e.texto}</Chip>
                    </span>
                  </span>
                  <span className="pc-fila-meta">
                    {p.numeroVuelo ? (
                      <span>
                        <Plane size={14} aria-hidden="true" /> {p.numeroVuelo}
                        {p.fecha ? ` · ${fechaLinda(p.fecha)}` : ''}
                      </span>
                    ) : (
                      <span className="pc-tenue">Sin vuelo indicado</span>
                    )}
                    {p.origen ? <span>{p.origen}</span> : null}
                    <span>
                      {p.piezas !== null ? `${num(p.piezas)} pzs` : '— pzs'} · {p.kilos !== null ? `${num(p.kilos, 1)} kg` : '— kg'}
                    </span>
                  </span>
                  <Pasos paso={e.cancelada ? 0 : e.paso} novedad={e.novedad} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Pasos({ paso, novedad }: { paso: number; novedad?: boolean }) {
  return (
    <span className="pc-pasos" aria-hidden="true">
      {PASOS.map((t, i) => (
        <span key={t} className={`${i < paso ? 'hecho' : ''} ${i === paso - 1 ? 'ahora' : ''} ${novedad && i === 2 ? 'novedad' : ''}`}>
          <i />
          <em>{i === 2 && novedad ? 'Con novedad' : t}</em>
        </span>
      ))}
    </span>
  );
}

/* ───────────── Formulario (nueva y edición) ───────────── */

function FormularioPrealerta({
  valor,
  onChange,
  existentes,
  propia,
  deshabilitado,
}: {
  valor: FormPrealerta;
  onChange: (v: FormPrealerta) => void;
  existentes: Set<string>;
  /** La guía de la prealerta que se edita (no cuenta como repetida de sí misma). */
  propia?: string;
  deshabilitado?: boolean;
}) {
  const aeroManual = useRef(Boolean(valor.aerolinea));
  const set = (c: keyof FormPrealerta, v: string) => onChange({ ...valor, [c]: v });
  const ver = valor.guia.trim() ? revisarGuia(valor.guia) : null;
  const repetida = ver?.ok && normGuia(ver.formateada) !== normGuia(propia) && existentes.has(normGuia(ver.formateada));
  const alVuelo = (t: string) => {
    const a = !aeroManual.current ? aerolineaDe(t) : null;
    onChange({ ...valor, vuelo: t, aerolinea: !aeroManual.current ? (a ?? '') : valor.aerolinea });
  };
  return (
    <div className="pc-form">
      <Campo etiqueta="Número de guía (AWB)*" ayuda="11 dígitos: 3 del prefijo y 8 de la serie. Ej. 176-12345675">
        <input
          className="pc-guia-in"
          inputMode="numeric"
          autoComplete="off"
          value={valor.guia}
          disabled={deshabilitado}
          onChange={(e) => set('guia', e.target.value)}
          onBlur={() => {
            const v = revisarGuia(valor.guia);
            if (v.ok) set('guia', v.formateada);
          }}
          placeholder="176-12345675"
          aria-invalid={ver ? !ver.ok : undefined}
        />
        {ver && !ver.ok ? <span className="pc-aviso bad">{ver.motivo}</span> : null}
        {ver?.ok && !ver.control ? (
          <span className="pc-aviso warn">
            <AlertTriangle size={14} aria-hidden="true" /> El último dígito no cuadra con la serie (debería ser {ver.esperado}). Revisa que la guía esté bien escrita.
          </span>
        ) : null}
        {ver?.ok && ver.control ? (
          <span className="pc-aviso ok">
            <CheckCircle2 size={14} aria-hidden="true" /> Guía válida
          </span>
        ) : null}
        {repetida ? (
          <span className="pc-aviso warn">
            <AlertTriangle size={14} aria-hidden="true" /> Ya enviaste una prealerta con esta guía. Si la envías otra vez, el sistema la rechazará como repetida.
          </span>
        ) : null}
      </Campo>
      <div className="pc-grid">
        <Campo etiqueta="Número de vuelo" ayuda="Ej. AV 123 o LA8044. Con él ponemos la aerolínea.">
          <input value={valor.vuelo} disabled={deshabilitado} onChange={(e) => alVuelo(e.target.value.toUpperCase())} placeholder="AV123" autoCapitalize="characters" />
        </Campo>
        <Campo etiqueta="Aerolínea">
          <input
            value={valor.aerolinea}
            disabled={deshabilitado}
            onChange={(e) => {
              aeroManual.current = true;
              set('aerolinea', e.target.value);
            }}
            placeholder="Se completa sola"
          />
        </Campo>
        <Campo etiqueta="Fecha estimada de llegada">
          <input type="date" value={valor.fecha} disabled={deshabilitado} onChange={(e) => set('fecha', e.target.value)} />
        </Campo>
        <Campo etiqueta="Origen" ayuda="Ciudad o aeropuerto (MIA, Miami…)">
          <input value={valor.origen} disabled={deshabilitado} onChange={(e) => set('origen', e.target.value)} placeholder="MIA" />
        </Campo>
        <Campo etiqueta="Piezas">
          <input inputMode="numeric" value={valor.piezas} disabled={deshabilitado} onChange={(e) => set('piezas', e.target.value)} placeholder="0" />
        </Campo>
        <Campo etiqueta="Kilos">
          <input inputMode="decimal" value={valor.kilos} disabled={deshabilitado} onChange={(e) => set('kilos', e.target.value)} placeholder="0,0" />
        </Campo>
      </div>
      <Campo etiqueta="Descripción de la carga">
        <textarea rows={2} value={valor.descripcion} disabled={deshabilitado} onChange={(e) => set('descripcion', e.target.value)} placeholder="Ej. Repuestos de automóvil, 4 cajas" />
      </Campo>
    </div>
  );
}

const esValida = (f: FormPrealerta): boolean => revisarGuia(f.guia).ok;

/** Caja de documento (guía o factura): elegir, soltar o fotografiar. */
function CajaDocumento({ archivo, onArchivo, deshabilitado }: { archivo: File | null; onArchivo: (f: File | null) => void; deshabilitado?: boolean }) {
  const [sobre, setSobre] = useState(false);
  const tomar = (fs: FileList | File[] | null) => {
    const f = fs && fs.length ? fs[0]! : null;
    if (!f) return;
    if (f.size > 12 * 1024 * 1024) {
      avisar('El archivo pesa más de 12 MB. Envía uno más liviano.');
      return;
    }
    onArchivo(f);
  };
  return (
    <div className="oc-campo">
      <span className="oc-label">Documento (guía aérea o factura)</span>
      {archivo ? (
        <div className="pc-arch">
          <FileText size={20} aria-hidden="true" />
          <span>
            <strong>{archivo.name}</strong>
            <small>{archivo.size >= 1048576 ? `${(archivo.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(archivo.size / 1024))} KB`}</small>
          </span>
          <Boton chico tono="suave" onClick={() => onArchivo(null)} disabled={deshabilitado} aria-label="Quitar documento" icono={<X size={16} />} />
        </div>
      ) : (
        <label
          className={`pc-suelta ${sobre ? 'sobre' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setSobre(true);
          }}
          onDragLeave={() => setSobre(false)}
          onDrop={(e) => {
            e.preventDefault();
            setSobre(false);
            tomar(e.dataTransfer.files);
          }}
        >
          <UploadCloud size={24} aria-hidden="true" />
          <strong>Toca para adjuntar o suelta el archivo aquí</strong>
          <small>PDF o foto, hasta 12 MB. Es opcional, pero nos ayuda a recibir tu carga más rápido.</small>
          <input
            type="file"
            accept="application/pdf,image/*"
            disabled={deshabilitado}
            onChange={(e) => {
              tomar(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      )}
    </div>
  );
}

/* ───────────── Nueva prealerta ───────────── */

function NuevaPrealerta({
  existentes,
  bloqueado,
  hecha,
  onCreada,
  onOtra,
  onVer,
}: {
  existentes: Set<string>;
  bloqueado: boolean;
  hecha: { ref: string; guia: string; documento: 'si' | 'no' | 'fallo'; aviso?: string } | null;
  onCreada: (h: { ref: string; guia: string; documento: 'si' | 'no' | 'fallo'; aviso?: string }) => void;
  onOtra: () => void;
  onVer: () => void;
}) {
  const [f, setF] = useState<FormPrealerta>(FORM_VACIO);
  const [archivo, setArchivo] = useState<File | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enviar = async () => {
    if (ocupado || !esValida(f)) return;
    setOcupado(true);
    setError(null);
    try {
      const fila = await cortex.tables.insert('prealertas', valoresDe(f, { canal: CANAL_PORTAL }));
      let documento: 'si' | 'no' | 'fallo' = 'no';
      let aviso: string | undefined;
      if (archivo) {
        try {
          await cortex.files.upload(archivo, { table: 'prealertas', id: fila.id, field: 'documento', name: archivo.name });
          documento = 'si';
        } catch (e) {
          documento = 'fallo';
          aviso = mensajeDe(e);
        }
      }
      const v = revisarGuia(f.guia);
      onCreada({ ref: referenciaDe(fila.id), guia: v.ok ? v.formateada : f.guia, documento, aviso });
      setF(FORM_VACIO);
      setArchivo(null);
    } catch (e) {
      setError(mensajeDe(e));
    } finally {
      setOcupado(false);
    }
  };

  if (hecha)
    return (
      <section className="oc-card pc-listo" role="status">
        <div className="pc-listo-ico" aria-hidden="true">
          <Check size={30} />
        </div>
        <h2>Recibimos tu prealerta</h2>
        <p className="pc-listo-guia">{hecha.guia}</p>
        <p className="pc-ref">
          Referencia <strong>{hecha.ref}</strong>
        </p>
        <p className="pc-sub">Nuestro equipo documental ya fue avisado. La cruzaremos con el vuelo y aquí verás cómo avanza.</p>
        {hecha.documento === 'si' ? <p className="pc-nota ok">Documento adjuntado.</p> : null}
        {hecha.documento === 'fallo' ? (
          <p className="pc-nota aviso">
            <AlertTriangle size={16} aria-hidden="true" /> La prealerta quedó registrada, pero el documento no se pudo subir ({hecha.aviso}). Ábrela en «Mis prealertas» y adjúntalo de nuevo.
          </p>
        ) : null}
        <div className="pc-acciones">
          <Boton tono="primario" icono={<Plus size={18} />} onClick={onOtra}>
            Enviar otra
          </Boton>
          <Boton onClick={onVer}>Ver mis prealertas</Boton>
        </div>
      </section>
    );

  return (
    <section className="oc-card pc-card">
      <h2>Nueva prealerta</h2>
      <p className="pc-sub">Avísanos qué carga viene en camino. Solo la guía es obligatoria; entre más datos, más rápido la recibimos.</p>
      <FormularioPrealerta valor={f} onChange={setF} existentes={existentes} deshabilitado={ocupado || bloqueado} />
      <CajaDocumento archivo={archivo} onArchivo={setArchivo} deshabilitado={ocupado || bloqueado} />
      {error ? <ErrorCaja mensaje={error} /> : null}
      <div className="pc-barra">
        <Boton tono="primario" grande icono={<Send size={18} />} disabled={ocupado || bloqueado || !esValida(f)} onClick={() => void enviar()}>
          {ocupado ? 'Enviando…' : 'Enviar prealerta'}
        </Boton>
      </div>
    </section>
  );
}

/* ───────────── Varias a la vez ───────────── */

interface FilaLote extends Record<string, string> {
  k: string;
  guia: string;
  vuelo: string;
  fecha: string;
  origen: string;
  piezas: string;
  kilos: string;
  descripcion: string;
  resultado: string;
}

let SEQ = 0;
const filaVacia = (): FilaLote => ({ k: `f${Date.now().toString(36)}${SEQ++}`, guia: '', vuelo: '', fecha: '', origen: '', piezas: '', kilos: '', descripcion: '', resultado: '' });
const conDatos = (f: FilaLote): boolean => Boolean(f.guia.trim() || f.vuelo.trim() || f.piezas.trim() || f.kilos.trim() || f.origen.trim() || f.descripcion.trim());
const conVacias = (fs: FilaLote[]): FilaLote[] => {
  const base = fs.filter(conDatos);
  return [...base, ...Array.from({ length: 3 }, filaVacia)];
};

const COLS: { c: keyof FilaLote; t: string; n?: boolean; ancho: number; ph?: string }[] = [
  { c: 'guia', t: 'Guía', ancho: 160, ph: '176-12345675' },
  { c: 'vuelo', t: 'Vuelo', ancho: 90, ph: 'AV123' },
  { c: 'fecha', t: 'Fecha', ancho: 130, ph: 'dd/mm/aaaa' },
  { c: 'origen', t: 'Origen', ancho: 90, ph: 'MIA' },
  { c: 'piezas', t: 'Piezas', n: true, ancho: 80 },
  { c: 'kilos', t: 'Kilos', n: true, ancho: 90 },
  { c: 'descripcion', t: 'Descripción', ancho: 220 },
];

function Lote({ existentes, bloqueado, onTerminado, onVer }: { existentes: Set<string>; bloqueado: boolean; onTerminado: () => void; onVer: () => void }) {
  const [filas, setFilas] = useState<FilaLote[]>(() => conVacias([]));
  const [texto, setTexto] = useState('');
  const [comun, setComun] = useState({ vuelo: '', fecha: '', origen: '' });
  const [ocupado, setOcupado] = useState(false);
  const [progreso, setProgreso] = useState('');
  const [resumen, setResumen] = useState<{ creadas: number; falladas: number } | null>(null);

  const agregar = (rs: ReturnType<typeof leerPegado>, desde?: number) => {
    const nuevas: FilaLote[] = rs.map((r) => ({
      ...filaVacia(),
      guia: (() => {
        const v = revisarGuia(r.guia);
        return v.ok ? v.formateada : r.guia;
      })(),
      vuelo: r.vuelo.toUpperCase(),
      fecha: aFechaIso(r.fecha) || r.fecha,
      origen: r.origen,
      piezas: r.piezas,
      kilos: r.kilos,
      descripcion: r.descripcion,
    }));
    setFilas((p) => {
      if (desde === undefined) return conVacias([...p.filter(conDatos), ...nuevas]);
      const antes = p.slice(0, desde).filter(conDatos);
      const despues = p.slice(desde + 1).filter(conDatos);
      return conVacias([...antes, ...nuevas, ...(conDatos(p[desde]!) ? [p[desde]!] : []), ...despues]);
    });
    setResumen(null);
  };
  const alPegar = (e: ClipboardEvent, i: number) => {
    const t = e.clipboardData.getData('text');
    if (!/\t|\n/.test(t)) return;
    e.preventDefault();
    const rs = leerPegado(t);
    if (!rs.length) return;
    agregar(rs, i);
    avisar(`${rs.length} renglones pegados.`);
  };
  const cambiar = (i: number, c: keyof FilaLote, v: string) => setFilas((p) => conVacias(p.map((f, j) => (j === i ? { ...f, [c]: c === 'guia' || c === 'vuelo' ? v.toUpperCase() : v, resultado: '' } : f))));
  const quitar = (i: number) => setFilas((p) => conVacias(p.filter((_, j) => j !== i)));

  const revisadas = useMemo(() => {
    const vistas = new Map<string, number>();
    return filas.map((f) => {
      if (!conDatos(f)) return { f, estado: 'vacia' as const, msg: '' };
      const v = revisarGuia(f.guia);
      if (!v.ok) return { f, estado: 'mal' as const, msg: v.motivo };
      const g = normGuia(v.formateada);
      const veces = (vistas.get(g) ?? 0) + 1;
      vistas.set(g, veces);
      if (veces > 1) return { f, estado: 'mal' as const, msg: 'Repetida en esta tabla.' };
      if (existentes.has(g)) return { f, estado: 'mal' as const, msg: 'Ya la prealertaste antes.' };
      if (f.fecha && !/^\d{4}-\d{2}-\d{2}$/.test(aFechaIso(f.fecha) || f.fecha)) return { f, estado: 'mal' as const, msg: 'La fecha no se entiende (usa dd/mm/aaaa).' };
      if (f.piezas.trim() && aNumero(f.piezas) === null) return { f, estado: 'mal' as const, msg: 'Las piezas deben ser un número.' };
      if (f.kilos.trim() && aNumero(f.kilos) === null) return { f, estado: 'mal' as const, msg: 'Los kilos deben ser un número.' };
      if (!v.control) return { f, estado: 'aviso' as const, msg: `El último dígito no cuadra (debería ser ${v.esperado}). Revísala; si el sistema la rechaza, corrígela.` };
      return { f, estado: 'ok' as const, msg: '' };
    });
  }, [filas, existentes]);

  const aEnviar = revisadas.filter((r) => r.estado === 'ok' || r.estado === 'aviso');
  const conError = revisadas.filter((r) => r.estado === 'mal').length;
  const totalPzs = aEnviar.reduce((s, r) => s + (aNumero(r.f.piezas) ?? 0), 0);
  const totalKg = aEnviar.reduce((s, r) => s + (aNumero(r.f.kilos) ?? 0), 0);

  const enviar = async () => {
    if (ocupado || !aEnviar.length) return;
    setOcupado(true);
    let creadas = 0;
    let falladas = 0;
    const hechas = new Set<string>();
    const mensajes = new Map<string, string>();
    for (let i = 0; i < aEnviar.length; i++) {
      const { f } = aEnviar[i]!;
      setProgreso(`Enviando ${i + 1} de ${aEnviar.length}…`);
      const vuelo = (f.vuelo || comun.vuelo).trim();
      const form: FormPrealerta = {
        guia: f.guia,
        vuelo,
        aerolinea: aerolineaDe(vuelo) ?? '',
        fecha: aFechaIso(f.fecha) || aFechaIso(comun.fecha) || '',
        origen: (f.origen || comun.origen).trim(),
        piezas: f.piezas,
        kilos: f.kilos,
        descripcion: f.descripcion,
      };
      try {
        await cortex.tables.insert('prealertas', valoresDe(form, { canal: CANAL_PORTAL }));
        creadas++;
        hechas.add(f.k);
      } catch (e) {
        falladas++;
        mensajes.set(f.k, mensajeDe(e));
      }
    }
    setProgreso('');
    setOcupado(false);
    setResumen({ creadas, falladas });
    setFilas((p) => conVacias(p.filter((f) => !hechas.has(f.k)).map((f) => (mensajes.has(f.k) ? { ...f, resultado: mensajes.get(f.k)! } : f))));
    if (creadas) {
      avisar(`${creadas} prealerta${creadas === 1 ? '' : 's'} enviada${creadas === 1 ? '' : 's'}.`);
      onTerminado();
    }
  };

  return (
    <section className="oc-card pc-card">
      <h2>Varias prealertas a la vez</h2>
      <p className="pc-sub">
        Copia las filas de tu Excel y pégalas en la tabla (o en el cuadro). Reconocemos las columnas por su encabezado: <em>Guía, Vuelo, Fecha, Origen, Piezas, Kilos, Descripción</em>. Sin encabezado, van en ese orden.
      </p>
      <details className="pc-pegar">
        <summary>
          <ClipboardPaste size={16} aria-hidden="true" /> Pegar texto
        </summary>
        <textarea
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          rows={4}
          placeholder={'Guía\tVuelo\tFecha\tOrigen\tPiezas\tKilos\n176-12345675\tAV123\t12/11/2026\tMIA\t12\t340,5'}
        />
        <Boton
          chico
          disabled={!texto.trim()}
          onClick={() => {
            const rs = leerPegado(texto);
            if (!rs.length) return avisar('No encontramos guías en ese texto.');
            agregar(rs);
            setTexto('');
            avisar(`${rs.length} renglones agregados.`);
          }}
        >
          Agregar a la tabla
        </Boton>
      </details>

      <div className="pc-comun">
        <span>Para las filas sin dato, usar:</span>
        <input value={comun.vuelo} onChange={(e) => setComun({ ...comun, vuelo: e.target.value.toUpperCase() })} placeholder="Vuelo" aria-label="Vuelo para todas" />
        <input type="date" value={comun.fecha} onChange={(e) => setComun({ ...comun, fecha: e.target.value })} aria-label="Fecha para todas" />
        <input value={comun.origen} onChange={(e) => setComun({ ...comun, origen: e.target.value })} placeholder="Origen" aria-label="Origen para todas" />
      </div>

      <div className="pc-hoja" role="region" aria-label="Tabla de prealertas">
        <table className="pc-t">
          <thead>
            <tr>
              <th className="n">#</th>
              {COLS.map((c) => (
                <th key={c.c} className={c.n ? 'num' : ''}>
                  {c.t}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {revisadas.map(({ f, estado, msg }, i) => (
              <tr key={f.k} className={estado === 'mal' ? 'mal' : estado === 'aviso' ? 'aviso' : ''}>
                <td className="n">{i + 1}</td>
                {COLS.map((c) => (
                  <td key={c.c} className={c.n ? 'num' : ''} style={{ minWidth: c.ancho }}>
                    <input
                      value={f[c.c]}
                      disabled={ocupado || bloqueado}
                      inputMode={c.n ? 'decimal' : undefined}
                      placeholder={i < 3 ? c.ph : undefined}
                      onChange={(e) => cambiar(i, c.c, e.target.value)}
                      onPaste={(e) => alPegar(e, i)}
                      aria-label={`${c.t} ${i + 1}`}
                    />
                  </td>
                ))}
                <td className="x">
                  {conDatos(f) ? (
                    <button type="button" onClick={() => quitar(i)} aria-label={`Quitar fila ${i + 1}`} disabled={ocupado}>
                      <Trash2 size={15} />
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {revisadas.some((r) => r.msg || r.f.resultado) ? (
        <ul className="pc-problemas">
          {revisadas.map(({ f, estado, msg }, i) =>
            msg || f.resultado ? (
              <li key={f.k} className={estado === 'mal' || f.resultado ? 'mal' : 'aviso'}>
                <b>Fila {i + 1}{f.guia ? ` (${f.guia})` : ''}:</b> {f.resultado ? `El sistema no la aceptó: ${f.resultado}` : msg}
              </li>
            ) : null,
          )}
        </ul>
      ) : null}

      <div className="pc-totales">
        <span>
          <strong>{aEnviar.length}</strong> guías listas
        </span>
        <span>
          <strong>{num(totalPzs)}</strong> piezas
        </span>
        <span>
          <strong>{num(totalKg, 1)}</strong> kg
        </span>
        {conError ? (
          <span className="mal">
            <strong>{conError}</strong> con error (no se enviarán)
          </span>
        ) : null}
      </div>

      {resumen ? (
        <p className={`pc-nota ${resumen.falladas ? 'aviso' : 'ok'}`} role="status">
          {resumen.creadas ? `Enviamos ${resumen.creadas} prealerta${resumen.creadas === 1 ? '' : 's'}. ` : ''}
          {resumen.falladas ? `${resumen.falladas} no se pudieron enviar: quedaron en la tabla con su motivo.` : 'Nuestro equipo documental ya fue avisado.'}{' '}
          {resumen.creadas ? (
            <button type="button" className="pc-enlace" onClick={onVer}>
              Ver mis prealertas
            </button>
          ) : null}
        </p>
      ) : null}

      <div className="pc-barra">
        <Boton tono="primario" grande icono={<Send size={18} />} disabled={ocupado || bloqueado || !aEnviar.length} onClick={() => void enviar()}>
          {ocupado ? progreso || 'Enviando…' : aEnviar.length ? `Enviar ${aEnviar.length} prealerta${aEnviar.length === 1 ? '' : 's'}` : 'Enviar'}
        </Boton>
        <Boton tono="suave" disabled={ocupado} onClick={() => setFilas(conVacias([]))}>
          Vaciar tabla
        </Boton>
      </div>
    </section>
  );
}

/* ───────────── Detalle ───────────── */

function Detalle({ p, onCerrar, onCambio }: { p: Prealerta; onCerrar: () => void; onCambio: () => Promise<void> }) {
  const e = estadoCliente(p);
  const [editando, setEditando] = useState(false);
  const [f, setF] = useState<FormPrealerta>({
    guia: p.guia,
    vuelo: p.numeroVuelo,
    aerolinea: p.aerolinea,
    fecha: p.fecha,
    origen: p.origen,
    piezas: p.piezas === null ? '' : String(p.piezas),
    kilos: p.kilos === null ? '' : String(p.kilos),
    descripcion: p.descripcion,
  });
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const correr = async (fn: () => Promise<unknown>, ok: string): Promise<boolean> => {
    setOcupado(true);
    setError(null);
    try {
      await fn();
      avisar(ok);
      await onCambio();
      return true;
    } catch (err) {
      setError(mensajeDe(err));
      return false;
    } finally {
      setOcupado(false);
    }
  };

  const guardar = async () => {
    const c = cambios(p, f);
    if (!Object.keys(c).length) return setEditando(false);
    if (await correr(() => cortex.tables.update('prealertas', p.id, c), 'Cambios guardados.')) setEditando(false);
  };
  const cancelar = async () => {
    const ok = await cortex.ui.confirm(`¿Pedir la cancelación de la guía ${p.guia}? Nuestro equipo documental la confirmará.`, { confirmLabel: 'Pedir cancelación', danger: true }).catch(() => false);
    if (!ok) return;
    await correr(() => cortex.tables.update('prealertas', p.id, { cancelacion: 'Pedida' }), 'Pedimos la cancelación. Documental la confirmará.');
  };
  const adjuntar = async (file: File | null) => {
    if (!file) return;
    await correr(() => cortex.files.upload(file, { table: 'prealertas', id: p.id, field: 'documento', name: file.name }), 'Documento adjuntado.');
  };

  return (
    <Hoja titulo={`Guía ${p.guia}`} onCerrar={onCerrar}>
      <div className="pc-det">
        <div className="pc-det-estado">
          <Chip tono={e.tono}>{e.texto}</Chip>
          <small>Referencia {referenciaDe(p.id)}</small>
        </div>
        <Pasos paso={e.cancelada ? 0 : e.paso} novedad={e.novedad} />
        <p className={`pc-nota ${e.novedad ? 'aviso' : 'info'}`}>{e.sigue}</p>

        {editando ? (
          <>
            <FormularioPrealerta valor={f} onChange={setF} existentes={new Set()} propia={p.guia} deshabilitado={ocupado} />
            {error ? <ErrorCaja mensaje={error} /> : null}
            <div className="pc-barra">
              <Boton tono="primario" disabled={ocupado || !esValida(f)} onClick={() => void guardar()}>
                {ocupado ? 'Guardando…' : 'Guardar cambios'}
              </Boton>
              <Boton tono="suave" disabled={ocupado} onClick={() => setEditando(false)}>
                Descartar
              </Boton>
            </div>
          </>
        ) : (
          <>
            <dl className="pc-datos">
              <div>
                <dt>Vuelo</dt>
                <dd>{p.numeroVuelo || '—'}{p.aerolinea ? ` · ${p.aerolinea}` : ''}</dd>
              </div>
              <div>
                <dt>Llegada estimada</dt>
                <dd>{p.fecha ? fechaLinda(p.fecha) : '—'}</dd>
              </div>
              <div>
                <dt>Origen</dt>
                <dd>{p.origen || '—'}</dd>
              </div>
              <div>
                <dt>Piezas</dt>
                <dd>{p.piezas !== null ? num(p.piezas) : '—'}</dd>
              </div>
              <div>
                <dt>Kilos</dt>
                <dd>{p.kilos !== null ? num(p.kilos, 1) : '—'}</dd>
              </div>
              <div>
                <dt>Enviada</dt>
                <dd>{new Date(p.creada).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Bogota' })}</dd>
              </div>
              {p.descripcion ? (
                <div className="ancho">
                  <dt>Descripción</dt>
                  <dd>{p.descripcion}</dd>
                </div>
              ) : null}
            </dl>
            <div className="pc-docs">
              <span className="oc-label">Documento</span>
              {p.documentos.length ? (
                p.documentos.map((d) => (
                  <a key={d.url} className="oc-doc" href={d.url} target="_blank" rel="noreferrer">
                    <FileText size={16} /> {d.name}
                  </a>
                ))
              ) : (
                <small className="pc-tenue">Sin documento adjunto.</small>
              )}
              {e.editable ? <AdjuntarMas onArchivo={(file) => void adjuntar(file)} ocupado={ocupado} tiene={p.documentos.length > 0} /> : null}
            </div>
            {error ? <ErrorCaja mensaje={error} /> : null}
            {e.editable ? (
              <div className="pc-barra">
                <Boton icono={<Pencil size={16} />} onClick={() => setEditando(true)} disabled={ocupado}>
                  Corregir datos
                </Boton>
                <Boton tono="suave" icono={<X size={16} />} onClick={() => void cancelar()} disabled={ocupado}>
                  Pedir cancelación
                </Boton>
              </div>
            ) : (
              <p className="pc-tenue pc-pie">
                {e.cancelada ? 'Ya pediste cancelar esta prealerta.' : 'Esta prealerta ya está cruzada con un vuelo, por eso no se puede corregir desde aquí. Si algo está mal, escríbele al equipo documental con tu referencia.'}
              </p>
            )}
          </>
        )}
      </div>
    </Hoja>
  );
}

function AdjuntarMas({ onArchivo, ocupado, tiene }: { onArchivo: (f: File | null) => void; ocupado: boolean; tiene: boolean }) {
  return (
    <label className="oc-btn chico oc-sel-arch" aria-disabled={ocupado}>
      <UploadCloud size={16} /> {tiene ? 'Reemplazar documento' : 'Adjuntar documento'}
      <input
        type="file"
        accept="application/pdf,image/*"
        disabled={ocupado}
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null;
          e.target.value = '';
          if (file && file.size > 12 * 1024 * 1024) return avisar('El archivo pesa más de 12 MB.');
          onArchivo(file);
        }}
      />
    </label>
  );
}
