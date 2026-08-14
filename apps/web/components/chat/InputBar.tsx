'use client';

import type { ScopeSpace } from '@/app/(chat)/chat/actions';
import { TeachFlowDialog } from '@/components/browser/TeachFlowDialog';
import {
  MENTION_MIN_CHARS,
  type PaletteGroup,
  type PaletteItem,
  type PaletteResponse,
  STATIC_COMMAND_GROUP,
  filterPalette,
  flattenPalette,
  mentionAtCaret,
  paletteSize,
  slashQuery,
} from '@/lib/chat-palette-shape';
import {
  matchShortcut,
  pickShortcuts,
  readUses,
  recordUse,
  shortcutCandidates,
} from '@/lib/chat-shortcuts';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  AlarmClock,
  ArrowUp,
  BarChart3,
  BookOpen,
  Bot,
  Boxes,
  Building2,
  CalendarDays,
  Car,
  ChevronDown,
  FileText,
  GitBranch,
  Globe,
  Handshake,
  Layers,
  Mail,
  Paperclip,
  Server,
  ShieldCheck,
  Target,
  Telescope,
  Terminal,
  User,
  Wallet,
  Workflow,
  Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AttachmentTray } from './AttachmentTray';
import { ScopePicker, ScopeStrip } from './MemoryScope';
import { QuickChips } from './QuickChips';
import { ScreenViewButton, type ScreenViewSession, ScreenViewStrip } from './ScreenView';
import { VoiceDictation } from './VoiceDictation';

interface AgentInfo {
  slug: string;
  name: string;
  description?: string;
}

interface InputBarProps {
  onSend: (text: string) => void;
  disabled: boolean;
  conversationId?: string;
  agents: AgentInfo[];
  agentSlug: string;
  onAgentChange: (slug: string) => void;
  draft?: string;
  onDraftConsumed?: () => void;
  /** The spaces this conversation is narrowed to. Empty means everything visible. */
  scope: ScopeSpace[];
  onScopeChange: (next: ScopeSpace[]) => void;
  /**
   * The shared-tab session, owned by ChatRoot because the frame has to reach
   * the request body. The composer only draws its control and its live strip.
   */
  screen?: ScreenViewSession;
}

const CHAR_COUNT_THRESHOLD = 3500;

