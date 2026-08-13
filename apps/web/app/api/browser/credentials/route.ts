import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { createCredential, listCredentials } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Logins for third-party portals.
 *
 * THIS ROUTE HAS NO READ PATH FOR A SECRET, and that is structural rather than
 * careful: `listCredentials` selects an explicit column list that does not
 * include `secret_encrypted`, and the only function in the codebase that does
 * select it is `unlockForRun`, which hands the value to the browser service and
 * returns it to nobody. So there is no endpoint that could be made to echo a
 * password back, whatever anybody sends it.
 *
 * Writing one is admin-only. A credential is a company asset that grants
 * whoever holds it the power to act as the company on somebody else's system,
 * and the person who binds it to a flow is deciding, implicitly, what that
 * power will be spent on.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const session = await requireSession();
  const db = getOrgScopedClient(session.organization.id);
  return NextResponse.json({
    // Names, hosts and dates. Never a value.
    credentials: await listCredentials(db),
    // Whether the POST below would accept anything from this person, answered
    // BEFORE they are shown a password field rather than after they have typed
    // one. A form that collects a company password and then says "you are not
    // allowed" has already made somebody type a secret for nothing, and the
    // next thing they do is send it to an admin over WhatsApp.
    canSave: session.role === 'org_admin',
  });
}

interface Body {
  label?: string;
  host?: string;
  fields?: Record<string, string>;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  if (session.role !== 'org_admin') {
    return NextResponse.json(
      { error: 'Sólo un administrador puede guardar una credencial de la empresa.' },
      { status: 403 },
    );
  }
  const db = getOrgScopedClient(session.organization.id);

  const body = (await req.json().catch(() => ({}))) as Body;
  const label = (body.label ?? '').trim();
  const host = (body.host ?? '').trim();
  const fields = body.fields ?? {};

  if (!label || !host || Object.keys(fields).length === 0) {
    return NextResponse.json(
      { error: 'Hace falta un nombre, el sitio y al menos un campo.' },
      { status: 400 },
    );
  }

  try {
    const created = await createCredential(db, { label, host, fields, createdBy: session.id });
    // The field NAMES are loggable; the values are not, and are not in scope
    // here by the time this line runs.
    logger.info(
      { userId: session.id, host: created.host, fields: created.fieldNames },
      'stored a portal credential',
    );
    return NextResponse.json({ credential: created });
  } catch {
    return NextResponse.json(
      { error: 'Ya hay una credencial con ese nombre en este espacio de trabajo.' },
      { status: 409 },
    );
  }
}
