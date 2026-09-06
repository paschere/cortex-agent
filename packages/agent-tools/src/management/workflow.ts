import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionRow } from '../actions/shape';
import { proposeAction } from '../actions/store';
import { ManagementError, getManagementCase } from './store';
import {
  type CollectionInvoice,
  type CollectionPayment,
  type CollectionWorkflow,
  type PaymentProof,
  type WorkflowState,
  verifyCollectionBalance,
  workflowStartSchema,
} from './workflow-shape';
const columns =
  'id,case_id,user_id,invoice_id,recipient,state,detail,action_id,draft_balance,evidence,revision,last_checked_at,created_at,updated_at';
function one<T>(data: unknown): T | null {
  const r = Array.isArray(data) ? data[0] : data;
  return r && typeof r === 'object' && (r as { id?: string }).id ? (r as T) : null;
}
export async function readCollectionWorkflow(db: SupabaseClient, caseId: string) {
  const r = await db
    .from('management_workflows')
    .select(columns)
    .eq('case_id', caseId)
    .maybeSingle();
  if (r.error)
    throw new ManagementError('No se pudo consultar el proceso. Comprueba la migración 0131.');
  return r.data as CollectionWorkflow | null;
}
export async function listCollectionInvoices(db: SupabaseClient) {
  const r = await db
    .from('document_extractions')
    .select(
      'id,doc_number,counterparty_name,client_id,total_amount,currency,due_on,review_state,doc_type',
    )
    .eq('doc_type', 'invoice')
    .eq('review_state', 'confirmed')
    .order('created_at', { ascending: false })
    .limit(100);
  if (r.error) throw new ManagementError('No se pudieron consultar las facturas.');
  return r.data as CollectionInvoice[];
}
export async function loadCollectionProof(db: SupabaseClient, invoiceId: string) {
  const [invoice, payments] = await Promise.all([
    db
      .from('document_extractions')
      .select(
        'id,doc_number,counterparty_name,client_id,total_amount,currency,due_on,review_state,doc_type',
      )
      .eq('id', invoiceId)
      .maybeSingle(),
    db
      .from('payments')
      .select('id,extraction_id,state,currency,kind,amount,paid_on')
      .eq('extraction_id', invoiceId)
      .limit(1001),
  ]);
  if (invoice.error || payments.error)
    throw new ManagementError(
      'No se pudo verificar el saldo. No se preparará ni enviará un cobro.',
    );
  if (!invoice.data) throw new ManagementError('Factura no encontrada.');
  if ((payments.data?.length ?? 0) > 1000)
    throw new ManagementError('Demasiados movimientos para verificar el saldo completo.');
  const doc = invoice.data as CollectionInvoice;
  return {
    invoice: doc,
    proof: verifyCollectionBalance(doc, (payments.data ?? []) as CollectionPayment[]),
  };
}
export async function startCollectionWorkflow(db: SupabaseClient, actorId: string, input: unknown) {
  const parsed = workflowStartSchema.parse(input);
  await loadCollectionProof(db, parsed.invoiceId);
  const r = await db.rpc('management_workflow_start', {
    p_actor_id: actorId,
    p_case_id: parsed.caseId,
    p_invoice_id: parsed.invoiceId,
    p_recipient: parsed.recipient,
  });
  if (r.error)
    throw new ManagementError(
      r.error.code === 'P0001' ? r.error.message : 'No se pudo iniciar el proceso.',
    );
  const run = one<CollectionWorkflow>(r.data);
  if (!run) throw new ManagementError('No se recibió el proceso creado.');
  return run;
}
export async function cancelCollectionWorkflow(db: SupabaseClient, actorId: string, id: string) {
  const r = await db.rpc('management_workflow_cancel', { p_actor_id: actorId, p_id: id });
  if (r.error)
    throw new ManagementError(
      r.error.code === 'P0001' ? r.error.message : 'No se pudo detener el proceso.',
    );
}

