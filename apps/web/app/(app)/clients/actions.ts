'use server';

import type { GridRow, GridView } from '@/components/datagrid/types';
import {
  CLIENT_STATUSES,
  type ClientService,
  type ClientStatus,
  type CustomsRole,
  type LinkEntityKind,
} from '@/lib/clients-shape';
import type { ActionResult } from '@/lib/clients/types';
import { deleteGridView, saveGridView } from '@/lib/datagrid/views-store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  addAlias,
  addDomain,
  applyOrPropose,
  confirmClientLinks,
  confirmLink,
  createCommitment,
  describeLinkRun,
  getClient,
  linkClientRecords,
  matchCommitmentsToClients,
  mergeClients,
  normalizeTags,
  registerClient,
  rejectClientLinks,
  rejectLink,
  removeDomain,
  splitAlias,
  updateClient,
  upsertContact,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';

const PATH = '/clients';

/**
 * Errors people can act on.
 *
 * The NIT refusal and the domain refusals are the two messages that matter
 * here: both are written in the module to say what is wrong AND what to do
 * about it, so they are passed through whole rather than replaced with
 * something generic. A "no se pudo guardar" in place of "ese NIT no cuadra con
 * el dígito de verificación" is the difference between a person fixing a typo
 * and a person filing a bug.
 */
function describe(err: unknown, fallback: string): string {
  if (err instanceof NotFoundError) return 'Ese cliente ya no existe.';
  if (err instanceof ValidationError) return err.message;
  if (err instanceof Error && err.name === 'InvalidNitError') return err.message;
  const message = err instanceof Error ? err.message : '';
  return message && message.length < 300 ? message : fallback;
}

export async function createClient(input: {
  name: string;
  legalName?: string;
  nit?: string;
  status?: ClientStatus;
  city?: string;
  department?: string;
  phone?: string;
  website?: string;
  services?: ClientService[];
  customsRole?: CustomsRole | null;
  paymentTermsDays?: number | null;
  notes?: string;
  domains?: string[];
}): Promise<ActionResult> {
  const user = await requireSession();
  if (!input.name?.trim()) return { ok: false, error: 'Ponle el nombre del cliente primero.' };

  try {
    const db = getOrgScopedClient(user.organization.id);
    const { client, created, nearDuplicates } = await registerClient(db, {
      name: input.name,
      legalName: input.legalName ?? null,
      nit: input.nit?.trim() || null,
      status: input.status ?? 'active',
      city: input.city ?? null,
      department: input.department ?? null,
      phone: input.phone ?? null,
      website: input.website ?? null,
      services: input.services,
      customsRole: input.customsRole ?? null,
      paymentTermsDays: input.paymentTermsDays ?? null,
      notes: input.notes ?? null,
      createdBy: user.id,
    });

    // A refused domain must not lose the client that was just created. Each one
    // is reported by name so the person knows which of the three failed.
    const refused: string[] = [];
    for (const domain of input.domains ?? []) {
      if (!domain.trim()) continue;
      try {
        await addDomain(db, { clientId: client.id, domain, userId: user.id });
      } catch (err) {
        refused.push(describe(err, `No se pudo registrar ${domain}.`));
      }
    }

    // Adopt the deadlines that already named this client in free text, and say
    // how many were left alone. A number without its denominator is a claim.
    const adopted = await matchCommitmentsToClients(db, { onlyClientId: client.id });

    const notes: string[] = [];
    if (!created) notes.push('Ya existía, así que lo actualicé en vez de crear una copia.');
    if (nearDuplicates.length > 0) {
      notes.push(
        `Ojo: ya estaba ${nearDuplicates.map((c) => c.name).join(', ')}, que se escribe casi igual.`,
      );
    }
    if (adopted.matched > 0) {
      notes.push(
        `Le colgué ${adopted.matched} vencimiento${adopted.matched === 1 ? '' : 's'} que ya estaba${adopted.matched === 1 ? '' : 'n'} a su nombre.`,
      );
    }
    if (adopted.ambiguous > 0) {
      notes.push(
        `Dejé ${adopted.ambiguous} sin vincular porque emparejaban con más de un cliente.`,
      );
    }
    notes.push(...refused);

    revalidatePath(PATH);
    return { ok: true, clientId: client.id, note: notes.join(' ') || undefined };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo registrar el cliente.') };
  }
}

export async function saveClient(
  id: string,
  patch: {
    status?: ClientStatus;
    city?: string;
    department?: string;
    phone?: string;
    website?: string;
    paymentTermsDays?: number | null;
    customsRole?: CustomsRole | null;
    services?: ClientService[];
    notes?: string;
  },
): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    await updateClient(db, id, patch);
    revalidatePath(`${PATH}/${id}`);
    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo guardar el cambio.') };
  }
}

