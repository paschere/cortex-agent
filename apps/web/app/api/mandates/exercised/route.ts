import type { ExercisedMandate } from '@/lib/mandates/delegation';
import { listMandatesByIds, mandateState } from '@/lib/mandates/store';
import { requireSession } from '@/lib/session';
import { mustReadList } from '@/lib/supabase/read';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * QUÉ MANDATOS ACTUARON EN ESTA CONVERSACIÓN, Y CON QUÉ AUTORIDAD.
 *
 * ===========================================================================
 * POR QUÉ HACE FALTA UNA CONSULTA HABIENDO YA UN AVISO EN EL RESULTADO
 * ===========================================================================
 * El resultado de una llamada delegada llega al chat con un `_security` pegado
 * que dice `delegatedBy: '<nombre del mandato>'`. Eso basta para SABER que hubo
 * autonomía, y por eso es lo que decide si se enseña el aviso: es la misma señal
 * que escribió la fila de auditoría, y viaja con el mensaje incluso después de
 * una recarga.
 *
 * Lo que no basta es para dar la cara por ello. El aviso tiene que decir de
 * QUIÉN es la decisión y de CUÁNDO —«como me autorizaste el 3 de agosto»— y
 * ofrecer la puerta de salida al lado. Nada de eso viaja en el resultado, ni
 * debería: son columnas de `mandates`, cambian (una revocación de hace un
 * minuto tiene que verse) y el nombre solo no identifica una fila. Así que esta
 * ruta las trae de la base, sin inventarse ninguna.
 *
 * ===========================================================================
 * SE PARTE DE audit_events Y NO DE mandate_uses
 * ===========================================================================
 * Las dos tablas registran lo mismo desde dos sitios distintos, y solo una tiene
 * `conversation_id`: `mandate_uses` existe para el presupuesto diario y no sabe
 * en qué conversación estaba nadie. `audit_events` con `decision='delegated'` es
 * la fila que sí puede contestar «qué se hizo sin preguntar EN ESTA charla», y
 * además sobrevive al borrado del mandato (`on delete set null`), que es
 * exactamente lo que un aviso posterior necesita.
 *
 * ===========================================================================
 * NO SE CACHEA, Y ESO ES DELIBERADO
 * ===========================================================================
 * `loadMandates` no memoiza para que una revocación muerda en la llamada
 * siguiente; un aviso que siguiera ofreciendo «revocar» sobre algo ya revocado,
 * o que dijera «en vigor» un minuto después de apagarlo, desharía esa promesa en
 * la única pantalla donde la persona la está usando. `force-dynamic`, y punto.
 */

/** Un turno de chat está topado en 12 pasos; esto cubre una conversación larga. */
const MAX_ROWS = 200;

interface DelegatedRow {
  mandate_id: string | null;
  tool_id: string;
  created_at: string;
}

export interface ExercisedResponse {
  /** Si quien mira puede revocar. Solo `org_admin` — igual que conceder. */
  canRevoke: boolean;
  delegations: ExercisedMandate[];
}

export async function GET(req: NextRequest) {
  const conversationId = req.nextUrl.searchParams.get('conversationId');
  const user = await requireSession();
  const empty: ExercisedResponse = { canRevoke: user.role === 'org_admin', delegations: [] };
  if (!conversationId) return NextResponse.json(empty);

  const db = getOrgScopedClient(user.organization.id);

  // El cliente con ámbito de organización es lo que hace que el id de otra
  // empresa devuelva nada en vez de los permisos de otra empresa.
  const rows = mustReadList<DelegatedRow>(
    await db
      .from('audit_events')
      .select('mandate_id, tool_id, created_at')
      .eq('conversation_id', conversationId)
      .eq('decision', 'delegated')
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS),
    'lo que Cortex hizo sin preguntar en esta conversación',
  );

  const ids = rows.map((r) => r.mandate_id).filter((id): id is string => !!id);
  if (ids.length === 0) return NextResponse.json(empty);

  const mandates = await listMandatesByIds(db, ids);
  const now = new Date();

  // Los nombres se resuelven aquí y no en el componente: `granted_by` es un uuid
  // y un aviso que enseñara un uuid no explica nada. Una sola consulta para
  // todos, como en la pantalla de auditoría.
  const granters = [...new Set(mandates.map((m) => m.granted_by).filter(Boolean))];
  const names: Record<string, string> = {};
  if (granters.length > 0) {
    const people = mustReadList<{ id: string; email: string; name: string | null }>(
      await db.from('users').select('id, email, name').in('id', granters),
      'quién concedió estos mandatos',
    );
    for (const p of people) names[p.id] = p.name || p.email;
  }

  const delegations: ExercisedMandate[] = mandates.map((m) => {
    const mine = rows.filter((r) => r.mandate_id === m.id);
    return {
      mandateId: m.id,
      label: m.label,
      grantedByName: names[m.granted_by] ?? null,
      grantedByIsViewer: m.granted_by === user.id,
      createdAt: m.created_at,
      state: mandateState(m, now),
      toolIds: [...new Set(mine.map((r) => r.tool_id))],
      calls: mine.length,
      // Las filas vienen ordenadas de más nueva a más vieja.
      lastUsedAt: mine[0]?.created_at ?? null,
    };
  });

  return NextResponse.json({ canRevoke: user.role === 'org_admin', delegations });
}
