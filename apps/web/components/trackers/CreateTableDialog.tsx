'use client';

import type {
  FolderChoice,
  FolderProposalView,
  SchemaActions,
  SheetProposalView,
  SheetSourceInfo,
} from '@/app/(app)/trackers/schema-types';
import type { TrackerField } from '@/lib/trackers/schema-editor';
import * as Dialog from '@radix-ui/react-dialog';
import { FileSpreadsheet, FolderInput, Loader2, Table2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SchemaEditor, type SchemaSeed } from './SchemaEditor';
import { schemaActions } from './schema-client';

/**
 * «CREAR TABLA NUEVA» CON TODAS LAS REGLAS.
 *
 * Tres caminos: desde cero (un campo de texto y a armarlo), desde una hoja
 * conectada del Feed de la persona o desde una carpeta de Drive (enlace o
 * nombre, con o sin subcarpetas): Cortex mira qué hay dentro, lee una muestra y
 * abre el mismo editor prellenado; al crear se llena con los archivos. En el segundo, Cortex LEE la hoja y abre el
 * editor ya prellenado —tipos, obligatorios, formatos, clave, duplicados— con
 * el porqué de cada cosa; la persona corrige y al crear la tabla se llena con
 * la hoja y queda sincronizada. Sólo se ofrecen las hojas del propio Feed.
 */

type Step =
  | { kind: 'choose' }
  | { kind: 'scratch' }
  | { kind: 'sheets' }
  | { kind: 'sheet'; proposal: SheetProposalView }
  | { kind: 'folders' }
  | { kind: 'folder'; proposal: FolderProposalView };

const BLANK: TrackerField[] = [{ key: 'nombre', label: 'Nombre', type: 'text', required: true }];

