'use client';

import { Panel, PanelHead } from '@/components/ui/panel';
import { clsx } from 'clsx';
import { ChevronDown, Copy, Ghost, Layers, Scissors, Timer } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { ago, num, plural } from '../format';
import type {
  Corroboration,
  FragmentBrief,
  FragmentHealth,
  KnowledgeShape,
  StaleDocument,
} from '../types';

/**
 * What is wrong with the memory — four findings, chosen because somebody can do
 * something about each of them.
 *
 * WHAT WAS LEFT OUT, AND WHY. A dashboard that shows everything says nothing,
 * so most of what could have gone here did not:
 *
 *   · A word cloud of the corpus's commonest terms. It reads as "the shape of
 *     the knowledge" and it is the shape of the LANGUAGE: the top of that list
 *     is "cliente", "factura", "servicio" for every company that has ever
 *     existed. Replaced by corroboration, which measures something real.
 *   · Fragments or storage per week. The page already charts documents per
 *     week; a second growth curve of the same corpus in a different unit is a
 *     panel that agrees with its neighbour and adds nothing.
 *   · A single "health score". There is no denominator for it, so it would be a
 *     number invented to look precise on a screen whose whole claim is that
 *     every figure comes from a row.
 *   · Embedding dimensions, model names, index types. True, and not one person
 *     running an operation has ever needed them.
 */

