import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type CustomToolRow,
  EXECUTION_COLUMNS,
  buildInputSchema,
  executeCustomTool,
} from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 90;

const TABLE = 'custom_tools';

const Body = z.object({
  /** Values for the tool's declared fields. Validated against its own schema. */
  input: z.record(z.unknown()).default({}),
});

/**
 * Run a tool with test values and show what actually went over the wire.
 *
 * WITHOUT THIS THE WHOLE FEATURE IS UNUSABLE. A custom tool that returns
 * nothing could be a wrong path, a wrong header name, an expired key, a body
 * the API rejects, or a destination our guard refused — and from inside a chat
 * window they are indistinguishable. The tester is where an admin sees the
 * request Cortex built, the status that came back, and the first few KB of the
 * response, including the error page.
 *
 * TWO PROPERTIES IT MUST HAVE, and both are easy to lose:
 *
 *   1. It runs through the SAME code as a real call — `executeCustomTool`, and
 *      therefore the same destination validation, the same timeout, the same
 *      size cap, the same redirect posture. A tester with its own relaxed HTTP
 *      path would be a bypass of every check in this feature, reachable by any
 *      admin, from a URL bar.
 *   2. It does not show the secret. What is returned is the `preview` request,
 *      whose Authorization header reads `Bearer ••••••••`, and a response body
 *      that has had every literal occurrence of the credential removed on the
 *      way out.
 *
 * It deliberately does NOT go through `runTool`: a test is not a tool call. It
 * must run even when the tool requires confirmation (there is nobody to
 * confirm to), it must not consume the tool's production rate-limit budget, and
 * it must not land in `audit_events` as though the agent had done something.
 * The gate that replaces those is stricter, not looser: org_admin only.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (user.role !== 'org_admin') {
    return NextResponse.json(
      { error: 'Solo un administrador de la organización puede probar una herramienta.' },
      { status: 403 },
    );
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const parsedBody = Body.safeParse(body ?? {});
  if (!parsedBody.success) {
    return NextResponse.json({ error: parsedBody.error.flatten() }, { status: 400 });
  }

  const db = getOrgScopedClient(user.organization.id);
  const { data } = await db.from(TABLE).select(EXECUTION_COLUMNS).eq('id', id).maybeSingle();
  if (!data) {
    return NextResponse.json({ error: 'No existe esa herramienta.' }, { status: 404 });
  }
  const row = data as unknown as CustomToolRow;

  // The same validation the model's arguments face, so "the model sent the
  // wrong thing" and "the endpoint is broken" stay distinguishable.
  const schema = buildInputSchema(row.input_schema);
  const validated = schema.safeParse(parsedBody.data.input);
  if (!validated.success) {
    return NextResponse.json(
      {
        error: 'Los valores de prueba no cumplen el esquema de la herramienta.',
        issues: validated.error.flatten(),
      },
      { status: 422 },
    );
  }

  const startedAt = Date.now();
  const { result, detail } = await executeCustomTool(
    row,
    validated.data as Record<string, unknown>,
  );
  const elapsedMs = Date.now() - startedAt;

  // Record the outcome so the list can show a tool that is quietly broken.
  await db
    .from(TABLE)
    .update({
      last_tested_at: new Date().toISOString(),
      last_error: result.ok ? null : (result.message ?? '').slice(0, 2000),
    })
    .eq('id', id);

  return NextResponse.json({
    ok: result.ok,
    elapsedMs,
    /** Exactly what was sent, credential replaced by dots. */
    request: {
      method: detail.preview.method,
      url: detail.preview.url,
      headers: detail.preview.headers,
      body: detail.preview.body ?? null,
    },
    /** Every address contacted, so a redirect chain is visible. */
    chain: detail.chain,
    response: detail.response
      ? {
          status: detail.response.status,
          statusText: detail.response.statusText,
          headers: detail.response.headers,
          body: detail.response.body,
          truncated: detail.response.truncated,
        }
      : null,
    /** What the model would have received from this call. */
    modelResult: result,
  });
}
