import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { getFlow, listCredentials, writeAuditEvent } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * Colgarle a un trámite la cuenta con la que entra.
 *
 * ---------------------------------------------------------------------------
 * POR QUÉ ES UNA RUTA APARTE Y NO UN PATCH DEL TRÁMITE
 * ---------------------------------------------------------------------------
 * El PATCH de `flows/[id]` dice, y con razón, que los pasos, el estado y la
 * credencial son del motor: una ruta que pudiera tocarlos sería una forma de
 * editar un trámite probado sin volver a probarlo. Vincular una cuenta no es
 * eso —no cambia lo que el trámite hace, cambia con qué identidad lo hace—
 * pero merece su propia puerta, con su propio permiso y su propia entrada en
 * la auditoría.
 *
 * ---------------------------------------------------------------------------
 * AQUÍ NO PASA NINGÚN SECRETO
 * ---------------------------------------------------------------------------
 * El cuerpo de esta petición son DOS IDENTIFICADORES. La contraseña viaja una
 * sola vez en su vida, al POST de `/api/browser/credentials`, que la cifra
 * antes de que toque Postgres. Esta ruta ni siquiera es capaz de leerla: lo
 * único que consulta de la credencial lo consulta con `listCredentials`, que
 * selecciona una lista explícita de columnas donde `secret_encrypted` no está.
 *
 * ---------------------------------------------------------------------------
 * LA CREDENCIAL NOMBRA SU SITIO, Y SÓLO SE VINCULA A ESE SITIO
 * ---------------------------------------------------------------------------
 * `unlockForRun` ya se niega a abrir una credencial para un origen distinto
 * del suyo, y esa es la defensa que importa. Ésta es la misma comprobación
 * hecha veinte segundos antes: descubrir en la corrida de las 3am que la clave
 * de la DIAN estaba colgada de un trámite del RUNT es la peor hora para
 * enterarse, y la persona que la vinculó ya no está para corregirlo.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  flowId: z.string().uuid(),
  // `nullish`, no `optional`. Un `null` explícito es «desvincúlala», y el
  // cliente lo manda tal cual porque `JSON.stringify` sí serializa un null;
  // `optional()` sólo admite el campo AUSENTE y rechazaría con un 400 la única
  // forma que tiene la pantalla de decir «quítale la cuenta».
  credentialId: z.string().uuid().nullish(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const started = performance.now();
  const session = await requireSession();
  if (session.role !== 'org_admin') {
    return NextResponse.json(
      { error: 'Sólo un administrador puede decidir con qué cuenta entra un trámite.' },
      { status: 403 },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'No entendí lo que llegó.' }, { status: 400 });
  }
  const { flowId } = parsed.data;
  const credentialId = parsed.data.credentialId ?? null;

  const db = getOrgScopedClient(session.organization.id);

  const flow = await getFlow(db, flowId);
  if (!flow) return NextResponse.json({ error: 'Ese trámite no existe.' }, { status: 404 });

  // Nombres, sitios y fechas. Nunca un valor. Ver credentials.ts.
  let credentialLabel: string | null = null;
  if (credentialId) {
    const credential = (await listCredentials(db)).find((c) => c.id === credentialId);
    if (!credential) {
      return NextResponse.json({ error: 'Esa credencial ya no existe.' }, { status: 404 });
    }
    if (credential.host.toLowerCase() !== flow.host.toLowerCase()) {
      return NextResponse.json(
        {
          error: `«${credential.label}» es la cuenta de ${credential.host}, y este trámite abre ${flow.host}. No la voy a vincular: al correr tampoco se abriría.`,
        },
        { status: 409 },
      );
    }
    credentialLabel = credential.label;
  }

  const { error } = await db
    .from('browser_flows')
    .update({ credential_id: credentialId, updated_at: new Date().toISOString() })
    .eq('id', flowId);
  if (error) {
    logger.error({ err: error.message, flowId }, 'could not bind a credential to a browser flow');
    return NextResponse.json(
      { error: 'No pude vincularla. Vuelve a intentarlo en un momento.' },
      { status: 500 },
    );
  }

  await writeAuditEvent({
    db,
    userId: session.id,
    toolId: 'browser.bind_credential',
    input: { flow: flow.slug },
    status: 'ok',
    latencyMs: Math.round(performance.now() - started),
    surface: 'web',
    riskLevel: 'high',
    decision: 'allowed',
    riskReason: credentialLabel
      ? `Le dio al trámite «${flow.name}» la cuenta «${credentialLabel}» de ${flow.host}.`
      : `Le quitó al trámite «${flow.name}» la cuenta con la que entraba.`,
    // El nombre de la credencial es rotulable; su contenido no está en alcance
    // en ninguna línea de este archivo.
    metadata: { flowId, slug: flow.slug, host: flow.host, credentialId, credentialLabel },
  });

  return NextResponse.json({ ok: true, credentialId, credentialLabel });
}
