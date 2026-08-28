'use client';

import { Panel, PanelHead } from '@/components/ui/panel';
import { Loader2, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { deleteSpace } from '../actions';
import { AccessPanel } from './AccessPanel';
import { DocumentList } from './DocumentList';
import { IntakePanel } from './Intake';
import { RelationsPanel } from './RelationsGraph';
import { num } from './format';
import type { IntakeKey, SpaceSummary } from './types';

/**
 * Everything you DO to a space, once the map above has already said what is in
 * it.
 *
 * This is what used to be a whole separate page. The header, the counted
 * figures and the back button all moved into the map and the breadcrumb — a
 * strip of four statistics directly under a drawing that already shows the same
 * four things is the page disagreeing with itself — so what is left here is
 * only the parts that change something: putting material in, seeing what
 * connects to what, and taking things out.
 */
export function SpaceTools({
  space,
  allSpaces,
  intake,
  onIntakeChange,
  onLeave,
  onOpenDocument,
}: {
  space: SpaceSummary;
  allSpaces: SpaceSummary[];
  intake: IntakeKey;
  onIntakeChange: (key: IntakeKey) => void;
  /** Called after the space is gone, so the map goes back up a level. */
  onLeave: () => void;
  onOpenDocument: (documentId: string) => void;
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
    onLeave();
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {space.canWrite ? (
        <IntakePanel space={space} active={intake} onActiveChange={onIntakeChange} />
      ) : (
        <Panel className="px-5 py-4 text-xs leading-relaxed text-ink-faint">
          Puedes leerlo todo y Cortex responde con esto, pero aquí no guardas: te dieron acceso de
          lectura. Pídele «aportar» a quien lo administra, o guarda tu copia en uno de tus espacios.
        </Panel>
      )}

      {space.canShare && <AccessPanel space={space} />}

      <RelationsPanel spaceId={space.id} onOpenDocument={(t) => onOpenDocument(t.documentId)} />

      <Panel>
        <PanelHead title="Todo lo que hay dentro" right="incluido lo que todavía no es memoria" />
        <p className="px-5 pt-1 text-xs text-ink-muted">
          El mapa de arriba solo dibuja lo que ya quedó en fragmentos. Aquí está todo, en cualquier
          estado.
        </p>
        <div className="px-5 pb-4 pt-3">
          <DocumentList
            spaceId={space.id}
            spaceName={space.name}
            canWrite={space.canWrite}
            moveTargets={moveTargets.map((s) => ({ id: s.id, name: s.name, kind: s.kind }))}
            onOpenFragments={onOpenDocument}
          />
        </div>
      </Panel>

      {space.canShare && (
        <Panel className="px-5 py-3">
          {confirming ? (
            <div className="rounded-card border border-rose/30 bg-rose-soft px-3.5 py-3">
              <p className="text-xs leading-relaxed text-ink">
                Borrar <b>{space.name}</b> borra{' '}
                {space.documentCount === 1
                  ? 'el documento que tiene'
                  : `sus ${num(space.documentCount)} documentos`}{' '}
                y todo lo que Cortex aprendió de ellos.{' '}
                {space.kind === 'global'
                  ? 'Toda la empresa pierde esas respuestas, no solo tú.'
                  : space.kind === 'shared'
                    ? `Lo pierden también los ${space.sharedWith} accesos que tiene dados.`
                    : 'No se puede deshacer.'}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={remove}
                  disabled={removing}
                  className="inline-flex items-center gap-1.5 rounded-pill bg-rose px-3.5 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  {removing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Borrar el espacio y lo que contiene
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="rounded-pill px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  Dejarlo así
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-xs font-semibold text-ink-faint transition-colors hover:bg-rose-soft hover:text-rose"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Borrar este espacio
            </button>
          )}
          {error && (
            <p className="mt-2 rounded-card border border-rose/30 bg-rose-soft px-3 py-2 text-xs text-rose">
              {error}
            </p>
          )}
        </Panel>
      )}
    </div>
  );
}
