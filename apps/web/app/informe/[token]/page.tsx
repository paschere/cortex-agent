import { PublicShell } from '@/app/v/[token]/PublicShell';
import { BoardDocument } from '@/components/board/BoardDocument';
import { boardUnlockCookieName, isBoardUnlocked, openPublicBoard } from '@/lib/board/public';
import { readBranding, toViewBrand } from '@/lib/branding/store';
import { countBoardOpen } from '@cortex/agent-tools';
import { Download } from 'lucide-react';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { BoardPasswordGate } from './BoardPasswordGate';

/**
 * EL INFORME PARA SOCIOS, VISTO DESDE AFUERA (0191).
 *
 * Fuera del shell de la app: quien lo abre es un socio sin cuenta. Ve la
 * marca de la empresa, el informe tal como se guardó (no se recalcula: es el
 * informe de ESE mes) y el PDF. Un token que no abre es 404 sin más.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function PublicBoardPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const opened = await openPublicBoard(token);
  if (!opened) notFound();
  const { report, db, organizationName } = opened;
  const branding = await readBranding(db).catch(() => null);
  const brand = toViewBrand(
    branding,
    organizationName,
    (v) => `/api/board/public/logo?token=${encodeURIComponent(token)}&v=${v}`,
  );

  if (report.visibility === 'contrasena') {
    const jar = await cookies();
    if (!(await isBoardUnlocked(db, report.id, jar.get(boardUnlockCookieName(report.id))?.value))) {
      return (
        <PublicShell brand={brand}>
          <BoardPasswordGate token={token} title={report.title} />
        </PublicShell>
      );
    }
  }
  void countBoardOpen(db, report).catch(() => undefined);
  return (
    <PublicShell brand={brand}>
      <div className="mb-6 flex justify-end">
        <a
          href={`/api/board/public/pdf?token=${encodeURIComponent(token)}`}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-4 py-1.5 text-xs font-semibold text-ink hover:bg-surface-2"
        >
          <Download className="h-3.5 w-3.5" aria-hidden /> Descargar PDF
        </a>
      </div>
      <div className="rounded-card border border-border bg-surface p-5 shadow-card sm:p-10">
        <BoardDocument content={report.content} accent={brand.primary} />
      </div>
    </PublicShell>
  );
}