export function Analysis({
  health,
  shape,
  stale,
  onOpenDocument,
  onOpenFragment,
}: {
  health: FragmentHealth | null;
  shape: KnowledgeShape | null;
  stale: StaleDocument[];
  onOpenDocument: (documentId: string) => void;
  onOpenFragment: (documentId: string, chunkIndex: number) => void;
}) {
  // Distinct fragments, counted in SQL. Summing the three defect counts here
  // would double-count anything that is both a duplicate and truncated.
  const badlyCut = health?.flagged ?? 0;

  return (
    <section>
      <div className="mb-2.5">
        <h2 className="text-[14px] font-bold text-ink">Cómo quedó lo que memorizó</h2>
        <p className="mt-0.5 max-w-2xl text-[12px] text-ink-faint">
          Cuatro cosas que sí se pueden arreglar. Todo lo de aquí sale de contar fragmentos, no de
          estimar nada.
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <DeadMemory health={health} onOpenDocument={onOpenDocument} />
        <BadlyCut health={health} count={badlyCut} onOpenFragment={onOpenFragment} />
        <Shape shape={shape} onOpenDocument={onOpenDocument} />
        <Stale stale={stale} onOpenDocument={onOpenDocument} />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- dead memory */

function DeadMemory({
  health,
  onOpenDocument,
}: {
  health: FragmentHealth | null;
  onOpenDocument: (documentId: string) => void;
}) {
  if (!health)
    return <Unavailable title="Lo que nunca ha usado" icon={<Ghost className="h-4 w-4" />} />;

  // The bootstrapping problem, handled in words rather than by inventing
  // history. Nothing counted retrievals before this shipped, so on day one the
  // honest answer is "I have not been counting long enough to tell you", and a
  // backfilled figure would be the one lie on a page built to be checkable.
  const counting = health.retrievals > 0;
  const share = health.total > 0 ? Math.round((health.neverUsed / health.total) * 100) : 0;

  return (
    <Panel>
      <PanelHead
        icon={<Ghost className="h-4 w-4" />}
        title="Lo que nunca ha usado"
        right={counting ? `${num(health.retrievals)} recuperaciones contadas` : undefined}
      />

      {!counting ? (
        <div className="px-5 pb-5 pt-2">
          <p className="text-[12.5px] leading-relaxed text-ink-muted">
            Todavía no he registrado ni una recuperación, así que no te puedo decir qué sobra.
            Empieza a contar desde ahora: cuando Cortex responda usando la memoria, los fragmentos
            que use quedan marcados y aquí van a aparecer los que nunca le sirvieron.
          </p>
          <p className="mt-2 text-[11.5px] text-ink-faint">
            De momento hay <span className="tabular text-ink-muted">{num(health.total)}</span>{' '}
            fragmentos guardados en{' '}
            <span className="tabular text-ink-muted">{num(health.documents)}</span> documentos.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-1 px-5 pb-3 pt-2">
            <div>
              <div className="stat-num text-[34px] leading-none text-ink">
                {num(health.neverUsed)}
              </div>
              <div className="field-label mt-1">fragmentos sin usar nunca</div>
            </div>
            <p className="max-w-xs text-[11.5px] leading-relaxed text-ink-faint">
              El <span className="tabular text-ink-muted">{num(share)}%</span> de la memoria. Se
              guardó, se indexó y nunca ha entrado en una respuesta.
              {health.lastUsedAt && ` La última vez que usó algo fue ${ago(health.lastUsedAt)}.`}
            </p>
          </div>

          {health.samples.deadDocuments.length > 0 && (
            <ul className="divide-y divide-border border-t border-border">
              {health.samples.deadDocuments.map((doc) => (
                <li key={doc.documentId}>
                  <button
                    type="button"
                    onClick={() => onOpenDocument(doc.documentId)}
                    className="flex w-full items-center justify-between gap-3 px-5 py-2 text-left transition-colors hover:bg-surface-2"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] font-semibold text-ink">
                        {doc.documentTitle}
                      </span>
                      <span className="block truncate text-[10.5px] text-ink-faint">
                        {doc.spaceName}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="stat-num text-[13px] text-ink">
                        {num(doc.never)}/{num(doc.total)}
                      </span>
                      <span className="block text-[10px] text-ink-faint">sin usar</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------- badly cut */

function BadlyCut({
  health,
  count,
  onOpenFragment,
}: {
  health: FragmentHealth | null;
  count: number;
  onOpenFragment: (documentId: string, chunkIndex: number) => void;
}) {
  const [open, setOpen] = useState<'tiny' | 'cut' | 'repeated' | null>(null);
  if (!health)
    return <Unavailable title="Fragmentos mal cortados" icon={<Scissors className="h-4 w-4" />} />;

  const defects = [
    {
      key: 'tiny' as const,
      icon: <Layers className="h-3.5 w-3.5" />,
      label: 'Demasiado cortos',
      value: health.tiny,
      why: 'Un «listo» o un «ok» sueltos. Se parecen un poco a todo y no responden nada.',
      samples: health.samples.tiny,
    },
    {
      key: 'cut' as const,
      icon: <Scissors className="h-3.5 w-3.5" />,
      label: 'Cortados a mitad de una idea',
      value: health.cut,
      why: 'La frase sigue en el fragmento de al lado. Si sale este, sale media respuesta.',
      samples: health.samples.cut,
    },
    {
      key: 'repeated' as const,
      icon: <Copy className="h-3.5 w-3.5" />,
      label: 'Repetidos palabra por palabra',
      value: health.repeated,
      why: 'El mismo texto guardado dos veces o más. Se quitan el puesto entre ellos en cada búsqueda.',
      samples: health.samples.repeated,
    },
  ];

  return (
    <Panel>
      <PanelHead
        icon={<Scissors className="h-4 w-4" />}
        title="Fragmentos mal cortados"
        right={`mediana ${num(health.medianTokens)} tokens`}
      />
      <p className="px-5 pt-1 text-[12px] text-ink-muted">
        {count === 0
          ? 'Ninguno. El troceado de este corpus está limpio.'
          : `${plural(count, 'fragmento', 'fragmentos')} que le quitan puntería a la búsqueda.`}
      </p>

      <ul className="mt-2 divide-y divide-border border-t border-border">
        {defects.map((defect) => (
          <li key={defect.key}>
            <button
              type="button"
              disabled={defect.value === 0}
              aria-expanded={open === defect.key}
              onClick={() => setOpen((was) => (was === defect.key ? null : defect.key))}
              className={clsx(
                'flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors',
                defect.value === 0 ? 'cursor-default opacity-55' : 'hover:bg-surface-2',
              )}
            >
              <span className={clsx(defect.value > 0 ? 'text-amber' : 'text-ink-faint')}>
                {defect.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-semibold text-ink">{defect.label}</span>
                <span className="block text-[10.5px] leading-snug text-ink-faint">
                  {defect.why}
                </span>
              </span>
              <span className="stat-num shrink-0 text-[15px] text-ink">{num(defect.value)}</span>
              {defect.value > 0 && (
                <ChevronDown
                  className={clsx(
                    'h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform',
                    open === defect.key && 'rotate-180',
                  )}
                />
              )}
            </button>

            {open === defect.key && (
              <ul className="bg-surface-2 px-5 pb-3 pt-1">
                {defect.samples.map((sample) => (
                  <Sample key={sample.chunkId} sample={sample} onOpen={onOpenFragment} />
                ))}
                {defect.samples.length === 0 && (
                  <li className="py-2 text-[11.5px] text-ink-faint">
                    No pude traer ejemplos de estos.
                  </li>
                )}
              </ul>
            )}
          </li>
        ))}
      </ul>

      {health.unembedded > 0 && (
        <p className="border-t border-border px-5 py-2.5 text-[11.5px] leading-relaxed text-amber">
          Además, <span className="tabular">{num(health.unembedded)}</span> fragmentos están
          guardados pero sin indexar por significado: solo se encuentran si escribes las palabras
          exactas.
        </p>
      )}
    </Panel>
  );
}

function Sample({
  sample,
  onOpen,
}: {
  sample: FragmentBrief;
  onOpen: (documentId: string, chunkIndex: number) => void;
}) {
  return (
    <li className="border-t border-border first:border-t-0">
      <button
        type="button"
        onClick={() => onOpen(sample.documentId, sample.chunkIndex)}
        className="block w-full py-2 text-left"
      >
        <p className="line-clamp-2 border-l-2 border-border-strong pl-2.5 text-[12px] leading-relaxed text-ink">
          {sample.content || '(vacío)'}
        </p>
        <p className="mt-1 truncate pl-2.5 text-[10.5px] text-ink-faint">
          {sample.documentTitle} · frag.{' '}
          <span className="tabular">{num(sample.chunkIndex + 1)}</span> ·{' '}
          <span className="tabular">{num(sample.tokens)}</span> tokens
          {sample.copies > 1 && ` · ${num(sample.copies)} copias`}
        </p>
      </button>
    </li>
  );
}

/* ------------------------------------------------------------------ shape */

function Shape({
  shape,
  onOpenDocument,
}: {
  shape: KnowledgeShape | null;
  onOpenDocument: (documentId: string) => void;
}) {
  if (!shape)
    return (
      <Unavailable title="De qué sabe por varios lados" icon={<Layers className="h-4 w-4" />} />
    );

  const partial = shape.total > shape.considered;

  return (
    <Panel>
      <PanelHead
        icon={<Layers className="h-4 w-4" />}
        title="De qué sabe por varios lados"
        right={partial ? `los ${num(shape.considered)} más recientes` : undefined}
      />
      <p className="px-5 pt-1 text-[12px] leading-relaxed text-ink-muted">
        Un dato que aparece en cuatro documentos es un dato en el que la empresa está de acuerdo
        consigo misma. Uno que solo aparece en un sitio depende de que ese sitio esté bien.
      </p>

      <div className="mt-2 grid gap-px border-t border-border bg-border sm:grid-cols-2">
        <Column
          title="Respaldado"
          hint="otros documentos dicen lo mismo"
          rows={shape.corroborated}
          onOpen={onOpenDocument}
          measure={(r) => `${num(r.neighbours)}`}
          measureLabel="documentos"
          tone="text-emerald"
        />
        <Column
          title="Solo por un lado"
          hint="nada más habla de esto"
          rows={shape.alone}
          onOpen={onOpenDocument}
          measure={(r) => `${num(r.chunks)}`}
          measureLabel="fragmentos"
          tone="text-amber"
          empty="Todo lo que miré tiene respaldo en otro documento."
        />
      </div>
    </Panel>
  );
}

function Column({
  title,
  hint,
  rows,
  onOpen,
  measure,
  measureLabel,
  tone,
  empty,
}: {
  title: string;
  hint: string;
  rows: Corroboration[];
  onOpen: (documentId: string) => void;
  measure: (row: Corroboration) => string;
  measureLabel: string;
  tone: string;
  empty?: string;
}) {
  return (
    <div className="bg-surface pb-2">
      <div className="px-5 pt-3">
        <div className="field-label">{title}</div>
        <div className="text-[10.5px] text-ink-faint">{hint}</div>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 pt-2 text-[11.5px] text-ink-faint">
          {empty ?? 'Todavía nada que medir.'}
        </p>
      ) : (
        <ul className="mt-1">
          {rows.map((row) => (
            <li key={row.documentId}>
              <button
                type="button"
                onClick={() => onOpen(row.documentId)}
                className="flex w-full items-baseline justify-between gap-2 px-5 py-1.5 text-left transition-colors hover:bg-surface-2"
              >
                <span className="min-w-0 truncate text-[12px] text-ink">{row.title}</span>
                <span className={clsx('stat-num shrink-0 text-[12px]', tone)}>
                  {measure(row)}
                  <span className="ml-1 font-sans text-[10px] font-medium text-ink-faint">
                    {measureLabel}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ stale */

const STALE_TONE: Record<StaleDocument['status'], string> = {
  expired: 'text-rose',
  superseded: 'text-rose',
  old: 'text-amber',
  aging: 'text-amber',
};

function Stale({
  stale,
  onOpenDocument,
}: {
  stale: StaleDocument[];
  onOpenDocument: (documentId: string) => void;
}) {
  const blocking = stale.filter((s) => s.status === 'expired' || s.status === 'superseded').length;

  return (
    <Panel>
      <PanelHead
        icon={<Timer className="h-4 w-4" />}
        title="Vencido o reemplazado"
        right={stale.length > 0 ? `${num(stale.length)} para revisar` : undefined}
      />
      <p className="px-5 pt-1 text-[12px] leading-relaxed text-ink-muted">
        {stale.length === 0
          ? 'Nada vencido ni reemplazado. Todo lo que Cortex puede citar sigue en pie.'
          : blocking > 0
            ? `${plural(blocking, 'documento', 'documentos')} dejaron de ser ciertos. Cortex los sigue citando, pero avisando de su fecha.`
            : 'Nada ha vencido; esto es material viejo que conviene confirmar antes de citarlo.'}
      </p>

      {stale.length > 0 && (
        <ul className="mt-2 divide-y divide-border border-t border-border">
          {stale.map((doc) => (
            <li key={doc.id}>
              <button
                type="button"
                onClick={() => onOpenDocument(doc.id)}
                className="flex w-full items-center justify-between gap-3 px-5 py-2 text-left transition-colors hover:bg-surface-2"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[12px] font-semibold text-ink">
                    {doc.title}
                  </span>
                  <span className="block truncate text-[10.5px] text-ink-faint">
                    {doc.spaceName}
                  </span>
                </span>
                <span className={clsx('shrink-0 text-right text-[11px]', STALE_TONE[doc.status])}>
                  {doc.label}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ shared */

/**
 * A panel that could not be computed says so and gets out of the way. Zeros
 * would read as "everything is fine here", which is the one thing it must never
 * say by accident.
 */
function Unavailable({ title, icon }: { title: string; icon: ReactNode }) {
  return (
    <Panel>
      <PanelHead icon={icon} title={title} />
      <p className="px-5 pb-5 pt-2 text-[12px] leading-relaxed text-ink-faint">
        No se pudo calcular ahora mismo. Vuelve a cargar la página; si sigue igual, es que el
        análisis no alcanzó a correr sobre un corpus de este tamaño.
      </p>
    </Panel>
  );
}
