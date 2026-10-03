import { openPublicSurvey } from '@/lib/crm/public';
import { notify } from '@/lib/notifications/notify';
import { bogotaToday, npsBucket, recordNpsResponse, toolErrorMessage } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * La respuesta a una encuesta de satisfacción desde el enlace público (0193).
 *
 * El token es la credencial, como en la página. Una respuesta por encuesta:
 * contestar dos veces devuelve la primera. Un detractor (0–6) deja una tarea
 * para el responsable del cliente y le avisa en la campana; cualquier
 * respuesta le avisa a quien mandó la encuesta.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const fail = (error: string, status = 400) =>
  NextResponse.json({ ok: false, error }, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    token?: unknown;
    score?: unknown;
    comment?: unknown;
    name?: unknown;
  } | null;
  const token = typeof body?.token === 'string' ? body.token : '';
  const score = typeof body?.score === 'number' ? body.score : Number.NaN;
  const comment = typeof body?.comment === 'string' ? body.comment.trim().slice(0, 2000) : '';
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 120) : '';
  const opened = token ? await openPublicSurvey(token) : null;
  if (!opened) return fail('Este enlace ya no está disponible.', 404);
  if (!Number.isInteger(score) || score < 0 || score > 10)
    return fail('Elige un número de 0 a 10.');

  const { survey, db } = opened;
  try {
    const result = await recordNpsResponse(db, survey, {
      score,
      comment: comment || null,
      respondentName: name || null,
      today: bogotaToday(),
    });
    if (!result.alreadyAnswered) {
      const detractor = npsBucket(score) === 'detractor';
      const title = `${survey.client_name} calificó ${score}/10 en la encuesta`;
      const text = comment ? `«${comment.slice(0, 300)}»` : 'Sin comentario.';
      const href = '/comercial?tab=encuestas';
      const told = new Set<string>();
      if (result.followUp?.ownerUserId) {
        told.add(result.followUp.ownerUserId);
        await notify(db, {
          userId: result.followUp.ownerUserId,
          kind: 'management_attention',
          tone: 'warning',
          title,
          body: `${text} Te quedó una tarea para llamarlo hoy.`,
          href: '/comercial?tab=actividades',
          groupKey: `nps:${survey.id}`,
        }).catch(() => null);
      }
      if (survey.created_by && !told.has(survey.created_by)) {
        await notify(db, {
          userId: survey.created_by,
          kind: 'view_activity',
          tone: detractor ? 'warning' : 'good',
          title,
          body: text,
          href,
          groupKey: `nps:${survey.id}`,
        }).catch(() => null);
      }
    }
    return NextResponse.json(
      {
        ok: true,
        score: result.response.score,
        comment: result.response.comment,
        alreadyAnswered: result.alreadyAnswered,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return fail(toolErrorMessage(err));
  }
}