/**
 * Register a domain.
 *
 * The most consequential button on the whole screen: from here on, everything
 * that arrives from this domain is attributed to this client with no further
 * review. The confirmation copy in the component says exactly that, and the
 * refusals underneath (a public provider, a domain already taken) come back
 * whole.
 */
export async function registerDomain(clientId: string, domain: string): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    await addDomain(db, { clientId, domain, userId: user.id });
    revalidatePath(`${PATH}/${clientId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo registrar el dominio.') };
  }
}

export async function unregisterDomain(clientId: string, id: string): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    await removeDomain(db, id);
    revalidatePath(`${PATH}/${clientId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo quitar el dominio.') };
  }
}

export async function saveContact(input: {
  clientId: string;
  fullName: string;
  email?: string;
  phone?: string;
  roleTitle?: string;
  isPrimary?: boolean;
}): Promise<ActionResult> {
  const user = await requireSession();
  if (!input.fullName.trim()) return { ok: false, error: 'Falta el nombre de la persona.' };
  try {
    const db = getOrgScopedClient(user.organization.id);
    await upsertContact(db, {
      clientId: input.clientId,
      fullName: input.fullName,
      email: input.email ?? null,
      phone: input.phone ?? null,
      roleTitle: input.roleTitle ?? null,
      isPrimary: input.isPrimary ?? false,
      // Typed on this form by this person. There is no control here that lets
      // somebody file their own entry as something Cortex found.
      source: 'manual',
      createdBy: user.id,
    });
    revalidatePath(`${PATH}/${input.clientId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo guardar el contacto.') };
  }
}

/** A person accepts a proposal. The only path from "propuesto" to "vinculado". */
export async function acceptProposal(clientId: string, linkId: string): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    await confirmLink(db, { id: linkId, userId: user.id });
    revalidatePath(`${PATH}/${clientId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo confirmar el vínculo.') };
  }
}

export async function discardProposal(
  clientId: string,
  linkId: string,
  reason?: string,
): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    await rejectLink(db, { id: linkId, userId: user.id, reason: reason ?? null });
    revalidatePath(`${PATH}/${clientId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo descartar la propuesta.') };
  }
}

/**
 * Attach one thing to a client from the card, on this person's say-so.
 *
 * Filed as `manual`, always. The form has no control for "how did you work this
 * out", because a control that let somebody label their own decision as a
 * domain match would empty the word "automático" of meaning everywhere else on
 * the screen.
 */
export async function attach(input: {
  clientId: string;
  kind: LinkEntityKind;
  id?: string;
  ref?: string;
  label?: string;
}): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    const result = await applyOrPropose(db, {
      clientId: input.clientId,
      kind: input.kind,
      id: input.id ?? null,
      ref: input.ref ?? null,
      label: input.label ?? null,
      method: 'manual',
      witnessUserId: user.id,
      createdBy: user.id,
    });
    revalidatePath(`${PATH}/${input.clientId}`);
    if (result.outcome === 'taken_by_another_client') {
      return {
        ok: false,
        error: `Eso ya está vinculado a ${result.heldBy?.name ?? 'otro cliente'}. Quítalo de allá primero: una misma cosa no puede ser de dos clientes.`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo vincular.') };
  }
}

/**
 * Turn an unclaimed counterparty into a client, and adopt its deadlines.
 *
 * The one-click end of the migration story: the screen lists the free-text
 * counterparties nobody answers for, and this is the button next to each one.
 * It reports how many deadlines came across, which is the only honest way to
 * present the number.
 */
export async function claimCounterparty(counterparty: string): Promise<ActionResult> {
  const user = await requireSession();
  const name = counterparty.trim();
  if (!name) return { ok: false, error: 'Falta el nombre.' };
  try {
    const db = getOrgScopedClient(user.organization.id);
    const { client } = await registerClient(db, { name, createdBy: user.id });
    const adopted = await matchCommitmentsToClients(db, { onlyClientId: client.id });
    revalidatePath(PATH);
    return {
      ok: true,
      clientId: client.id,
      note:
        adopted.matched > 0
          ? `${client.name} queda registrado con ${adopted.matched} vencimiento${adopted.matched === 1 ? '' : 's'}.`
          : `${client.name} queda registrado. Falta el NIT y el dominio de su correo.`,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo crear el cliente.') };
  }
}

/** Attach an existing commitment's counterparty to an existing client. */
export async function assignCounterparty(
  counterparty: string,
  clientId: string,
): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    const client = await getClient(db, clientId);
    if (!client) return { ok: false, error: 'Ese cliente ya no existe.' };

    // Only the rows whose counterparty is literally this text, and only the
    // ones nobody has claimed. Deliberately narrow: this button says "these
    // ones", and it must not quietly take anything else with it.
    const { error } = await db
      .from('commitments')
      .update({ client_id: clientId })
      .eq('counterparty', counterparty)
      .is('client_id', null);
    if (error) throw error;

    revalidatePath(PATH);
    revalidatePath(`${PATH}/${clientId}`);
    return { ok: true, clientId, note: `Quedaron a nombre de ${client.name}.` };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo asignar.') };
  }
}

// ---------------------------------------------------------------------------
// 0179: la lista (grilla), la ficha 360 y «Por confirmar»
// ---------------------------------------------------------------------------

const isStatus = (v: unknown): v is ClientStatus =>
  typeof v === 'string' && (CLIENT_STATUSES as readonly string[]).includes(v);

const asTags = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((t): t is string => typeof t === 'string')
    : typeof v === 'string'
      ? v.split(',')
      : [];

/**
 * Una celda editada en la grilla. Sólo tres columnas se pueden tocar desde la
 * lista: responsable, etiquetas y estado. El resto se cambia en la ficha.
 */
export async function editClientCell(rowId: string, key: string, value: unknown): Promise<void> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  if (key === 'responsable') {
    await updateClient(db, rowId, {
      ownerUserId: typeof value === 'string' && value ? value : null,
    });
  } else if (key === 'etiquetas') {
    await updateClient(db, rowId, { tags: normalizeTags(asTags(value)) });
  } else if (key === 'estado') {
    if (!isStatus(value)) throw new Error('Ese estado no existe.');
    await updateClient(db, rowId, { status: value });
  } else {
    throw new Error('Esa columna no se edita desde la lista. Ábrela en la ficha del cliente.');
  }
  revalidatePath(PATH);
}

/**
 * Lo mismo para varios a la vez. Etiquetar SUMA las etiquetas a las que cada
 * cliente ya tenía (etiquetar en lote nunca borra); responsable y estado se
 * reemplazan.
 */
export async function bulkEditClients(
  rowIds: string[],
  key: string,
  value: unknown,
): Promise<void> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const ids = rowIds.slice(0, 500);
  if (key === 'etiquetas') {
    const add = normalizeTags(asTags(value));
    for (const id of ids) {
      const client = await getClient(db, id);
      if (!client) continue;
      await updateClient(db, id, { tags: normalizeTags([...(client.tags ?? []), ...add]) });
    }
  } else {
    for (const id of ids) await editClientCell(id, key, value);
  }
  revalidatePath(PATH);
}

/** Crear desde la fila nueva de la grilla: nombre y, si lo hay, NIT. */
export async function quickCreateClient(values: Record<string, unknown>): Promise<GridRow> {
  const user = await requireSession();
  const name = typeof values.nombre === 'string' ? values.nombre.trim() : '';
  if (name.length < 2) throw new Error('Ponle el nombre del cliente primero.');
  const db = getOrgScopedClient(user.organization.id);
  const nit = typeof values.nit === 'string' && values.nit.trim() ? values.nit : null;
  const { client } = await registerClient(db, { name, nit, createdBy: user.id });
  await matchCommitmentsToClients(db, { onlyClientId: client.id });
  revalidatePath(PATH);
  return {
    id: client.id,
    href: `${PATH}/${client.id}`,
    values: { nombre: client.name, nit: values.nit ?? null, estado: client.status, etiquetas: [] },
  };
}

/** «Buscar vínculos ahora»: el mismo barrido del trabajo diario, para esta empresa. */
export async function runClientLinking(): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    const report = await linkClientRecords(db, { userId: user.id });
    revalidatePath(PATH);
    return { ok: true, note: describeLinkRun(report) };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo revisar los vínculos.') };
  }
}

export async function confirmProposals(
  ids: string[],
  rememberAlias?: string | null,
): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    const out = await confirmClientLinks(db, {
      ids,
      userId: user.id,
      rememberAlias: rememberAlias ?? null,
    });
    revalidatePath(PATH);
    const bits = [`Confirmé ${out.confirmed}.`];
    if (out.competitorsRejected)
      bits.push(
        `Descarté ${out.competitorsRejected} propuesta${out.competitorsRejected === 1 ? '' : 's'} de otros clientes para lo mismo.`,
      );
    if (out.aliasLearned) bits.push('Desde ahora, ese nombre se vincula solo.');
    return { ok: true, note: bits.join(' ') };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo confirmar.') };
  }
}

export async function rejectProposals(ids: string[]): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    const n = await rejectClientLinks(db, {
      ids,
      userId: user.id,
      reason: 'No es de este cliente.',
    });
    revalidatePath(PATH);
    return { ok: true, note: `Descarté ${n}. No se volverán a proponer por la misma razón.` };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo descartar.') };
  }
}

/** Unir dos clientes. El botón ya pidió confirmación; aquí se hace. */
export async function mergeClientsAction(keepId: string, mergeId: string): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    const result = await mergeClients(db, { keepId, mergeId, userId: user.id });
    revalidatePath(PATH);
    revalidatePath(`${PATH}/${keepId}`);
    const total = Object.values(result.moved).reduce((s, n) => s + n, 0);
    return {
      ok: true,
      clientId: keepId,
      note: `Quedaron unidos en ${result.kept.name}: pasé ${total} cosa${total === 1 ? '' : 's'}.`,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudieron unir.') };
  }
}

export async function addAliasAction(clientId: string, alias: string): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    await addAlias(db, { clientId, alias, userId: user.id });
    revalidatePath(`${PATH}/${clientId}`);
    return { ok: true, note: 'Desde ahora, lo que llegue con ese nombre se vincula solo.' };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo guardar el nombre.') };
  }
}

export async function splitAliasAction(clientId: string, aliasId: string): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    const result = await splitAlias(db, { aliasId, userId: user.id });
    revalidatePath(PATH);
    revalidatePath(`${PATH}/${clientId}`);
    return {
      ok: true,
      clientId: result.client.id,
      note: `${result.client.name} quedó como cliente aparte, con ${result.movedLinks + result.movedLedger} cosa${result.movedLinks + result.movedLedger === 1 ? '' : 's'} que habían llegado sólo por ese nombre.`,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo separar.') };
  }
}

export async function addClientNote(clientId: string, body: string): Promise<ActionResult> {
  const user = await requireSession();
  const text = body.trim();
  if (!text) return { ok: false, error: 'Escribe la nota.' };
  const db = getOrgScopedClient(user.organization.id);
  const { error } = await db
    .from('client_notes')
    .insert({ client_id: clientId, body: text.slice(0, 4000), created_by: user.id });
  if (error) return { ok: false, error: describe(error, 'No se pudo guardar la nota.') };
  revalidatePath(`${PATH}/${clientId}`);
  return { ok: true, note: 'Nota guardada en la ficha.' };
}

export async function setClientTags(clientId: string, tags: string[]): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    await updateClient(db, clientId, { tags: normalizeTags(tags) });
    revalidatePath(`${PATH}/${clientId}`);
    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudieron guardar las etiquetas.') };
  }
}

export async function setClientOwner(
  clientId: string,
  ownerUserId: string | null,
): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    await updateClient(db, clientId, { ownerUserId });
    revalidatePath(`${PATH}/${clientId}`);
    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo cambiar el responsable.') };
  }
}

/**
 * Un compromiso con este cliente, desde la ficha. Queda a nombre de quien lo
 * escribió (fuente `manual`) y colgado del cliente.
 */
export async function createClientCommitment(input: {
  clientId: string;
  title: string;
  dueOn: string;
  amountCop?: number | null;
  kind?: 'payment' | 'contract' | 'other';
}): Promise<ActionResult> {
  const user = await requireSession();
  if (!input.title.trim()) return { ok: false, error: 'Escribe qué se comprometió.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueOn)) return { ok: false, error: 'Elige la fecha.' };
  try {
    const db = getOrgScopedClient(user.organization.id);
    const client = await getClient(db, input.clientId);
    if (!client) return { ok: false, error: 'Ese cliente ya no existe.' };
    const row = await createCommitment(db, {
      title: input.title,
      kind: input.kind ?? 'other',
      dueOn: input.dueOn,
      counterparty: client.name,
      amountCop: input.amountCop ?? null,
      ownerUserId: client.owner_user_id ?? user.id,
      source: { kind: 'manual', userId: user.id },
      createdBy: user.id,
    });
    const { error } = await db
      .from('commitments')
      .update({ client_id: client.id })
      .eq('id', row.id);
    if (error) throw error;
    revalidatePath(`${PATH}/${client.id}`);
    return { ok: true, note: 'Compromiso creado; te aviso antes de que venza.' };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo crear el compromiso.') };
  }
}

/** Las vistas guardadas de la lista viven en el scope `clients` (0178). */
export async function saveClientView(view: GridView): Promise<GridView> {
  return saveGridView('clients', view);
}

export async function deleteClientView(id: string): Promise<void> {
  return deleteGridView(id);
}
