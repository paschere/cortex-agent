import { isSameOrigin } from '@/lib/activations/request';
import {
  ActivationExecutionError,
  activationOperationDecisionSchema,
  activationOperationPrepareSchema,
  activationOperationReconcileSchema,
  claimActivationApproval,
  listActivationCaseOptions,
  listActivationOperations,
  listActivationToolOptions,
  prepareActivationOperation,
  reconcileActivationOperation,
} from '@/lib/management/activation-execution';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
// A write (30s) plus two bounded reads (10s each) stays below this ceiling.
export const maxDuration = 90;

const Query = z.object({
  caseId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
});

const Body = z.discriminatedUnion('action', [
  activationOperationPrepareSchema,
  activationOperationDecisionSchema,
  activationOperationReconcileSchema,
]);

function privateJson(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

function failure(error: unknown, fallback: string) {
  if (error instanceof ActivationExecutionError)
    return privateJson({ error: error.message }, { status: error.status });
  return privateJson({ error: fallback }, { status: 503 });
}

export async function GET(req: NextRequest) {
  if (!isSameOrigin(req)) return privateJson({ error: 'Origen inválido.' }, { status: 403 });
  const user = await requireSession();
  const parsed = Query.safeParse({
    caseId: req.nextUrl.searchParams.get('caseId') ?? undefined,
    runId: req.nextUrl.searchParams.get('runId') ?? undefined,
  });
  if (!parsed.success)
    return privateJson({ error: 'El asunto o la activación no son válidos.' }, { status: 400 });
  try {
    const db = getOrgScopedClient(user.organization.id);
    const [operations, tools, cases] = await Promise.all([
      listActivationOperations(db, user.id, parsed.data),
      listActivationToolOptions(db, user.id),
      parsed.data.runId
        ? listActivationCaseOptions(db, user.id, parsed.data.runId)
        : Promise.resolve([]),
    ]);
    return privateJson({ operations, tools, cases });
  } catch (error) {
    return failure(error, 'No se pudo cargar el puente de activación.');
  }
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return privateJson({ error: 'Origen inválido.' }, { status: 403 });
  const user = await requireSession();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return privateJson({ error: 'La propuesta o decisión no es válida.' }, { status: 400 });

  try {
    const db = getOrgScopedClient(user.organization.id);
    if (parsed.data.action === 'prepare') {
      const operation = await prepareActivationOperation(db, user.id, parsed.data);
      return privateJson({ operation }, { status: 201 });
    }
    if (parsed.data.action === 'reconcile') {
      const operation = await reconcileActivationOperation(db, user.id, parsed.data.operationId);
      return privateJson({ operation });
    }
    const operation = await claimActivationApproval(
      db,
      user.id,
      parsed.data.operationId,
      parsed.data.action,
    );
    return privateJson({ operation });
  } catch (error) {
    return failure(error, 'No se pudo procesar la operación de activación.');
  }
}
