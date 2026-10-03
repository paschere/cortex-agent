import { BoardDetail } from '@/components/board/BoardDetail';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { workspaceHref } from '@/lib/workspace-context';
import {
  DEFAULT_BOARD_SETTINGS,
  boardPublicUrl,
  getBoardReport,
  isCompanyManager,
  readBoardSettings,
} from '@cortex/agent-tools';
import { notFound } from 'next/navigation';
import { generateBoardAction, sendBoardAction, setBoardAccessAction } from '../actions';

export const dynamic = 'force-dynamic';

/** Un informe para socios (0191): el documento y lo que se hace con él. */
export default async function BoardReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const [report, settings, canEdit] = await Promise.all([
    getBoardReport(db, id),
    readBoardSettings(db).catch(() => ({ ...DEFAULT_BOARD_SETTINGS })),
    isCompanyManager(db, user.id),
  ]);
  if (!report) notFound();
  const href = (path: string) => workspaceHref(user.organization.id, path);
  return (
    <BoardDetail
      report={report}
      canEdit={canEdit}
      recipients={settings.recipients}
      publicUrl={
        report.shareToken && report.visibility !== 'privado'
          ? boardPublicUrl(report.shareToken)
          : null
      }
      links={{ list: href('/informe-socios'), pdf: href(`/api/board/${report.id}/pdf`) }}
      actions={{
        generate: generateBoardAction,
        setAccess: setBoardAccessAction,
        send: sendBoardAction,
      }}
    />
  );
}
