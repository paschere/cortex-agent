'use client';

import { CertificatesView } from '@/components/tax/CertificatesView';
import { DraftView } from '@/components/tax/DraftView';
import { ExogenaView } from '@/components/tax/ExogenaView';
import { TaxHome } from '@/components/tax/TaxHome';
import type {
  CertificatesScreen,
  ExogenaScreen,
  TaxActions,
  TaxDraftScreen,
  TaxLinks,
  TaxScreenData,
  TaxUpload,
} from '@/components/tax/types';
import { useEffect } from 'react';

const wait = () => new Promise((r) => setTimeout(r, 450));

export function TaxFixture({
  dark,
  data,
  links,
  draft,
  certificates,
  exogena,
}: {
  dark: boolean;
  data: TaxScreenData;
  links: TaxLinks;
  draft?: TaxDraftScreen | null;
  certificates?: CertificatesScreen | null;
  exogena?: ExogenaScreen | null;
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  /** Acciones de mentira: contestan como el servidor, sin guardar nada. */
  const actions: TaxActions = {
    async saveProfile() {
      await wait();
      return { ok: true, note: 'Guardado (de mentira). Recalculé 12 fechas.' };
    },
    async mark() {
      await wait();
      return { ok: true, note: 'Cerré su vencimiento (de mentira).' };
    },
  };
  const upload: TaxUpload = async () => {
    await wait();
    return { ok: true, documentId: '00000000-0000-4000-8000-0000000000aa', note: 'Subido.' };
  };
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <main className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-8 md:py-7">
        {draft ? (
          <DraftView
            data={draft}
            upload={upload}
            actions={{
              save: async () => {
                await wait();
                return { ok: true, note: 'Borrador guardado (de mentira).' };
              },
              review: async () => {
                await wait();
                return { ok: true, note: 'Revisado (de mentira).' };
              },
              present: async () => {
                await wait();
                return { ok: true, note: 'Presentado (de mentira).' };
              },
              annul: async () => {
                await wait();
                return { ok: true, note: 'Anulado (de mentira).' };
              },
            }}
          />
        ) : certificates ? (
          <CertificatesView
            data={certificates}
            actions={{
              send: async () => {
                await wait();
                return { ok: true, note: 'Mandé 3 certificados (de mentira).' };
              },
              setConcept: async () => {
                await wait();
                return { ok: true, note: 'Guardado.' };
              },
            }}
          />
        ) : exogena ? (
          <ExogenaView data={exogena} />
        ) : (
          <TaxHome data={data} links={links} actions={actions} upload={upload} />
        )}
      </main>
    </div>
  );
}
