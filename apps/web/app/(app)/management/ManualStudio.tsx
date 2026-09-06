'use client';
import { VoiceDictation } from '@/components/chat/VoiceDictation';
import { Button } from '@/components/ui/button';
import { CortexSignature } from '@/components/ui/cortex-signature';
import { manualFields, manualNarration, missingManualFields } from '@/lib/management/manual-draft';
import {
  type ManagementPlaybookData,
  type ManagementProfile,
  managementPlaybookSchema,
} from '@/lib/management/shape';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  FileText,
  Loader2,
  Plus,
  Search,
  Sparkles,
} from 'lucide-react';
import { useEffect, useRef, useState, useTransition } from 'react';
import { saveProfile } from './actions';
import { Alert, Field } from './form-fields';
import { organizeManual } from './manual-actions';
const blank: ManagementPlaybookData = {
  name: '',
  purpose: '',
  trigger: '',
  inputs: '',
  steps: '',
  successCriteria: '',
  exceptions: '',
  authority: '',
  browserUrl: null,
};
export function ManualStudio({
  profile,
  isAdmin,
  onSaved,
  onUse,
  activeTab,
}: {
  profile: ManagementProfile;
  isAdmin: boolean;
  activeTab: boolean;
  onSaved: () => void;
  onUse: (manual: ManagementPlaybookData) => void;
}) {
  const studioRef = useRef<HTMLElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [narration, setNarration] = useState('');
  const [draft, setDraft] = useState<ManagementPlaybookData | null>(null);
  const [sourceSnapshot, setSourceSnapshot] = useState('');
  const [questionsReviewed, setQuestionsReviewed] = useState(false);
  const [questions, setQuestions] = useState<string[]>([]);
  const [step, setStep] = useState<'explain' | 'review'>('explain');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [listening, setListening] = useState(false);
  const [pending, start] = useTransition();
  const [baseRevision, setBaseRevision] = useState(profile.revision);
  const [baseProfile, setBaseProfile] = useState(profile.data);
  const originalManual = typeof editing === 'number' ? baseProfile.playbooks[editing] : null;
  const dirty =
    editing !== null &&
    (originalManual
      ? narration !== manualNarration(originalManual) ||
        Boolean(draft && manualNarration(draft) !== manualNarration(originalManual))
      : Boolean(narration || draft));
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Navigation changes reset the reading position; text edits must not.
  useEffect(() => {
    if (activeTab) studioRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, [activeTab, selected, editing, step]);
  const active = selected === null ? null : profile.data.playbooks[selected];
  function begin(index: number | 'new') {
    const manual = index === 'new' ? null : profile.data.playbooks[index];
    setEditing(index);
    setDraft(manual ?? null);
    setNarration(manual ? manualNarration(manual) : '');
    setStep('explain');
    setSourceSnapshot('');
    setQuestionsReviewed(false);
    setQuestions([]);
    setError('');
    setNotice('');
    setBaseRevision(profile.revision);
    setBaseProfile(profile.data);
  }
  function leave() {
    if (dirty && !window.confirm('¿Descartar este borrador sin guardar?')) return;
    setEditing(null);
    setError('');
  }
  function analyze() {
    setError('');
    start(async () => {
      try {
        const r = await organizeManual(narration);
        if (r.ok) {
          setSourceSnapshot(narration);
          setQuestionsReviewed(false);
          setDraft(r.manual);
          setQuestions(r.questions);
          setStep('review');
        } else setError(r.error);
      } catch {
        setError('No se pudo conectar con Cortex. Conservamos tu explicación.');
      }
    });
  }
  function save() {
    if (!draft) return;
    const parsed = managementPlaybookSchema.safeParse(draft);
    if (!parsed.success) {
      setError('Completa los campos pendientes y revisa el enlace antes de guardar.');
      return;
    }
    setError('');
    start(async () => {
      try {
        const playbooks =
          editing === 'new'
            ? [...baseProfile.playbooks, parsed.data]
            : baseProfile.playbooks.map((p, i) => (i === editing ? parsed.data : p));
        const r = await saveProfile({ ...baseProfile, playbooks }, baseRevision);
        if (r.ok) {
          setSelected(editing === 'new' ? baseProfile.playbooks.length : editing);
          setEditing(null);
          setNotice('Manual guardado y compartido con la empresa.');
          onSaved();
        } else setError(r.error);
      } catch {
        setError('No se pudo guardar. El borrador sigue disponible.');
      }
    });
  }
  function removeManual() {
    if (
      selected === null ||
      !active ||
      !window.confirm(
        `¿Eliminar el manual «${active.name}» de la empresa? Los asuntos ya creados se conservan.`,
      )
    )
      return;
    setError('');
    start(async () => {
      try {
        const r = await saveProfile(
          { ...profile.data, playbooks: profile.data.playbooks.filter((_, i) => i !== selected) },
          profile.revision,
        );
        if (r.ok) {
          setSelected(null);
          setNotice('Manual eliminado.');
          onSaved();
        } else setError(r.error);
      } catch {
        setError('No se pudo eliminar el manual.');
      }
    });
  }
  const missing = draft ? missingManualFields(draft) : [];
  if (editing !== null)
    return (
      <section ref={studioRef} className="manual-studio scroll-mt-20 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Button variant="ghost" disabled={pending || listening} onClick={leave}>
            <ArrowLeft className="h-4 w-4" />
            Biblioteca de procesos
          </Button>
          <div className="flex items-center gap-3 text-xs text-ink-muted">
            <span className={step === 'explain' ? 'text-primary-ink' : ''}>1. Cuéntalo</span>
            <ChevronRight className="h-3 w-3" />
            <span className={step === 'review' ? 'text-primary-ink' : ''}>
              2. Revisa y comparte
            </span>
          </div>
        </div>
        {error && <Alert>{error}</Alert>}
        {step === 'explain' ? (
          <div className="manual-intake grid gap-8 p-6 sm:p-10 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-w-0">
              <CortexSignature className="mb-5 h-16 w-16 text-primary-ink" />
              <h1 className="text-3xl font-medium tracking-tight sm:text-[40px] sm:leading-tight">
                Tú conoces el proceso.
                <br />
                Cortex le da estructura.
              </h1>
              <p className="mt-4 max-w-xl text-sm leading-relaxed text-ink-muted">
                Cuéntalo de principio a fin, como se lo explicarías a alguien nuevo. Puedes mezclar
                pasos, personas y excepciones; Cortex propondrá dónde va cada cosa.
              </p>
              <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                <VoiceDictation
                  label="Dictar el proceso"
                  disabled={pending || !activeTab || narration.length >= 18000}
                  getBaseText={() => narration}
                  onText={(text) => setNarration(text.slice(0, 18000))}
                  onListeningChange={setListening}
                />
                <span className="text-xs text-ink-faint">
                  {narration.length.toLocaleString('es-CO')} / 18.000
                </span>
              </div>
              <label htmlFor="manual-narration" className="mt-5 block text-sm font-semibold">
                Tu explicación
              </label>
              <textarea
                id="manual-narration"
                value={narration}
                onChange={(e) => setNarration(e.target.value)}
                disabled={pending}
                maxLength={18000}
                rows={8}
                className="manual-narration mt-3 w-full resize-y rounded-2xl border border-border bg-canvas/50 p-5 text-sm leading-7 text-ink outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/15"
                placeholder="Por ejemplo: los lunes Ana revisa las facturas vencidas en nuestra hoja de cartera. Primero cruza los pagos confirmados. Si queda saldo, prepara un correo para que yo lo apruebe. Si el cliente reclama, se lo pasa a contabilidad…"
              />
              {narration.length >= 18000 && (
                <p className="mt-3 text-sm text-amber">
                  Llegaste al límite de esta explicación. Resume el texto antes de continuar.
                </p>
              )}
              {listening && (
                <output className="mt-3 block text-sm text-rose">
                  Escuchando. Puedes explicar todo seguido; termina el dictado para organizarlo.
                </output>
              )}
              <div className="mt-7 flex flex-wrap gap-3">
                <Button
                  disabled={pending || listening || narration.trim().length < 30}
                  onClick={analyze}
                >
                  {pending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  {pending
                    ? 'Organizando tu explicación…'
                    : draft
                      ? 'Reorganizar con Cortex'
                      : 'Organizar con Cortex'}
                </Button>
                <Button
                  variant="ghost"
                  disabled={pending || listening}
                  onClick={() => {
                    setDraft(draft ?? { ...blank });
                    setStep('review');
                  }}
                >
                  Editar directamente
                </Button>
              </div>
              <p className="mt-4 text-xs leading-relaxed text-ink-faint">
                La explicación se envía a Cortex al organizarla. El dictado usa el servicio de
                reconocimiento del navegador. Nada se comparte como manual hasta que lo guardes.
              </p>
            </div>
            <aside className="manual-guide self-start rounded-2xl border border-border/60 p-6">
              <h3 className="text-sm font-semibold">No necesitas seguir un formulario</h3>
              <p className="mt-3 text-xs leading-relaxed text-ink-muted">
                Estas pistas ayudan a que el manual quede completo. Cuéntalas en el orden que
                prefieras.
              </p>
              <ol className="mt-6 space-y-5">
                {[
                  ['Qué lo inicia', 'Cuándo, por qué y con qué datos.'],
                  ['Quién hace qué', 'Los pasos, las herramientas y las decisiones.'],
                  ['Qué cambia el camino', 'Excepciones y cuándo pedir ayuda.'],
                  ['Cómo sabemos que terminó', 'La evidencia y quién da el visto bueno.'],
                ].map(([title, body]) => (
                  <li key={title} className="border-l border-primary/40 pl-4">
                    <h4 className="text-sm font-medium">{title}</h4>
                    <p className="mt-1 text-xs leading-relaxed text-ink-muted">{body}</p>
                  </li>
                ))}
              </ol>
              <div className="mt-7 border-t border-border pt-4 text-xs leading-relaxed text-ink-muted">
                Cortex organiza lo que le cuentas. Si falta información, te la señala.
              </div>
            </aside>
          </div>
        ) : (
          draft && (
            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_280px]">
              <div className="min-w-0 space-y-5">
                <div>
                  <h1 className="text-2xl font-medium tracking-tight">Así queda tu proceso</h1>
                  <p className="mt-2 text-sm text-ink-muted">
                    Revisa cada sección. Puedes corregirla aquí o ampliar tu explicación y volver a
                    organizarla.
                  </p>
                </div>
                <Field
                  label="Nombre del proceso"
                  value={draft.name}
                  onChange={(name) => setDraft({ ...draft, name })}
                  disabled={pending}
                />
                {manualFields.map(([key, label, hint]) => (
                  <ManualReviewSection
                    key={key}
                    fieldKey={key}
                    label={label}
                    hint={hint}
                    value={draft[key]}
                    disabled={pending}
                    onChange={(value) => setDraft({ ...draft, [key]: value })}
                  />
                ))}
                <Field
                  label="Enlace al trámite enseñado (opcional)"
                  value={draft.browserUrl ?? ''}
                  onChange={(browserUrl) => setDraft({ ...draft, browserUrl: browserUrl || null })}
                  disabled={pending}
                />
              </div>
              <aside className="space-y-5 xl:sticky xl:top-4 xl:self-start">
                <div className="rounded-2xl border border-border bg-surface/80 p-5">
                  <h3 className="font-semibold">Antes de compartir</h3>
                  <p className="mt-3 text-sm text-ink-muted">
                    {missing.length
                      ? `${missing.length} secciones necesitan tu información.`
                      : 'Las secciones están completas. Comprueba que reflejen cómo trabaja tu empresa.'}
                  </p>
                  {missing.length > 0 && (
                    <ul className="mt-4 space-y-2 text-xs text-amber">
                      {missing.map((m) => (
                        <li key={m}>{m}</li>
                      ))}
                    </ul>
                  )}
                  <Button
                    className="mt-5 w-full"
                    disabled={
                      pending || missing.length > 0 || (questions.length > 0 && !questionsReviewed)
                    }
                    onClick={save}
                  >
                    {pending ? 'Guardando…' : 'Guardar manual en la empresa'}
                  </Button>
                  <Button
                    className="mt-2 w-full"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      setNarration(manualNarration(draft));
                      setStep('explain');
                    }}
                  >
                    Ampliar mi explicación
                  </Button>
                  <p className="mt-4 text-xs leading-relaxed text-ink-faint">
                    Documentar permisos no activa acciones ni reemplaza las aprobaciones de Cortex.
                  </p>
                </div>
                {questions.length > 0 && (
                  <div className="rounded-2xl border border-amber/25 p-5">
                    <h3 className="text-sm font-semibold text-amber">Cortex necesita aclarar</h3>
                    <ul className="mt-4 space-y-4 text-sm leading-relaxed text-ink-muted">
                      {questions.map((q) => (
                        <li key={q}>{q}</li>
                      ))}
                    </ul>
                    <label className="mt-5 flex items-start gap-2 text-xs leading-relaxed text-ink-muted">
                      <input
                        type="checkbox"
                        checked={questionsReviewed}
                        onChange={(e) => setQuestionsReviewed(e.target.checked)}
                      />
                      Revisé estas dudas y el borrador refleja las decisiones correctas.
                    </label>
                  </div>
                )}
                <details className="rounded-2xl border border-border p-5">
                  <summary className="cursor-pointer text-sm font-medium">
                    Ver la explicación usada
                  </summary>
                  <p className="mt-4 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-muted">
                    {sourceSnapshot || narration}
                  </p>
                </details>
              </aside>
            </div>
          )
        )}
      </section>
    );
  if (active)
    return (
      <section ref={studioRef} className="scroll-mt-20 space-y-7">
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap justify-between gap-3">
          <Button variant="ghost" onClick={() => setSelected(null)}>
            <ArrowLeft className="h-4 w-4" />
            Todos los procesos
          </Button>
          {isAdmin && (
            <div className="flex gap-2">
              <Button variant="ghost" disabled={pending} onClick={removeManual}>
                Eliminar manual
              </Button>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => begin(selected as number)}
              >
                Editar este manual
              </Button>
            </div>
          )}
        </div>
        <div className="manual-intake rounded-3xl p-6 sm:p-9">
          <BookOpen className="mb-5 h-6 w-6 text-primary-ink" />
          <h1 className="max-w-3xl text-3xl font-medium tracking-tight sm:text-4xl">
            {active.name}
          </h1>
          <p className="mt-4 max-w-2xl whitespace-pre-wrap text-sm leading-relaxed text-ink-muted">
            {active.purpose}
          </p>
          <Button className="mt-6" onClick={() => onUse(active)}>
            Crear asunto de este proceso
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div>
            <h3 className="mb-6 text-lg font-medium">El recorrido</h3>
            <ol className="manual-timeline space-y-0">
              {active.steps
                .split('\n')
                .filter((s) => s.trim())
                .map((s, i) => (
                  <li key={`${i}-${s}`} className="relative flex gap-5 pb-8">
                    <span className="relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full border border-primary/30 bg-surface text-xs text-primary-ink">
                      {i + 1}
                    </span>
                    <p className="pt-1 text-sm leading-7 text-ink-muted">
                      {s.replace(/^\d+[.)]\s*/, '')}
                    </p>
                  </li>
                ))}
            </ol>
            <section className="rounded-2xl border border-emerald/20 bg-emerald-soft/20 p-6">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-emerald">
                <Check className="h-4 w-4" />
                El resultado se comprueba así
              </h3>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-ink-muted">
                {active.successCriteria}
              </p>
            </section>
          </div>
          <aside className="space-y-6">
            {[
              ['Cuándo empieza', active.trigger],
              ['Qué necesitamos', active.inputs],
              ['Si algo cambia', active.exceptions],
              ['Permisos y decisiones', active.authority],
            ].map(([title, value]) => (
              <section key={title} className="border-t border-border pt-5">
                <h3 className="text-sm font-semibold">{title}</h3>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-ink-muted">
                  {value}
                </p>
              </section>
            ))}
            {active.browserUrl && (
              <a
                href={active.browserUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex text-sm text-primary-ink"
              >
                Abrir trámite enseñado ↗
              </a>
            )}
          </aside>
        </div>
      </section>
    );
  const visible = profile.data.playbooks
    .map((manual, index) => ({ manual, index }))
    .filter(({ manual }) =>
      `${manual.name} ${manual.purpose}`.toLowerCase().includes(query.toLowerCase()),
    );
  return (
    <section ref={studioRef} className="scroll-mt-20 space-y-7">
      {notice && <output className="block text-sm text-emerald">{notice}</output>}
      <div className="manual-intake flex flex-wrap items-center justify-between gap-7 rounded-3xl p-6 sm:p-9">
        <div className="max-w-xl">
          <h1 className="text-3xl font-medium tracking-tight sm:text-4xl">
            El conocimiento de tu equipo,
            <br />
            listo para trabajar.
          </h1>
          <p className="mt-4 max-w-lg text-sm leading-relaxed text-ink-muted">
            Procesos claros, decisiones visibles y una forma de comprobar cada resultado. Cuéntaselo
            a Cortex una vez y construyan el manual juntos.
          </p>
        </div>
        {isAdmin && (
          <Button disabled={profile.data.playbooks.length >= 20} onClick={() => begin('new')}>
            <Plus className="h-4 w-4" />
            Contar un nuevo proceso
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-ink-muted">
          {profile.data.playbooks.length}{' '}
          {profile.data.playbooks.length === 1 ? 'proceso compartido' : 'procesos compartidos'}
        </p>
        <label className="flex items-center gap-2 rounded-xl border border-border bg-surface/40 px-3 py-2 focus-within:ring-2 focus-within:ring-primary/50">
          <Search className="h-4 w-4 text-ink-faint" />
          <input
            aria-label="Buscar procesos"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar un proceso"
            className="min-w-0 bg-transparent text-sm outline-none"
          />
        </label>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {visible.map(({ manual, index }) => (
          <button
            key={`${index}-${manual.name}`}
            onClick={() => setSelected(index)}
            type="button"
            className="manual-library-card group flex min-h-60 flex-col rounded-2xl border border-border/70 p-6 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="mb-7 grid h-11 w-11 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary-ink">
              <FileText className="h-5 w-5" />
            </span>
            <h3 className="text-lg font-medium tracking-tight">{manual.name}</h3>
            <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-ink-muted">
              {manual.purpose}
            </p>
            <span className="mt-auto flex items-center justify-between pt-7 text-xs text-primary-ink">
              Explorar el proceso
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </span>
          </button>
        ))}
      </div>
      {!visible.length && (
        <div className="rounded-2xl border border-dashed border-border p-10 text-center">
          <BookOpen className="mx-auto mb-4 h-7 w-7 text-primary-ink" />
          <h3 className="text-lg font-medium">
            {query ? 'No encontramos ese proceso' : 'El primer manual empieza con una conversación'}
          </h3>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-ink-muted">
            {query
              ? 'Prueba otra palabra o busca por su propósito.'
              : 'Explica un proceso que tu equipo repita: cobros, solicitudes, compras o trámites. Cortex te ayudará a ordenarlo.'}
          </p>
        </div>
      )}
    </section>
  );
}

function ManualReviewSection({
  fieldKey,
  label,
  hint,
  value,
  disabled,
  onChange,
}: {
  fieldKey: string;
  label: string;
  hint: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(!value.trim() || fieldKey === 'steps');
  const id = `manual-field-${fieldKey}`;
  return (
    <section
      id={`manual-section-${fieldKey}`}
      className={`manual-review-section overflow-hidden rounded-2xl border ${!value.trim() ? 'border-amber/35 bg-amber-soft/20' : 'border-border/70 bg-surface/60'}`}
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-4 p-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={() => setOpen(!open)}
      >
        <span>
          <span className="block text-sm font-semibold">{label}</span>
          <span className="mt-1 block text-xs text-ink-muted">{hint}</span>
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {!value.trim() ? (
            <span className="text-xs text-amber">Completar</span>
          ) : (
            <Check className="h-4 w-4 text-emerald" />
          )}
          <ChevronRight
            className={`h-4 w-4 text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`}
          />
        </span>
      </button>
      {open ? (
        <div id={`${id}-body`} className="px-5 pb-4">
          <label htmlFor={id} className="sr-only">
            {label}
          </label>
          <textarea
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            rows={fieldKey === 'steps' ? 5 : 2}
            className="w-full rounded-xl border border-border p-3 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/40"
            placeholder="Completa esta parte con lo que ocurre en tu empresa."
          />
        </div>
      ) : (
        <p
          id={`${id}-body`}
          className="line-clamp-2 px-5 pb-5 text-sm leading-relaxed text-ink-muted"
        >
          {value}
        </p>
      )}
    </section>
  );
}