/**
 * `/` COMMANDS AND `@` MENTIONS — and the thing that is deliberately absent.
 *
 * ===========================================================================
 * NO MODEL SELECTOR
 * ===========================================================================
 * The reference puts one in the composer and it is the one idea from it that is
 * rejected outright here. Which model answers is a product decision, argued and
 * MEASURED in packages/agent-tools/src/model.ts — Sonnet 5 over Opus 5 on cost
 * for a tool-heavy turn, reasoning off because at `max` it ate the answer's
 * budget on exactly the long turns this product is made of. Exposing that as a
 * dropdown would hand a dispatcher a dial whose settings they cannot evaluate,
 * make every support conversation start with "which model were you on", and
 * quietly invalidate the latency and quality numbers the product is tuned
 * against. The agent pill stays because agents differ in what they are ALLOWED
 * to do, which is the person's business; the model is not.
 *
 * ===========================================================================
 * WHAT ELSE IS IN HERE, AND THE FOUR THINGS THAT ARE NOT
 * ===========================================================================
 * The count is the design. A composer with a button for everything is a
 * composer where the person stops seeing any of them, so a control gets in only
 * if it lets somebody do something they otherwise could NOT do — never because
 * it saves a step.
 *
 *   agent pill   Which agent answers. It changes what Cortex is ALLOWED to do,
 *                which is the person's business. Already here.
 *   📎 adjuntar  Dragging a file is not a gesture that exists on a phone. The
 *                tray was reachable by drag alone, so on the surface where most
 *                of these people are standing, attaching was impossible.
 *   🎙 dictar    Hands full, phone in a pocket. See VoiceDictation.tsx.
 *   🧠 memoria   Which part of the brain answers. See MemoryScope.tsx.
 *   👁 mirar     Ask about what is ON THE SCREEN. It is admitted against the
 *                rule above and not around it: without it there is no way to
 *                ask about the page in front of you at all. The fallback is not
 *                "one more click" — it is take an OS screenshot, find the file,
 *                drag it in, and do it again for the follow-up, which is why
 *                what people actually do is describe the screen in words and
 *                get an answer about the description. See ScreenView.tsx.
 *
 * REJECTED, with the reason each time:
 *   MODEL SELECTOR   see above; the one idea from the reference thrown out.
 *   BUTTONS FOR THE  `/vencimientos`, `/informe`, `/placa` are already one
 *   DAILY ROUTINES   keystroke away in the `/` menu, and the empty screen
 *                    offers them in full sentences. A row of shortcut buttons
 *                    would be a third copy of the same six commands, competing
 *                    with the four controls above for the glance.
 *
 *                    SIGUE RECHAZADO, y la fila que hay ahora ENCIMA de la caja
 *                    no lo contradice: no es una lista escrita a mano. La
 *                    escribe el uso de quien la está mirando (ver
 *                    `lib/chat-shortcuts.ts`), sólo admite frases que se pueden
 *                    mandar enteras, y sale del mismo catálogo ya filtrado por
 *                    lo que este espacio puede ejecutar. Al mes son las cinco
 *                    preguntas de esa persona, que es justo lo que ninguna de
 *                    las otras dos copias sabe. Y se esconde en cuanto alguien
 *                    escribe, así que nunca compite con los controles de abajo
 *                    por la mirada de quien ya está redactando.
 *   TONE / LENGTH    A knob whose effect nobody can evaluate on their own
 *                    answer, on a product whose whole claim is that it shows
 *                    you where the answer came from.
 *   PIN A TOOL       The ranker chooses tools per turn and that choice is
 *                    measured; letting somebody pin one routes around the
 *                    measurement. Already argued at /api/chat/mentions — and
 *                    still true now that the `/` menu lists the catalogue: what
 *                    it inserts is the SENTENCE somebody would have typed to
 *                    ask for that tool, never the tool itself.
 *
 * ===========================================================================
 * BOTH MENUS EXPAND TO PLAIN TEXT
 * ===========================================================================
 * `@Coltrans` becomes the client's name and `/vencimientos` becomes a sentence.
 * Neither attaches a hidden parameter to the request, and that is the whole
 * design: a question composed with the menus and the same question typed by
 * hand produce byte-identical turns. So there is nothing here that can widen
 * what the model sees, nothing that behaves differently for the person who
 * knows the shortcuts, and nothing extra to reason about when a turn goes
 * wrong. A command is a phrase somebody would have had to type; a mention is a
 * name they would have had to spell.
 *
 * ===========================================================================
 * DE DÓNDE SALEN LAS FILAS, Y CUÁNTO CUESTAN
 * ===========================================================================
 * Los dos menús se pagan al revés a propósito, y la razón es lo acotada que
 * está cada lista:
 *
 *   `/`  UNA petición al abrirse (`/api/chat/commands`), con `staleTime` de
 *        cinco minutos, y a partir de ahí se filtra en memoria. Rutinas,
 *        flujos, trámites, encargos y el catálogo de herramientas caben en unos
 *        kilobytes y casi no cambian dentro de una conversación; volver a
 *        buscarlos en el servidor a cada tecla serían siete consultas a
 *        Supabase por letra y un menú que parpadea.
 *   `@`  búsqueda en el servidor con debounce y dos letras mínimo, porque
 *        clientes, personas, documentos y placas son miles de filas y crecen.
 *        Traerlos enteros al navegador sería descargar el CRM para dibujar
 *        cinco filas.
 *
 * La regla, dicha una vez: lo acotado se trae y se filtra aquí; lo ilimitado se
 * busca allá. Ninguna de las dos mitades adivina — cada una hace lo que su
 * tamaño permite.
 */

/**
 * Los nueve comandos fijos, las secciones que llegan del servidor y el filtrado
 * viven en lib/chat-palette-shape.ts, porque el filtrado es lógica pura con
 * casos de borde (tildes, tope de la vista de reposo, una sección que falló) y
 * la lógica pura se prueba en Node y no a mano en un menú.
 */

