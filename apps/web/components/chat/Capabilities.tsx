'use client';

import type { PaletteGroup, PaletteResponse } from '@/lib/chat-palette-shape';
import { type FamilyTone, groupMeta } from '@/lib/tool-taxonomy';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  BookOpen,
  Boxes,
  Building2,
  CalendarDays,
  Car,
  Coins,
  GitBranch,
  Globe,
  Handshake,
  Mail,
  MessagesSquare,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Target,
  Wallet,
  Workflow,
  Wrench,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';

/**
 * LA PUERTA. Lo que Cortex sabe hacer, sin teclear nada.
 *
 * EL PROBLEMA NO ERA QUE FALTARAN OPCIONES. El menú del `/` ya ofrece decenas
 * de frases curadas en español y el `@` nombra cosas; hay más de cien
 * herramientas detrás. Lo que no existía era una forma de VER eso sin saber ya
 * que existe: había que teclear una barra para descubrir que hay un catálogo, y
 * nadie teclea una barra en una caja que le pide que escriba una pregunta. Un
 * producto cuyo repertorio sólo se conoce por rumor no tiene repertorio.
 *
 * POR QUÉ EN LA CABECERA Y NO EN EL COMPOSITOR. El compositor ya lleva siete
 * controles y la queja era justamente que ninguno pesa más que otro; meter el
 * octavo allí habría enterrado la puerta en el sitio donde ya no se distingue
 * nada. La cabecera, en cambio, tenía el nombre a la izquierda, dos botones a
 * la derecha y mil cuatrocientos píxeles de nada en medio — la barra más grande
 * de la pantalla sin decir una palabra. La puerta va donde estaba el vacío.
 *
 * NO CUESTA NI UNA CONSULTA. Se cuelga de la MISMA clave de react-query que el
 * compositor ya pidió al montar para dibujar sus chips (`['chat-palette',
 * agentSlug]`, cinco minutos de frescura). Abrir el catálogo no dispara nada:
 * lee lo que ya está en memoria. Y por venir de ahí hereda lo importante — el
 * servidor ya filtró por `usableToolIds`, así que aquí NO se anuncia nada que
 * este espacio de trabajo no pueda ejecutar de verdad. Un catálogo que promete
 * lo que no hay es peor que no tener catálogo.
 *
 * UN CLIC ESCRIBE, NO MANDA. Es la misma regla que defiende `EmptyState.tsx`
 * con sus tarjetas: «una tarjeta que dispara un turno al primer clic es una
 * tarjeta que da miedo tocar». Aquí pesa aún más, porque quien abre esto viene
 * a MIRAR qué se puede pedir — está explorando, no decidiendo — y muchas frases
 * quedan a medias a propósito («Busca al cliente ») esperando el nombre. La
 * frase aterriza en el compositor con el foco puesto y el cursor al final. Lo
 * que sí manda de un clic son los chips de `QuickChips`, y la diferencia sigue
 * siendo la de siempre: aquéllos repiten lo que ya preguntaste, esto propone lo
 * que todavía no sabías que podías preguntar.
 *
 * UN DIÁLOGO Y NO UN DESPLEGABLE. Ochenta frases largas en una docena de
 * familias es un sitio al que se entra, no una lista que se ojea: hace falta
 * espacio para leer de qué va cada familia antes de elegir. El desplegable
 * además roba las flechas y el tabulador, y aquí hay dos columnas que recorrer.
 *
 * CUÁNTAS FAMILIAS CABEN. Trece, que son todas las que hay con todo conectado:
 * cada fila del índice mide 36px y la columna tiene 476 disponibles. Medido en
 * pantalla al añadir «Cartera y papeles» y «Tu empresa». Si algún día entra la
 * decimoséptima, el índice empieza a hacer scroll y hay que repensarlo — no
 * añadir la fila y confiar en que se vea.
 */

/**
 * Sólo hacen falta los iconos de los GRUPOS —la puerta no dibuja familias—,
 * pero tienen que estar TODOS: un nombre que falte cae a `Wrench` en silencio,
 * y así llevaban «Tus servidores MCP» (`Server`) y «Herramientas propias»
 * (`Boxes`) dibujadas con una llave inglesa desde que se abrió la puerta.
 */
const ICONS: Record<string, typeof Wrench> = {
  BookOpen,
  Boxes,
  Building2,
  CalendarDays,
  Car,
  Coins,
  GitBranch,
  Globe,
  Handshake,
  Mail,
  MessagesSquare,
  Server,
  ShieldCheck,
  Target,
  Wallet,
  Workflow,
  Wrench,
};

