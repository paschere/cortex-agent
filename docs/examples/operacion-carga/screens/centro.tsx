import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cortex, useLocations } from '@cortex/app-sdk';
import { AlertOctagon, AlertTriangle, Bell, BellOff, CheckCircle2, ClipboardList, Eye, FileWarning, HandHelping, MapPin, Maximize2, Minimize2, Moon, Plane, Sun, Users, X } from 'lucide-react';
import { RESPALDO_VIVO_MS, aAtencion, aVuelo, traerTodo, useCarga, useRol } from '../lib/datos';
import { cargarTareas, usePersonas } from '../lib/tareas';
import { hayCampo, isoBogota, useAhora, useEsquema } from '../lib/documental';
import { FILTROS, OBJETIVOS, armarActivas, armarNovedades, armarOperarios, esVisto, estaEscalada, haceTxt, pasaFiltro } from '../lib/centro';
import type { Filtro, Novedad } from '../lib/centro';
import { hayVivo, useEstadoVivo } from '../lib/enVivo';
import { prepararSonido, pitar, vibrar } from '../lib/Sonido';
import { Cifra, IndicadorConexion, TarjetaActiva, VistaVuelo } from '../lib/PiezasCentro';
import { fechaLarga, hhmm } from '../lib/formato';
import { hoyBogota } from '../lib/tiempo';
import { useGuardado } from '../lib/guardado';
import { Boton, Chip, ErrorCaja, Estado, Frase, Hoja, Metrica, Pantalla, Tarjeta, avisar, mensajeDe } from '../lib/ui';
import '../lib/centro.css';

/**
 * CENTRO DE ATENCIÓN — tablero EN VIVO de atención y novedades para el supervisor, el documental y gerencia.
 * Los cambios llegan en 1–2 s (tiempo real del SDK; si no hay, sondeo). Novedades que entran animadas, críticas
 * con sonido y escalamiento, cronómetros por etapa contra su objetivo (lib/centro.ts → OBJETIVOS) y operarios
 * en turno. Modo TV: pantalla completa, letra grande, tema oscuro opcional y rotación automática de secciones.
 */

const TABLAS_VIVO = ['eventos_operacion', 'vuelos', 'atenciones', 'tareas_operacion', 'prefacturacion'];
/** Cuánto dura resaltada una novedad recién llegada. */
const NUEVA_MS = 9_000;
/** En modo TV: cada cuánto cambia de sección y cuánto sin tocar nada antes de rotar. */
const ROTA_CADA_MS = 12_000;
const SIN_TOCAR_MS = 20_000;
const SECCIONES_TV = ['novedades', 'atenciones', 'operarios'] as const;
type SeccionTv = (typeof SECCIONES_TV)[number];
const TEXTO_SECCION: Record<SeccionTv, string> = { novedades: 'Novedades', atenciones: 'Atenciones activas', operarios: 'Operarios en turno' };

async function cargar() {
  const hoy = hoyBogota();
  const [ev, vs, ats, tareas, gu] = await Promise.all([
    traerTodo('eventos_operacion', { order: { field: 'created_at', dir: 'desc' } }, 250),
    traerTodo('vuelos', { order: { field: 'fecha', dir: 'desc' } }, 300),
    cortex.tables.query('atenciones', { order: { field: 'created_at', dir: 'desc' }, limit: 150 }),
    cargarTareas(200),
    traerTodo('prefacturacion', { order: { field: 'created_at', dir: 'desc' } }, 500).catch(() => []),
  ]);
  const vuelos = vs.map(aVuelo);
  return {
    vuelos,
    atenciones: ats.rows.map(aAtencion),
    atRows: ats.rows,
    tareas,
    novedades: armarNovedades(ev, ats.rows, gu, vuelos, hoy),
  };
}

