'use client';

import { Panel } from '@/components/ui/panel';
import { relativeTime } from '@/lib/relative-time';
import { ArrowLeft, Building2, FileText, Loader2, Lock, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { deleteSpace } from '../actions';
import { DocumentList } from './DocumentList';
import { DriveSyncPanel } from './DriveSyncPanel';
import { SpaceChip } from './KnowledgeBase';
import { UploadDropzone } from './UploadDropzone';
import type { SpaceSummary } from './types';

export function SpaceDetail({
  space,
  allSpaces,
  onBack,
  viewerName,
}: {
  space: SpaceSummary;
  allSpaces: SpaceSummary[];
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

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-[12px] font-semibold text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        All spaces
      </button>

      {/* ------------------------------------------------------------ header */}
      <Panel className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[17px] font-extrabold tracking-tight text-ink">{space.name}</h2>
              <SpaceChip kind={space.kind} />
            </div>
            <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-ink-muted">
              {space.description ??
                (space.kind === 'global'
                  ? 'Everyone can read this, and everyone’s Zippy answers from it.'
                  : space.isMine
                    ? 'Only you can read this. Nobody else’s Zippy will ever retrieve from it.'
                    : `${space.ownerName ?? 'Someone'}’s own notes.`)}
            </p>
            <p className="mt-2 text-[11.5px] text-ink-faint">
              {space.documentCount === 1 ? '1 document' : `${space.documentCount} documents`}
              {space.lastAddedAt && ` · last added ${relativeTime(space.lastAddedAt)}`}
              {space.ownerName &&
                (space.kind === 'global'
                  ? ` · published by ${space.ownerName}`
                  : ` · ${space.isMine ? `${viewerName} (you)` : space.ownerName}`)}
            </p>
          </div>

          <span
            className={
              space.kind === 'global'
                ? 'grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-primary-soft text-primary'
                : 'grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-surface-2 text-ink-muted'
            }
          >
            {space.kind === 'global' ? (
              <Building2 className="h-5 w-5" />
            ) : (
              <Lock className="h-5 w-5" />
            )}
          </span>
        </div>

        {space.canWrite && (
          <div className="mt-4 border-t border-border pt-3">
            {confirming ? (
              <div className="rounded-[10px] border border-rose/30 bg-rose-soft px-3.5 py-3">
                <p className="text-[12.5px] leading-relaxed text-ink">
                  Deleting <b>{space.name}</b> removes{' '}
                  {space.documentCount === 1
                    ? 'the document in it'
                    : `all ${space.documentCount} documents in it`}{' '}
                  and everything Zippy learned from them.{' '}
                  {space.kind === 'global'
                    ? 'Everyone loses these answers, not just you.'
                    : 'This cannot be undone.'}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={remove}
                    disabled={removing}
                    className="inline-flex items-center gap-1.5 rounded-pill bg-rose px-3.5 py-1.5 text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                  >
                    {removing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Delete the space and its documents
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    className="rounded-pill px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted transition-colors hover:bg-surface hover:text-ink"
                  >
                    Keep it
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-[12px] font-semibold text-ink-faint transition-colors hover:bg-rose-soft hover:text-rose"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete this space
              </button>
            )}
            {error && (
              <p className="mt-2 rounded-[10px] border border-rose/30 bg-rose-soft px-3 py-2 text-[12px] text-rose">
                {error}
              </p>
            )}
          </div>
        )}
      </Panel>

      {/* ------------------------------------------------------------ intake */}
      {space.canWrite ? (
        <>
          <Panel className="p-5">
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              Add to {space.name}
            </div>
            <UploadDropzone spaceId={space.id} spaceName={space.name} />
          </Panel>
          <DriveSyncPanel spaceId={space.id} />
        </>
      ) : (
        <Panel className="px-5 py-4 text-[12.5px] leading-relaxed text-ink-faint">
          You can read everything here and Zippy answers from it, but only an org admin can add or
          remove documents. To keep your own version, save it to one of your spaces instead.
        </Panel>
      )}

      {/* --------------------------------------------------------- documents */}
      <Panel className="p-5">
        <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
          <FileText className="h-3.5 w-3.5" />
          Documents
        </div>
        <DocumentList
          spaceId={space.id}
          spaceName={space.name}
          canWrite={space.canWrite}
          moveTargets={moveTargets.map((s) => ({ id: s.id, name: s.name, kind: s.kind }))}
        />
      </Panel>
    </div>
  );
}
