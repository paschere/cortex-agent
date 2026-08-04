'use client';

import { Panel, PanelHead } from '@/components/ui/panel';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { clock, num, plural } from './format';
import type { IntakeKey } from './types';

/**
 * What Brain Knowledge already knows about itself.
 *
 * WHY THIS IS NOT A GIMMICK. Every fragment has a vector, and two documents
 * about the same subject have been sitting next to each other in that space
 * since the day they were indexed. Nothing here is generated: an edge is a
 * cosine similarity over a threshold, or a person who demonstrably spoke in
 * both recordings. If neither holds, no line is drawn.
 *
 * WHY A CHORD DIAGRAM AND NOT A FORCE SIMULATION. A force layout is a ball of
 * string that moves while you are trying to read it, it costs a frame budget on
 * a phone, and it has to be specially disabled for reduced motion. A ring with
 * arcs is what a technical manual would print: deterministic, still, readable
 * at a glance, and it groups the four sources so that a line crossing the
 * middle means the thing worth seeing — a call and a document about the same
 * subject.
 */

interface GraphNode {
  id: string;
  title: string;
  source: IntakeKey;
  speakers: string[];
  durationSeconds: number | null;
  chunks: number;
}

interface Semantic {
  a: string;
  b: string;
  score: number;
}

interface People {
  a: string;
  b: string;
  names: string[];
}

interface Graph {
  nodes: GraphNode[];
  semantic: Semantic[];
  people: People[];
  considered: number;
  total: number;
  indexing: number;
  minSimilarity: number;
}

export const SOURCE_LABEL: Record<IntakeKey, string> = {
  upload: 'Documentos',
  meeting: 'Reuniones',
  record: 'Grabaciones',
  drive: 'Google Drive',
};

const SOURCE_ONE: Record<IntakeKey, string> = {
  upload: 'documento',
  meeting: 'reunión',
  record: 'grabación',
  drive: 'archivo de Drive',
};

/** Four tonal steps of the one blue. A rainbow would say nothing extra. */
const SOURCE_TONE: Record<IntakeKey, number> = {
  upload: 1,
  meeting: 0.62,
  record: 0.38,
  drive: 0.16,
};

/** The order sources sit around the ring, so the groups never swap places. */
const RING_ORDER: IntakeKey[] = ['upload', 'meeting', 'record', 'drive'];

const SIZE = 420;
const CENTRE = SIZE / 2;
const RADIUS = 168;

async function fetchGraph(spaceId?: string, source?: IntakeKey): Promise<Graph> {
  const params = new URLSearchParams();
  if (spaceId) params.set('spaceId', spaceId);
  if (source) params.set('source', source);
  const r = await fetch(`/api/kb/graph?${params.toString()}`);
  if (!r.ok) throw new Error('No se pudieron leer las relaciones.');
  return (await r.json()) as Graph;
}

export function RelationsPanel({
  spaceId,
  source,
  onClose,
}: {
  spaceId?: string;
  source?: IntakeKey;
  onClose?: () => void;
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['kb-graph', spaceId ?? 'all', source ?? 'all'],
    queryFn: () => fetchGraph(spaceId, source),
  });

  const [selected, setSelected] = useState<string | null>(null);

  const title = source ? `Relaciones · ${SOURCE_LABEL[source]}` : 'Relaciones';

  return (
    <Panel>
      <PanelHead
        title={title}
        right={
          onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1 rounded-card px-1.5 py-0.5 text-[11.5px] font-semibold text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
              Cerrar
            </button>
          ) : data ? (
            `${plural(data.nodes.length, 'documento', 'documentos')}`
          ) : null
        }
      />
      <p className="px-5 pt-1 text-[12.5px] text-ink-muted">
        Lo que ya está indexado y de qué se parece a qué.
      </p>

      <div className="mt-3 border-t border-border">
        {isLoading ? (
          <p className="px-5 py-8 text-center text-[12.5px] text-ink-faint">
            Leyendo las relaciones…
          </p>
        ) : isError || !data ? (
          <p className="px-5 py-8 text-center text-[12.5px] text-rose">
            No se pudieron leer las relaciones. Vuelve a intentar.
          </p>
        ) : (
          <GraphBody data={data} selected={selected} onSelect={setSelected} />
        )}
      </div>
    </Panel>
  );
}