export default function Centro() {
  const hoy = hoyBogota();
  const { rol, nombre } = useRol();
  const esq = useEsquema();
  const { data, loading, error, refresh } = useCarga(cargar, [], RESPALDO_VIVO_MS, TABLAS_VIVO);
  const ahora = useAhora(1000);
  const estadoVivo = useEstadoVivo();
  const gente = useLocations({ refreshMs: 20_000 });
  const personas = usePersonas(['operario']);

  const [filtro, setFiltro] = useGuardado<Filtro>('centro-filtro', 'todo', FILTROS.map((f) => f.id));
  const [sonido, setSonido] = useGuardado<'si' | 'no'>('centro-sonido', 'si', ['si', 'no']);
  const [oscuro, setOscuro] = useGuardado<'si' | 'no'>('centro-oscuro', 'no', ['si', 'no']);
  const [tv, setTv] = useState(false);
  const [seccion, setSeccion] = useState<SeccionTv>('novedades');
  const [selClave, setSelClave] = useState<string | null>(null);
  const [ocupadoClave, setOcupadoClave] = useState<string | null>(null);
  /** Lo que acabo de marcar (se ve al instante, antes de que vuelva el dato del servidor). */
  const [locales, setLocales] = useState<Record<string, Partial<Pick<Novedad, 'vistoPor' | 'vistoEn' | 'tomadoPor'>>>>({});
  /** «Visto» de lo que no se guarda en la base (novedades de atención o guía): solo este equipo. */
  const [vistasLocal, setVistasLocal] = useState<ReadonlySet<string>>(() => leerVistas());
  const [nuevas, setNuevas] = useState<Record<string, number>>({});
  const conocidas = useRef<Set<string> | null>(null);
  const fullscreenPedido = useRef(false);
  const raiz = useRef<HTMLDivElement>(null);
  const ancha = useAncha();

  /* ── Novedades con lo que acabo de marcar ── */
  const novedades = useMemo(
    () => (data?.novedades ?? []).map((n) => (locales[n.clave] ? { ...n, ...locales[n.clave] } : n)),
    [data, locales],
  );

  /* ── Llegada de novedades nuevas: animación, sonido y vibración ── */
  useEffect(() => {
    if (!data) return;
    if (conocidas.current === null) {
      conocidas.current = new Set(data.novedades.map((n) => n.clave));
      return;
    }
    const nuevasAhora = data.novedades.filter((n) => !conocidas.current?.has(n.clave));
    if (!nuevasAhora.length) return;
    for (const n of nuevasAhora) conocidas.current.add(n.clave);
    const t = Date.now();
    setNuevas((p) => ({ ...p, ...Object.fromEntries(nuevasAhora.map((n) => [n.clave, t])) }));
    const critica = nuevasAhora.some((n) => n.critico);
    if (sonido === 'si') {
      pitar(critica);
      if (critica) vibrar(true);
    }
  }, [data, sonido]);

  /* ── Primer toque: el navegador solo deja sonar después ── */
  useEffect(() => {
    const f = () => prepararSonido();
    window.addEventListener('pointerdown', f, { once: true });
    window.addEventListener('keydown', f, { once: true });
    return () => {
      window.removeEventListener('pointerdown', f);
      window.removeEventListener('keydown', f);
    };
  }, []);

  /* ── Derivados ── */
  const activas = useMemo(() => (data ? armarActivas(data.vuelos.filter((v) => v.fecha === hoy || !['Cerrado', 'Cancelado'].includes(v.estado)), data.atenciones, data.tareas, ahora) : []), [data, hoy, ahora]);
  const operarios = useMemo(
    () => (data ? armarOperarios(personas.personas, data.vuelos, data.atenciones, data.tareas, gente.locations, ahora) : []),
    [data, personas.personas, gente.locations, ahora],
  );

  const sinTomar = activas.filter((a) => a.tipo === 'vuelo' && a.etapa === 0).length;
  const abiertas = (data?.atenciones.filter((a) => a.estado === 'En atención').length ?? 0) + (data?.tareas.filter((t) => t.estado === 'En curso').length ?? 0);
  const criticasSinVer = novedades.filter((n) => n.critico && !n.cerrada && !esVisto(n, vistasLocal)).length;
  const escaladas = novedades.filter((n) => estaEscalada(n, ahora, vistasLocal)).length;
  const cerradasHoy =
    (data?.atenciones.filter((a) => a.fecha === hoy && a.estado !== 'En atención').length ?? 0) +
    (data?.tareas.filter((t) => t.estado === 'Terminada' && t.fin.slice(0, 10) === hoy).length ?? 0);

  const conteo = (f: Filtro) => novedades.filter((n) => pasaFiltro(n, f, vistasLocal)).length;
  const visibles = useMemo(() => novedades.filter((n) => pasaFiltro(n, filtro, vistasLocal)).slice(0, 60), [novedades, filtro, vistasLocal]);
  const sel = selClave ? (novedades.find((n) => n.clave === selClave) ?? null) : null;

  /* ── Marcar «lo vi» / «lo tomo» ── */
  const marcar = useCallback(
    async (n: Novedad, tomar: boolean) => {
      if (!n.persiste) {
        setVistasLocal((p) => {
          const s = new Set(p).add(n.clave);
          guardarVistas(s);
          return s;
        });
        return;
      }
      if (!hayCampo(esq, 'eventos_operacion', 'visto_por')) {
        avisar('Faltan aplicar los datos del centro (campos visto_por, visto_en, tomado_por).');
        return;
      }
      const yo = nombre || 'Alguien';
      const cuando = isoBogota(Date.now());
      const vals: Record<string, unknown> = {};
      if (!n.vistoPor) {
        vals.visto_por = yo;
        vals.visto_en = cuando;
      }
      if (tomar) {
        vals.tomado_por = yo;
        if (!n.vistoPor) vals.visto_por = yo;
      }
      if (!Object.keys(vals).length) return;
      setOcupadoClave(n.clave);
      setLocales((p) => ({ ...p, [n.clave]: { vistoPor: (vals.visto_por as string) ?? n.vistoPor, vistoEn: (vals.visto_en as string) ?? n.vistoEn, tomadoPor: (vals.tomado_por as string) ?? n.tomadoPor } }));
      try {
        await cortex.tables.update('eventos_operacion', n.id, vals);
        avisar(tomar ? 'Lo tomaste.' : 'Marcado como visto.');
        await refresh();
      } catch (e) {
        setLocales((p) => {
          const { [n.clave]: _x, ...resto } = p;
          return resto;
        });
        avisar(mensajeDe(e));
      } finally {
        setOcupadoClave(null);
      }
    },
    [esq, nombre, refresh],
  );

  /* ── Modo TV ── */
  const ultimoToque = useRef(Date.now());
  useEffect(() => {
    if (!tv) return;
    const f = () => {
      ultimoToque.current = Date.now();
    };
    for (const e of ['pointermove', 'pointerdown', 'keydown', 'wheel']) window.addEventListener(e, f);
    const t = setInterval(() => {
      if (Date.now() - ultimoToque.current < SIN_TOCAR_MS) return;
      setSeccion((s) => SECCIONES_TV[(SECCIONES_TV.indexOf(s) + 1) % SECCIONES_TV.length] as SeccionTv);
    }, ROTA_CADA_MS);
    return () => {
      for (const e of ['pointermove', 'pointerdown', 'keydown', 'wheel']) window.removeEventListener(e, f);
      clearInterval(t);
    };
  }, [tv]);
  useEffect(() => {
    const f = () => {
      if (!document.fullscreenElement) setTv((x) => (x && fullscreenPedido.current ? false : x));
    };
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);
  const entrarTv = async () => {
    setTv(true);
    setSelClave(null);
    ultimoToque.current = Date.now();
    try {
      await raiz.current?.requestFullscreen?.();
      fullscreenPedido.current = true;
    } catch {
      fullscreenPedido.current = false; // el marco no permite pantalla completa: queda el modo TV dentro de la ventana
    }
  };
  const salirTv = async () => {
    setTv(false);
    fullscreenPedido.current = false;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      /* ya salió */
    }
  };
  useEffect(() => {
    if (!tv) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && void salirTv();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [tv]);

  const alternarSonido = () => {
    const nuevo = sonido === 'si' ? 'no' : 'si';
    setSonido(nuevo);
    if (nuevo === 'si') {
      prepararSonido();
      pitar(false);
    }
  };

  const hayCritica = criticasSinVer > 0;
  const mostrar = (s: SeccionTv) => !tv || seccion === s;

  const feed = (
    <Tarjeta
      titulo={<>Novedades <span className="oc-sub">de hoy</span></>}
      icono={<Bell size={18} />}
      tono={hayCritica ? 'alerta' : undefined}
      derecha={
        <div className="cn-filtros" role="group" aria-label="Filtrar novedades">
          {FILTROS.map((f) => (
            <button key={f.id} type="button" aria-pressed={filtro === f.id} onClick={() => setFiltro(f.id)}>
              {f.texto}
              <i>{conteo(f.id)}</i>
            </button>
          ))}
        </div>
      }
    >
      {!visibles.length ? (
        <p className="oc-sub" style={{ padding: '10px 2px' }}>{filtro === 'todo' ? 'Sin novedades hoy. Cuando algo pase, entra aquí solo.' : 'Nada con este filtro.'}</p>
      ) : (
        <ul className="cn-feed">
          {visibles.map((n) => (
            <FilaNovedad
              key={n.clave}
              n={n}
              ahora={ahora}
              nueva={ahora - (nuevas[n.clave] ?? 0) < NUEVA_MS}
              visto={esVisto(n, vistasLocal)}
              escalada={estaEscalada(n, ahora, vistasLocal)}
              seleccionada={selClave === n.clave}
              ocupado={ocupadoClave === n.clave}
              puedeMarcar={!tv}
              onAbrir={() => setSelClave(n.clave)}
              onVisto={() => void marcar(n, false)}
              onTomo={() => void marcar(n, true)}
            />
          ))}
        </ul>
      )}
    </Tarjeta>
  );

  const panelActivas = (
    <Tarjeta titulo="Atenciones activas" icono={<ClipboardList size={18} />} derecha={<span className="oc-sub">objetivo: tomar en {OBJETIVOS.sinTomarMin} min · atender en {OBJETIVOS.atencionMin} min</span>}>
      {!activas.length ? (
        <p className="oc-sub">Ninguna atención en curso ahora.</p>
      ) : (
        <ul className="cn-activas">
          {activas.map((a) => (
            <TarjetaActiva key={a.clave} a={a} ahora={ahora} onAbrir={a.vueloId && !tv ? () => void cortex.nav.go({ screen: 'vuelo', prefill: { vuelo: a.vueloId } }).catch(() => undefined) : undefined} />
          ))}
        </ul>
      )}
    </Tarjeta>
  );

  const panelOperarios = (
    <Tarjeta titulo="Operarios en turno" icono={<Users size={18} />} derecha={<span className="oc-sub">{operarios.length ? `${operarios.filter((o) => o.ocupado).length} ocupados de ${operarios.length}` : ''}</span>}>
      {!operarios.length ? (
        <p className="oc-sub">{personas.faltaActualizar || personas.error ? 'Se ven los operarios que tienen algo en curso.' : 'Nadie con el turno abierto ahora.'}</p>
      ) : (
        <ul className="cn-ops">
          {operarios.map((o) => {
            const min = o.desde ? (ahora - o.desde) / 60_000 : null;
            const vieja = o.lugarAt !== null && (ahora - o.lugarAt) / 60_000 > OBJETIVOS.ubicacionVieja;
            return (
              <li key={o.clave} className={o.ocupado ? 'ocupado' : 'libre'}>
                <span className="av" aria-hidden="true">{iniciales(o.nombre)}</span>
                <span className="tx">
                  <b>{o.nombre}</b>
                  <span>{o.haciendo}{min !== null ? <em> · desde hace {Math.max(0, Math.round(min))} min</em> : null}</span>
                  {o.detalle ? <small>{o.detalle}</small> : null}
                  {o.lugar ? (
                    <small className={vieja ? 'vieja' : ''}>
                      <MapPin size={12} /> {o.lugar}
                      {o.lugarAt !== null ? ` · ${haceTxt((ahora - o.lugarAt) / 1000)}` : ''}
                    </small>
                  ) : null}
                </span>
                <Chip tono={o.ocupado ? 'info' : 'good'} vivo={o.ocupado}>{o.ocupado ? 'Ocupado' : 'Libre'}</Chip>
              </li>
            );
          })}
        </ul>
      )}
    </Tarjeta>
  );

  const detalle = sel ? <DetalleNovedad n={sel} data={data} visto={esVisto(sel, vistasLocal)} ocupado={ocupadoClave === sel.clave} onVisto={() => void marcar(sel, false)} onTomo={() => void marcar(sel, true)} /> : null;

  return (
    <div ref={raiz} className={`cn-raiz ${tv ? 'tv' : ''} ${oscuro === 'si' ? 'oscuro' : ''}`}>
      <Pantalla
        clase={`centro ${tv ? 'tv' : ''} ${oscuro === 'si' ? 'oscuro' : ''}`}
        titulo="Centro de atención"
        sub={tv ? `${fechaLarga(hoy)} · ${hhmm(new Date(ahora).toISOString())}` : `${fechaLarga(hoy)} · atención y novedades en vivo`}
        acciones={
          <>
            <IndicadorConexion estado={estadoVivo} hayVivo={hayVivo()} />
            <Boton chico tono="suave" onClick={alternarSonido} aria-pressed={sonido === 'si'} aria-label={sonido === 'si' ? 'Silenciar los avisos' : 'Activar el sonido de los avisos'} icono={sonido === 'si' ? <Bell size={16} /> : <BellOff size={16} />}>
              {sonido === 'si' ? 'Sonido' : 'Silencio'}
            </Boton>
            <Boton chico tono="suave" onClick={() => setOscuro(oscuro === 'si' ? 'no' : 'si')} aria-label="Cambiar entre tema claro y oscuro" icono={oscuro === 'si' ? <Sun size={16} /> : <Moon size={16} />}>
              {oscuro === 'si' ? 'Claro' : 'Oscuro'}
            </Boton>
            {tv ? (
              <Boton chico onClick={() => void salirTv()} icono={<Minimize2 size={16} />}>Salir del modo TV</Boton>
            ) : (
              <Boton chico tono="primario" onClick={() => void entrarTv()} icono={<Maximize2 size={16} />}>Modo TV</Boton>
            )}
          </>
        }
      >
        {error && data ? <ErrorCaja mensaje={`No se pudo actualizar: ${error}`} reintentar={() => void refresh()} /> : null}

        {data ? (
          <Frase tono={escaladas ? 'bad' : criticasSinVer || sinTomar ? 'warn' : 'good'} icono={escaladas ? <AlertOctagon size={20} /> : criticasSinVer || sinTomar ? <AlertTriangle size={20} /> : <CheckCircle2 size={20} />}>
            Ahora: <b>{abiertas} {abiertas === 1 ? 'atención abierta' : 'atenciones abiertas'}</b>
            {sinTomar ? <>, <b>{sinTomar} {sinTomar === 1 ? 'vuelo sin tomar' : 'vuelos sin tomar'}</b></> : ', ningún vuelo esperando'}
            {criticasSinVer ? <>, <b>{criticasSinVer} {criticasSinVer === 1 ? 'crítica sin ver' : 'críticas sin ver'}</b>{escaladas ? <> (<b>{escaladas} escalada{escaladas === 1 ? '' : 's'}</b>)</> : null}</> : null}.
          </Frase>
        ) : null}

        <div className="oc-kpis cn-kpis">
          <Metrica etiqueta="Atenciones abiertas" valor={<Cifra n={abiertas} />} tono="info" icono={<ClipboardList size={14} />} pista="Vuelos y tareas en curso" />
          <Metrica etiqueta="Sin tomar" valor={<Cifra n={sinTomar} />} tono={sinTomar ? 'bad' : undefined} icono={<Plane size={14} />} pista={`Más de ${OBJETIVOS.sinTomarMin} min = rojo`} />
          <Metrica etiqueta="Críticas sin ver" valor={<Cifra n={criticasSinVer} />} tono={criticasSinVer ? 'bad' : undefined} icono={<FileWarning size={14} />} onClick={() => setFiltro('criticas')} activo={filtro === 'criticas'} pista={escaladas ? `${escaladas} escalada${escaladas === 1 ? '' : 's'}` : `Escalan a los ${OBJETIVOS.escalaCriticaMin} min`} />
          <Metrica etiqueta="Cerradas hoy" valor={<Cifra n={cerradasHoy} />} tono="good" icono={<CheckCircle2 size={14} />} pista="Atenciones y tareas" />
        </div>

        {tv ? (
          <div className="cn-tv-barra" role="tablist" aria-label="Sección en pantalla">
            {SECCIONES_TV.map((s) => (
              <button key={s} type="button" role="tab" aria-selected={seccion === s} className={seccion === s ? 'on' : ''} onClick={() => { setSeccion(s); ultimoToque.current = Date.now(); }}>
                {TEXTO_SECCION[s]}
              </button>
            ))}
          </div>
        ) : null}

        <div className="oc-sec">
          <Estado
            cargando={loading}
            error={error}
            vacio={!data}
            tituloVacio="Sin datos todavía"
            textoVacio={<p>Cuando haya vuelos, tareas y eventos hoy, aparecen aquí.</p>}
            reintentar={() => void refresh()}
          >
            <div className={`cn-grid ${sel && ancha && !tv ? 'con-panel' : ''} ${tv ? 'una' : ''}`}>
              {mostrar('novedades') ? <div className="cn-col">{feed}</div> : null}
              {mostrar('atenciones') || mostrar('operarios') ? (
                <div className="cn-col">
                  {mostrar('atenciones') ? panelActivas : null}
                  {mostrar('operarios') ? panelOperarios : null}
                </div>
              ) : null}
              {sel && ancha && !tv ? (
                <aside className="oc-panel cn-panel" aria-label="Vista rápida de la novedad">
                  <div className="oc-panel-top">
                    <h2>Vista rápida</h2>
                    <Boton chico tono="suave" onClick={() => setSelClave(null)} aria-label="Cerrar el panel" icono={<X size={18} />} />
                  </div>
                  {detalle}
                </aside>
              ) : null}
            </div>
          </Estado>
        </div>

        {sel && !ancha && !tv ? (
          <Hoja titulo={sel.titulo} onCerrar={() => setSelClave(null)}>
            {detalle}
          </Hoja>
        ) : null}
      </Pantalla>
    </div>
  );
}

/* ───────────── Una novedad del feed ───────────── */

function FilaNovedad({
  n,
  ahora,
  nueva,
  visto,
  escalada,
  seleccionada,
  ocupado,
  puedeMarcar,
  onAbrir,
  onVisto,
  onTomo,
}: {
  n: Novedad;
  ahora: number;
  nueva: boolean;
  visto: boolean;
  escalada: boolean;
  seleccionada: boolean;
  ocupado: boolean;
  puedeMarcar: boolean;
  onAbrir: () => void;
  onVisto: () => void;
  onTomo: () => void;
}) {
  const seg = Math.max(0, (ahora - n.at) / 1000);
  const Icono = n.critico ? AlertOctagon : n.fuente === 'guia' ? FileWarning : n.tareaId ? ClipboardList : Plane;
  return (
    <li className={`cn-item ${n.critico ? 'crit' : ''} ${escalada ? 'escalada' : ''} ${nueva ? 'entra' : ''} ${visto ? 'visto' : ''} ${seleccionada ? 'sel' : ''}`}>
      <button type="button" className="cn-main" onClick={onAbrir} aria-pressed={seleccionada}>
        <span className="ic" aria-hidden="true"><Icono size={20} /></span>
        <span className="tx">
          <span className="fila1">
            <b>{n.titulo}</b>
            {n.critico ? <Chip tono="bad">Crítica</Chip> : null}
            {escalada ? <Chip tono="bad">Escalada</Chip> : null}
            {nueva ? <Chip tono="accent" vivo>Nueva</Chip> : null}
          </span>
          {n.detalle ? <span className="det">{n.detalle}</span> : null}
          <span className="meta">
            <span className="hace">{haceTxt(seg)}</span>
            {n.vuelo ? <span className="oc-mono">{n.vuelo}</span> : null}
            {n.quien ? <span>{n.quien}</span> : null}
            {n.vistoPor ? <span className="ok"><Eye size={12} /> Visto por {n.vistoPor}</span> : null}
            {n.tomadoPor ? <span className="ok"><HandHelping size={12} /> Lo tomó {n.tomadoPor}</span> : null}
          </span>
        </span>
      </button>
      {puedeMarcar && !n.cerrada ? (
        <div className="cn-acc">
          {!visto ? (
            <Boton chico disabled={ocupado} onClick={onVisto} icono={<Eye size={15} />}>Lo vi</Boton>
          ) : null}
          {n.persiste && !n.tomadoPor ? (
            <Boton chico tono={n.critico ? 'primario' : undefined} disabled={ocupado} onClick={onTomo} icono={<HandHelping size={15} />}>Lo tomo</Boton>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/* ───────────── Panel lateral / hoja: detalle de la novedad ───────────── */

function DetalleNovedad({ n, data, visto, ocupado, onVisto, onTomo }: { n: Novedad; data: Awaited<ReturnType<typeof cargar>> | null; visto: boolean; ocupado: boolean; onVisto: () => void; onTomo: () => void }) {
  const v = data?.vuelos.find((x) => x.id === n.vueloId) ?? null;
  const evsVuelo = (data?.novedades ?? []).flatMap((x) => (x.evento && x.vueloId === n.vueloId ? [x.evento] : []));
  return (
    <div className="oc-form">
      <div>
        <div className="oc-chips">
          {n.critico ? <Chip tono="bad">Crítica</Chip> : null}
          <Chip tono={visto ? 'good' : 'warn'}>{visto ? 'Vista' : 'Sin ver'}</Chip>
          {n.tomadoPor ? <Chip tono="info">Lo tomó {n.tomadoPor}</Chip> : null}
        </div>
        <h3 style={{ marginTop: 8, fontSize: 20 }}>{n.titulo}</h3>
        {n.detalle ? <p style={{ marginTop: 4 }}>{n.detalle}</p> : null}
        <dl className="oc-pares" style={{ marginTop: 10 }}>
          <dt>Cuándo</dt><dd>{hhmm(new Date(n.at).toISOString())} · {haceTxt((Date.now() - n.at) / 1000)}</dd>
          {n.quien ? <><dt>Quién</dt><dd>{n.quien}</dd></> : null}
          {n.vuelo ? <><dt>Vuelo</dt><dd>{n.vuelo}</dd></> : null}
          {n.vistoPor ? <><dt>Lo vio</dt><dd>{n.vistoPor}{n.vistoEn ? ` · ${hhmm(n.vistoEn)}` : ''}</dd></> : null}
          {n.evento?.equipo ? <><dt>Equipo</dt><dd>{n.evento.equipo}{n.evento.proveedor ? ` · ${n.evento.proveedor}` : ''}</dd></> : null}
          {n.evento?.zona ? <><dt>Zona</dt><dd>{n.evento.zona}</dd></> : null}
        </dl>
        {!n.cerrada ? (
          <div className="oc-btns" style={{ marginTop: 10 }}>
            {!visto ? <Boton onClick={onVisto} disabled={ocupado} icono={<Eye size={16} />}>Lo vi</Boton> : null}
            {n.persiste && !n.tomadoPor ? <Boton tono="primario" onClick={onTomo} disabled={ocupado} icono={<HandHelping size={16} />}>Lo tomo</Boton> : null}
          </div>
        ) : null}
        {!n.persiste ? <p className="oc-sub" style={{ marginTop: 6 }}>Esta novedad viene de {n.fuente === 'guia' ? 'una guía' : 'la atención'}: «Lo vi» se recuerda solo en este equipo.</p> : null}
      </div>
      {v ? <VistaVuelo v={v} atenciones={(data?.atenciones ?? []).filter((a) => a.vueloId === v.id)} eventos={evsVuelo} /> : n.vueloId ? <p className="oc-sub">Cargando el vuelo…</p> : null}
    </div>
  );
}

/* ───────────── Utilidades ───────────── */

const iniciales = (nombre: string): string =>
  nombre
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

function useAncha(): boolean {
  const [a, setA] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 1100);
  useEffect(() => {
    const f = () => setA(window.innerWidth >= 1100);
    window.addEventListener('resize', f);
    return () => window.removeEventListener('resize', f);
  }, []);
  return a;
}

const CLAVE_VISTAS = 'oc:centro-vistas';
/** Lo visto de novedades sin escritura en la base: solo de hoy, para que no crezca. */
function leerVistas(): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(CLAVE_VISTAS);
    if (!raw) return new Set();
    const o = JSON.parse(raw) as { dia?: string; claves?: string[] };
    return o.dia === hoyBogota() ? new Set(o.claves ?? []) : new Set();
  } catch {
    return new Set();
  }
}
function guardarVistas(s: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(CLAVE_VISTAS, JSON.stringify({ dia: hoyBogota(), claves: [...s].slice(-300) }));
  } catch {
    /* sin almacenamiento */
  }
}
