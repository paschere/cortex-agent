'use client';

import {
  STARTER_TEMPLATES,
  type StarterCategory,
  type StarterTemplate,
  templateShape,
} from '@/lib/views/starter-templates';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import {
  ArrowUp,
  Boxes,
  CalendarDays,
  Check,
  Inbox,
  KanbanSquare,
  type LucideIcon,
  Sparkles,
  SquareDashed,
  TrendingUp,
  Truck,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { BLANK, type StudioLaunch } from '../ViewStudio';
import { ViewThumbnail } from '../ViewThumbnail';

/**
 * «NUEVA VISTA»: LA GALERÍA DE DÓNDE EMPEZAR.
 *
 * Tres maneras, de la más guiada a la más libre, en una sola pantalla:
 *
 *   - DESCRIBIRLA. Arriba, porque es lo más corto: se escribe lo que se quiere
 *     ver y el estudio abre con Cortex ya armándola con las tablas de la
 *     empresa. Debajo, frases sugeridas a partir de las tablas que el espacio
 *     ya tiene, para que el primer clic produzca algo con sus datos.
 *   - UNA PLANTILLA, con la miniatura de su forma. Las «Lista, con tus datos»
 *     (`kind: 'spec'`) abren armadas sobre datos que Cortex ya lleva (cartera,
 *     ventas) sin gastar una respuesta del plan; las «Cortex la arma» llevan
 *     una frase porque dependen de las tablas de cada empresa (y si faltan,
 *     Cortex propone crearlas).
 *   - EL LIENZO EN BLANCO, para quien prefiere armar a mano.
 *
 * Todo abre el estudio (`StudioLaunch`): nada se guarda hasta «Crear».
 */

const ICON: Record<StarterTemplate['icon'], LucideIcon> = {
  truck: Truck,
  wallet: Wallet,
  trending: TrendingUp,
  inbox: Inbox,
  users: Users,
  boxes: Boxes,
  calendar: CalendarDays,
  kanban: KanbanSquare,
};

const CATEGORIES: Array<StarterCategory | 'Todas'> = [
  'Todas',
  'Ventas y cartera',
  'Operación',
  'Clientes y equipo',
];

export function launchFor(t: StarterTemplate): StudioLaunch {
  if (t.kind === 'spec')
    return {
      draft: { name: t.name, description: t.description, spec: t.spec, newTrackers: [] },
      explanation: `Plantilla «${t.title}» con datos reales de Cortex. Ajústala y guárdala cuando te sirva.`,
    };
  return { draft: { ...BLANK, name: t.title }, autoPrompt: t.prompt };
}

export function TemplateCard({
  template,
  onPick,
  compact = false,
}: {
  template: StarterTemplate;
  onPick: () => void;
  compact?: boolean;
}) {
  const Icon = ICON[template.icon];
  return (
    <button
      type="button"
      onClick={onPick}
      className="group flex h-full w-full flex-col overflow-hidden rounded-card border border-border bg-surface text-left shadow-card transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-pop motion-reduce:transition-none motion-reduce:hover:translate-y-0"
    >
      <div className="relative border-b border-border bg-canvas/60 p-2.5">
        <ViewThumbnail blocks={templateShape(template)} size={compact ? 'sm' : 'lg'} />
        <span
          className={clsx(
            'absolute bottom-4 left-4 inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-micro font-semibold shadow-card',
            template.kind === 'spec'
              ? 'bg-emerald-soft text-emerald'
              : 'bg-primary-soft text-primary',
          )}
        >
          {template.kind === 'spec' ? (
            <>
              <Check className="h-3 w-3" aria-hidden /> Lista, con tus datos
            </>
          ) : (
            <>
              <Sparkles className="h-3 w-3" aria-hidden /> Cortex la arma
            </>
          )}
        </span>
      </div>
      <div className="flex flex-1 gap-3 p-3.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink group-hover:text-primary">
            {template.title}
          </span>
          <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-ink-muted">
            {template.body}
          </span>
        </span>
      </div>
    </button>
  );
}

export function NewViewDialog({
  open,
  onOpenChange,
  suggestions,
  onLaunch,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suggestions: string[];
  onLaunch: (launch: StudioLaunch) => void;
}) {
  const [category, setCategory] = useState<StarterCategory | 'Todas'>('Todas');
  const [text, setText] = useState('');
  const templates = STARTER_TEMPLATES.filter(
    (t) => category === 'Todas' || t.category === category,
  );
  const describe = (value: string) => {
    const ask = value.trim();
    if (ask.length < 4) return;
    onLaunch({ draft: BLANK, autoPrompt: ask });
    setText('');
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 animate-veil bg-canvas/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 top-6 z-50 flex flex-col overflow-hidden rounded-t-card border border-border bg-surface shadow-pop outline-none sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:max-h-[90vh] sm:w-[min(1040px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-card">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
            <div>
              <Dialog.Title className="text-lg font-semibold text-ink">Nueva vista</Dialog.Title>
              <Dialog.Description className="text-xs text-ink-muted">
                Descríbela, parte de una plantilla o ármala a mano. Nada se guarda hasta «Crear».
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Cerrar"
              className="grid h-8 w-8 place-items-center rounded-pill text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
            {/* Describirla */}
            <section className="rounded-card border border-primary/30 bg-gradient-to-br from-primary-soft/70 to-surface p-4 sm:p-5">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                <Sparkles className="h-4 w-4 text-primary" aria-hidden /> Describir con Cortex
              </p>
              <p className="mt-0.5 text-xs text-ink-muted">
                Di qué quieres ver y para quién. Cortex la arma con las tablas de tu empresa y la
                abre en el estudio para que la ajustes.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  describe(text);
                }}
                className="mt-3 flex items-end gap-2 rounded-card border border-border-strong bg-surface p-1.5 shadow-card focus-within:border-primary"
              >
                <textarea
                  rows={2}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      describe(text);
                    }
                  }}
                  maxLength={4000}
                  aria-label="Describe la vista"
                  placeholder="«Tablero de remates con el total por ciudad y los que vencen esta semana»"
                  className="min-h-[3rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-ink outline-none placeholder:text-ink-faint"
                />
                <button
                  type="submit"
                  disabled={text.trim().length < 4}
                  className="cortex-primary-button inline-flex h-9 shrink-0 items-center gap-1.5 rounded-pill bg-primary px-3.5 text-xs font-semibold text-white transition-all duration-150 hover:bg-primary-strong disabled:opacity-40"
                >
                  <ArrowUp className="h-3.5 w-3.5" aria-hidden /> Crear con Cortex
                </button>
              </form>
              {suggestions.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setText(s)}
                      className="rounded-pill border border-border bg-surface px-2.5 py-1 text-left text-micro text-ink-muted transition-all duration-150 hover:-translate-y-px hover:border-border-strong hover:text-ink"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </section>

            {/* Plantillas */}
            <section className="mt-6">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-base font-semibold text-ink">Plantillas</h3>
                <fieldset className="flex flex-wrap gap-1 rounded-pill bg-surface-2 p-0.5">
                  <legend className="sr-only">Área</legend>
                  {CATEGORIES.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-pressed={category === c}
                      onClick={() => setCategory(c)}
                      className={clsx(
                        'rounded-pill px-2.5 py-1 text-micro font-semibold transition-colors duration-150',
                        category === c
                          ? 'bg-surface text-ink shadow-card'
                          : 'text-ink-muted hover:text-ink',
                      )}
                    >
                      {c}
                    </button>
                  ))}
                </fieldset>
              </div>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {templates.map((t) => (
                  <li key={t.id}>
                    <TemplateCard template={t} onPick={() => onLaunch(launchFor(t))} />
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    onClick={() => onLaunch({ draft: BLANK })}
                    className="group flex h-full min-h-[14rem] w-full flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed border-border-strong p-5 text-center transition-all duration-150 hover:border-primary/60 hover:bg-primary-soft/20 motion-reduce:transition-none"
                  >
                    <span className="grid h-10 w-10 place-items-center rounded-pill bg-surface-2 text-ink-muted transition-colors group-hover:text-primary">
                      <SquareDashed className="h-5 w-5" aria-hidden />
                    </span>
                    <span className="text-sm font-semibold text-ink group-hover:text-primary">
                      Lienzo en blanco
                    </span>
                    <span className="max-w-[16rem] text-xs leading-relaxed text-ink-muted">
                      Arma la vista pieza por pieza: cifras, tablas, gráficos, tableros y
                      formularios.
                    </span>
                  </button>
                </li>
              </ul>
            </section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
