import { DRIVE_READONLY, type DriveContext, driveListChildren } from '@/app/api/kb/drive/_lib';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type ToolContext, createIntegrationsClient } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_SUGGESTIONS = 8;

/**
 * Carpetas de primer nivel del Drive de quien pregunta, SOLO NOMBRES, para
 * proponerlas en el recorrido de los primeros 15 minutos. No lee ni encola
 * nada: leer una carpeta es una decisión que se toma en el Cerebro (/kb).
 */
export async function GET(): Promise<NextResponse> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const integrations = createIntegrationsClient(db, user.id, logger);
  if (!(await integrations.hasScopes('google', [DRIVE_READONLY])))
    return NextResponse.json({ connected: false, folders: [] });
  try {
    const ctx: DriveContext = { integrations } as ToolContext;
    const { files } = await driveListChildren(ctx, 'root', {});
    const folders = files
      .filter((f) => f.isFolder)
      .slice(0, MAX_SUGGESTIONS)
      .map((f) => ({ id: f.id, name: f.name }));
    return NextResponse.json({ connected: true, folders });
  } catch (err) {
    logger.warn({ err }, 'first-run: no se pudieron listar carpetas de Drive');
    return NextResponse.json({ connected: true, folders: [] });
  }
}
