'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
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
  Trash2,
  Terminal,
  UserCheck,
} from 'lucide-react';
import { Panel } from '@/components/ui/panel';
import {
  type BuilderTool,
  type ParamDef,
  type StepDef,
  SLUG_RE,
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

const SECTION = 'text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint';
const FIELD =
  'w-full rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10';

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
        'relative h-[18px] w-8 shrink-0 rounded-pill transition-colors',
        on ? (tone === 'amber' ? 'bg-amber' : 'bg-primary') : 'bg-border',
      )}
    >
      <span
        className={clsx(
          'absolute top-[2px] h-[14px] w-[14px] rounded-full bg-surface shadow-card transition-all',
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
  const undeclared = useMemo(
    () => used.filter((u) => !declared.includes(u)),
    [used, declared],
  );
  const unused = useMemo(() => declared.filter((d) => !used.includes(d)), [declared, used]);

  const errors = useMemo(() => {
    const list: string[] = [];
    if (name.trim().length < 2 || name.trim().length > 80) list.push('Name must be 2–80 characters.');
    if (!SLUG_RE.test(slug)) list.push('Slug must be kebab-case, 2–49 characters (a–z, 0–9, dashes).');
    if (description.length > 300) list.push('Description must be 300 characters or fewer.');
    if (emoji.length > 8) list.push('Emoji must be 8 characters or fewer.');
    if (intro.length > 1000) list.push('Intro must be 1000 characters or fewer.');
    if (cleanSteps.length < 1) list.push('A pipeline needs at least one step.');
    if (cleanSteps.length > MAX_STEPS) list.push(`A pipeline can have at most ${MAX_STEPS} steps.`);
    cleanSteps.forEach((s, i) => {
      if (s.title.length < 2 || s.title.length > 80) list.push(`Step ${i + 1}: title must be 2–80 characters.`);
      if (s.detail.length < 5 || s.detail.length > 2000)
        list.push(`Step ${i + 1}: detail must be 5–2000 characters.`);
      if ((s.tools ?? []).length > 8) list.push(`Step ${i + 1}: at most 8 tools.`);
    });
    if (params.length > MAX_PARAMS) list.push(`At most ${MAX_PARAMS} parameters.`);
    params.forEach((p, i) => {
      const n = p.name.trim();
      if (!n) list.push(`Parameter ${i + 1}: name is required.`);
      else if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(n))
        list.push(`Parameter "${n}": names must start with a letter and use letters, digits or _.`);
    });
    const dupes = declared.filter((d, i) => declared.indexOf(d) !== i);
    if (dupes.length > 0) list.push(`Duplicate parameter names: ${[...new Set(dupes)].join(', ')}.`);
    if (undeclared.length > 0)
      list.push(`Undeclared placeholders: ${undeclared.map((u) => `{{${u}}}`).join(', ')} — add them as parameters.`);
    return list;
  }, [name, slug, description, emoji, intro, cleanSteps, params, declared, undeclared]);

  const warnings = useMemo(() => {
    const list: string[] = [];
    if (unused.length > 0)
      list.push(`Declared but never used: ${unused.map((u) => `{{${u}}}`).join(', ')}.`);
    if (cleanSteps.length > 0 && !cleanSteps.some((s) => s.checkpoint))
      list.push('No checkpoint — the agent will run end to end without pausing for you.');
    if (cleanSteps.every((s) => (s.tools ?? []).length === 0))
      list.push('No tools attached to any step. Naming tools makes the playbook far more reliable.');
    return list;
  }, [unused, cleanSteps]);

  const preview = useMemo(
    () =>
      renderPlaybook({
        emoji,
        name: name.trim() || 'Untitled pipeline',
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
          typeof data.error === 'string' ? data.error : 'Could not save this pipeline. Try again.',
        );
        setSaving(false);
        return;
      }
      const data = (await res.json()) as { slug: string };
      router.push(`/pipelines/${data.slug}`);
      router.refresh();
    } catch {
      setServerError('Network error — please try again.');
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
          <ArrowLeft className="h-3.5 w-3.5" /> {mode === 'edit' ? 'Back to pipeline' : 'Pipelines'}
        </Link>
      </div>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-[14px] bg-gradient-to-br from-primary to-primary-strong text-white shadow-pop">
            <Save className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-[22px] font-extrabold tracking-tight text-ink">
              {mode === 'create' ? 'New pipeline' : 'Edit pipeline'}
            </h1>
            <p className="mt-0.5 text-[13px] text-ink-muted">
              {cleanSteps.length} step{cleanSteps.length === 1 ? '' : 's'}
              {checkpointCount > 0
                ? ` · ${checkpointCount} checkpoint${checkpointCount === 1 ? '' : 's'}`
                : ' · no checkpoints'}
              {declared.length > 0 ? ` · ${declared.length} parameter${declared.length === 1 ? '' : 's'}` : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={mode === 'edit' ? `/pipelines/${slug}` : '/pipelines'}
            className="rounded-pill border border-border px-3.5 py-2 text-[12.5px] font-semibold text-ink-muted transition-colors hover:text-ink"
          >
            Cancel
          </Link>
          <button
            type="button"
            onClick={save}
            disabled={errors.length > 0 || saving}
            className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-[12.5px] font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {mode === 'create' ? 'Create pipeline' : 'Save changes'}
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
            <div className={clsx(SECTION, 'mb-3')}>Identity</div>
            <div className="flex gap-3">
              <label className="block w-[70px] shrink-0">
                <span className="mb-1 block text-[11.5px] font-semibold text-ink-muted">Emoji</span>
                <input
                  value={emoji}
                  onChange={(e) => setEmoji(e.target.value.slice(0, 2))}
                  maxLength={2}
                  aria-label="Pipeline emoji"
                  className={clsx(FIELD, 'text-center text-[20px]')}
                />
              </label>
              <label className="block min-w-0 flex-1">
                <span className="mb-1 block text-[11.5px] font-semibold text-ink-muted">Name</span>
                <input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!slugTouched) setSlug(slugify(e.target.value));
                  }}
                  maxLength={80}
                  placeholder="Weekly client report"
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
                placeholder="weekly-client-report"
                className={clsx(FIELD, 'font-mono text-[12px] disabled:opacity-60')}
              />
              <span className="mt-1 block text-[11px] text-ink-faint">
                {mode === 'edit'
                  ? 'The slug is permanent — run history and scheduled routines address this pipeline by it.'
                  : 'How people (and routines) will name this pipeline. Derived from the name, editable.'}
              </span>
            </label>

            <label className="mt-3 block">
              <span className="mb-1 block text-[11.5px] font-semibold text-ink-muted">Description</span>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={300}
                placeholder="One line the gallery card will show."
                className={FIELD}
              />
            </label>

            <label className="mt-3 block">
              <span className="mb-1 block text-[11.5px] font-semibold text-ink-muted">
                Intro <span className="font-normal text-ink-faint">— context shown before step 1</span>
              </span>
              <textarea
                value={intro}
                onChange={(e) => setIntro(e.target.value)}
                maxLength={1000}
                rows={3}
                placeholder="You are preparing the weekly report for {{client}}. Keep it to numbers, not adjectives."
                className={clsx(FIELD, 'resize-y leading-relaxed')}
              />
              <span className="mt-1 block text-right text-[11px] text-ink-faint">
                {intro.length}/1000
              </span>
            </label>
          </Panel>

          {/* Steps */}
          <Panel className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <div className={SECTION}>The flow</div>
              <span className="text-[11px] text-ink-faint">
                {cleanSteps.length}/{MAX_STEPS} steps
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
                      <span className="z-10 grid h-9 w-9 shrink-0 place-items-center rounded-full border-2 border-amber bg-amber-soft">
                        <UserCheck className="h-4 w-4 text-amber" />
                      </span>
                    ) : (
                      <span className="z-10 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-primary-strong text-[13px] font-extrabold text-white shadow-pop">
                        {i + 1}
                      </span>
                    )}

                    <div
                      className={clsx(
                        'min-w-0 flex-1 rounded-card border p-3.5',
                        s.checkpoint ? 'border-amber/40 bg-amber-soft/40' : 'border-border bg-surface-2',
                      )}
                    >
                      <div className="mb-2 flex items-center justify-between gap-2">
                        {s.checkpoint ? (
                          <span className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-amber">
                            Checkpoint · you decide
                          </span>
                        ) : (
                          <span className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-faint">
                            Step {i + 1}
                          </span>
                        )}
                        <div className="flex items-center gap-0.5">
                          <IconBtn
                            label="Move step up"
                            disabled={i === 0}
                            onClick={() => move(i, -1)}
                            icon={<ChevronUp className="h-3.5 w-3.5" />}
                          />
                          <IconBtn
                            label="Move step down"
                            disabled={isLast}
                            onClick={() => move(i, 1)}
                            icon={<ChevronDown className="h-3.5 w-3.5" />}
                          />
                          <IconBtn
                            label="Duplicate step"
                            disabled={steps.length >= MAX_STEPS}
                            onClick={() => duplicateStep(i)}
                            icon={<Copy className="h-3.5 w-3.5" />}
                          />
                          <IconBtn
                            label="Delete step"
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
                        placeholder="Short imperative title — e.g. Sweep the job boards"
                        className={clsx(FIELD, 'font-bold')}
                      />
                      <textarea
                        value={s.detail}
                        onChange={(e) => patchStep(i, { detail: e.target.value })}
                        maxLength={2000}
                        rows={3}
                        placeholder="What to do: which tools to call, what to look for, what to produce. Use {{param}} to inject arguments."
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
                          label={`Step ${i + 1} requires my approval`}
                          onClick={() => patchStep(i, { checkpoint: !s.checkpoint })}
                        />
                        <span className="text-[12px] font-semibold text-ink-muted">
                          Requires my approval
                        </span>
                        <span className="text-[11px] text-ink-faint">
                          — hard stop: present findings and wait
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
              className="ml-[52px] inline-flex items-center gap-1.5 rounded-pill border border-dashed border-border px-3 py-1.5 text-[12px] font-semibold text-ink-faint transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" /> Add step
            </button>
          </Panel>

          {/* Params */}
          <Panel className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className={SECTION}>Parameters</div>
              <span className="text-[11px] text-ink-faint">
                {params.length}/{MAX_PARAMS}
              </span>
            </div>
            <p className="mb-3 text-[12px] text-ink-muted">
              Anything the pipeline needs at run time. Reference a parameter anywhere in the intro or
              a step with <code className="font-mono text-[11.5px] text-primary">{'{{name}}'}</code>.
            </p>

            {params.length === 0 && (
              <p className="mb-3 rounded-[10px] bg-surface-2 px-3 py-2.5 text-[12px] text-ink-faint">
                No parameters — this pipeline runs the same way every time.
              </p>
            )}

            <div className="space-y-2">
              {params.map((p, i) => (
                <div
                  key={p.key}
                  className="flex flex-wrap items-center gap-2 rounded-[10px] border border-border bg-surface-2 p-2.5"
                >
                  <Hash className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <input
                    value={p.name}
                    onChange={(e) =>
                      setParams((prev) =>
                        prev.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x)),
                      )
                    }
                    placeholder="client"
                    className={clsx(FIELD, 'w-[130px] shrink-0 font-mono text-[12px]')}
                  />
                  <input
                    value={p.description}
                    onChange={(e) =>
                      setParams((prev) =>
                        prev.map((x, idx) => (idx === i ? { ...x, description: e.target.value } : x)),
                      )
                    }
                    maxLength={200}
                    placeholder="What this is — shown when someone runs the pipeline"
                    className={clsx(FIELD, 'min-w-[160px] flex-1')}
                  />
                  <div className="flex items-center gap-1.5">
                    <Switch
                      on={p.required}
                      label={`Parameter ${p.name || i + 1} is required`}
                      onClick={() =>
                        setParams((prev) =>
                          prev.map((x, idx) => (idx === i ? { ...x, required: !x.required } : x)),
                        )
                      }
                    />
                    <span className="text-[11.5px] font-semibold text-ink-muted">Required</span>
                  </div>
                  <IconBtn
                    label="Remove parameter"
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
              className="mt-3 inline-flex items-center gap-1.5 rounded-pill border border-dashed border-border px-3 py-1.5 text-[12px] font-semibold text-ink-faint transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" /> Add parameter
            </button>
          </Panel>
        </div>

        {/* ── Side column: validation + live preview ────────────────────── */}
        <div className="space-y-4 lg:sticky lg:top-4">
          <Panel className="p-4">
            <div className={clsx(SECTION, 'mb-2.5')}>Validation</div>

            {errors.length === 0 && warnings.length === 0 && (
              <p className="flex items-start gap-2 text-[12px] font-semibold text-emerald">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Everything checks out — ready to save.
              </p>
            )}

            {errors.length > 0 && (
              <ul className="space-y-1.5">
                {errors.map((e) => (
                  <li key={e} className="flex items-start gap-2 text-[11.5px] leading-snug text-rose">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{e}</span>
                  </li>
                ))}
              </ul>
            )}

            {warnings.length > 0 && (
              <ul className={clsx('space-y-1.5', errors.length > 0 && 'mt-2.5 border-t border-border pt-2.5')}>
                {warnings.map((w) => (
                  <li key={w} className="flex items-start gap-2 text-[11.5px] leading-snug text-amber">
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
                    className="inline-flex items-center gap-1 rounded-pill bg-primary-soft px-2 py-0.5 font-mono text-[10.5px] font-semibold text-primary transition-colors hover:bg-primary hover:text-white"
                  >
                    <Plus className="h-3 w-3" /> declare {u}
                  </button>
                ))}
              </div>
            )}
          </Panel>

          <Panel className="overflow-hidden">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
              <Terminal className="h-3.5 w-3.5 text-primary" />
              <span className={SECTION}>What the agent will actually see</span>
            </div>
            <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[11px] leading-relaxed text-ink">
              {preview}
            </pre>
            <p className="border-t border-border bg-surface-2 px-4 py-2 text-[10.5px] leading-snug text-ink-faint">
              Byte-for-byte what <span className="font-mono">pipeline.run</span> hands the model.
              Unfilled <span className="font-mono">{'{{params}}'}</span> stay as placeholders until
              someone runs it.
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
        'rounded-[8px] p-1.5 text-ink-faint transition-colors disabled:cursor-not-allowed disabled:opacity-30',
        tone === 'rose' ? 'hover:bg-rose-soft hover:text-rose' : 'hover:bg-surface hover:text-ink',
      )}
    >
      {icon}
    </button>
  );
}
