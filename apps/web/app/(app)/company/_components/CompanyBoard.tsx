'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel, PanelHead } from '@/components/ui/panel';
import {
  COMPANY_FACTS_BUDGET,
  COMPANY_FACT_LABEL_MAX,
  COMPANY_FACT_VALUE_MAX,
  weighCompanyFactsHere,
} from '@/lib/company-facts-shape';
import { clsx } from 'clsx';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useMemo, useState, useTransition } from 'react';
import { removeFact, saveFact } from '../actions';
import type { ActionResult, FactView, SectionView } from './types';

/**
 * LA FICHA, EDITABLE EN SITIO.
 *
 * ===========================================================================
 * POR QUÉ NO ES UN FORMULARIO DE CUARENTA CASILLAS
 * ===========================================================================
 * Porque un formulario de cuarenta casillas es un formulario que nadie termina,
 * y una ficha con treinta y dos casillas vacías se lee como un producto roto —
 * el mismo argumento que la migración 0101 escribió para las metas y que aquí
 * vale igual. Así que los campos sugeridos NO son casillas: son fichas en las
 * que se pulsa, que abren UNA fila con la etiqueta ya puesta. Se responde lo que
 * se sabe, se ignora lo que no aplica, y se añade lo que nadie previó.
 *
 * ===========================================================================
 * EL MEDIDOR SE MUEVE MIENTRAS SE TECLEA, Y ESO ES EL DISEÑO
 * ===========================================================================
 * La barra de arriba cuenta caracteres, no porcentaje de un formulario
 * completado. Es lo honesto: este texto entra en cada respuesta de Cortex, así
 * que lo que se está gastando es contexto y dinero, no «avance». Se mueve con
 * cada letra porque el momento en que alguien tiene que enterarse de que se está
 * pasando es MIENTRAS escribe, no cuando pulsa guardar.
 *
 * La aritmética que la mueve es una copia de la del servidor —
 * `lib/company-facts-shape.ts`— y `company-facts-parity.test.ts` falla en cuanto
 * discrepan. Sin esa prueba, el medidor diría que caben cuatrocientos
 * caracteres, el guardado los rechazaría, y nadie podría ver la cuenta.
 *
 * ===========================================================================
 * SIN PERMISO DE ESCRITURA NO SE ESCONDE NADA, SÓLO SE APAGAN LOS CONTROLES
 * ===========================================================================
 * Quien no es admin ve la ficha entera, el medidor y el bloque literal. Lo que
 * no ve son los botones. Es a propósito: la ficha explica las respuestas que esa
 * persona recibe todo el día, y no poder cambiarla no es una razón para no poder
 * comprobarla. El permiso de verdad lo aplica el servidor en cada acción.
 */

interface Draft {
  /** Null cuando es un hecho nuevo. */
  id: string | null;
  section: string;
  label: string;
  value: string;
}

