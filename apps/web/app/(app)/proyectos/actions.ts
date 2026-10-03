'use server';

import type { GridRow } from '@/components/datagrid/types';
import type { ActionResult } from '@/lib/projects/shape';
import { projectRow } from '@/lib/projects/views';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  PROJECT_STATUSES,
  type ProjectCostKind,
  type ProjectKind,
  type ProjectPatch,
  type ProjectStatus,
  addProjectCost,
  addProjectMilestone,
  addProjectTask,
  bogotaToday,
  consumeProjectMaterial,
  createProject,
  createProjectFromOpportunity,
  deleteProjectTimeEntry,
  getProjectRow,
  invoiceProject,
  isCompanyManager,
  linkProjectLedgerExpense,
  loadProjectsOverview,
  logProjectTime,
  setLaborRate,
  setProjectTaskStatus,
  updateProject,
  wonOpportunitiesWithoutProject,
} from '@cortex/agent-tools';
import { revalidatePath } from 'next/cache';

/**
 * LO QUE SE HACE DESDE /proyectos (migración 0196).
 *
 * Todo con el handle de la empresa de la sesión, llamando al almacén del
 * paquete (que valida estados, fechas y montos). Quién puede qué:
 *
 *   · registrar SUS horas, cerrar tareas y agregar tareas: cualquiera del equipo;
 *   · cambiar presupuesto, estado, valores, costos, hitos y facturar: quien
 *     administra la empresa o el responsable del proyecto;
 *   · el costo por hora de la gente: sólo quien administra.
 *
 * Facturar deja el pedido y la factura en BORRADOR en Ventas: emitirla sigue
 * siendo la aprobación de siempre en /ventas.
 */

const PATH = '/proyectos';

function fail(err: unknown, fallback: string): ActionResult {
  const message = err instanceof Error ? err.message : '';
  return { ok: false, error: message && message.length < 240 ? message : fallback };
}

async function session() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  return { user, db, today: bogotaToday() };
}

async function canManageProject(
  db: ReturnType<typeof getOrgScopedClient>,
  userId: string,
  projectId: string,
): Promise<boolean> {
  if (await isCompanyManager(db, userId)) return true;
  const p = await getProjectRow(db, projectId);
  return !!p && p.owner_id === userId;
}

function refresh(id?: string) {
  revalidatePath(PATH);
  if (id) revalidatePath(`${PATH}/${id}`);
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n =
    typeof value === 'number'
      ? value
      : Number(
          String(value)
            .replace(/[^\d.,-]/g, '')
            .replace(/\.(?=\d{3}\b)/g, '')
            .replace(',', '.'),
        );
  return Number.isFinite(n) ? n : null;
}

const day = (v: unknown): string | null =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;

function patchFrom(key: string, value: unknown): ProjectPatch {
  switch (key) {
    case 'proyecto':
      return { title: String(value ?? '') };
    case 'cliente':
      return { clientName: value ? String(value) : null };
    case 'tipo':
      return { kind: value === 'proyecto' ? 'proyecto' : 'orden_servicio' };
    case 'estado':
      if (!PROJECT_STATUSES.includes(value as ProjectStatus))
        throw new Error('Ese estado no existe.');
      return { status: value as ProjectStatus };
    case 'horas_pres':
      return { budgetHours: toNumber(value) };
    case 'presupuesto':
      return { budgetAmount: toNumber(value) };
    case 'contrato':
      return { contractAmount: toNumber(value) };
    case 'inicio':
      return { startOn: day(value) };
    case 'entrega':
      return { dueOn: day(value) };
    default:
      throw new Error('Esa columna no se edita aquí.');
  }
}

// ---------------------------------------------------------------------------
// La grilla
// ---------------------------------------------------------------------------

export async function editProjectCell(rowId: string, key: string, value: unknown): Promise<void> {
  const { db, user, today } = await session();
  if (!(await canManageProject(db, user.id, rowId)))
    throw new Error('Sólo quien administra o el responsable cambia este proyecto.');
  await updateProject(db, rowId, patchFrom(key, value), { today });
  refresh(rowId);
}

export async function bulkEditProjects(
  rowIds: string[],
  key: string,
  value: unknown,
): Promise<void> {
  const { db, user, today } = await session();
  const manager = await isCompanyManager(db, user.id);
  for (const id of rowIds.slice(0, 200)) {
    if (!manager && !(await canManageProject(db, user.id, id))) continue;
    await updateProject(db, id, patchFrom(key, value), { today });
  }
  refresh();
}

