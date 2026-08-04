'use client';

import { Panel } from '@/components/ui/panel';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Copy,
  Hash,
  Info,
  Loader2,
  Lock,
  Plus,
  Save,
  Terminal,
  Trash2,
  UserCheck,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  type BuilderTool,
  type ParamDef,
  SLUG_RE,
  type StepDef,
  extractPlaceholders,
  placeholderSources,
  renderPlaybook,
  slugify,
  slugifyInput,
} from '../_lib/playbook';
import { ToolPicker } from './ToolPicker';

interface StepRow {
  key: string;
  title: string;
  detail: string;
  tools: string[];
  checkpoint: boolean;
}

interface ParamRow {
  key: string;
  name: string;
  description: string;
  required: boolean;
}

let uid = 0;
const nextKey = (prefix: string) => `${prefix}${++uid}`;

const MAX_STEPS = 12;
const MAX_PARAMS = 10;

export interface PipelineBuilderProps {
  mode: 'create' | 'edit';
  tools: BuilderTool[];
  /** Run number the preview should show: times_run + 1. */
  nextRunNumber: number;
  initial?: {
    slug: string;
    name: string;
    description: string;
    emoji: string;
    intro: string;
    steps: StepDef[];
    params: ParamDef[];
  };
}

const SECTION = 'field-label';
const FIELD =
  'w-full rounded-card border border-border bg-surface px-3 py-2 text-[13px] text-ink transition-colors placeholder:text-ink-faint focus:border-border-strong';

/** Small pill switch, matching the tools catalog toggle. */
function Switch({
  on,
  onClick,
  label,
  tone = 'primary',
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  tone?: 'primary' | 'amber';
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className={clsx(
        'relative h-[18px] w-8 shrink-0 rounded-sm transition-colors',
        on ? (tone === 'amber' ? 'bg-amber' : 'bg-primary') : 'bg-border',
      )}
    >
      <span
        className={clsx(
          'absolute top-[2px] h-[14px] w-[14px] rounded-sm bg-surface transition-all',
          on ? 'left-[16px]' : 'left-[2px]',
        )}
      />
    </button>
  );
}