export function CreateTableDialog({
  open,
  onOpenChange,
  onCreated,
  actions = schemaActions,
  initialName = '',
  prefer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (created: { slug: string; id: string; fields: TrackerField[] }) => void;
  actions?: SchemaActions;
  initialName?: string;
  /** Saltarse la pregunta inicial. */
  prefer?: 'scratch';
}) {
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const [others, setOthers] = useState<Array<{ slug: string; name: string }>>([]);

  useEffect(() => {
    if (!open) return;
    setStep(prefer === 'scratch' ? { kind: 'scratch' } : { kind: 'choose' });
    actions.listTrackers?.().then(setOthers);
  }, [open, prefer, actions]);

  const seed: SchemaSeed = {
    name: initialName,
    description: '',
    fields: BLANK,
    duplicates: null,
    otherTrackers: others,
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] animate-veil bg-canvas/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 z-[70] flex max-h-[92vh] flex-col overflow-hidden rounded-t-card border border-border bg-surface shadow-pop outline-none sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[min(44rem,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-card">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <Dialog.Title className="text-base font-semibold text-ink">
                Crear tabla nueva
              </Dialog.Title>
              <Dialog.Description className="text-xs text-ink-muted">
                Con sus campos y sus reglas, sin pasar por el chat.
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Cerrar"
              className="grid h-8 w-8 place-items-center rounded-pill text-ink-faint hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-4 pt-4">
            {step.kind === 'choose' && (
              <div className="grid gap-3 pb-4 sm:grid-cols-2">
                <Choice
                  icon={<Table2 className="h-5 w-5" />}
                  title="Desde cero"
                  text="Eliges el nombre y los campos, uno por uno."
                  onClick={() => setStep({ kind: 'scratch' })}
                />
                <Choice
                  icon={<FileSpreadsheet className="h-5 w-5" />}
                  title="Desde una hoja conectada"
                  text="Cortex lee tu hoja y te propone los campos y las reglas; tú corriges."
                  onClick={() => setStep({ kind: 'sheets' })}
                />
                <Choice
                  icon={<FolderInput className="h-5 w-5" />}
                  title="Desde una carpeta de Drive"
                  text="Cortex mira qué hay (hojas, PDF, fotos, subcarpetas), lee una muestra y te propone los campos."
                  onClick={() => setStep({ kind: 'folders' })}
                />
              </div>
            )}
            {step.kind === 'scratch' && (
              <SchemaEditor
                seed={seed}
                actions={actions}
                onCreated={onCreated}
                onCancel={() => onOpenChange(false)}
              />
            )}
            {step.kind === 'sheets' && (
              <SheetPicker
                actions={actions}
                onBack={() => setStep({ kind: 'choose' })}
                onProposal={(proposal) => {
                  setStep({ kind: 'sheet', proposal });
                }}
              />
            )}
            {step.kind === 'folders' && (
              <FolderPicker
                actions={actions}
                onBack={() => setStep({ kind: 'choose' })}
                onProposal={(proposal) => setStep({ kind: 'folder', proposal })}
              />
            )}
            {step.kind === 'folder' && (
              <SchemaEditor
                folder={step.proposal}
                seed={{
                  name: step.proposal.suggestedName,
                  description: step.proposal.description,
                  fields: step.proposal.fields,
                  duplicates: step.proposal.duplicates
                    ? {
                        key: step.proposal.duplicates.key,
                        distinctBy: step.proposal.duplicates.distinctBy,
                        flagField: step.proposal.duplicates.flagField,
                        flagValue: step.proposal.duplicates.flagValue,
                      }
                    : null,
                  otherTrackers: others,
                }}
                actions={actions}
                onCreated={onCreated}
                onCancel={() => setStep({ kind: 'folders' })}
              />
            )}
            {step.kind === 'sheet' && (
              <SchemaEditor
                sheet={step.proposal}
                seed={{
                  name: step.proposal.suggestedName,
                  description: '',
                  fields: step.proposal.fields,
                  duplicates: step.proposal.duplicates
                    ? {
                        key: step.proposal.duplicates.key,
                        distinctBy: step.proposal.duplicates.distinctBy,
                        flagField: step.proposal.duplicates.flagField,
                        flagValue: step.proposal.duplicates.flagValue,
                      }
                    : null,
                  otherTrackers: others,
                }}
                actions={actions}
                onCreated={onCreated}
                onCancel={() => setStep({ kind: 'sheets' })}
              />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Choice({
  icon,
  title,
  text,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-start gap-3 rounded-card border border-border bg-surface p-4 text-left transition-all hover:-translate-y-px hover:border-primary/50 hover:bg-primary-soft/30 hover:shadow-card"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
        {icon}
      </span>
      <span>
        <span className="block text-sm font-semibold text-ink">{title}</span>
        <span className="block text-xs leading-relaxed text-ink-muted">{text}</span>
      </span>
    </button>
  );
}

function SheetPicker({
  actions,
  onBack,
  onProposal,
}: {
  actions: SchemaActions;
  onBack: () => void;
  onProposal: (p: SheetProposalView) => void;
}) {
  const [sources, setSources] = useState<SheetSourceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!actions.listSheets) {
      setError('Esta pantalla no puede leer hojas conectadas.');
      return;
    }
    actions.listSheets().then((r) => {
      if (!alive) return;
      if (r.ok) setSources(r.sources);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [actions]);

  async function pick(sourceId: string, index: number) {
    if (!actions.proposeFromSheet) return;
    setReading(`${sourceId}:${index}`);
    setError(null);
    const r = await actions.proposeFromSheet(sourceId, index);
    setReading(null);
    if (r.ok) onProposal(r.proposal);
    else setError(r.error);
  }

  return (
    <div className="space-y-3 pb-4">
      <button type="button" onClick={onBack} className="text-xs font-semibold text-primary">
        ← Volver
      </button>
      {!sources && !error && (
        <p className="flex items-center gap-2 text-sm text-ink-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Buscando tus hojas…
        </p>
      )}
      {error && <p className="text-sm text-rose">{error}</p>}
      {sources && sources.length === 0 && (
        <p className="text-sm leading-relaxed text-ink-muted">
          No tienes hojas de Google conectadas con datos vigentes. Conéctala desde el chat («conecta
          esta hoja: …») o actualízala en tu Feed y vuelve aquí. Sólo se muestran tus propias hojas.
        </p>
      )}
      <ul className="space-y-2">
        {sources?.map((s) => (
          <li key={s.id} className="rounded-card border border-border p-3">
            <p className="text-sm font-semibold text-ink">{s.name}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {s.tabs.map((t) => (
                <button
                  key={t.index}
                  type="button"
                  disabled={reading !== null}
                  onClick={() => pick(s.id, t.index)}
                  className="inline-flex items-center gap-1.5 rounded-pill border border-border-strong px-3 py-1 text-xs font-semibold text-ink-muted hover:border-primary/50 hover:text-ink disabled:opacity-50"
                >
                  {reading === `${s.id}:${t.index}` && <Loader2 className="h-3 w-3 animate-spin" />}
                  {t.name} · {t.rows} filas
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Pegar el enlace de una carpeta de Drive o escribir su nombre. Con la casilla
 * «incluir subcarpetas» (encendida: si la carpeta tiene subcarpetas, entran).
 * Leer es lo único que pasa aquí: nada se crea hasta el editor.
 */
function FolderPicker({
  actions,
  onBack,
  onProposal,
}: {
  actions: SchemaActions;
  onBack: () => void;
  onProposal: (p: FolderProposalView) => void;
}) {
  const [ref, setRef] = useState('');
  const [deep, setDeep] = useState(true);
  const [choices, setChoices] = useState<FolderChoice[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function read(folder: FolderChoice) {
    if (!actions.proposeFromFolder) return;
    setBusy(folder.id);
    setError(null);
    const r = await actions.proposeFromFolder(folder.id, deep);
    setBusy(null);
    if (r.ok) onProposal(r.proposal);
    else setError(r.error);
  }

  async function search() {
    if (!actions.findFolders || !ref.trim()) return;
    setBusy('search');
    setError(null);
    setChoices([]);
    const r = await actions.findFolders(ref);
    setBusy(null);
    if (!r.ok) return setError(r.error);
    // Un enlace (o un único nombre) se lee de una vez; si hay varias, se elige.
    if (r.folders.length === 1) return read(r.folders[0] as FolderChoice);
    setChoices(r.folders);
  }

  if (!actions.findFolders || !actions.proposeFromFolder)
    return <p className="pb-4 text-sm text-rose">Esta pantalla no puede leer carpetas de Drive.</p>;

  return (
    <div className="space-y-3 pb-4">
      <button type="button" onClick={onBack} className="text-xs font-semibold text-primary">
        ← Volver
      </button>
      <label className="block text-xs font-semibold text-ink" htmlFor="folder-ref">
        Enlace o nombre de la carpeta
      </label>
      <div className="flex gap-2">
        <input
          id="folder-ref"
          value={ref}
          maxLength={500}
          onChange={(e) => setRef(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          placeholder="https://drive.google.com/drive/folders/… o «Facturas»"
          className="min-w-0 flex-1 rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink"
        />
        <button
          type="button"
          onClick={search}
          disabled={busy !== null || !ref.trim()}
          className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Leer carpeta
        </button>
      </div>
      <label className="flex items-center gap-2 text-xs text-ink-muted">
        <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} />
        Incluir subcarpetas (hasta 3 niveles); la subcarpeta de cada archivo queda en un campo
        «Carpeta»
      </label>
      {busy && (
        <p className="flex items-center gap-2 text-sm text-ink-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Mirando qué hay en la carpeta y leyendo una
          muestra…
        </p>
      )}
      {error && <p className="text-sm text-rose">{error}</p>}
      {choices.length > 1 && (
        <ul className="space-y-2">
          {choices.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => read(c)}
                className="w-full rounded-card border border-border p-3 text-left text-sm font-semibold text-ink hover:border-primary/50 disabled:opacity-50"
              >
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs leading-relaxed text-ink-muted">
        Se lee con tu cuenta de Google. Las hojas se leen fila por fila, sin modelo; los PDF, Word y
        fotos los lee el modelo y lo dudoso queda «Por revisar».
      </p>
    </div>
  );
}
