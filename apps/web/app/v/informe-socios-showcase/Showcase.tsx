'use client';

import { BoardDetail } from '@/components/board/BoardDetail';
import { BoardHome } from '@/components/board/BoardHome';
import type { BoardReport, BoardSettings } from '@cortex/agent-tools';
import { useEffect } from 'react';

const wait = () => new Promise((r) => setTimeout(r, 400));
const fake = async () => {
  await wait();
  return { ok: true as const, note: 'Listo (de mentira).' };
};

export function BoardFixture({
  dark,
  view,
  report,
  reports,
  settings,
}: {
  dark: boolean;
  view: 'lista' | 'detalle';
  report: BoardReport;
  reports: BoardReport[];
  settings: BoardSettings;
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <main className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-8 md:py-7">
        {view === 'lista' ? (
          <BoardHome
            today="2026-10-05"
            reports={reports}
            settings={settings}
            canEdit
            defaultPeriod="2026-09"
            periods={[
              { value: '2026-10', label: 'Octubre de 2026 (en curso)' },
              { value: '2026-09', label: 'Septiembre de 2026' },
              { value: '2026-08', label: 'Agosto de 2026' },
            ]}
            links={{
              self: '#',
              statements: '/v/estados-showcase',
              budget: '/v/presupuesto-showcase',
              integrations: '#',
              schedules: '#',
            }}
            hrefs={Object.fromEntries(
              reports.map((r) => [r.id, { detail: '/v/informe-socios-showcase', pdf: '#' }]),
            )}
            actions={{ generate: fake, saveSettings: fake }}
          />
        ) : (
          <BoardDetail
            report={report}
            canEdit
            recipients={settings.recipients}
            publicUrl={`http://localhost:3100/informe/${report.shareToken}`}
            links={{ list: '/v/informe-socios-showcase?vista=lista', pdf: '#' }}
            actions={{
              generate: fake,
              setAccess: async () => ({
                ok: true as const,
                note: 'Listo (de mentira).',
                url: 'http://localhost:3100/informe/x',
              }),
              send: fake,
            }}
          />
        )}
      </main>
    </div>
  );
}