export async function createProjectRow(values: Record<string, unknown>): Promise<GridRow> {
  const { db, user, today } = await session();
  const created = await createProject(
    db,
    {
      title: String(values.proyecto ?? '').trim(),
      clientName: values.cliente ? String(values.cliente) : null,
      kind: values.tipo === 'proyecto' ? 'proyecto' : 'orden_servicio',
      status: PROJECT_STATUSES.includes(values.estado as ProjectStatus)
        ? (values.estado as ProjectStatus)
        : 'abierto',
      budgetAmount: toNumber(values.presupuesto),
      budgetHours: toNumber(values.horas_pres),
      contractAmount: toNumber(values.contrato),
      startOn: day(values.inicio),
      dueOn: day(values.entrega),
    },
    { userId: user.id, today },
  );
  const { projects } = await loadProjectsOverview(db, today, {});
  const s = projects.find((x) => x.project.id === created.id);
  refresh();
  if (!s) throw new Error('No se pudo leer el proyecto recién creado.');
  return projectRow(s);
}

// ---------------------------------------------------------------------------
// Crear desde el formulario
// ---------------------------------------------------------------------------

export async function createProjectAction(input: {
  title: string;
  kind: ProjectKind;
  client: string | null;
  budgetAmount: number | null;
  budgetHours: number | null;
  contractAmount: number | null;
  startOn: string | null;
  dueOn: string | null;
  ownerId: string | null;
  tasks: string[];
}): Promise<ActionResult> {
  const { db, user, today } = await session();
  try {
    const p = await createProject(
      db,
      {
        title: input.title,
        kind: input.kind,
        clientName: input.client,
        budgetAmount: input.budgetAmount,
        budgetHours: input.budgetHours,
        contractAmount: input.contractAmount,
        startOn: input.startOn,
        dueOn: input.dueOn,
        ownerId: input.ownerId ?? user.id,
        tasks: input.tasks.filter((t) => t.trim()).map((title) => ({ title })),
      },
      { userId: user.id, today },
    );
    refresh();
    return { ok: true, note: `Abrí ${p.code}.`, href: `${PATH}/${p.id}` };
  } catch (err) {
    return fail(err, 'No pude abrir el proyecto.');
  }
}

export async function openFromOpportunity(opportunityId: string): Promise<ActionResult> {
  const { db, user, today } = await session();
  try {
    const won = await wonOpportunitiesWithoutProject(db, { limit: 100 });
    const o = won.find((x) => x.id === opportunityId);
    if (!o) return { ok: false, error: 'Esa oportunidad ya tiene proyecto o no está ganada.' };
    const { project } = await createProjectFromOpportunity(
      db,
      {
        opportunityId: o.id,
        title: o.title,
        clientId: o.clientId,
        clientName: o.clientName,
        amount: o.value,
        ownerId: o.ownerId ?? user.id,
        quoteId: o.quoteId,
      },
      { userId: user.id, today },
    );
    refresh();
    return { ok: true, note: `Abrí ${project.code}.`, href: `${PATH}/${project.id}` };
  } catch (err) {
    return fail(err, 'No pude abrir el proyecto.');
  }
}

// ---------------------------------------------------------------------------
// El detalle
// ---------------------------------------------------------------------------

export async function updateProjectAction(id: string, patch: ProjectPatch): Promise<ActionResult> {
  const { db, user, today } = await session();
  try {
    if (!(await canManageProject(db, user.id, id)))
      return { ok: false, error: 'Sólo quien administra o el responsable cambia este proyecto.' };
    await updateProject(db, id, patch, { today });
    refresh(id);
    return { ok: true, note: 'Guardado.' };
  } catch (err) {
    return fail(err, 'No pude guardar.');
  }
}

export async function addTaskAction(
  projectId: string,
  task: { title: string; assigneeId: string | null; dueOn: string | null },
): Promise<ActionResult> {
  const { db, user } = await session();
  try {
    await addProjectTask(db, projectId, task, user.id);
    refresh(projectId);
    return { ok: true, note: 'Tarea agregada.' };
  } catch (err) {
    return fail(err, 'No pude agregar la tarea.');
  }
}

export async function toggleTaskAction(
  projectId: string,
  taskId: string,
  done: boolean,
): Promise<ActionResult> {
  const { db } = await session();
  try {
    await setProjectTaskStatus(db, taskId, done ? 'done' : 'open');
    refresh(projectId);
    return { ok: true };
  } catch (err) {
    return fail(err, 'No pude cambiar la tarea.');
  }
}

export async function logTimeAction(input: {
  projectId: string;
  hours: number;
  date: string;
  userId: string | null;
  billable: boolean;
  note: string | null;
}): Promise<ActionResult> {
  const { db, user, today } = await session();
  try {
    const who = input.userId ?? user.id;
    if (who !== user.id && !(await canManageProject(db, user.id, input.projectId)))
      return {
        ok: false,
        error: 'Cada quien registra sus horas; las de otro, quien administra o el responsable.',
      };
    const e = await logProjectTime(
      db,
      {
        projectId: input.projectId,
        userId: who,
        workedOn: input.date,
        hours: input.hours,
        billable: input.billable,
        note: input.note,
      },
      { recordedBy: user.id, today },
    );
    refresh(input.projectId);
    revalidatePath('/team/yo');
    return {
      ok: true,
      note: `Registré ${e.hours} h el ${e.workedOn}.${e.costRate === 0 ? ' Sin costo por hora: fíjalo en Costo por hora.' : ''}`,
    };
  } catch (err) {
    return fail(err, 'No pude registrar las horas.');
  }
}

