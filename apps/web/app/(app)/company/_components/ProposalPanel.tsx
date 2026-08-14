'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel, PanelHead } from '@/components/ui/panel';
import { Provenance } from '@/components/ui/provenance';
import { COMPANY_FACTS_BUDGET } from '@/lib/company-facts-shape';
import { clsx } from 'clsx';
import { Check, Plus, Search, Sparkles, X } from 'lucide-react';
import { useMemo, useState, useTransition } from 'react';
import type { FactAlternative, Proposal, ProposedFact } from '../_lib/proposal';
import { isBulkAcceptable, weighSelection } from '../_lib/proposal';
import { acceptFacts, proposeFacts } from '../actions';
import type { ActionResult, FactView, SectionView } from './types';

/**
 * «QUE LO BUSQUE CORTEX».
 *
 * ===========================================================================
 * POR QUÉ PIDE EL NOMBRE ANTES DE BUSCAR
 * ===========================================================================
 * No es una comodidad de búsqueda: es el desempate y sin él la mitad de esta
 * pantalla sería peligrosa. Un contrato nombra a DOS empresas y trae DOS NIT, y
 * nada dentro del texto dice cuál de las dos eres tú. El nombre que se teclea
 * aquí es lo que hace que se proponga TU razón social y TU NIT y no los de tu
 * cliente. Ver `_lib/extract.ts`.
 *
 * ===========================================================================
 * CADA VALOR LLEVA SU PROCEDENCIA, Y NO COMO ADORNO
 * ===========================================================================
 * «Razón social: COLTRANS S.A.S. · de tu contrato con Coltrans, marzo 2026» y
 * «Razón social: Coltrans S.A.S. · de coltrans.com, leído hoy» son la misma
 * frase con dos niveles de confianza distintos, y una persona decide distinto
 * según cuál sea. Por eso el chip está pegado al valor y no en una columna
 * aparte, por eso debajo va el RENGLÓN LITERAL de donde salió, y por eso el
 * botón de aceptar en bloque no toca lo que viene de la web.
 *
 * Y por eso también: aquí no hay ni un valor sin chip. `selectProposal`
 * descarta los que llegan sin procedencia antes de que esta pantalla los vea,
 * así que la regla del sistema de diseño —un valor sin procedencia no lleva
 * chip— se cumple no pintando chips vacíos sino no teniendo esos valores.
 *
 * ===========================================================================
 * LO QUE NO SE ENCONTRÓ SE ENSEÑA, VACÍO
 * ===========================================================================
 * La lista de abajo no es un error ni una disculpa: es la otra mitad del
 * resultado. Un hueco con nombre —«NIT, sin respuesta»— es infinitamente mejor
 * que un valor verosímil, y además es accionable: cada hueco abre el formulario
 * de a mano con la etiqueta ya puesta, que es lo mismo que ya hacen las fichas
 * sugeridas de cada sección.
 */

interface Props {
  facts: FactView[];
  sections: SectionView[];
  /** Lo que dice `ba_organization`. Es una semilla editable, no una respuesta. */
  seedName: string;
  onFillManually: (section: string, label: string) => void;
  onResult: (result: ActionResult) => void;
}