/** Safe to retry: only prepares a proposal with a unique origin, never sends it. */
export async function advanceCollectionWorkflow(db: SupabaseClient, id: string) {
  const token = randomUUID();
  const claim = await db.rpc('management_workflow_claim', { p_id: id, p_token: token });
  if (claim.error) throw new ManagementError('No se pudo tomar el seguimiento.');
  const run = one<CollectionWorkflow>(claim.data);
  if (!run) return null;
  let state: WorkflowState = run.state;
  let detail = run.detail;
  let actionId = run.action_id;
  let balance = run.draft_balance;
  let evidence = run.evidence;
  try {
    const item = await getManagementCase(db, run.case_id);
    if (['verified', 'cancelled'].includes(item.data.state))
      throw new Error('El asunto está cerrado. Reábrelo para continuar el seguimiento.');
    const { invoice, proof } = await loadCollectionProof(db, run.invoice_id);
    evidence = proof;
    // Search every state: a crash after proposing or sending must never create a second cobro.
    const actions = await db
      .from('actions')
      .select('*')
      .eq('user_id', run.user_id)
      .eq('origin_kind', 'manual')
      .eq('origin_id', run.id)
      .order('created_at', { ascending: false })
      .limit(1);
    if (actions.error) throw new Error('No se pudo comprobar si ya existe un cobro.');
    let action = (actions.data?.[0] ?? null) as ActionRow | null;
    if (action) actionId = action.id;
    if (proof.balance === 0) {
      state = 'review';
      detail =
        action?.state === 'proposed'
          ? 'El saldo está cubierto por pagos confirmados. El cobro pendiente quedará bloqueado al intentar enviarlo; descártalo en Acciones y revisa la evidencia.'
          : 'El saldo está cubierto por pagos confirmados vinculados a la factura. La evidencia está lista para revisar el cierre.';
    } else {
      if (!action) {
        const checkpoint = await db.rpc('management_workflow_checkpoint', {
          p_id: id,
          p_token: token,
          p_balance: proof.balance,
          p_evidence: proof,
        });
        if (checkpoint.error)
          throw new Error('No se pudo guardar el saldo antes de preparar el cobro.');
        const actor = await db.from('users').select('id').eq('id', run.user_id).maybeSingle();
        if (actor.error || !actor.data)
          throw new Error('El responsable ya no pertenece a esta empresa.');
        const agent = await db
          .from('agents')
          .select('id')
          .eq('slug', 'cortex')
          .eq('archived', false)
          .maybeSingle();
        if (agent.error || !agent.data)
          throw new Error('No hay un agente Cortex activo para preparar el cobro.');
        const amount = new Intl.NumberFormat('es-CO', {
          style: 'currency',
          currency: proof.currency,
        }).format(proof.balance);
        const proposal = await proposeAction(db, {
          userId: run.user_id,
          agentId: agent.data.id,
          kind: 'collect_payment',
          toolId: 'gmail.send_message',
          originKind: 'manual',
          originId: run.id,
          clientId: invoice.client_id,
          rationale: `[saldo:${proof.currency}:${proof.balance}] Saldo consultado de la factura ${invoice.doc_number ?? invoice.id}. Verificar el destinatario antes de aprobar.`,
          payload: {
            to: [run.recipient],
            subject: `Seguimiento de factura ${invoice.doc_number ?? ''}`.trim(),
            body: `Buen día,\n\nSegún nuestros registros, la factura ${invoice.doc_number ?? invoice.id} presenta un saldo pendiente de ${amount}.${invoice.due_on ? ` Su fecha de vencimiento es ${invoice.due_on}.` : ''}\n\n¿Nos pueden confirmar la fecha prevista de pago? Si ya realizaron el pago o encuentran alguna diferencia, por favor compártannos el soporte para revisarlo.\n\nGracias.`,
          },
        });
        action = proposal.action;
        actionId = action.id;
        balance = proof.balance;
      }
      if (action.state === 'dismissed')
        throw new Error('El cobro fue descartado. Revisa el motivo en Acciones.');
      if (action.state === 'proposed') {
        if (new Date(action.expires_at).getTime() < Date.now())
          throw new Error(
            'La propuesta venció. Revisa el cobro en Acciones; no se generará otro automáticamente.',
          );
        state = 'approval';
        detail =
          'Cobro preparado con datos de la factura. Falta revisar el destinatario y aprobar el envío en Acciones.';
      } else if (action.execution_status === 'ok') {
        state = 'waiting';
        detail =
          action.outcome === 'replied'
            ? 'El cliente respondió. Revisa la conversación; una respuesta no demuestra que haya pagado.'
            : action.outcome === 'no_reply'
              ? 'El cliente aún no responde. Revisa el siguiente paso; no se enviará otra insistencia sin aprobación.'
              : 'Envío registrado. El proceso revisa el saldo y el estado de respuesta cada 15 minutos.';
      } else
        throw new Error(
          'El envío falló o su resultado no está confirmado. Comprueba el buzón antes de intentar otra acción; este proceso no repetirá el envío.',
        );
    }
  } catch (error) {
    state = 'blocked';
    detail = error instanceof Error ? error.message : 'No se pudo continuar el proceso.';
    evidence = null;
  }
  const settled = await db.rpc('management_workflow_settle', {
    p_id: id,
    p_token: token,
    p_state: state,
    p_detail: detail,
    p_action_id: actionId,
    p_balance: balance,
    p_evidence: evidence,
  });
  if (settled.error)
    throw new ManagementError('No se pudo registrar el avance; actualiza antes de continuar.');
  return one<CollectionWorkflow>(settled.data);
}

/** Fresh source check at the last shared send gate, across web/chat/MCP. */
export async function assertCollectionActionCurrent(
  db: SupabaseClient,
  action: Pick<ActionRow, 'id' | 'origin_kind' | 'origin_id' | 'rationale'>,
) {
  if (action.origin_kind !== 'manual' || !action.origin_id) return;
  // Other manual actions can have free-text origins; they are not workflows.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(action.origin_id))
    return;
  const r = await db
    .from('management_workflows')
    .select(columns)
    .eq('id', action.origin_id)
    .maybeSingle();
  if (r.error) throw new Error('No se pudo comprobar la vigencia del cobro.');
  const run = r.data as CollectionWorkflow | null;
  if (!run) return;
  if (run.state === 'cancelled') throw new Error('El proceso fue detenido.');
  const item = await getManagementCase(db, run.case_id);
  if (['verified', 'cancelled'].includes(item.data.state))
    throw new Error('El asunto está cerrado. No se enviará el cobro.');
  const { proof } = await loadCollectionProof(db, run.invoice_id);
  if (proof.balance <= 0)
    throw new Error(
      'La factura ya está pagada según los registros confirmados. No se enviará el cobro.',
    );
  if (
    run.draft_balance == null ||
    proof.balance !== Number(run.draft_balance) ||
    !action.rationale.startsWith(`[saldo:${proof.currency}:${proof.balance}] `)
  )
    throw new Error(
      'El saldo cambió desde que se preparó el cobro. Revisa el importe antes de preparar una nueva acción.',
    );
}
export async function readWorkflowHistory(db: SupabaseClient, id: string) {
  const r = await db
    .from('management_workflow_events')
    .select('id,state,detail,evidence,created_at')
    .eq('workflow_id', id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (r.error) throw new ManagementError('No se pudo leer el historial del proceso.');
  return r.data ?? [];
}