export function CompanyBoard({
  facts,
  sections,
  canEdit,
  block,
}: {
  facts: FactView[];
  sections: SectionView[];
  canEdit: boolean;
  block: string;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  const names = useMemo(() => Object.fromEntries(sections.map((s) => [s.key, s.name])), [sections]);

  // El peso de lo GUARDADO más lo que se está escribiendo, sustituyendo la fila
  // que se edita en vez de sumarla: corregir un dato largo por uno corto tiene
  // que hacer BAJAR la barra, no subirla por el peso del que va a desaparecer.
  const used = useMemo(() => {
    const rest = facts.filter((f) => !draft?.id || f.id !== draft.id);
    const pending =
      draft?.label.trim() && draft.value.trim()
        ? [{ section: draft.section, label: draft.label, value: draft.value }]
        : [];
    return weighCompanyFactsHere([...rest, ...pending], names);
  }, [facts, draft, names]);

  function commit(input: Draft) {
    setBusy(true);
    startTransition(async () => {
      const outcome = await saveFact({
        id: input.id,
        section: input.section,
        label: input.label,
        value: input.value,
      });
      setResult(outcome);
      setBusy(false);
      if (outcome.ok) setDraft(null);
    });
  }

  function drop(id: string) {
    setBusy(true);
    startTransition(async () => {
      const outcome = await removeFact({ id });
      setResult(outcome);
      setBusy(false);
    });
  }

  return (
    <div className="space-y-4">
      <BudgetMeter used={used} count={facts.length} block={block} />

      {/* `<output>` y no un `<p role="status">`: trae el rol puesto y es el
          elemento que existe para el resultado de una acción. Un lector de
          pantalla lo anuncia sin que nadie mueva el foco, que es lo que hace
          falta cuando lo que cambió está tres secciones más abajo. */}
      {result && (
        <output
          className={clsx(
            'block rounded-card border px-4 py-3 text-sm',
            result.ok
              ? 'border-emerald/25 bg-emerald/5 text-ink'
              : 'border-rose/30 bg-rose/5 text-ink',
          )}
        >
          {result.ok ? result.note : result.error}
        </output>
      )}

      {sections.map((section) => (
        <Section
          key={section.key}
          section={section}
          facts={facts.filter((f) => f.section === section.key)}
          canEdit={canEdit}
          busy={busy}
          draft={draft?.section === section.key ? draft : null}
          onDraft={setDraft}
          onCommit={commit}
          onDrop={drop}
        />
      ))}

      {!canEdit && (
        <p className="text-xs text-ink-faint">
          Puedes ver la ficha completa porque es lo que explica las respuestas de Cortex. Cambiarla
          es de un administrador del espacio.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * El medidor.
 *
 * Una sola tira y no cinco, por lo mismo que argumenta `ContextWeight`: las
 * partes compiten por UN presupuesto, y una tira continua es la única forma que
 * lo dice. Pasado el tope se pinta de rosa y lo dice con palabras — el color
 * solo no es un mensaje.
 */
function BudgetMeter({ used, count, block }: { used: number; count: number; block: string }) {
  const [open, setOpen] = useState(false);
  const over = used > COMPANY_FACTS_BUDGET;
  const share = Math.min(used / COMPANY_FACTS_BUDGET, 1);
  const fmt = (n: number) => n.toLocaleString('es-CO');

  return (
    <Panel>
      <PanelHead
        title="Lo que ocupa en cada respuesta"
        right={
          <span className={clsx('tabular text-micro', over ? 'text-rose' : 'text-ink-muted')}>
            {fmt(used)} / {fmt(COMPANY_FACTS_BUDGET)} caracteres
          </span>
        }
      />
      <div className="px-5 pb-4 pt-3">
        <div className="flex h-2.5 w-full overflow-hidden rounded-pill bg-surface-2">
          <span
            className={clsx('h-full transition-all duration-200', over ? 'bg-rose' : 'bg-primary')}
            style={{ width: `${share * 100}%` }}
          />
        </div>
        <p className="mt-2.5 text-micro leading-relaxed text-ink-faint">
          {count === 0
            ? 'Todavía no hay nada escrito, así que Cortex no sabe nada de la empresa por su cuenta.'
            : `${count} ${count === 1 ? 'dato' : 'datos'}. Este texto va completo en cada respuesta de Cortex —en el chat, en Google Chat, por MCP y en las rutinas— así que ocupa sitio que si no usarían los documentos del cerebro. Nunca se recorta solo: si te pasas del tope, el guardado te lo dice.`}
        </p>
        {over && (
          <p className="mt-1.5 text-xs font-semibold text-rose">
            Te pasaste del tope. Borra un dato que ya no aplique o acorta alguno antes de añadir
            más.
          </p>
        )}

        {block && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="text-micro font-semibold text-ink-muted underline-offset-2 hover:text-ink hover:underline"
            >
              {open ? 'Ocultar' : 'Ver'} lo que recibe Cortex, palabra por palabra
            </button>
            {open && (
              <pre className="scroll-slim mt-2 max-h-80 overflow-auto rounded-sm bg-surface-2 p-3 font-mono text-micro leading-relaxed text-ink-muted">
                {block}
              </pre>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

function Section({
  section,
  facts,
  canEdit,
  busy,
  draft,
  onDraft,
  onCommit,
  onDrop,
}: {
  section: SectionView;
  facts: FactView[];
  canEdit: boolean;
  busy: boolean;
  draft: Draft | null;
  onDraft: (d: Draft | null) => void;
  onCommit: (d: Draft) => void;
  onDrop: (id: string) => void;
}) {
  const written = new Set(facts.map((f) => f.label.trim().toLowerCase()));
  const missing = section.suggested.filter((s) => !written.has(s.trim().toLowerCase()));

  return (
    <Panel>
      <PanelHead
        title={section.name}
        right={
          <span className="tabular text-micro text-ink-faint">
            {facts.length === 0 ? 'sin datos' : `${facts.length}`}
          </span>
        }
      />
      <div className="px-5 pb-4 pt-2">
        <p className="text-xs leading-relaxed text-ink-muted">{section.blurb}</p>

        <ul className="mt-3 divide-y divide-border">
          {facts.map((fact) =>
            draft?.id === fact.id ? (
              <li key={fact.id} className="py-3">
                <FactForm
                  draft={draft}
                  busy={busy}
                  onChange={onDraft}
                  onCommit={onCommit}
                  onCancel={() => onDraft(null)}
                />
              </li>
            ) : (
              <li key={fact.id} className="group flex items-start gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="field-label">{fact.label}</div>
                  {/* Regla 3 del sistema de diseño: un dato que alguien puede
                      citar o copiar va en monoespaciada. Un NIT y un plazo de
                      pago son exactamente eso. */}
                  <div className="mt-0.5 break-words font-mono text-xs leading-relaxed text-ink">
                    {fact.value}
                  </div>
                  <div className="mt-1 text-micro text-ink-faint">
                    {fact.updatedByName ? `${fact.updatedByName} · ` : ''}
                    {fact.updatedOn}
                  </div>
                </div>
                {canEdit && (
                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <IconButton
                      label={`Editar ${fact.label}`}
                      disabled={busy}
                      onClick={() =>
                        onDraft({
                          id: fact.id,
                          section: fact.section,
                          label: fact.label,
                          value: fact.value,
                        })
                      }
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                    </IconButton>
                    <IconButton
                      label={`Borrar ${fact.label}`}
                      disabled={busy}
                      danger
                      onClick={() => onDrop(fact.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </IconButton>
                  </div>
                )}
              </li>
            ),
          )}
        </ul>

        {draft && draft.id === null && (
          <div className="border-t border-border pt-3">
            <FactForm
              draft={draft}
              busy={busy}
              onChange={onDraft}
              onCommit={onCommit}
              onCancel={() => onDraft(null)}
            />
          </div>
        )}

        {canEdit && !draft && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {/* EL ESTADO VACÍO, QUE NO ES UN CARTEL. Cada hueco es un botón que
                deja la fila abierta con el nombre ya escrito: responder «NIT»
                pasa de ser una decisión sobre qué escribir a ser teclear el
                número. */}
            {missing.map((label) => (
              <button
                key={label}
                type="button"
                onClick={() => onDraft({ id: null, section: section.key, label, value: '' })}
                className="inline-flex items-center gap-1 rounded-pill border border-dashed border-border-strong px-2.5 py-1 text-micro font-semibold text-ink-muted transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-ink"
              >
                <Plus className="h-3 w-3" aria-hidden />
                {label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => onDraft({ id: null, section: section.key, label: '', value: '' })}
              className="inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-micro font-semibold text-ink-faint transition-colors hover:text-ink"
            >
              <Plus className="h-3 w-3" aria-hidden />
              otro dato
            </button>
          </div>
        )}

        {!canEdit && facts.length === 0 && (
          <p className="mt-3 text-micro text-ink-faint">
            Nadie ha escrito nada aquí, así que Cortex no lo sabe.
          </p>
        )}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

function FactForm({
  draft,
  busy,
  onChange,
  onCommit,
  onCancel,
}: {
  draft: Draft;
  busy: boolean;
  onChange: (d: Draft) => void;
  onCommit: (d: Draft) => void;
  onCancel: () => void;
}) {
  const ready = draft.label.trim().length >= 2 && draft.value.trim().length >= 1;

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) onCommit(draft);
      }}
    >
      <Input
        value={draft.label}
        onChange={(e) => onChange({ ...draft, label: e.target.value })}
        placeholder="Cómo se llama el dato"
        maxLength={COMPANY_FACT_LABEL_MAX}
        aria-label="Nombre del dato"
        // Autofoco sólo cuando la etiqueta viene vacía: si llegó precargada
        // desde una ficha sugerida, el cursor tiene que estar en lo que falta.
        autoFocus={draft.label.length === 0}
      />
      <Input
        value={draft.value}
        onChange={(e) => onChange({ ...draft, value: e.target.value })}
        placeholder="Lo que hay que saber"
        maxLength={COMPANY_FACT_VALUE_MAX}
        aria-label="Contenido del dato"
        className="font-mono"
        autoFocus={draft.label.length > 0}
      />
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={!ready || busy} className="px-3 py-1.5 text-xs">
          <Check className="h-3.5 w-3.5" aria-hidden />
          {busy ? 'Guardando…' : 'Guardar'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={busy}
          className="px-3 py-1.5 text-xs"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          Cancelar
        </Button>
        <span className="tabular ml-auto text-micro text-ink-faint">
          {draft.value.trim().length}/{COMPANY_FACT_VALUE_MAX}
        </span>
      </div>
    </form>
  );
}

function IconButton({
  label,
  danger,
  disabled,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'rounded-pill p-1.5 transition-colors disabled:opacity-40',
        danger
          ? 'text-ink-faint hover:bg-rose/10 hover:text-rose'
          : 'text-ink-faint hover:bg-surface-2 hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}
