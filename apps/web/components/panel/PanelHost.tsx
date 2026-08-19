'use client';

import { PanelResult } from '@/lib/panels/registry';
import {
  PANELS,
  type PanelId,
  panelFromSearch,
  panelKeyFromSearch,
  searchWithPanel,
} from '@/lib/panels/shape';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { ArrowUpRight, RefreshCw, X } from 'lucide-react';
import Link from 'next/link';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/**
 * EL MARCO DEL PANEL, Y EL SITIO DONDE VIVE.
 *
 * ===========================================================================
 * LA PREMISA DE TODO EL DISEÑO: ABRIR ESTO NO PUEDE DESMONTAR `ChatRoot`
 * ===========================================================================
 * Todo lo que la conversación tiene y no está en ninguna base de datos —los
 * fotogramas de la pantalla compartida (migración 0092: sin bytes, a
 * propósito), la sesión de `getDisplayMedia`, el razonamiento del turno, los
 * avisos de vigilancia, el borrador del compositor y el `fetch` de un turno en
 * vuelo— vive en la memoria de `ChatRoot`. Si abrir un panel lo desmonta, el
 * panel no arregla nada: cambia una forma de perder la conversación por otra.
 *
 * ASÍ QUE EL ESTADO NO VIVE DENTRO DEL CHAT, VIVE POR ENCIMA. `PanelProvider`
 * envuelve el shell entero y recibe `{children}` COMO PROP. Cuando su estado
 * cambia, React vuelve a renderizar el proveedor y se encuentra con que el
 * elemento `children` es el MISMO objeto que la vez anterior —viene de una
 * prop, y el proveedor no lo construye—, así que descarta ese subárbol sin
 * recorrerlo. `ChatRoot` no se vuelve a renderizar; mucho menos se desmonta.
 *
 * No es una teoría: `CommandMenuProvider` lleva meses montado exactamente así,
 * y abrir ⌘K estando en `/chat` no ha costado nunca un mensaje. Este proveedor
 * es hermano suyo, con la misma forma y por la misma razón.
 *
 * Y `PanelHost` se dibuja como HERMANO de `{children}`, nunca como padre: un
 * padre que aparece y desaparece cambiaría la posición de `ChatRoot` en el
 * árbol, y cambiar de posición SÍ es desmontar. Está clavado en
 * `components/nav/AppShell.tsx` y `components/panel/mount.test.ts` lo vigila.
 *
 * ===========================================================================
 * LA URL: `replaceState`, NUNCA EL ROUTER
 * ===========================================================================
 * `?panel=payments` se escribe con `window.history.replaceState`, el mismo
 * mecanismo y por la misma razón documentada que usa `ChatRoot.tsx` para pasar
 * de `/chat` a `/chat/<id>` a mitad de stream: `router.replace()` remonta la
 * ruta y se lleva por delante lo que se está escribiendo. Queda enlazable y
 * sobrevive a un refresco sin que el router se entere de nada.
 *
 * LAS DOS ESCRITURAS SE CRUZAN, Y NO SE PISAN. En una conversación nueva, la
 * primera respuesta hace que `ChatRoot` reescriba la dirección a `/chat/<id>` a
 * mitad de stream. Esa línea conserva `window.location.search` en lugar de
 * descartarlo, así que el `?panel=` de aquí sobrevive y el enlace sigue
 * describiendo la pantalla entera. Cada uno escribe su mitad —`ChatRoot` el
 * camino, esto la consulta— y ninguno tiene que saber del otro.
 * `e2e/panel.spec.ts` lo vigila con un turno goteado.
 */

interface PanelContextValue {
  /** El panel abierto, o `null`. */
  panelId: PanelId | null;
  /** La clave de una ficha, o `null`. Nunca un `toolId`. */
  panelKey: string | null;
  open: (id: PanelId, key?: string | null) => void;
  close: () => void;
  /**
   * Si hay de verdad un proveedor encima.
   *
   * Importa porque quien pregunta esto es el rail, y el rail decide con la
   * respuesta si un clic ABRE un panel o NAVEGA. Sin este campo, un rail
   * montado fuera del shell se comería el clic con un `open` que no hace nada y
   * la fila quedaría muerta — que es peor que no tener panel.
   */
  available: boolean;
}

const PanelContext = createContext<PanelContextValue | null>(null);