function GraphBody({
  data,
  selected,
  onSelect,
}: {
  data: Graph;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { nodes, semantic, people } = data;

  // Degree first, because it decides where a node sits inside its group: the
  // most connected documents end up next to the middle of their arc, which
  // keeps the busiest lines short.
  const layout = useMemo(() => {
    const degree = new Map<string, number>();
    for (const e of [...semantic, ...people]) {
      degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
      degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
    }
    const ordered = RING_ORDER.flatMap((source) =>
      nodes
        .filter((n) => n.source === source)
        .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)),
    );
    const positions = new Map<string, { x: number; y: number; angle: number }>();
    ordered.forEach((n, i) => {
      // Start at the top and go clockwise; one full turn over every node.
      const angle = (i / Math.max(ordered.length, 1)) * Math.PI * 2 - Math.PI / 2;
      positions.set(n.id, {
        x: CENTRE + Math.cos(angle) * RADIUS,
        y: CENTRE + Math.sin(angle) * RADIUS,
        angle,
      });
    });
    return { ordered, positions, degree };
  }, [nodes, semantic, people]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const chosen = selected ? (byId.get(selected) ?? null) : null;

  if (nodes.length === 0) {
    return (
      <p className="px-5 py-8 text-[12.5px] leading-relaxed text-ink-muted">
        Todavía no hay nada indexado aquí.{' '}
        {data.indexing > 0
          ? `${plural(data.indexing, 'documento está', 'documentos están')} en proceso: sus vectores aún no existen.`
          : 'Añade un documento y en un minuto aparecen sus relaciones.'}
      </p>
    );
  }

  if (nodes.length === 1) {
    return (
      <p className="px-5 py-8 text-[12.5px] leading-relaxed text-ink-muted">
        Con un solo documento no hay relaciones que mostrar. Añade otro del mismo tema y la línea
        aparece sola.
      </p>
    );
  }

  const noEdges = semantic.length === 0 && people.length === 0;

  return (
    <div>
      <div className="grid gap-px bg-border lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
        <div className="bg-surface px-4 py-4">
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-full text-primary" aria-hidden="true">
            {/* The ring the documents sit on. Structure, so it is a hairline. */}
            <circle
              cx={CENTRE}
              cy={CENTRE}
              r={RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth={0.5}
              opacity={0.22}
            />

            {/* People first, underneath: a fact should not hide an inference. */}
            {people.map((e) => {
              const from = layout.positions.get(e.a);
              const to = layout.positions.get(e.b);
              if (!from || !to) return null;
              const dim = selected !== null && selected !== e.a && selected !== e.b;
              return (
                <path
                  key={`p-${e.a}-${e.b}`}
                  d={arc(from, to, 0.82)}
                  fill="none"
                  className="text-ink"
                  stroke="currentColor"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  opacity={dim ? 0.07 : 0.32}
                />
              );
            })}

            {semantic.map((e) => {
              const from = layout.positions.get(e.a);
              const to = layout.positions.get(e.b);
              if (!from || !to) return null;
              const dim = selected !== null && selected !== e.a && selected !== e.b;
              return (
                <path
                  key={`s-${e.a}-${e.b}`}
                  d={arc(from, to, 0.62 + (1 - e.score) * 0.33)}
                  fill="none"
                  stroke="currentColor"
                  // The weight is the similarity, so a thick line means more.
                  strokeWidth={0.5 + e.score * 1.6}
                  opacity={dim ? 0.08 : 0.2 + e.score * 0.55}
                />
              );
            })}

            {layout.ordered.map((n) => {
              const at = layout.positions.get(n.id);
              if (!at) return null;
              const side = 5 + Math.min(7, Math.sqrt(n.chunks) * 1.6);
              const on = selected === n.id;
              const linked =
                selected !== null &&
                [...semantic, ...people].some(
                  (e) => (e.a === selected && e.b === n.id) || (e.b === selected && e.a === n.id),
                );
              const dim = selected !== null && !on && !linked;
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: an SVG node cannot be a <button>, so the ring is aria-hidden and the select underneath reaches every document from the keyboard.
                <g key={n.id} onClick={() => onSelect(on ? null : n.id)} className="cursor-pointer">
                  <title>{n.title}</title>
                  <rect
                    x={at.x - side / 2}
                    y={at.y - side / 2}
                    width={side}
                    height={side}
                    fill="currentColor"
                    opacity={dim ? 0.15 : SOURCE_TONE[n.source]}
                    stroke="currentColor"
                    strokeWidth={on ? 2 : n.source === 'drive' ? 0.8 : 0}
                  />
                  {/* A generous invisible target: these are tapped on a phone. */}
                  <circle cx={at.x} cy={at.y} r={13} fill="transparent" />
                </g>
              );
            })}
          </svg>

          {/* The keyboard's way into the same map: every document on the ring
              is in here, and choosing one selects it exactly as tapping does. */}
          <label className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <span className="field-label">Ver un documento</span>
            <select
              value={selected ?? ''}
              onChange={(e) => onSelect(e.target.value || null)}
              className="h-8 max-w-full rounded-card border border-border bg-surface px-2.5 text-[12px] font-medium text-ink focus:border-border-strong"
            >
              <option value="">Elige uno…</option>
              {layout.ordered.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title}
                </option>
              ))}
            </select>
          </label>

          <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
            {RING_ORDER.map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5">
                <span
                  className="h-2.5 w-2.5 bg-primary"
                  style={{ opacity: SOURCE_TONE[s] }}
                  aria-hidden
                />
                <span className="field-label">{SOURCE_LABEL[s]}</span>
              </span>
            ))}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[10.5px] text-ink-faint">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-px w-6 bg-primary" aria-hidden />
              línea llena: hablan de lo mismo
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-px w-6"
                style={{
                  backgroundImage:
                    'repeating-linear-gradient(90deg, currentColor 0 3px, transparent 3px 6px)',
                }}
                aria-hidden
              />
              punteada: habló la misma persona
            </span>
          </div>
        </div>

        <div className="bg-surface">
          {chosen ? (
            <NodeDetail
              node={chosen}
              semantic={semantic}
              people={people}
              byId={byId}
              onClose={() => onSelect(null)}
            />
          ) : (
            <div className="px-5 py-5">
              <div className="field-label">Cómo leerlo</div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">
                {noEdges
                  ? 'Nada se parece lo suficiente todavía. Cuando entren dos documentos del mismo tema, aparece la línea.'
                  : 'Toca un documento y te muestro con qué se relaciona y por qué.'}
              </p>
              <dl className="mt-4 divide-y divide-border border-y border-border">
                <Line
                  label="Documentos en el mapa"
                  value={num(nodes.length)}
                  hint={
                    data.total > data.considered
                      ? `los ${num(data.considered)} más recientes de ${num(data.total)}`
                      : 'todo lo indexado'
                  }
                />
                <Line
                  label="Parecidos"
                  value={num(semantic.length)}
                  hint={`por encima de ${data.minSimilarity.toLocaleString('es-CO', { minimumFractionDigits: 2 })} de similitud`}
                />
                <Line
                  label="Personas en común"
                  value={num(people.length)}
                  hint="la misma voz en dos conversaciones"
                />
                {data.indexing > 0 && (
                  <Line
                    label="Sin indexar"
                    value={num(data.indexing)}
                    hint="todavía no tienen vectores"
                  />
                )}
              </dl>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Line({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <dt className="field-label">{label}</dt>
        <dd className="mt-0.5 text-[11px] text-ink-faint">{hint}</dd>
      </div>
      <span className="stat-num shrink-0 text-[17px] text-ink">{value}</span>
    </div>
  );
}

/** One document, and everything it shares with the rest. */
function NodeDetail({
  node,
  semantic,
  people,
  byId,
  onClose,
}: {
  node: GraphNode;
  semantic: Semantic[];
  people: People[];
  byId: Map<string, GraphNode>;
  onClose: () => void;
}) {
  const alike = semantic
    .filter((e) => e.a === node.id || e.b === node.id)
    .map((e) => ({ other: byId.get(e.a === node.id ? e.b : e.a), score: e.score }))
    .filter((x): x is { other: GraphNode; score: number } => !!x.other)
    .sort((a, b) => b.score - a.score);

  const shared = people
    .filter((e) => e.a === node.id || e.b === node.id)
    .map((e) => ({ other: byId.get(e.a === node.id ? e.b : e.a), names: e.names }))
    .filter((x): x is { other: GraphNode; names: string[] } => !!x.other);

  return (
    <div className="px-5 py-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-bold text-ink">{node.title}</div>
          <div className="mt-0.5 text-[11.5px] text-ink-faint">
            {SOURCE_ONE[node.source]} · <span className="tabular">{num(node.chunks)}</span>{' '}
            {node.chunks === 1 ? 'fragmento' : 'fragmentos'}
            {node.durationSeconds ? ` · ${clock(node.durationSeconds)}` : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-card px-1.5 py-0.5 text-[11.5px] font-semibold text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
        >
          Quitar
        </button>
      </div>

      <div className="mt-4">
        <div className="field-label">Habla de lo mismo que</div>
        {alike.length === 0 ? (
          <p className="mt-1.5 text-[12px] text-ink-muted">
            Nada más se le parece por encima del umbral.
          </p>
        ) : (
          <ul className="mt-1.5 divide-y divide-border border-y border-border">
            {alike.slice(0, 8).map(({ other, score }) => (
              <li key={other.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="min-w-0">
                  <span className="block truncate text-[12px] font-medium text-ink">
                    {other.title}
                  </span>
                  <span className="block text-[10.5px] text-ink-faint">
                    {SOURCE_ONE[other.source]}
                  </span>
                </span>
                <span className="stat-num shrink-0 text-[12.5px] text-primary">
                  {Math.round(score * 100)}%
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {shared.length > 0 && (
        <div className="mt-4">
          <div className="field-label">Habló la misma persona</div>
          <ul className="mt-1.5 divide-y divide-border border-y border-border">
            {shared.slice(0, 8).map(({ other, names }) => (
              <li key={other.id} className="py-1.5">
                <span className="block truncate text-[12px] font-medium text-ink">
                  {other.title}
                </span>
                <span className="block text-[10.5px] text-ink-faint">{names.join(', ')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {node.speakers.length > 0 && (
        <p className="mt-3 text-[11px] text-ink-faint">
          Voces en esta: {node.speakers.join(', ')}.
        </p>
      )}
    </div>
  );
}

/**
 * A chord: the two ends joined through a control point pulled toward the
 * centre. `bow` of 0 is a straight line across, 1 passes through the middle.
 */
function arc(from: { x: number; y: number }, to: { x: number; y: number }, bow: number): string {
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const cx = midX + (CENTRE - midX) * clamp(bow);
  const cy = midY + (CENTRE - midY) * clamp(bow);
  return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}