/** El mismo mapa de tonos del catálogo de /tools: la familia se reconoce por su color en las dos pantallas. */
const TONE_CHIP: Record<FamilyTone, string> = {
  primary: 'bg-primary-soft text-primary',
  emerald: 'bg-emerald-soft text-emerald',
  amber: 'bg-amber-soft text-amber',
  sky: 'bg-sky-soft text-sky',
  rose: 'bg-rose-soft text-rose',
};

const PALETTE_STALE_MS = 5 * 60 * 1000;

/** `tools:docs` → `docs`, que es la clave con la que la taxonomía guarda el resumen. */
function metaOf(group: PaletteGroup) {
  return groupMeta(group.id.replace(/^tools:/, ''));
}

export function Capabilities({
  agentSlug,
  onCompose,
  disabled,
}: {
  agentSlug: string;
  /** Escribe la frase en el compositor y le deja el foco. Nunca envía. */
  onCompose: (phrase: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [picked, setPicked] = useState<string | null>(null);

  // MISMA CLAVE que la del compositor: esto no pide nada, se sirve de lo que ya
  // hay. `enabled: open` es sólo por si alguien llega aquí antes que el
  // compositor — el caso normal es un acierto de caché.
  const commands = useQuery<PaletteResponse>({
    queryKey: ['chat-palette', agentSlug],
    queryFn: async () => {
      const res = await fetch(`/api/chat/commands?agent=${encodeURIComponent(agentSlug)}`);
      if (!res.ok) throw new Error('commands');
      return (await res.json()) as PaletteResponse;
    },
    staleTime: PALETTE_STALE_MS,
    enabled: open,
  });

  const groups = useMemo(
    () => (commands.data?.groups ?? []).filter((g) => g.items.length > 0),
    [commands.data],
  );

  const total = useMemo(() => groups.reduce((n, g) => n + g.items.length, 0), [groups]);

  /**
   * BUSCAR ATRAVIESA LAS FAMILIAS. Quien escribe «cliente» no sabe —ni tiene
   * por qué saber— en cuál de todas lo guardamos, así que el filtro mira
   * todas y las que se quedan sin coincidencias desaparecen del índice en vez
   * de quedarse ahí para ser pulsadas y no dar nada.
   *
   * Y LOS EJEMPLOS DEL MARCADOR DE POSICIÓN SALEN DEL CATÁLOGO DE VERDAD. El
   * primero que escribí decía «factura», y «factura» no devolvía nada: aquí las
   * facturas se llaman pagos y cartera. Un campo de búsqueda que sugiere una
   * palabra y contesta «nada coincide» enseña, en el primer intento, que el
   * buscador no sirve. Visto en pantalla, no deducido.
   */
  const filtered = useMemo(() => {
    const q = term.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => {
        // El nombre de la familia cuenta como coincidencia de TODAS sus filas:
        // quien teclea «agenda» está pidiendo la familia entera, y devolverle
        // sólo las dos frases que repiten la palabra dentro es esconderle las
        // otras. Si además la fila la nombra, tanto mejor — no se duplica.
        const byFamily = `${g.heading} ${metaOf(g).blurb}`.toLowerCase().includes(q);
        if (byFamily) return g;
        return {
          ...g,
          items: g.items.filter((it) =>
            `${it.label} ${it.hint ?? ''} ${it.keywords ?? ''}`.toLowerCase().includes(q),
          ),
        };
      })
      .filter((g) => g.items.length > 0);
  }, [groups, term]);

  // La familia abierta, con red: si la búsqueda se llevó por delante la que
  // estaba elegida, manda la primera que quedó viva en vez de un panel vacío.
  const active = filtered.find((g) => g.id === picked) ?? filtered[0];

  function compose(phrase: string) {
    setOpen(false);
    onCompose(phrase);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Se abre limpio. Volver y encontrarse el filtro de la vez pasada es
        // volver y encontrarse un catálogo que parece medio vacío.
        if (next) {
          setTerm('');
          setPicked(null);
        }
      }}
    >
      <Dialog.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={clsx(
            'inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-border bg-surface px-3 py-1.5',
            'text-xs font-medium text-ink-muted shadow-card',
            'transition-colors duration-150 hover:border-primary/30 hover:bg-primary-soft hover:text-primary-ink',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
            'disabled:opacity-40 motion-reduce:transition-none',
          )}
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
          Qué puedes pedirme
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/25 backdrop-blur-[2px] data-[state=open]:animate-veil motion-reduce:animate-none" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[min(600px,calc(100vh-3rem))] w-[min(860px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-card bg-canvas shadow-pop focus:outline-none">
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold tracking-[-0.01em] text-ink">
                Qué puedes pedirme
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs leading-snug text-ink-muted">
                {/* La cifra sale de lo que de verdad llegó, no de una constante:
                    un espacio sin correo conectado tiene menos frases y el
                    encabezado tiene que decir la suya, no la del catálogo
                    completo. */}
                {total > 0
                  ? `${total} cosas que este espacio puede hacer hoy. Toca una y te la dejo escrita abajo.`
                  : 'Toca una y te la dejo escrita abajo — la revisas antes de mandarla.'}
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Cerrar"
              className="shrink-0 rounded-full p-1.5 text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="shrink-0 border-b border-border px-4 py-2.5 sm:px-5">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
                aria-hidden
              />
              <input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="Busca por palabra: cliente, reunión, informe, meta…"
                aria-label="Buscar en el catálogo"
                className="w-full rounded-pill border border-border bg-surface py-2 pl-9 pr-3 text-xs text-ink placeholder:text-ink-faint focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10"
              />
            </div>
          </div>

          {commands.isError ? (
            /* Un fallo de red NO se dibuja como un catálogo vacío: «no sé hacer
               nada» y «no pude leer lo que sé hacer» son dos frases distintas y
               sólo una es cierta. Misma regla que sostiene el menú del `/`. */
            <p className="grid flex-1 place-items-center px-5 text-center text-sm text-ink-muted">
              No pude cargar el catálogo. Revisa la conexión y vuelve a abrirlo.
            </p>
          ) : filtered.length === 0 ? (
            /* Ocupa el panel en vez de dejar una línea suelta sobre
               seiscientos píxeles de nada: un diálogo que se queda del mismo
               tamaño y se vacía parece roto, no vacío. */
            <p className="grid flex-1 place-items-center px-5 text-center text-sm text-ink-muted">
              {commands.isLoading
                ? 'Cargando lo que este espacio puede hacer…'
                : `Nada coincide con «${term.trim()}». Prueba con otra palabra.`}
            </p>
          ) : (
            <div className="flex min-h-0 flex-1">
              {/* EL ÍNDICE. Una docena de familias es demasiado para una rejilla de
                  tarjetas —se convierte en una pared que hay que leer entera—
                  y muy poco para un buscador solo. Una columna se recorre con
                  la vista de arriba abajo en un segundo. */}
              <nav
                aria-label="Familias"
                className="scroll-slim w-[15rem] shrink-0 overflow-y-auto border-r border-border p-2"
              >
                {filtered.map((group) => {
                  const meta = metaOf(group);
                  const Icon = ICONS[meta.icon] ?? Wrench;
                  const on = group.id === active?.id;
                  return (
                    <button
                      key={group.id}
                      type="button"
                      onClick={() => setPicked(group.id)}
                      onMouseEnter={() => setPicked(group.id)}
                      className={clsx(
                        'flex w-full items-center gap-2.5 rounded-sm px-2 py-2 text-left',
                        'transition-colors duration-150 motion-reduce:transition-none',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                        on ? 'bg-primary-soft' : 'hover:bg-surface-2',
                      )}
                    >
                      <span
                        className={clsx(
                          'grid h-6 w-6 shrink-0 place-items-center rounded-sm',
                          TONE_CHIP[meta.tone],
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" aria-hidden />
                      </span>
                      <span
                        className={clsx(
                          'min-w-0 flex-1 truncate text-xs font-medium',
                          on ? 'text-primary-ink' : 'text-ink',
                        )}
                      >
                        {group.heading}
                      </span>
                      {/* La cuenta va monoespaciada porque es una cifra que se
                          compara de un vistazo entre filas. Regla 3. */}
                      <span className="shrink-0 font-mono text-micro text-ink-faint">
                        {group.items.length}
                      </span>
                    </button>
                  );
                })}
              </nav>

              <div className="scroll-slim min-w-0 flex-1 overflow-y-auto p-4 sm:p-5">
                {active && (
                  <>
                    <h3 className="text-base font-semibold text-ink">{active.heading}</h3>
                    <p className="mt-1 max-w-[46rem] text-xs leading-relaxed text-ink-muted">
                      {metaOf(active).blurb}
                    </p>
                    <ul className="mt-3.5 space-y-1">
                      {active.items.map((item) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            onClick={() => compose(item.expands)}
                            className={clsx(
                              'group flex w-full items-baseline gap-2 rounded-sm px-2.5 py-2 text-left',
                              'transition-colors duration-150 hover:bg-primary-soft motion-reduce:transition-none',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                            )}
                          >
                            <span className="min-w-0 flex-1 text-sm text-ink group-hover:text-primary-ink">
                              {item.label}
                              {/* La frase que espera un dato termina en espacio:
                                  el puntito dice «aquí sigues tú» sin escribir
                                  una instrucción al lado de cada fila. */}
                              {item.expands.endsWith(' ') && (
                                <span className="text-ink-faint"> …</span>
                              )}
                            </span>
                            {item.hint && (
                              <span className="shrink-0 text-micro text-ink-faint">
                                {item.hint}
                              </span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
