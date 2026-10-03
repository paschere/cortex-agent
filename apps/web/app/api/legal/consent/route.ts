import {
  currentAccount,
  listConsentDetails,
  recordConsents,
  requestFingerprint,
  revokeConsents,
} from '@/lib/legal/consent-store';
import { LEGAL_DOCUMENTS, LEGAL_DOCUMENT_VERSIONS, type LegalDocument } from '@/lib/legal/versions';
import { getOptionalSession } from '@/lib/session';
import { NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/legal/consent — la autorización de tratamiento de la persona de la sesión.
 *
 *   GET     su historial (qué aceptó, cuándo, qué versión).
 *   POST    acepta las versiones VIGENTES de los documentos nombrados. El cliente
 *           manda la versión que vio; si no es la vigente se rechaza (409), para
 *           que nadie quede registrado aceptando un texto que no leyó.
 *   DELETE  revoca la autorización (Ley 1581 art. 8 e).
 */

const Accept = z
  .object({
    documents: z
      .array(
        z.object({
          document: z.enum(LEGAL_DOCUMENTS),
          version: z.string().min(1).max(40),
        }),
      )
      .min(1)
      .max(LEGAL_DOCUMENTS.length),
  })
  .strict();

function json<T>(body: T, status = 200) {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export async function GET() {
  const account = await currentAccount();
  if (!account) return json({ error: 'Inicia sesión.' }, 401);
  return json({ consents: await listConsentDetails(account.id), current: LEGAL_DOCUMENT_VERSIONS });
}

export async function POST(req: Request) {
  const account = await currentAccount();
  if (!account) return json({ error: 'Inicia sesión.' }, 401);
  const parsed = Accept.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: 'Solicitud inválida.' }, 400);

  const stale = parsed.data.documents.filter(
    (d) => LEGAL_DOCUMENT_VERSIONS[d.document] !== d.version,
  );
  if (stale.length > 0) {
    return json(
      {
        error:
          'Los documentos cambiaron mientras los leías. Recarga la página y revísalos de nuevo.',
      },
      409,
    );
  }

  // La sesión puede no tener espacio todavía (un invitado que no ha aceptado):
  // la autorización es de la persona y vale igual.
  const session = await getOptionalSession();
  const fp = await requestFingerprint();
  await recordConsents({
    accountId: account.id,
    organizationId: session?.organization.id ?? null,
    documents: parsed.data.documents.map((d) => d.document as LegalDocument),
    source: 'app',
    ipHash: fp.ipHash,
    userAgent: fp.userAgent,
  });
  return json({ ok: true });
}

export async function DELETE() {
  const account = await currentAccount();
  if (!account) return json({ error: 'Inicia sesión.' }, 401);
  const revoked = await revokeConsents(account.id);
  return json({ ok: true, revoked });
}