const PALETTE_ICONS: Record<string, typeof Terminal> = {
  AlarmClock,
  BarChart3,
  BookOpen,
  Boxes,
  Building2,
  CalendarDays,
  Car,
  FileText,
  GitBranch,
  Globe,
  Handshake,
  Layers,
  Mail,
  Server,
  ShieldCheck,
  Target,
  Telescope,
  Terminal,
  User,
  Wallet,
  Workflow,
  Wrench,
};

function paletteIcon(name: string): typeof Terminal {
  return PALETTE_ICONS[name] ?? Wrench;
}

/** Cinco minutos: lo que tarda en aparecer una rutina creada en otra pestaña. */
const PALETTE_STALE_MS = 5 * 60 * 1000;

/** Lo que se espera entre dos teclas antes de ir a buscar menciones. */
const MENTION_DEBOUNCE_MS = 140;

const BRIEFING_COMMAND = '/briefing';

function expandBriefingCommand(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith(BRIEFING_COMMAND)) return null;
  const company = trimmed.slice(BRIEFING_COMMAND.length).trim();
  if (!company) return null;
  return `Fetch a deal health briefing for ${company}: search HubSpot for the company, get the most recent deal, list BANT signals present/missing, and summarize last 3 activities.`;
}

export function InputBar({
  onSend,
  disabled,
  conversationId,
  agents,
  agentSlug,
  onAgentChange,
  draft,
  onDraftConsumed,
  scope,
  onScopeChange,
  screen,
}: InputBarProps) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  /**
   * Qué disparador se cerró con Escape. Es una llave («@12», «/») y no un
   * booleano a propósito: cerrar el menú no puede borrar lo tecleado, y sin
   * recordar CUÁL se cerró la siguiente búsqueda con debounce lo volvía a abrir
   * medio segundo después — así que no había forma de escribir «@» y un nombre
   * a mano.
   */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The tray's own file dialog, lent to the paperclip. Null until the tray
  // exists, which is why the button appears with it and not before: there is no
  // conversation to attach a file to yet.
  const [openFilePicker, setOpenFilePicker] = useState<(() => void) | null>(null);
  const registerFilePicker = useCallback(
    (open: () => void) => setOpenFilePicker((prev) => (prev === open ? prev : open)),
    [],
  );
  const textRef = useRef(text);
  textRef.current = text;

  const activeAgent = agents.find((a) => a.slug === agentSlug) ?? agents[0];
  const pillDisabled = !!conversationId || agents.length <= 1;

  const mention = useMemo(() => mentionAtCaret(text, caret), [text, caret]);
  const slash = useMemo(() => (mention ? null : slashQuery(text)), [mention, text]);
  // El `@` gana cuando los dos podrían aplicar: se está tecleando un nombre
  // dentro de algo que empezó con barra, y lo que importa es el nombre.
  const trigger = mention ? `@${mention.start}` : slash !== null ? '/' : null;

  // Un disparador que desaparece limpia el pestillo: la próxima `@` abre menú.
  useEffect(() => {
    if (!trigger) setDismissed(null);
  }, [trigger]);

  /**
   * El catálogo del `/`, UNA vez por conversación.
   *
   * Antes esperaba a que alguien tecleara una barra. Ahora se pide al montar,
   * porque los chips de arriba salen de esta misma respuesta y no de una
   * segunda: es la petición que el `/` iba a hacer de todos modos, adelantada un
   * turno, con la misma clave de caché y los mismos cinco minutos — así que
   * abrir el menú después sigue sin costar nada. Un chat en el que nadie teclea
   * una barra pasa a costar una consulta, y a cambio la fila de accesos existe.
   */
  const commands = useQuery<PaletteResponse>({
    queryKey: ['chat-palette', agentSlug],
    queryFn: async () => {
      const res = await fetch(`/api/chat/commands?agent=${encodeURIComponent(agentSlug)}`);
      if (!res.ok) throw new Error('commands');
      return (await res.json()) as PaletteResponse;
    },
    staleTime: PALETTE_STALE_MS,
  });

  // El término del `@`, retrasado. Se separa de `mention` para que la clave de
  // la consulta cambie una vez por pausa y no una vez por tecla.
  const [mentionTerm, setMentionTerm] = useState('');
  useEffect(() => {
    const typed = mention?.query ?? '';
    if (typed.length < MENTION_MIN_CHARS) {
      setMentionTerm('');
      return;
    }
    const timer = setTimeout(() => setMentionTerm(typed), MENTION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [mention]);

  const mentions = useQuery<PaletteResponse>({
    queryKey: ['chat-mentions', mentionTerm],
    queryFn: async () => {
      const res = await fetch(`/api/chat/mentions?q=${encodeURIComponent(mentionTerm)}`);
      if (!res.ok) throw new Error('mentions');
      return (await res.json()) as PaletteResponse;
    },
    enabled: mentionTerm.length >= MENTION_MIN_CHARS,
    staleTime: 30_000,
    // Las filas de la letra anterior se quedan mientras llegan las de esta. Un
    // menú que se vacía y se vuelve a llenar en cada tecla es un menú donde la
    // fila que ibas a elegir se mueve debajo del cursor.
    placeholderData: (previous) => previous,
  });

  /**
   * Un fallo de red no puede parecerse a «no hay nada». Es la misma regla que
   * cumplen las dos rutas por dentro con los errores de Supabase, sostenida
   * hasta el final del cable.
   */
  const groups = useMemo<PaletteGroup[]>(() => {
    if (mention) {
      if (mention.query.length < MENTION_MIN_CHARS) return [];
      if (mentions.isError) {
        return [
          {
            id: 'menciones',
            heading: 'Menciones',
            icon: 'Building2',
            items: [],
            error: 'No pude buscar. Revisa la conexión.',
          },
        ];
      }
      return mentions.data?.groups ?? [];
    }
    if (slash === null) return [];
    const fromServer = commands.isError
      ? [
          {
            id: 'catalogo',
            heading: 'Catálogo',
            icon: 'Wrench',
            items: [],
            error: 'No pude cargar rutinas, flujos ni herramientas.',
          },
        ]
      : (commands.data?.groups ?? []);
    return filterPalette([STATIC_COMMAND_GROUP, ...fromServer], slash);
  }, [mention, slash, mentions.data, mentions.isError, commands.data, commands.isError]);

  const rows = useMemo(() => flattenPalette(groups), [groups]);
  const menuOpen =
    trigger !== null &&
    dismissed !== trigger &&
    (paletteSize(groups) > 0 || groups.some((group) => group.error));
  // El resaltado vuelve arriba cuando cambia LO QUE SE VE. Clamping en vez de
  // resetear en cada render: una lista que se acorta no puede dejar el índice
  // apuntando al vacío, y Enter sobre el vacío no hace nada visible.
  const activeRow = rows.length === 0 ? 0 : Math.min(active, rows.length - 1);

  /**
   * LOS ACCESOS RÁPIDOS, de la misma respuesta que alimenta el menú del `/`.
   *
   * Los candidatos se derivan de los grupos tal cual llegan —ya filtrados por
   * `usableToolIds` en el servidor—, así que aquí no hay ninguna decisión sobre
   * qué puede o no puede ejecutar este espacio de trabajo. Ver
   * `lib/chat-shortcuts.ts` para el ranking y para por qué no comparte almacén
   * con el del rail.
   */
  const candidates = useMemo(
    () => shortcutCandidates([STATIC_COMMAND_GROUP, ...(commands.data?.groups ?? [])]),
    [commands.data],
  );

  /**
   * El uso se lee DESPUÉS de montar, nunca durante el render: `localStorage` no
   * existe en el servidor, y leerlo mientras se renderiza haría que el HTML que
   * baja y la primera pintura no coincidieran. El coste es que la fila aparece
   * con los por defecto un tick antes de ordenarse, y sólo la primera vez.
   */
  const [uses, setUses] = useState<Record<string, number>>({});
  useEffect(() => setUses(readUses()), []);

  const shortcuts = useMemo(() => pickShortcuts(candidates, uses), [candidates, uses]);

  const resize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  const put = useCallback(
    (value: string, caretAt?: number) => {
      setText(value);
      const ta = textareaRef.current;
      if (!ta) return;
      requestAnimationFrame(() => {
        ta.focus();
        const at = caretAt ?? value.length;
        ta.setSelectionRange(at, at);
        setCaret(at);
        resize();
      });
    },
    [resize],
  );

  // Dictation's way in. Deliberately NOT `put`: that one moves the caret and
  // takes focus, and doing either on every interim result would fight whoever
  // is editing the sentence while they speak.
  const setComposerText = useCallback(
    (value: string) => {
      setText(value);
      requestAnimationFrame(resize);
    },
    [resize],
  );

  // Prefill from a suggestion, a follow-up chip or a quoted selection.
  useEffect(() => {
    if (draft) {
      put(draft);
      onDraftConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  // Otra consulta, otras filas: el resaltado vuelve a la primera. Las tres
  // dependencias son señales de «cambió lo que se ve», no valores que el efecto
  // lea — por eso el analizador las cree de más y por eso están.
  // biome-ignore lint/correctness/useExhaustiveDependencies: el reseteo se dispara por el cambio de consulta, no por el uso de un valor.
  useEffect(() => setActive(0), [trigger, slash, mentionTerm]);

  /**
   * Lo elegido aterriza como TEXTO. Una mención reemplaza el `@palabra` que se
   * estaba tecleando; un comando reemplaza la línea entera. En ninguno de los
   * dos casos queda colgado un identificador: el siguiente turno es una frase
   * que una persona pudo haber escrito, y nada río abajo tiene que enterarse de
   * que hubo un menú de por medio.
   */
  function applyItem(item: PaletteItem) {
    if (mention) {
      const before = text.slice(0, mention.start);
      const after = text.slice(caret);
      put(`${before}${item.expands}${after}`, before.length + item.expands.length);
      return;
    }
    put(item.expands);
  }

  /**
   * EL ÚNICO SITIO POR EL QUE SALE UN TURNO DESDE AQUÍ, y por eso es donde se
   * aprende. Cuenta la frase mandada venga de donde venga —un chip, el menú del
   * `/`, una tarjeta de la pantalla vacía, un seguimiento o el teclado—, que es
   * lo que impide que la fila se refuerce sólo a sí misma. Ver `matchShortcut`.
   */
  const send = useCallback(
    (trimmed: string) => {
      const learned = matchShortcut(trimmed, candidates);
      if (learned) {
        recordUse(learned);
        setUses(readUses());
      }
      onSend(trimmed);
    },
    [candidates, onSend],
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const expanded = expandBriefingCommand(text);
    const trimmed = (expanded ?? text).trim();
    if (!trimmed || disabled) return;
    send(trimmed);
    setText('');
    setDismissed(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(trigger);
        return;
      }
      if (rows.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActive((i) => (Math.min(i, rows.length - 1) + 1) % rows.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActive((i) => (Math.min(i, rows.length - 1) - 1 + rows.length) % rows.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const row = rows[activeRow];
          if (row) applyItem(row.item);
          return;
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    setCaret(e.target.selectionStart ?? e.target.value.length);
    resize();
  }

  return (
    <div className="shrink-0 px-4 pb-4 pt-1">
      <div className="mx-auto w-full max-w-3xl">
        {conversationId && (
          <div className="mb-2">
            <AttachmentTray
              conversationId={conversationId}
              onAsk={(question) => put(question)}
              onPickerReady={registerFilePicker}
            />
          </div>
        )}

        <div className="relative">
          {/*
            Above the box, not inside a menu, and on every turn it is in force.
            The whole argument is in MemoryScope.tsx: a filter somebody forgot
            turns a full brain into "no tengo nada sobre eso".
          */}
          <ScopeStrip
            selected={scope}
            onRemove={(id) => onScopeChange(scope.filter((s) => s.id !== id))}
            onClear={() => onScopeChange([])}
            disabled={disabled}
          />
          {/*
            And here, for the same reason and with more at stake. A memory
            filter somebody forgot costs them an answer; a screen share somebody
            forgot is the worst thing this product can do to a person. So it is
            a band on the screen for as long as the share is, never a menu item
            and never a dot — see ScreenView.tsx.
          */}
          {screen && <ScreenViewStrip session={screen} />}
          {menuOpen && (
            /*
              A real listbox, not a styled div: arrow keys move `aria-activedescendant`
              and the textarea keeps focus, so somebody driving this from the
              keyboard never loses their place in what they were writing.

              Los encabezados van como `role="presentation"`: son rótulos de
              sección, no opciones, y un lector de pantalla que los cuente como
              filas anuncia «14 opciones» donde hay nueve.
            */
            <ul
              id="composer-menu"
              // biome-ignore lint/a11y/useSemanticElements: the listbox pattern is correct here; focus stays in the textarea.
              role="listbox"
              // "Menciones", not "Fuentes": since the composer grew a memory
              // filter, "fuente" means the space an answer was read from, and
              // it is already what the citations under an answer are called.
              // Two things by one name is how somebody looks for the filter in
              // the `@` menu.
              aria-label={mention ? 'Menciones' : 'Comandos'}
              className="scroll-slim absolute bottom-full z-40 mb-2 max-h-80 w-full overflow-y-auto rounded-card border border-border bg-surface p-1.5 shadow-pop"
            >
              {groups.map((group) => {
                const Icon = paletteIcon(group.icon);
                return (
                  <li key={group.id} role="presentation">
                    <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-micro font-semibold uppercase tracking-wide text-ink-faint">
                      <Icon className="h-3 w-3 shrink-0" aria-hidden />
                      {group.heading}
                    </div>
                    {group.error && (
                      // Nunca una lista vacía en lugar de un fallo: la sección
                      // dice qué no se pudo leer y sigue en su sitio.
                      <p className="px-2.5 pb-1.5 text-xs leading-snug text-ink-muted">
                        {group.error}
                      </p>
                    )}
                    <ul role="presentation">
                      {group.items.map((item) => {
                        const index = rows.findIndex(
                          (row) => row.groupId === group.id && row.item.id === item.id,
                        );
                        const selected = index === activeRow;
                        return (
                          // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handling lives on the textarea, which keeps focus.
                          <li
                            key={item.id}
                            id={`composer-option-${index}`}
                            role="option"
                            aria-selected={selected}
                            onMouseEnter={() => setActive(index)}
                            onMouseDown={(e) => {
                              // Before blur, so the caret position is still valid.
                              e.preventDefault();
                              applyItem(item);
                            }}
                            className={clsx(
                              'flex cursor-pointer items-baseline gap-2 rounded-sm px-2.5 py-1.5',
                              selected && 'bg-primary-soft',
                            )}
                          >
                            {/* Las dos truncan y las dos llevan `min-w-0`: sin
                                él un flex-item no baja de su ancho de contenido
                                y una frase larga empuja la pista fuera de la
                                caja en vez de cortarse. */}
                            <span
                              className={clsx(
                                'min-w-0 truncate text-xs text-ink',
                                item.mono ? 'font-mono font-semibold' : 'font-medium',
                              )}
                            >
                              {item.label}
                            </span>
                            {item.hint && (
                              <span className="min-w-0 shrink truncate text-xs text-ink-faint">
                                {item.hint}
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    {group.more !== undefined && (
                      <p className="px-2.5 pb-1 text-micro text-ink-faint">
                        y {group.more} más — sigue escribiendo
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {/*
            La fila de accesos, y las dos condiciones para que se vea. Vacío el
            compositor: es la fila para EMPEZAR, y sobre un borrador a medias
            sería una distracción justo encima de donde se está mirando. Y con
            el menú cerrado por consecuencia — el menú del `/` se abre en este
            mismo hueco, y sólo se abre cuando hay texto.
          */}
          {!text.trim() && <QuickChips shortcuts={shortcuts} onPick={send} disabled={disabled} />}

          <form
            onSubmit={handleSubmit}
            className={clsx(
              'rounded-card border bg-surface transition-all duration-150 motion-reduce:transition-none',
              focused
                ? 'border-primary/40 shadow-pop ring-4 ring-primary/10'
                : 'border-border shadow-card',
            )}
          >
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="Pregunta por una llamada, una placa o una rutina. @ para nombrar algo, / para un comando…"
              disabled={disabled}
              rows={1}
              role="combobox"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? 'composer-menu' : undefined}
              aria-activedescendant={
                menuOpen && rows.length > 0 ? `composer-option-${activeRow}` : undefined
              }
              aria-autocomplete="list"
              className="scroll-slim block max-h-[200px] min-h-[24px] w-full resize-none bg-transparent px-4 pt-3.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none disabled:opacity-50"
            />

            <div className="flex items-center justify-between gap-2 px-3 pb-2.5 pt-1">
              <div className="flex min-w-0 items-center gap-1">
                {pillDisabled ? (
                  <span
                    title="Empieza un chat nuevo para cambiar de agente"
                    className="inline-flex items-center gap-1.5 rounded-pill bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-faint"
                  >
                    <Bot className="h-3.5 w-3.5" />
                    {activeAgent?.name ?? 'Agente'}
                  </span>
                ) : (
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1.5 rounded-pill border border-border px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors duration-150 hover:border-primary/30 hover:bg-primary-soft hover:text-primary-ink motion-reduce:transition-none"
                      >
                        <Bot className="h-3.5 w-3.5 text-primary" />
                        {activeAgent?.name ?? 'Agente'}
                        <ChevronDown size={12} className="opacity-60" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        side="top"
                        align="start"
                        sideOffset={8}
                        className="z-50 min-w-[240px] rounded-card border border-border bg-surface p-1.5 shadow-pop"
                      >
                        {agents.map((a) => (
                          <DropdownMenu.Item
                            key={a.slug}
                            onSelect={() => onAgentChange(a.slug)}
                            className="flex cursor-pointer flex-col gap-0.5 rounded-sm px-2.5 py-2 text-sm outline-none transition-colors duration-150 data-[highlighted]:bg-primary-soft motion-reduce:transition-none"
                          >
                            <span className="font-semibold text-ink">{a.name}</span>
                            {a.description && (
                              <span className="line-clamp-1 text-xs text-ink-faint">
                                {a.description}
                              </span>
                            )}
                          </DropdownMenu.Item>
                        ))}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                )}

                <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden />

                {openFilePicker && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => openFilePicker()}
                    aria-label="Adjuntar un archivo"
                    title="Adjuntar un archivo"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-40 motion-reduce:transition-none"
                  >
                    <Paperclip className="h-4 w-4" aria-hidden />
                  </button>
                )}

                <VoiceDictation
                  disabled={disabled}
                  getBaseText={() => textRef.current}
                  onText={setComposerText}
                />

                {/* Enseñar un trámite sin salir de la conversación. The whole
                    recorder is the same component the Trámites screen uses;
                    see components/browser/TeachFlowDialog.tsx for why the
                    person starts it rather than the agent offering it. */}
                <TeachFlowDialog onCompose={setComposerText} />

                {/* Preguntarle a Cortex por lo que tienes en pantalla. The
                    fifth control, and the argument for admitting it is in
                    ScreenView.tsx: without it there is no way to ask about
                    what is on screen at all, which is the only test a control
                    has to pass to get in here. MIRAR, not GRABAR — the
                    recorder beside it does the other thing. */}
                {screen && <ScreenViewButton session={screen} disabled={disabled} />}

                <ScopePicker selected={scope} onChange={onScopeChange} disabled={disabled} />
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {text.length > CHAR_COUNT_THRESHOLD && (
                  <span className="tabular text-micro text-ink-faint">{text.length}</span>
                )}
                <button
                  type="submit"
                  disabled={disabled || !text.trim()}
                  aria-label="Enviar mensaje"
                  className="grid h-8 w-8 place-items-center rounded-full bg-primary text-white shadow-pop transition-all duration-150 hover:-translate-y-px hover:bg-primary-strong disabled:opacity-40 disabled:shadow-none motion-reduce:transform-none motion-reduce:transition-none"
                >
                  <ArrowUp size={16} strokeWidth={2.5} />
                </button>
              </div>
            </div>
          </form>
        </div>

        <p className="mt-1.5 text-center text-micro text-ink-faint">
          Cada respuesta trae su fuente: revísala antes de actuar.
        </p>
      </div>
    </div>
  );
}