export function PanelProvider({ children }: { children: ReactNode }) {
  const [panelId, setPanelId] = useState<PanelId | null>(null);
  const [panelKey, setPanelKey] = useState<string | null>(null);
  /** El último que estuvo abierto, para que ⌘\ pueda devolverlo. */
  const lastPanel = useRef<{ id: PanelId; key: string | null }>({ id: 'payments', key: null });

  /**
   * La dirección se lee DESPUÉS de montar, nunca durante el render.
   *
   * `window` no existe en el servidor, así que leerla mientras se renderiza
   * haría que el HTML que baja y la primera pintura del navegador no
   * coincidieran. El coste es que un enlace con `?panel=` abre el panel un tick
   * más tarde, que es también el orden honesto de los hechos.
   */
  useEffect(() => {
    const fromUrl = panelFromSearch(window.location.search);
    const key = panelKeyFromSearch(window.location.search);
    if (fromUrl) {
      if (PANELS[fromUrl].keyed && !key) return;
      lastPanel.current = { id: fromUrl, key };
      setPanelId(fromUrl);
      setPanelKey(key);
    }
  }, []);

  const writeUrl = useCallback((next: PanelId | null, key: string | null) => {
    const search = searchWithPanel(window.location.search, next, key);
    window.history.replaceState(null, '', `${window.location.pathname}${search}`);
  }, []);

  const open = useCallback(
    (id: PanelId, key?: string | null) => {
      const nextKey = PANELS[id].keyed ? key?.trim() || null : null;
      if (PANELS[id].keyed && !nextKey) return;
      lastPanel.current = { id, key: nextKey };
      setPanelId(id);
      setPanelKey(nextKey);
      writeUrl(id, nextKey);
    },
    [writeUrl],
  );

  const close = useCallback(() => {
    setPanelId(null);
    setPanelKey(null);
    writeUrl(null, null);
  }, [writeUrl]);

  /**
   * ⌘\ — abrir y cerrar sin soltar el teclado.
   *
   * Cerrado, devuelve el último que se miró; abierto, lo esconde. No se
   * registra con `useGlobalHotkeys` porque ese hook tiene las tres teclas
   * cableadas por nombre y añadirle una cuarta sería tocar el atajo de todo el
   * mundo para un panel. Escape también cierra, y sólo cuando hay algo abierto:
   * un Escape que no cierra nada tiene que seguir llegando a quien sí lo espera.
   */
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === '\\') {
        event.preventDefault();
        if (panelId) close();
        else open(lastPanel.current.id, lastPanel.current.key);
        return;
      }
      if (event.key === 'Escape' && panelId) close();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panelId, open, close]);

  const value = useMemo(
    () => ({ panelId, panelKey, open, close, available: true }),
    [panelId, panelKey, open, close],
  );

  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}

/**
 * Quien quiera abrir un panel. Fuera del proveedor no revienta: devuelve un
 * estado cerrado, un `open` que no hace nada y `available: false`, el mismo
 * trato que hacen `useMobileSidebar` y `useCommandMenu` — el rail se dibuja en
 * sitios donde no hay shell y no puede caerse por eso.
 */
