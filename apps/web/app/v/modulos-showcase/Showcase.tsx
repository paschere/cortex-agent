'use client';

import { ModuleOff } from '@/components/modules/ModuleOff';
import { ModulesScreen } from '@/components/modules/ModulesScreen';
import type { ModuleActions, PresetOption } from '@/components/modules/types';
import { PageHeader } from '@/components/ui/page-header';
import type { ModuleArea, ModulePageState } from '@/lib/modules/shape';
import { Boxes } from 'lucide-react';
import { useEffect } from 'react';

const wait = () => new Promise((r) => setTimeout(r, 450));

/** Acciones de mentira: contestan como el servidor, sin guardar nada. */
const actions: ModuleActions = {
  async toggle(_key, enabled) {
    await wait();
    return { ok: true, note: enabled ? 'Prendido (de mentira).' : 'Apagado (de mentira).' };
  },
  async previewPreset() {
    await wait();
    return { ok: true, note: '', on: ['Atención por WhatsApp'], off: ['Flota y rutas'] };
  },
  async applyPreset() {
    await wait();
    return { ok: true, note: 'Listo (de mentira).' };
  },
};

export function ModulosFixture({
  dark,
  pantalla,
  areas,
  canEdit,
  offState,
  presets,
}: {
  dark: boolean;
  pantalla: 'ajustes' | 'apagado';
  areas: ModuleArea[];
  canEdit: boolean;
  offState: Extract<ModulePageState, { off: true }> | null;
  presets: PresetOption[];
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <main className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8 md:py-7">
        {pantalla === 'apagado' && offState ? (
          <ModuleOff state={offState} toggle={actions.toggle} />
        ) : (
          <div className="flex flex-col gap-6">
            <PageHeader
              title="Módulos"
              subtitle="Prende lo que tu empresa usa y apaga lo que no. Lo apagado sale del menú, del chat y del piloto automático, y sus datos quedan guardados."
              icon={<Boxes className="h-5 w-5" aria-hidden />}
            />
            <ModulesScreen areas={areas} canEdit={canEdit} actions={actions} presets={presets} />
          </div>
        )}
      </main>
    </div>
  );
}
