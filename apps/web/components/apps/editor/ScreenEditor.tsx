'use client';

import { ViewEditor } from '@/components/views/editor/ViewEditor';
import { saveViewAction } from '@/lib/views/actions';
import type { EditorDraft } from '@/lib/views/editor-spec';
import type { ComputedView, ViewSpec } from '@cortex/agent-tools';
import { useRouter } from 'next/navigation';

/**
 * El lienzo de vistas, puesto sobre UNA pantalla de una aplicación.
 *
 * Guardar es `saveViewAction` con la versión que se abrió (si alguien guardó
 * mientras tanto, choca en vez de pisar) y después `router.refresh()` para que
 * la página traiga la versión nueva. Cerrar vuelve al panel de la app.
 */

export function ScreenEditor({
  appId,
  view,
  preview,
}: {
  appId: string;
  view: { id: string; version: number; name: string; description: string; spec: ViewSpec };
  preview: ComputedView | null;
}) {
  const router = useRouter();
  const initial: EditorDraft = {
    name: view.name,
    description: view.description,
    spec: view.spec,
    newTrackers: [],
  };
  return (
    <ViewEditor
      key={view.version}
      initial={initial}
      initialPreview={preview}
      viewId={view.id}
      version={view.version}
      isNew={false}
      onSave={async (draft, prompts) => {
        const res = await saveViewAction({
          viewId: view.id,
          expectedVersion: view.version,
          name: view.name,
          description: view.description,
          spec: draft.spec,
          newTrackers: draft.newTrackers,
          prompt: prompts.at(-1),
        });
        if (!res.ok) return { ok: false, error: res.error };
        router.refresh();
        return { ok: true };
      }}
      onCancel={() => router.push(`/apps/${appId}/edit`)}
    />
  );
}