export function usePanel(): PanelContextValue {
  const ctx = useContext(PanelContext);
  if (!ctx) {
    return { panelId: null, panelKey: null, open: () => {}, close: () => {}, available: false };
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// El contenido
// ---------------------------------------------------------------------------

type Load =
  | { state: 'loading' }
  | { state: 'ready'; of: string; result: unknown }
  | { state: 'error'; of: string; message: string };

function stamp(id: PanelId | null, key: string | null): string {
  return `${id ?? ''}:${key ?? ''}`;
}

/**
 * Una llamada por apertura, y ninguna cuando está cerrado.
 *
 * `nonce` existe para que «reintentar» y «actualizar» sean lo mismo que abrir:
 * cambiarlo vuelve a disparar el efecto sin duplicar el camino de datos.
 *
 * Y cada resultado RECUERDA DE QUÉ PANEL ES. Sin eso hay un fotograma —el que
 * va entre cambiar de panel y que el efecto se ejecute— en el que la cabecera
 * ya dice «Vencimientos» y debajo siguen las cifras de la cartera. Un panel que
 * enseña los datos de otro durante un parpadeo es peor que uno que tarda.
 */
function usePanelData(panelId: PanelId | null, panelKey: string | null) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [nonce, setNonce] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` no se lee dentro del efecto: ES el disparador. Sin él, «actualizar» necesitaría un segundo camino de datos en paralelo a éste, y dos caminos se contestan distinto en cuanto uno de los dos se arregla.
  useEffect(() => {
    if (!panelId) return;
    // Abortado al cambiar de panel o al cerrar: una respuesta que llega tarde
    // no puede pintarse encima del panel siguiente.
    const controller = new AbortController();
    setLoad({ state: 'loading' });
    fetch('/api/panel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // El id, y la clave si la superficie es de una entidad. La herramienta
      // y su entrada las decide el servidor.
      body: JSON.stringify({ panelId, key: panelKey }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as {
          result?: unknown;
          error?: string;
        } | null;
        if (!response.ok) {
          throw new Error(payload?.error ?? 'No se pudo abrir el panel.');
        }
        setLoad({ state: 'ready', of: stamp(panelId, panelKey), result: payload?.result });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({
          state: 'error',
          of: stamp(panelId, panelKey),
          message: err instanceof Error ? err.message : 'No se pudo abrir el panel.',
        });
      });
    return () => controller.abort();
  }, [panelId, panelKey, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  // Lo que sobró del panel anterior no se enseña: se lee como «cargando», que
  // es exactamente lo que está pasando.
  const current: Load =
    load.state === 'loading' || load.of === stamp(panelId, panelKey) ? load : { state: 'loading' };
  return { load: current, refresh };
}

function PanelBody({
  panelId,
  load,
  onRefresh,
}: {
  panelId: PanelId;
  load: Load;
  onRefresh: () => void;
}) {
  if (load.state === 'loading') {
    return (
      <div className="space-y-2 p-4" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-8 animate-pulse rounded-sm bg-surface-2 motion-reduce:animate-none"
          />
        ))}
        <span className="sr-only">Cargando…</span>
      </div>
    );
  }

  if (load.state === 'error') {
    return (
      <div className="p-4">
        <div className="rounded-card border border-rose/25 bg-rose-soft px-4 py-3 text-xs leading-relaxed text-rose">
          {load.message}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="mt-2 text-xs font-semibold text-primary underline underline-offset-2"
        >
          Reintentar
        </button>
      </div>
    );
  }

  /**
   * LOS DOS CENTINELAS DE SOBRE GANAN A LA VISTA, igual que en el chat.
   *
   * `runTool` se llama SIN `confirmed`, así que una herramienta con puerta
   * devuelve `__requires_confirmation` en vez de datos, y una que falla por
   * dentro devuelve `__error`. Los dos son estado del turno, no contenido, y la
   * capa estructural los filtra como ruido de protocolo — con lo que un panel
   * parado se dibujaría igual que un panel vacío. Vacío y bloqueado significan
   * lo contrario, así que se dicen.
   *
   * Hoy ninguno de los cinco paneles llega aquí: los cinco son de lectura. Está
   * escrito para el sexto.
   */
  const sentinel = envelope(load.result);
  if (sentinel) {
    return (
      <div className="p-4">
        <div className="rounded-card border border-amber/25 bg-amber-soft px-4 py-3 text-xs leading-relaxed text-amber">
          {sentinel}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4">
      <PanelResult panelId={panelId} result={load.result} onSettled={onRefresh} />
    </div>
  );
}

/** La frase que corresponde si el resultado es un sobre y no una respuesta. */
function envelope(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  if (record.__requires_confirmation) {
    return 'Esto necesita que lo apruebes antes de correr. Pídemelo en el chat y te lo pongo con el botón.';
  }
  if (typeof record.__error === 'string' && record.__error.trim()) return record.__error;
  return null;
}

function PanelHeader({
  panelId,
  onRefresh,
  onClose,
  closeAsDialog,
}: {
  panelId: PanelId;
  onRefresh: () => void;
  onClose: () => void;
  /** En la hoja móvil el cierre lo pone Radix, para que se lleve el foco con él. */
  closeAsDialog?: boolean;
}) {
  const shape = PANELS[panelId];
  const Icon = shape.icon;
  const iconButton =
    'rounded-full p-1.5 text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none';

  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary-soft text-primary ring-1 ring-inset ring-primary/15">
        <Icon strokeWidth={1.75} className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1 text-sm font-semibold text-ink">{shape.title}</div>

      {/* La puerta a la pantalla completa. Ésta SÍ navega, y por eso es un
          enlace de verdad: quien la pulsa está pidiendo la pantalla, no el
          resumen. Ningún destino desaparece — sólo deja de ser obligatorio. */}
      <Link
        href={shape.href}
        className="flex items-center gap-1 rounded-sm px-1.5 py-1 text-micro font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
      >
        Ver todo
        <ArrowUpRight strokeWidth={1.75} className="h-3.5 w-3.5" />
      </Link>

      <button type="button" onClick={onRefresh} aria-label="Actualizar" className={iconButton}>
        <RefreshCw strokeWidth={1.75} className="h-4 w-4" />
      </button>

      {closeAsDialog ? (
        <Dialog.Close aria-label="Cerrar el panel" className={iconButton}>
          <X strokeWidth={1.75} className="h-4 w-4" />
        </Dialog.Close>
      ) : (
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar el panel"
          aria-keyshortcuts="Meta+\ Control+\"
          className={iconButton}
        >
          <X strokeWidth={1.75} className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/**
 * ¿HAY SITIO PARA DOS COLUMNAS?
 *
 * Se pregunta en JavaScript y no sólo con clases de Tailwind porque las dos
 * colocaciones no son el mismo elemento con otro aspecto: una es una columna y
 * la otra es un diálogo de Radix, y un diálogo abierto ATRAPA EL FOCO, bloquea
 * el scroll y marca `aria-hidden` el resto de la página. Montarlo escondido con
 * `lg:hidden` dejaría la aplicación de escritorio inerte detrás de algo que no
 * se ve. Así que en escritorio no se monta, punto.
 *
 * Sin riesgo de hidratación: `PanelHost` sólo dibuja algo cuando hay un panel
 * abierto, y en el servidor nunca lo hay.
 */
function useCompactViewport(): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1023px)');
    const sync = () => setCompact(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return compact;
}

/**
 * El panel, en las dos colocaciones que caben en una pantalla.
 *
 * Ancho, es una columna a la derecha del chat, y NO es un modal: la
 * conversación de al lado sigue siendo utilizable, se puede seguir escribiendo
 * con el panel abierto, y por eso no hay trampa de foco ni fondo oscurecido. Es
 * `role="complementary"`, que es exactamente lo que es.
 *
 * Estrecho, no hay dos columnas que repartir, así que es una hoja a pantalla
 * completa por encima del chat — un `@radix-ui/react-dialog`, que ya es
 * dependencia y que el rail móvil ya usa. Ahí sí atrapa el foco y ahí sí lo
 * devuelve al cerrarse, porque ahí sí tapa lo que hay debajo.
 *
 * En los dos casos el chat sigue MONTADO. Una hoja que tapa no es una ruta que
 * reemplaza.
 */
export function PanelHost() {
  const { panelId, panelKey, close } = usePanel();
  const { load, refresh } = usePanelData(panelId, panelKey);
  const compact = useCompactViewport();
  const surface = useRef<HTMLElement>(null);

  /**
   * El foco entra en el panel al abrirlo, en la superficie y no en un control:
   * quien lo abre viene a LEER, y aterrizar en un botón hace que la primera
   * tecla haga algo. Desde ahí, un Tab entra en el contenido y Escape cierra.
   * En la hoja estrecha lo hace Radix, que además sabe devolverlo.
   */
  useEffect(() => {
    if (panelId && !compact) surface.current?.focus();
  }, [panelId, compact]);

  if (!panelId) return null;

  if (compact) {
    return (
      <Dialog.Root open onOpenChange={(next) => !next && close()}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed inset-0 z-50 flex flex-col bg-surface outline-none">
            <Dialog.Title className="sr-only">{PANELS[panelId].title}</Dialog.Title>
            <Dialog.Description className="sr-only">
              Se abre sobre la conversación, sin cerrarla.
            </Dialog.Description>
            <PanelHeader panelId={panelId} onRefresh={refresh} onClose={close} closeAsDialog />
            <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
              <PanelBody panelId={panelId} load={load} onRefresh={refresh} />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  return (
    <aside
      ref={surface}
      tabIndex={-1}
      // `<aside>` ya ES `complementary` para un lector de pantalla, y eso es
      // exactamente lo que el panel es: algo al lado de la conversación, no algo
      // encima de ella. Sin trampa de foco y sin fondo oscurecido, porque se
      // puede seguir escribiendo con él abierto.
      aria-label={PANELS[panelId].title}
      className={clsx(
        'flex shrink-0 flex-col border-l border-border bg-surface outline-none',
        PANELS[panelId].wide ? 'w-[560px] xl:w-[640px]' : 'w-[420px] xl:w-[480px]',
      )}
    >
      <PanelHeader panelId={panelId} onRefresh={refresh} onClose={close} />
      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
        <PanelBody panelId={panelId} load={load} onRefresh={refresh} />
      </div>
    </aside>
  );
}