export function ProposalPanel({ facts, sections, seedName, onFillManually, onResult }: Props) {
  const [name, setName] = useState(seedName);
  const [site, setSite] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  /**
   * Cuál de las respuestas se eligió para cada campo: 0 es la que ganó y 1 en
   * adelante son sus alternativas.
   *
   * SE GUARDA EL ÍNDICE Y NO EL VALOR, y esto no es un detalle. La procedencia
   * viaja pegada a cada opción, así que guardando sólo el texto elegido el chip
   * seguiría enseñando el de la ganadora: la pantalla diría «30 días» con un
   * sello que dice «Tus pagos» cuando ese 30 salió de las fichas de cliente.
   * Sería una procedencia falsa en la pantalla cuyo trabajo entero es que la
   * procedencia sea cierta.
   */
  const [chosen, setChosen] = useState<Record<string, number>>({});
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  const names = useMemo(() => Object.fromEntries(sections.map((s) => [s.key, s.name])), [sections]);
  const sectionName = (key: string) => names[key] ?? key;

  const selected = useMemo(
    () =>
      (proposal?.facts ?? [])
        .filter((f) => picked.has(f.key))
        .map((f) => ({
          section: f.section,
          label: f.label,
          value: optionsOf(f)[chosen[f.key] ?? 0]?.value ?? f.value,
        })),
    [proposal, picked, chosen],
  );

  // El medidor se mueve al marcar, no al guardar. Es el mismo argumento que el
  // de `CompanyBoard`: el momento de enterarse de que no cabe es mientras
  // eliges, no cuando ya elegiste.
  const projected = useMemo(() => weighSelection(facts, selected, names), [facts, selected, names]);
  const over = projected > COMPANY_FACTS_BUDGET;

  function search() {
    setBusy(true);
    setError(null);
    startTransition(async () => {
      const outcome = await proposeFacts({ name, site: site.trim() || null });
      setBusy(false);
      if (!outcome.ok || !outcome.proposal) {
        setError(outcome.error ?? 'No se pudo buscar.');
        return;
      }
      setProposal(outcome.proposal);
      setNotes(outcome.notes ?? []);
      setChosen({});
      // NADA VIENE MARCADO. Marcar por defecto convierte «revisa esto» en
      // «confirma esto», y son dos preguntas distintas.
      setPicked(new Set());
    });
  }

  function toggle(key: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function markTrusted() {
    if (!proposal) return;
    setPicked(
      new Set(proposal.facts.filter((f) => isBulkAcceptable(f.provenance.kind)).map((f) => f.key)),
    );
  }

  function save() {
    if (selected.length === 0) return;
    setBusy(true);
    startTransition(async () => {
      const outcome = await acceptFacts({ facts: selected });
      setBusy(false);
      onResult(outcome);
      if (outcome.ok) {
        setProposal(null);
        setPicked(new Set());
        setNotes([]);
      }
    });
  }

  const trustedCount = (proposal?.facts ?? []).filter((f) =>
    isBulkAcceptable(f.provenance.kind),
  ).length;

  return (
    <Panel>
      <PanelHead icon={<Sparkles className="h-4 w-4" aria-hidden />} title="Que lo busque Cortex" />
      <div className="px-5 pb-4 pt-2">
        <p className="text-xs leading-relaxed text-ink-muted">
          Escribe el nombre de la empresa y Cortex busca el resto en tus documentos, en tus propios
          datos y en la web. No guarda nada: te propone, con de dónde salió cada cosa, y tú apruebas
          lo que sea cierto.
        </p>

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[14rem] flex-1">
            <label className="field-label block" htmlFor="company-search-name">
              Nombre de la empresa
            </label>
            <Input
              id="company-search-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Coltrans Logística"
              maxLength={120}
              className="mt-1"
            />
          </div>
          <div className="min-w-[12rem] flex-1">
            <label className="field-label block" htmlFor="company-search-site">
              Su sitio web, si lo sabes
            </label>
            <Input
              id="company-search-site"
              value={site}
              onChange={(e) => setSite(e.target.value)}
              placeholder="coltrans.com"
              maxLength={200}
              className="mt-1 font-mono"
            />
          </div>
          <Button
            type="button"
            onClick={search}
            disabled={busy || name.trim().length < 2}
            className="px-3 py-2 text-xs"
          >
            <Search className="h-3.5 w-3.5" aria-hidden />
            {busy ? 'Buscando…' : 'Buscar'}
          </Button>
        </div>

        {error && (
          <output className="mt-3 block rounded-card border border-rose/30 bg-rose/5 px-4 py-3 text-sm text-ink">
            {error}
          </output>
        )}

        {notes.length > 0 && (
          <ul className="mt-3 space-y-1">
            {notes.map((note) => (
              <li key={note} className="text-micro leading-relaxed text-ink-faint">
                {note}
              </li>
            ))}
          </ul>
        )}

        {proposal && (
          <div className="mt-4 space-y-4">
            {proposal.facts.length === 0 ? (
              <p className="text-xs leading-relaxed text-ink-muted">
                No encontré nada que pueda citarte palabra por palabra, así que no te propongo nada.
                Lo que falta está abajo: puedes escribirlo tú.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-ink">
                    {proposal.facts.length}{' '}
                    {proposal.facts.length === 1 ? 'dato encontrado' : 'datos encontrados'}
                  </span>
                  {trustedCount > 0 && (
                    <button
                      type="button"
                      onClick={markTrusted}
                      className="text-micro font-semibold text-primary underline-offset-2 hover:underline"
                    >
                      Marcar los {trustedCount} de tus documentos y tus datos
                    </button>
                  )}
                  {picked.size > 0 && (
                    <button
                      type="button"
                      onClick={() => setPicked(new Set())}
                      className="text-micro font-semibold text-ink-faint underline-offset-2 hover:text-ink hover:underline"
                    >
                      Desmarcar todo
                    </button>
                  )}
                </div>

                {sections.map((section) => {
                  const own = proposal.facts.filter((f) => f.section === section.key);
                  if (own.length === 0) return null;
                  return (
                    <div key={section.key}>
                      <div className="field-label">{section.name}</div>
                      <ul className="mt-1.5 divide-y divide-border">
                        {own.map((fact) => (
                          <Row
                            key={fact.key}
                            fact={fact}
                            at={chosen[fact.key] ?? 0}
                            checked={picked.has(fact.key)}
                            busy={busy}
                            onToggle={() => toggle(fact.key)}
                            onChoose={(at) => setChosen((prev) => ({ ...prev, [fact.key]: at }))}
                          />
                        ))}
                      </ul>
                    </div>
                  );
                })}

                {/* EL AVISO LLEGA ANTES DE ACEPTAR, NO AL GUARDAR. La puerta de
                    escritura también lo rechazaría, pero enterarse ahí es
                    enterarse cuando ya elegiste. */}
                <div
                  className={clsx(
                    'rounded-sm px-3 py-2 text-micro leading-relaxed',
                    over ? 'bg-rose/5 text-rose' : 'bg-surface-2 text-ink-faint',
                  )}
                >
                  <span className="tabular">
                    {projected.toLocaleString('es-CO')} /{' '}
                    {COMPANY_FACTS_BUDGET.toLocaleString('es-CO')} caracteres
                  </span>{' '}
                  {over
                    ? 'con lo que llevas marcado. No cabe: desmarca alguno o acorta un dato que ya esté escrito.'
                    : 'si guardas lo que llevas marcado.'}
                  {proposal.overCountIfAll &&
                    ' Además, la ficha ya está en el máximo de datos: borra alguno que ya no aplique.'}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    onClick={save}
                    disabled={busy || selected.length === 0 || over}
                    className="px-3 py-1.5 text-xs"
                  >
                    <Check className="h-3.5 w-3.5" aria-hidden />
                    {busy
                      ? 'Guardando…'
                      : `Guardar ${selected.length === 0 ? 'lo marcado' : selected.length}`}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setProposal(null)}
                    disabled={busy}
                    className="px-3 py-1.5 text-xs"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                    Descartar la propuesta
                  </Button>
                </div>
              </>
            )}

            {proposal.unresolved.length > 0 && (
              <div className="border-t border-border pt-3">
                <div className="field-label">Lo que no encontré</div>
                <p className="mt-1 text-micro leading-relaxed text-ink-faint">
                  Nadie lo tiene escrito en ningún sitio que Cortex pueda citar, así que se queda
                  vacío. Pulsa uno para escribirlo tú.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {proposal.unresolved.map((field) => (
                    <button
                      key={`${field.section}:${field.label}`}
                      type="button"
                      onClick={() => onFillManually(field.section, field.label)}
                      className="inline-flex items-center gap-1 rounded-pill border border-dashed border-border-strong px-2.5 py-1 text-micro font-semibold text-ink-muted transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-ink"
                    >
                      <Plus className="h-3 w-3" aria-hidden />
                      {field.label}
                      <span className="font-normal text-ink-faint">
                        · {sectionName(field.section)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

/**
 * Un valor propuesto: la casilla, el valor, el chip y el renglón de donde salió.
 *
 * El renglón literal es la pieza que hace que aprobar signifique algo. Sin él,
 * aprobar es creerle a la pantalla; con él, es leer la frase «identificada con
 * NIT 900.373.115-3» del propio contrato y reconocerla.
 */
function Row({
  fact,
  at,
  checked,
  busy,
  onToggle,
  onChoose,
}: {
  fact: ProposedFact;
  /** Cuál de las respuestas está elegida. 0 es la que ganó. */
  at: number;
  checked: boolean;
  busy: boolean;
  onToggle: () => void;
  onChoose: (at: number) => void;
}) {
  const options = optionsOf(fact);
  // EL VALOR Y SU PROCEDENCIA SALEN DE LA MISMA OPCIÓN, SIEMPRE. Es la línea
  // que impide que la pantalla enseñe un valor con el sello de otro.
  const option = options[at] ?? (options[0] as FactAlternative);

  return (
    <li className="flex items-start gap-3 py-2.5">
      <input
        type="checkbox"
        checked={checked}
        disabled={busy}
        onChange={onToggle}
        aria-label={`Guardar ${fact.label}`}
        className="mt-1 h-4 w-4 shrink-0 rounded-sm accent-primary"
      />
      <div className="min-w-0 flex-1">
        <div className="field-label">{fact.label}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2">
          {/* Regla 3: un dato que alguien puede citar o copiar va monoespaciado. */}
          <span className="break-words font-mono text-xs leading-relaxed text-ink">
            {option.value}
          </span>
          <Provenance
            source={option.provenance.source}
            readAt={option.provenance.readAt}
            detail={option.provenance.detail}
          />
        </div>
        {option.provenance.quote && (
          <p className="mt-1 break-words border-l-2 border-border pl-2 font-mono text-micro leading-relaxed text-ink-faint">
            {option.provenance.quote}
          </p>
        )}

        {/* LAS OTRAS RESPUESTAS A LA MISMA PREGUNTA. No se tiran: «30 días» del
            contrato y «47 días» de los pagos son las dos verdad, y cuál sirve
            depende de para qué. */}
        {fact.alternatives.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-micro text-ink-faint">También encontré:</span>
            {options.map((choice, index) => (
              <button
                key={`${choice.provenance.source}:${choice.value}`}
                type="button"
                onClick={() => onChoose(index)}
                aria-pressed={index === at}
                className={clsx(
                  'rounded-pill border px-2 py-0.5 font-mono text-micro transition-colors',
                  index === at
                    ? 'border-primary/40 bg-primary/5 text-ink'
                    : 'border-border text-ink-muted hover:border-border-strong hover:text-ink',
                )}
              >
                {choice.value}
                <span className="ml-1 font-sans text-ink-faint">{choice.provenance.source}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Las respuestas a una pregunta, en un solo array: la que ganó y las demás.
 *
 * Existe para que el índice signifique lo mismo en los tres sitios que lo usan
 * —lo que se guarda, lo que se pinta y lo que se marca—, porque la alternativa
 * era construir la lista tres veces y confiar en que las tres coincidieran.
 */
function optionsOf(fact: ProposedFact): FactAlternative[] {
  return [{ value: fact.value, provenance: fact.provenance }, ...fact.alternatives];
}