export async function deleteTimeAction(projectId: string, entryId: string): Promise<ActionResult> {
  const { db, user } = await session();
  try {
    await deleteProjectTimeEntry(db, entryId, {
      userId: user.id,
      manager: await canManageProject(db, user.id, projectId),
    });
    refresh(projectId);
    revalidatePath('/team/yo');
    return { ok: true, note: 'Borrado.' };
  } catch (err) {
    return fail(err, 'No pude borrar el registro.');
  }
}

export async function addCostAction(
  projectId: string,
  input: {
    kind: ProjectCostKind;
    description: string;
    amount: number;
    date: string;
    counterparty: string | null;
  },
): Promise<ActionResult> {
  const { db, user } = await session();
  try {
    if (!(await canManageProject(db, user.id, projectId)))
      return { ok: false, error: 'Sólo quien administra o el responsable carga costos.' };
    await addProjectCost(
      db,
      {
        projectId,
        kind: input.kind,
        description: input.description,
        amount: input.amount,
        incurredOn: input.date,
        counterparty: input.counterparty,
      },
      user.id,
    );
    refresh(projectId);
    return { ok: true, note: 'Costo cargado.' };
  } catch (err) {
    return fail(err, 'No pude cargar el costo.');
  }
}

export async function linkLedgerAction(
  projectId: string,
  ledgerMovementId: string,
): Promise<ActionResult> {
  const { db, user } = await session();
  try {
    if (!(await canManageProject(db, user.id, projectId)))
      return { ok: false, error: 'Sólo quien administra o el responsable carga costos.' };
    const c = await linkProjectLedgerExpense(db, projectId, ledgerMovementId, { userId: user.id });
    refresh(projectId);
    return { ok: true, note: `Cargué «${c.description}» al proyecto.` };
  } catch (err) {
    return fail(err, 'No pude atar el gasto.');
  }
}

export async function consumeMaterialAction(
  projectId: string,
  input: { product: string; qty: number },
): Promise<ActionResult> {
  const { db, user, today } = await session();
  try {
    const r = await consumeProjectMaterial(
      db,
      { projectId, product: input.product, qty: input.qty },
      { userId: user.id, today },
    );
    refresh(projectId);
    revalidatePath('/inventario');
    return { ok: true, note: `Salieron ${r.qty} ${r.unit} de ${r.productName} del inventario.` };
  } catch (err) {
    return fail(err, 'No pude sacar el material.');
  }
}

export async function addMilestoneAction(
  projectId: string,
  input: { title: string; amount: number; dueOn: string | null },
): Promise<ActionResult> {
  const { db, user } = await session();
  try {
    if (!(await canManageProject(db, user.id, projectId)))
      return { ok: false, error: 'Sólo quien administra o el responsable agrega hitos.' };
    await addProjectMilestone(db, projectId, input);
    refresh(projectId);
    return { ok: true, note: 'Hito agregado.' };
  } catch (err) {
    return fail(err, 'No pude agregar el hito.');
  }
}

export async function invoiceAction(
  projectId: string,
  milestoneId: string | null,
): Promise<ActionResult> {
  const { db, user, today } = await session();
  try {
    if (!(await canManageProject(db, user.id, projectId)))
      return { ok: false, error: 'Sólo quien administra o el responsable factura.' };
    const r = await invoiceProject(db, projectId, { userId: user.id, today, milestoneId });
    const p = await getProjectRow(db, projectId);
    if (!milestoneId && p?.status === 'terminado')
      await updateProject(db, projectId, { status: 'facturado' }, { today }).catch(() => undefined);
    refresh(projectId);
    revalidatePath('/ventas');
    return {
      ok: true,
      note: r.existed
        ? `Ya existía la factura ${r.invoiceLabel}.`
        : `Factura ${r.invoiceLabel} en borrador: emítela desde Ventas.`,
      href: `/ventas/${r.invoiceId}`,
    };
  } catch (err) {
    return fail(err, 'No pude preparar la factura.');
  }
}

// ---------------------------------------------------------------------------
// Costo por hora
// ---------------------------------------------------------------------------

export async function setRateAction(
  userId: string | null,
  costRate: number,
  billRate: number | null,
): Promise<ActionResult> {
  const { db, user } = await session();
  try {
    if (!(await isCompanyManager(db, user.id)))
      return { ok: false, error: 'Sólo quien administra la empresa fija el costo por hora.' };
    await setLaborRate(db, { userId, costRate, billRate, source: 'manual' }, user.id);
    refresh();
    return { ok: true, note: 'Guardado. Vale para las horas que se registren desde ahora.' };
  } catch (err) {
    return fail(err, 'No pude guardar la tarifa.');
  }
}
