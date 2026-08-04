'use client';

import { Panel, PanelHead } from '@/components/ui/panel';
import { ArrowLeft, Loader2, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { deleteSpace } from '../actions';
import { DocumentList } from './DocumentList';
import { IntakePanel } from './Intake';
import { SpaceChip } from './KnowledgeBase';
import { RelationsPanel } from './RelationsGraph';
import { ago, hours, num, plural } from './format';
import type { IntakeKey, SpaceSummary } from './types';

export function SpaceDetail({
  space,
  allSpaces,
  intake,
  onIntakeChange,
  onBack,
  viewerName,
}: {
  space: SpaceSummary;
  allSpaces: SpaceSummary[];
  intake: IntakeKey;
  onIntakeChange: (key: IntakeKey) => void;
  onBack: () => void;
  viewerName: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Somewhere to move a document to: any other space this person may write to.
  const moveTargets = allSpaces.filter((s) => s.canWrite && s.id !== space.id);

  async function remove() {
    setRemoving(true);
    setError(null);
    const res = await deleteSpace(space.id);
    setRemoving(false);
    if (!res.ok) {
      setError(res.error);
      setConfirming(false);
      return;
    }
    onBack();
    router.refresh();
  }

  const owner =
    space.kind === 'global'
      ? space.ownerName
        ? `publicado por ${space.ownerName}`
        : null
      : space.isMine
        ? `${viewerName} (tú)`
        : space.ownerName;

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 rounded-card px-2.5 py-1 text-[12px] font-semibold text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Todos los espacios
      </button>

      {/* ------------------------------------------------------------ header */}
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[17px] font-extrabold tracking-tight text-ink">{space.name}</h2>
              <SpaceChip kind={space.kind} />
            </div>
            <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-ink-muted">
              {space.description ??
                (space.kind === 'global'
                  ? 'Lo lee toda la empresa y Cortex responde con esto a cualquiera.'
                  : space.isMine
                    ? 'Solo tú lo lees. La búsqueda de nadie más llega hasta aquí.'
                    : `Notas de ${space.ownerName ?? 'otra persona'}.`)}
            </p>
            {owner && <p className="mt-1.5 text-[11.5px] text-ink-faint">{owner}</p>}
          </div>
        </div>

        {/* What this one space is worth to an answer, in counted figures. */}
        <dl className="mt-4 grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-4">
          <Cell
            label="Fragmentos"
            value={space.chunkCount !== null ? num(space.chunkCount) : '—'}
            hint="citables uno por uno"
          />
          <Cell
            label="Documentos"
            value={num(space.documentCount)}
            hint={
              space.pendingCount > 0
                ? `${num(space.pendingCount)} sin indexar`
                : space.documentCount > 0
                  ? 'todo indexado'
                  : 'todavía ninguno'
            }
          />
          <Cell
            label="Horas escuchadas"
            value={hours(space.spokenSeconds)}
            hint={
              space.intake.record + space.intake.meeting > 0
                ? `${plural(space.intake.record + space.intake.meeting, 'conversación', 'conversaciones')}`
                : 'sin grabaciones aún'
            }
          />
          <Cell
            label="Última entrada"
            value={space.lastAddedAt ? ago(space.lastAddedAt) : '—'}
            hint={space.lastAddedAt ? 'lo último que entró' : 'nada ha entrado'}
          />
        </dl>

        {space.canWrite && (
          <div className="border-t border-border px-5 py-3">
            {confirming ? (
              <div className="rounded-card border border-rose/30 bg-rose-soft px-3.5 py-3">
                <p className="text-[12.5px] leading-relaxed text-ink">
                  Borrar <b>{space.name}</b> borra{' '}
                  {space.documentCount === 1
                    ? 'el documento que tiene'
                    : `sus ${num(space.documentCount)} documentos`}{' '}
                  y todo lo que Cortex aprendió de ellos.{' '}
                  {space.kind === 'global'
                    ? 'Toda la empresa pierde esas respuestas, no solo tú.'
                    : 'No se puede deshacer.'}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={remove}
                    disabled={removing}
                    className="inline-flex items-center gap-1.5 rounded-card bg-rose px-3.5 py-1.5 text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                  >
                    {removing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Borrar el espacio y lo que contiene
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    className="rounded-card px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                  >
                    Dejarlo así
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="inline-flex items-center gap-1.5 rounded-card px-2.5 py-1 text-[12px] font-semibold text-ink-faint transition-colors hover:bg-rose-soft hover:text-rose"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Borrar este espacio
              </button>
            )}
            {error && (
              <p className="mt-2 rounded-card border border-rose/30 bg-rose-soft px-3 py-2 text-[12px] text-rose">
                {error}
              </p>
            )}
          </div>
        )}
      </Panel>

      {/* ------------------------------------------------------------ intake */}
      {space.canWrite ? (
        <IntakePanel space={space} active={intake} onActiveChange={onIntakeChange} />
      ) : (
        <Panel className="px-5 py-4 text-[12.5px] leading-relaxed text-ink-faint">
          Puedes leerlo todo y Cortex responde con esto, pero solo un administrador añade o quita.
          Si quieres tu propia copia, guárdala en uno de tus espacios.
        </Panel>
      )}

      {/* ------------------------------------------------------- relations */}
      <RelationsPanel spaceId={space.id} />

      {/* --------------------------------------------------------- documents */}
      <Panel>
        <PanelHead
          title="Lo que hay dentro"
          right={
            space.documentCount > 0
              ? plural(space.documentCount, 'documento', 'documentos')
              : undefined
          }
        />
        <div className="px-5 pb-4 pt-3">
          <DocumentList
            spaceId={space.id}
            spaceName={space.name}
            canWrite={space.canWrite}
            moveTargets={moveTargets.map((s) => ({ id: s.id, name: s.name, kind: s.kind }))}
          />
        </div>
      </Panel>
    </div>
  );
}

/** One counted figure in the header strip: label, number, one line of why. */
function Cell({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="bg-surface px-5 py-3.5">
      <dt className="field-label">{label}</dt>
      <dd className="stat-num mt-1 text-[20px] leading-none text-ink">{value}</dd>
      <div className="mt-1 text-[11px] text-ink-faint">{hint}</div>
    </div>
  );
}