export function PipelineBuilder({ mode, tools, nextRunNumber, initial }: PipelineBuilderProps) {
  const router = useRouter();

  const [emoji, setEmoji] = useState(initial?.emoji || '⚡');
  const [name, setName] = useState(initial?.name ?? '');
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(mode === 'edit');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [intro, setIntro] = useState(initial?.intro ?? '');

  const [steps, setSteps] = useState<StepRow[]>(() =>
    (initial?.steps ?? []).length > 0
      ? (initial?.steps ?? []).map((s) => ({
          key: nextKey('s'),
          title: s.title,
          detail: s.detail,
          tools: s.tools ?? [],
          checkpoint: s.checkpoint ?? false,
        }))
      : [{ key: nextKey('s'), title: '', detail: '', tools: [], checkpoint: false }],
  );

  const [params, setParams] = useState<ParamRow[]>(() =>
    (initial?.params ?? []).map((p) => ({
      key: nextKey('p'),
      name: p.name,
      description: p.description ?? '',
      required: p.required !== false,
    })),
  );

  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // ── Derived state ────────────────────────────────────────────────────────
  const cleanSteps: StepDef[] = useMemo(
    () =>
      steps.map((s) => ({
        title: s.title.trim(),
        detail: s.detail.trim(),
        tools: s.tools,
        checkpoint: s.checkpoint,
      })),
    [steps],
  );

  const used = useMemo(
    () => extractPlaceholders(placeholderSources(intro, cleanSteps)),
    [intro, cleanSteps],
  );
  const declared = useMemo(() => params.map((p) => p.name.trim()).filter(Boolean), [params]);
  const undeclared = useMemo(() => used.filter((u) => !declared.includes(u)), [used, declared]);
  const unused = useMemo(() => declared.filter((d) => !used.includes(d)), [declared, used]);

  const errors = useMemo(() => {
    const list: string[] = [];
    if (name.trim().length < 2 || name.trim().length > 80)
      list.push('El nombre debe tener entre 2 y 80 caracteres.');
    if (!SLUG_RE.test(slug))
      list.push(
        'El slug va en minúsculas con guiones, entre 2 y 49 caracteres (a–z, 0–9, guiones).',
      );
    if (description.length > 300) list.push('La descripción no puede pasar de 300 caracteres.');
    if (emoji.length > 8) list.push('El emoji no puede pasar de 8 caracteres.');
    if (intro.length > 1000) list.push('La introducción no puede pasar de 1000 caracteres.');
    if (cleanSteps.length < 1) list.push('Un pipeline necesita al menos un paso.');
    if (cleanSteps.length > MAX_STEPS)
      list.push(`Un pipeline puede tener máximo ${MAX_STEPS} pasos.`);
    cleanSteps.forEach((s, i) => {
      if (s.title.length < 2 || s.title.length > 80)
        list.push(`Paso ${i + 1}: el título debe tener entre 2 y 80 caracteres.`);
      if (s.detail.length < 5 || s.detail.length > 2000)
        list.push(`Paso ${i + 1}: el detalle debe tener entre 5 y 2000 caracteres.`);
      if ((s.tools ?? []).length > 8) list.push(`Paso ${i + 1}: máximo 8 herramientas.`);
    });
    if (params.length > MAX_PARAMS) list.push(`Máximo ${MAX_PARAMS} parámetros.`);
    params.forEach((p, i) => {
      const n = p.name.trim();
      if (!n) list.push(`Parámetro ${i + 1}: el nombre es obligatorio.`);
      else if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(n))
        list.push(`Parámetro “${n}”: debe empezar con letra y usar solo letras, dígitos o _.`);
    });
    const dupes = declared.filter((d, i) => declared.indexOf(d) !== i);
    if (dupes.length > 0) list.push(`Hay parámetros repetidos: ${[...new Set(dupes)].join(', ')}.`);
    if (undeclared.length > 0)
      list.push(
        `Faltan por declarar: ${undeclared.map((u) => `{{${u}}}`).join(', ')}. Agrégalos como parámetros.`,
      );
    return list;
  }, [name, slug, description, emoji, intro, cleanSteps, params, declared, undeclared]);

  const warnings = useMemo(() => {
    const list: string[] = [];
    if (unused.length > 0)
      list.push(`Declarados pero nunca usados: ${unused.map((u) => `{{${u}}}`).join(', ')}.`);
    if (cleanSteps.length > 0 && !cleanSteps.some((s) => s.checkpoint))
      list.push(
        'Sin puntos de control: el agente corre de principio a fin sin detenerse a preguntarte.',
      );
    if (cleanSteps.every((s) => (s.tools ?? []).length === 0))
      list.push('Ningún paso tiene herramientas. Nombrarlas hace el guion mucho más confiable.');
    return list;
  }, [unused, cleanSteps]);

  const preview = useMemo(
    () =>
      renderPlaybook({
        emoji,
        name: name.trim() || 'Pipeline sin título',
        intro: intro.trim(),
        steps: cleanSteps,
        runNumber: nextRunNumber,
      }),
    [emoji, name, intro, cleanSteps, nextRunNumber],
  );

  // ── Step mutations ───────────────────────────────────────────────────────
  function patchStep(i: number, patch: Partial<StepRow>) {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  function move(i: number, dir: -1 | 1) {
    setSteps((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      const a = next[i];
      const b = next[j];
      if (!a || !b) return prev;
      next[i] = b;
      next[j] = a;
      return next;
    });
  }

  function duplicateStep(i: number) {
    setSteps((prev) => {
      if (prev.length >= MAX_STEPS) return prev;
      const s = prev[i];
      if (!s) return prev;
      const copy: StepRow = { ...s, key: nextKey('s'), tools: [...s.tools] };
      return [...prev.slice(0, i + 1), copy, ...prev.slice(i + 1)];
    });
  }

  function removeStep(i: number) {
    setSteps((prev) => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)));
  }

  function addStep() {
    setSteps((prev) =>
      prev.length >= MAX_STEPS
        ? prev
        : [...prev, { key: nextKey('s'), title: '', detail: '', tools: [], checkpoint: false }],
    );
  }

  function addParam(presetName = '') {
    setParams((prev) =>
      prev.length >= MAX_PARAMS
        ? prev
        : [...prev, { key: nextKey('p'), name: presetName, description: '', required: true }],
    );
  }

  // ── Save ─────────────────────────────────────────────────────────────────
  async function save() {
    if (errors.length > 0 || saving) return;
    setSaving(true);
    setServerError(null);

    const payload = {
      name: name.trim(),
      description: description.trim(),
      emoji: emoji || '⚡',
      intro: intro.trim(),
      steps: cleanSteps,
      params: params.map((p) => ({
        name: p.name.trim(),
        description: p.description.trim(),
        required: p.required,
      })),
      ...(mode === 'create' ? { slug } : {}),
    };

    try {
      const res = await fetch(mode === 'create' ? '/api/pipelines' : `/api/pipelines/${slug}`, {
        method: mode === 'create' ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: unknown };
        setServerError(
          typeof data.error === 'string'
            ? data.error
            : 'No se pudo guardar este pipeline. Vuelve a intentarlo.',
        );
        setSaving(false);
        return;
      }
      const data = (await res.json()) as { slug: string };
      router.push(`/pipelines/${data.slug}`);
      router.refresh();
    } catch {
      setServerError('Error de red. Vuelve a intentarlo.');
      setSaving(false);
    }
  }

  const checkpointCount = cleanSteps.filter((s) => s.checkpoint).length;

  return (
    <>
      <div className="mb-4">
        <Link
          href={mode === 'edit' ? `/pipelines/${slug}` : '/pipelines'}
          className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-faint hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" />{' '}
          {mode === 'edit' ? 'Volver al pipeline' : 'Pipelines'}
        </Link>
      </div>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="field-label">Pipeline</div>
          <div>
            <h1 className="text-[22px] font-extrabold tracking-tight text-ink">
              {mode === 'create' ? 'Nuevo pipeline' : 'Editar el pipeline'}
            </h1>
            <p className="tabular mt-0.5 text-[12px] text-ink-muted">
              {cleanSteps.length} {cleanSteps.length === 1 ? 'paso' : 'pasos'}
              {checkpointCount > 0
                ? ` · ${checkpointCount} ${checkpointCount === 1 ? 'punto de control' : 'puntos de control'}`
                : ' · sin puntos de control'}
              {declared.length > 0
                ? ` · ${declared.length} ${declared.length === 1 ? 'parámetro' : 'parámetros'}`
                : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={mode === 'edit' ? `/pipelines/${slug}` : '/pipelines'}
            className="rounded-card border border-border-strong px-3.5 py-2 text-[12.5px] font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            Cancelar
          </Link>
          <button
            type="button"
            onClick={save}
            disabled={errors.length > 0 || saving}
            className="inline-flex items-center gap-1.5 rounded-card bg-primary px-4 py-2 text-[12.5px] font-semibold text-white transition-colors hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {mode === 'create' ? 'Crear el pipeline' : 'Guardar cambios'}
          </button>
        </div>
      </div>

      {serverError && (
        <Panel className="mb-4 border-rose/40 bg-rose-soft p-3 text-[12.5px] font-semibold text-rose">
          {serverError}
        </Panel>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[1fr_360px]">
        {/* ── Editor column ─────────────────────────────────────────────── */}
        <div className="space-y-4">
          {/* Identity */}
          <Panel className="p-5">
            <div className={clsx(SECTION, 'mb-3')}>Identidad</div>
            <div className="flex gap-3">
              <label className="block w-[70px] shrink-0">
                <span className="mb-1 block text-[11.5px] font-semibold text-ink-muted">Emoji</span>
                <input
                  value={emoji}
                  onChange={(e) => setEmoji(e.target.value.slice(0, 2))}
                  maxLength={2}
                  aria-label="Emoji del pipeline"
                  className={clsx(FIELD, 'text-center text-[20px]')}
                />
              </label>
              <label className="block min-w-0 flex-1">
                <span className="mb-1 block text-[11.5px] font-semibold text-ink-muted">
                  Nombre
                </span>
                <input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!slugTouched) setSlug(slugify(e.target.value));
                  }}
                  maxLength={80}
                  placeholder="Reporte semanal de clientes"
                  className={FIELD}
                />
              </label>
            </div>

            <label className="mt-3 block">
              <span className="mb-1 flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-muted">
                Slug
                {mode === 'edit' && <Lock className="h-3 w-3 text-ink-faint" />}
              </span>
              <input
                value={slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(slugifyInput(e.target.value));
                }}
                disabled={mode === 'edit'}
                maxLength={49}
                placeholder="reporte-semanal-clientes"
                className={clsx(FIELD, 'font-mono text-[12px] disabled:opacity-60')}
              />
              <span className="mt-1 block text-[11px] text-ink-faint">
                {mode === 'edit'
                  ? 'El slug es permanente: el historial y las rutinas programadas llaman a este pipeline por él.'
                  : 'Así lo van a nombrar las personas y las rutinas. Sale del nombre y lo puedes editar.'}
              </span>
            </label>

            <label className="mt-3 block">
              <span className="mb-1 block text-[11.5px] font-semibold text-ink-muted">
                Descripción
              </span>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={300}
                placeholder="Una línea, la que se ve en la tarjeta."
                className={FIELD}
              />
            </label>

            <label className="mt-3 block">
              <span className="mb-1 block text-[11.5px] font-semibold text-ink-muted">
                Introducción{' '}
                <span className="font-normal text-ink-faint">— contexto antes del paso 1</span>
              </span>
              <textarea
                value={intro}
                onChange={(e) => setIntro(e.target.value)}
                maxLength={1000}
                rows={3}
                placeholder="Estás preparando el reporte semanal de {{cliente}}. Cíñete a las cifras, no a los adjetivos."
                className={clsx(FIELD, 'resize-y leading-relaxed')}
              />
              <span className="tabular mt-1 block text-right text-[11px] text-ink-faint">
                {intro.length}/1000
              </span>
            </label>
          </Panel>

          {/* Steps */}
          <Panel className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <div className={SECTION}>El flujo</div>
              <span className="tabular text-[11px] text-ink-faint">
                {cleanSteps.length}/{MAX_STEPS} pasos
              </span>
            </div>

            <ol className="relative space-y-0">
              {steps.map((s, i) => {
                const isLast = i === steps.length - 1;
                return (
                  <li key={s.key} className="relative flex gap-4 pb-5">
                    {!isLast && (
                      <span className="absolute left-[17px] top-9 h-[calc(100%-2rem)] w-[2px] rounded bg-border" />
                    )}
                    {s.checkpoint ? (
                      <span className="z-10 grid h-9 w-9 shrink-0 place-items-center rounded-card border border-amber bg-amber-soft">
                        <UserCheck className="h-4 w-4 text-amber" />
                      </span>
                    ) : (
                      <span className="stat-num z-10 grid h-9 w-9 shrink-0 place-items-center rounded-card bg-primary text-[13px] text-white">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                    )}

                    <div
                      className={clsx(
                        'min-w-0 flex-1 rounded-card border p-3.5',
                        s.checkpoint
                          ? 'border-amber/40 bg-amber-soft/40'
                          : 'border-border bg-surface-2',
                      )}
                    >
                      <div className="mb-2 flex items-center justify-between gap-2">
                        {s.checkpoint ? (
                          <span className="field-label text-amber">
                            Punto de control · decides tú
                          </span>
                        ) : (
                          <span className="field-label">Paso {String(i + 1).padStart(2, '0')}</span>
                        )}
                        <div className="flex items-center gap-0.5">
                          <IconBtn
                            label="Subir el paso"
                            disabled={i === 0}
                            onClick={() => move(i, -1)}
                            icon={<ChevronUp className="h-3.5 w-3.5" />}
                          />
                          <IconBtn
                            label="Bajar el paso"
                            disabled={isLast}
                            onClick={() => move(i, 1)}
                            icon={<ChevronDown className="h-3.5 w-3.5" />}
                          />
                          <IconBtn
                            label="Duplicar el paso"
                            disabled={steps.length >= MAX_STEPS}
                            onClick={() => duplicateStep(i)}
                            icon={<Copy className="h-3.5 w-3.5" />}
                          />
                          <IconBtn
                            label="Eliminar el paso"
                            disabled={steps.length <= 1}
                            onClick={() => removeStep(i)}
                            tone="rose"
                            icon={<Trash2 className="h-3.5 w-3.5" />}
                          />
                        </div>
                      </div>

                      <input
                        value={s.title}
                        onChange={(e) => patchStep(i, { title: e.target.value })}
                        maxLength={80}
                        placeholder="Título corto y en imperativo, por ejemplo: Barre los portales de empleo"
                        className={clsx(FIELD, 'font-bold')}
                      />
                      <textarea
                        value={s.detail}
                        onChange={(e) => patchStep(i, { detail: e.target.value })}
                        maxLength={2000}
                        rows={3}
                        placeholder="Qué hacer: qué herramientas llamar, qué buscar, qué producir. Usa {{parametro}} para inyectar argumentos."
                        className={clsx(FIELD, 'mt-2 resize-y leading-relaxed')}
                      />

                      <ToolPicker
                        tools={tools}
                        selected={s.tools}
                        onChange={(next) => patchStep(i, { tools: next })}
                      />

                      <div className="mt-3 flex items-center gap-2 border-t border-border pt-2.5">
                        <Switch
                          on={s.checkpoint}
                          tone="amber"
                          label={`El paso ${i + 1} requiere mi aprobación`}
                          onClick={() => patchStep(i, { checkpoint: !s.checkpoint })}
                        />
                        <span className="text-[12px] font-semibold text-ink-muted">
                          Requiere mi aprobación
                        </span>
                        <span className="text-[11px] text-ink-faint">
                          — parada en firme: muestra lo que encontró y espera
                        </span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>

            <button
              type="button"
              onClick={addStep}
              disabled={steps.length >= MAX_STEPS}
              className="ml-[52px] inline-flex items-center gap-1.5 rounded-card border border-dashed border-border-strong px-3 py-1.5 text-[12px] font-semibold text-ink-muted transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" /> Agregar un paso
            </button>
          </Panel>

          {/* Params */}
          <Panel className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className={SECTION}>Parámetros</div>
              <span className="tabular text-[11px] text-ink-faint">
                {params.length}/{MAX_PARAMS}
              </span>
            </div>
            <p className="mb-3 text-[12px] text-ink-muted">
              Todo lo que el pipeline necesita saber al ejecutarse. Menciona un parámetro en la
              introducción o en cualquier paso con{' '}
              <code className="font-mono text-[11.5px] text-primary">{'{{nombre}}'}</code>.
            </p>

            {params.length === 0 && (
              <p className="mb-3 rounded-card border border-border bg-surface-2 px-3 py-2.5 text-[12px] text-ink-muted">
                Sin parámetros: este pipeline corre igual siempre. Agrega uno si quieres que te pida
                un valor al ejecutarlo.
              </p>
            )}

            <div className="space-y-2">
              {params.map((p, i) => (
                <div
                  key={p.key}
                  className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface-2 p-2.5"
                >
                  <Hash className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <input
                    value={p.name}
                    onChange={(e) =>
                      setParams((prev) =>
                        prev.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x)),
                      )
                    }
                    placeholder="cliente"
                    className={clsx(FIELD, 'w-[130px] shrink-0 font-mono text-[12px]')}
                  />
                  <input
                    value={p.description}
                    onChange={(e) =>
                      setParams((prev) =>
                        prev.map((x, idx) =>
                          idx === i ? { ...x, description: e.target.value } : x,
                        ),
                      )
                    }
                    maxLength={200}
                    placeholder="Qué es esto: se muestra cuando alguien ejecuta el pipeline"
                    className={clsx(FIELD, 'min-w-[160px] flex-1')}
                  />
                  <div className="flex items-center gap-1.5">
                    <Switch
                      on={p.required}
                      label={`El parámetro ${p.name || i + 1} es obligatorio`}
                      onClick={() =>
                        setParams((prev) =>
                          prev.map((x, idx) => (idx === i ? { ...x, required: !x.required } : x)),
                        )
                      }
                    />
                    <span className="text-[11.5px] font-semibold text-ink-muted">Obligatorio</span>
                  </div>
                  <IconBtn
                    label="Quitar el parámetro"
                    tone="rose"
                    onClick={() => setParams((prev) => prev.filter((_, idx) => idx !== i))}
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                  />
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => addParam()}
              disabled={params.length >= MAX_PARAMS}
              className="mt-3 inline-flex items-center gap-1.5 rounded-card border border-dashed border-border-strong px-3 py-1.5 text-[12px] font-semibold text-ink-muted transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" /> Agregar un parámetro
            </button>
          </Panel>
        </div>

        {/* ── Side column: validation + live preview ────────────────────── */}
        <div className="space-y-4 lg:sticky lg:top-4">
          <Panel className="p-4">
            <div className={clsx(SECTION, 'mb-2.5')}>Validación</div>

            {errors.length === 0 && warnings.length === 0 && (
              <p className="flex items-start gap-2 text-[12px] font-semibold text-emerald">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Todo está en orden: ya puedes guardar.
              </p>
            )}

            {errors.length > 0 && (
              <ul className="space-y-1.5">
                {errors.map((e) => (
                  <li
                    key={e}
                    className="flex items-start gap-2 text-[11.5px] leading-snug text-rose"
                  >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{e}</span>
                  </li>
                ))}
              </ul>
            )}

            {warnings.length > 0 && (
              <ul
                className={clsx(
                  'space-y-1.5',
                  errors.length > 0 && 'mt-2.5 border-t border-border pt-2.5',
                )}
              >
                {warnings.map((w) => (
                  <li
                    key={w}
                    className="flex items-start gap-2 text-[11.5px] leading-snug text-amber"
                  >
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            )}

            {undeclared.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border pt-2.5">
                {undeclared.map((u) => (
                  <button
                    key={u}
                    type="button"
                    onClick={() => addParam(u)}
                    className="inline-flex items-center gap-1 rounded-sm border border-primary/30 bg-primary-soft px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-primary transition-colors hover:bg-primary hover:text-white"
                  >
                    <Plus className="h-3 w-3" /> declarar {u}
                  </button>
                ))}
              </div>
            )}
          </Panel>

          <Panel className="overflow-hidden">
            <div className="flex items-center gap-2 border-b border-border-strong px-4 py-2.5">
              <Terminal className="h-3.5 w-3.5 text-primary" />
              <span className={SECTION}>Lo que va a ver el agente</span>
            </div>
            <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[11px] leading-relaxed text-ink">
              {preview}
            </pre>
            <p className="border-t border-border bg-surface-2 px-4 py-2 text-[10.5px] leading-snug text-ink-faint">
              Esto es, carácter por carácter, lo que <span className="font-mono">pipeline.run</span>{' '}
              le entrega al modelo. Los <span className="font-mono">{'{{parametros}}'}</span> sin
              llenar se quedan así hasta que alguien lo ejecute.
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}

function IconBtn({
  label,
  icon,
  onClick,
  disabled = false,
  tone = 'default',
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'rose';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={clsx(
        'rounded-card p-1.5 text-ink-faint transition-colors disabled:cursor-not-allowed disabled:opacity-30',
        tone === 'rose' ? 'hover:bg-rose-soft hover:text-rose' : 'hover:bg-surface hover:text-ink',
      )}
    >
      {icon}
    </button>
  );
}
