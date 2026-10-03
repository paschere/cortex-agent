import { z } from 'zod';
import { bogotaToday } from '../commitments/shape';
import { isCompanyManager } from '../directory/store';
import { registerTool } from '../index';
import { resolveSalesDocument } from '../sales/tools';
import { resolvePerson } from '../work/shape';
import { workDirectory } from '../work/store';
import { ALERT_LABEL, type ProjectMetrics } from './math';
import {
  PROJECT_KIND_LABEL,
  PROJECT_STATUSES,
  PROJECT_STATUS_LABEL,
  type ProjectRow,
  type ProjectStatus,
  formatHours,
  formatMoney,
} from './shape';
import {
  ProjectInputError,
  createProject,
  createProjectFromSalesDocument,
  invoiceProject,
  loadProjectDetail,
  loadProjectsOverview,
  logTime,
  requireProject,
  updateProject,
} from './store';

/**
 * LAS HERRAMIENTAS DE PROYECTOS Y ÓRDENES DE SERVICIO (migración 0196).
 *
 *   projects.create         abrir una orden de servicio o un proyecto, libre o
 *                           desde una cotización/pedido de ventas. Confirma.
 *   projects.status         cómo va: avance, horas y costos contra presupuesto,
 *                           alertas. Sólo lee.
 *   projects.log_time       registrar horas. Confirma; cada quien registra las
 *                           suyas, las de otro sólo quien administra o el
 *                           responsable del proyecto.
 *   projects.profitability  margen: ingreso − mano de obra − materiales −
 *                           gastos. Sólo lee.
 *   projects.invoice        el pedido y la factura en BORRADOR en Ventas de un
 *                           hito o de lo que falte. Confirma; emitirla sigue
 *                           siendo sales.invoice_emit.
 */

const PROJECT_REF = z
  .string()
  .min(1)
  .max(200)
  .describe('El proyecto u orden: su código («OS-0007», «PRY-0012»), su id o su nombre.');

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const href = (id: string) => `/proyectos/${id}`;

function metricsOut(p: ProjectRow, m: ProjectMetrics) {
  return {
    id: p.id,
    code: p.code,
    title: p.title,
    kind: PROJECT_KIND_LABEL[p.kind],
    status: PROJECT_STATUS_LABEL[p.status],
    client: p.client_name,
    dueOn: p.due_on,
    progressPct: m.progress.pct,
    tasks: `${m.progress.tasksDone}/${m.progress.tasksTotal}`,
    lateTasks: m.progress.lateTasks,
    hoursUsed: m.hours.used,
    hoursBudget: m.hours.budget,
    costTotal: m.costs.total,
    costBudget: m.costs.budget,
    revenue: m.revenue.amount,
    revenueBasis: m.revenue.basis,
    invoiced: m.revenue.invoiced,
    unbilled: m.revenue.unbilled,
    margin: m.margin.amount,
    marginPct: m.margin.pct,
    alerts: m.alerts.map((a) => `${ALERT_LABEL[a.kind]}: ${a.message}`),
    href: href(p.id),
  };
}

const PROJECT_OUT = z.object({
  id: z.string(),
  code: z.string(),
  title: z.string(),
  kind: z.string(),
  status: z.string(),
  client: z.string().nullable(),
  dueOn: z.string().nullable(),
  progressPct: z.number().nullable(),
  tasks: z.string().describe('Cerradas/total'),
  lateTasks: z.number(),
  hoursUsed: z.number(),
  hoursBudget: z.number().nullable(),
  costTotal: z.number(),
  costBudget: z.number().nullable(),
  revenue: z.number(),
  revenueBasis: z.string().describe('contrato, facturado, horas (cobrables) o ninguno'),
  invoiced: z.number(),
  unbilled: z.number(),
  margin: z.number().nullable(),
  marginPct: z.number().nullable(),
  alerts: z.array(z.string()),
  href: z.string(),
});

function inputError(err: unknown): never {
  if (err instanceof ProjectInputError) throw new Error(err.message);
  throw err;
}

// ---------------------------------------------------------------------------

export const projectsCreate = registerTool({
  id: 'projects.create',
  description:
    'Abrir una orden de servicio o un proyecto para un cliente: libre («abre una orden de servicio para Nexa: mantenimiento de 3 montacargas, 40 horas, presupuesto $6M») o desde una cotización o un pedido de ventas («convierte la COT-12 en proyecto», con una tarea por línea si se pide). Guarda presupuesto de costo y de horas, valor del contrato, fechas, responsable y tareas (que van al registro de trabajo). Pide confirmación.',
  inputSchema: z.object({
    title: z
      .string()
      .max(200)
      .optional()
      .describe('Nombre corto del trabajo. Desde un documento, opcional.'),
    kind: z
      .enum(['orden_servicio', 'proyecto'])
      .optional()
      .describe('Por defecto, orden de servicio.'),
    client: z
      .string()
      .max(200)
      .optional()
      .describe('El cliente, por nombre como está en Clientes.'),
    fromDocument: z
      .string()
      .max(60)
      .optional()
      .describe('Cotización o pedido de ventas de donde sale: «COT-12», «PED-3» o su id.'),
    tasksFromLines: z.boolean().optional().describe('Con fromDocument: una tarea por cada línea.'),
    budgetAmount: z
      .number()
      .min(0)
      .optional()
      .describe('Presupuesto de COSTO (mano de obra + materiales + gastos), en pesos.'),
    budgetHours: z.number().min(0).optional().describe('Horas presupuestadas.'),
    contractAmount: z
      .number()
      .min(0)
      .optional()
      .describe('Lo que se le cobra al cliente, antes de IVA.'),
    startOn: isoDay.optional(),
    dueOn: isoDay.optional().describe('Fecha de entrega.'),
    owner: z
      .string()
      .max(160)
      .optional()
      .describe('Responsable: nombre o correo de alguien del equipo.'),
    tasks: z
      .array(
        z.object({
          title: z.string().min(1).max(300),
          assignee: z.string().max(160).optional(),
          dueOn: isoDay.optional(),
        }),
      )
      .max(50)
      .optional(),
    status: z.enum(['cotizado', 'abierto', 'en_curso']).optional(),
  }),
  outputSchema: z.object({
    id: z.string(),
    code: z.string(),
    title: z.string(),
    status: z.string(),
    created: z.boolean(),
    href: z.string(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const people = await workDirectory(ctx.db);
    const who = (raw: string | undefined): string | null => {
      if (!raw) return null;
      const m = resolvePerson(people, raw);
      if (m.kind === 'found') return m.id;
      if (m.kind === 'ambiguous')
        throw new Error(
          `«${raw}» puede ser ${m.candidates.map((c) => c.label).join(' o ')}. ¿Quién?`,
        );
      throw new Error(`No encontré a «${raw}» en el equipo.`);
    };
    const ownerId = input.owner ? who(input.owner) : ctx.userId;
    const tasks = (input.tasks ?? []).map((t) => ({
      title: t.title,
      assigneeId: who(t.assignee),
      dueOn: t.dueOn ?? null,
    }));
    try {
      if (input.fromDocument) {
        const doc = await resolveSalesDocument(ctx.db, input.fromDocument);
        const { project, created } = await createProjectFromSalesDocument(
          ctx.db,
          doc,
          {
            title: input.title,
            kind: input.kind,
            budgetAmount: input.budgetAmount ?? null,
            budgetHours: input.budgetHours ?? null,
            contractAmount: input.contractAmount,
            startOn: input.startOn ?? null,
            dueOn: input.dueOn ?? null,
            ownerId,
            status: input.status,
            tasks,
            tasksFromLines: input.tasksFromLines,
          },
          { userId: ctx.userId, today },
        );
        return {
          id: project.id,
          code: project.code,
          title: project.title,
          status: PROJECT_STATUS_LABEL[project.status],
          created,
          href: href(project.id),
          guidance: created
            ? `Abrí ${project.code} «${project.title}» desde ${input.fromDocument}${project.contract_amount ? `, por ${formatMoney(Number(project.contract_amount), project.currency)} antes de IVA` : ''}. Las horas se registran con projects.log_time.`
            : `${input.fromDocument} ya tenía proyecto: ${project.code} «${project.title}». No abrí otro.`,
        };
      }
      if (!input.title) throw new Error('Dime el nombre del trabajo.');
      const project = await createProject(
        ctx.db,
        {
          title: input.title,
          kind: input.kind,
          clientName: input.client ?? null,
          budgetAmount: input.budgetAmount ?? null,
          budgetHours: input.budgetHours ?? null,
          contractAmount: input.contractAmount ?? null,
          startOn: input.startOn ?? null,
          dueOn: input.dueOn ?? null,
          ownerId,
          status: input.status,
          origin: 'chat',
          tasks,
        },
        { userId: ctx.userId, today },
      );
      const notes = [`Abrí ${project.code} «${project.title}».`];
      if (input.client && !project.client_id)
        notes.push(`«${input.client}» no está en Clientes; quedó escrito como nombre.`);
      if (project.budget_amount === null)
        notes.push('Sin presupuesto de costo no puedo avisar si se pasa.');
      return {
        id: project.id,
        code: project.code,
        title: project.title,
        status: PROJECT_STATUS_LABEL[project.status],
        created: true,
        href: href(project.id),
        guidance: notes.join(' '),
      };
    } catch (err) {
      inputError(err);
    }
  },
});

// ---------------------------------------------------------------------------

export const projectsStatus = registerTool({
  id: 'projects.status',
  description:
    'Cómo van las órdenes de servicio y proyectos: avance por tareas, horas y costos contra presupuesto, lo facturado y lo que falta, y alertas (sobre el presupuesto, en riesgo, horas excedidas, tareas tarde, atrasado, terminado sin facturar). Con `project`, uno solo con sus tareas abiertas y horas por persona; sin él, la lista. «¿cómo va la OS-0007?», «¿qué proyectos están atrasados?». Sólo lee.',
  inputSchema: z.object({
    project: PROJECT_REF.optional(),
    statuses: z
      .array(z.enum(PROJECT_STATUSES))
      .max(8)
      .optional()
      .describe('Por defecto, los activos y los terminados sin cerrar.'),
    onlyAlerts: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  outputSchema: z.object({
    projects: z.array(PROJECT_OUT),
    detail: z
      .object({
        openTasks: z.array(
          z.object({
            title: z.string(),
            assignee: z.string().nullable(),
            dueAt: z.string().nullable(),
          }),
        ),
        hoursByPerson: z.array(z.object({ person: z.string(), hours: z.number() })),
      })
      .nullable(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    if (input.project) {
      const row = await requireProject(ctx.db, input.project).catch(inputError);
      const d = await loadProjectDetail(ctx.db, row.id, today);
      if (!d) throw new Error('Ese proyecto ya no existe.');
      const byPerson = new Map<string, number>();
      for (const t of d.time) {
        const who = t.userId ? (d.names[t.userId] ?? 'Alguien') : (t.personLabel ?? 'Sin nombre');
        byPerson.set(who, (byPerson.get(who) ?? 0) + t.hours);
      }
      const out = metricsOut(d.project, d.metrics);
      return {
        projects: [out],
        detail: {
          openTasks: d.tasks
            .filter((t) => t.status === 'open')
            .slice(0, 30)
            .map((t) => ({
              title: t.title,
              assignee: t.assigneeId ? (d.names[t.assigneeId] ?? null) : t.assigneeLabel,
              dueAt: t.dueAt,
            })),
          hoursByPerson: [...byPerson.entries()]
            .map(([person, hours]) => ({ person, hours: Math.round(hours * 10) / 10 }))
            .sort((a, b) => b.hours - a.hours),
        },
        guidance: describe(out, d.project.currency),
      };
    }
    const statuses: ProjectStatus[] = input.statuses?.length
      ? [...input.statuses]
      : ['cotizado', 'abierto', 'en_curso', 'en_pausa', 'terminado'];
    const { projects } = await loadProjectsOverview(ctx.db, today, { statuses });
    const list = projects
      .filter((s) => !input.onlyAlerts || s.metrics.alerts.length > 0)
      .slice(0, input.limit ?? 25)
      .map((s) => metricsOut(s.project, s.metrics));
    const alerting = list.filter((p) => p.alerts.length);
    return {
      projects: list,
      detail: null,
      guidance: !projects.length
        ? 'No hay órdenes de servicio ni proyectos abiertos. Se abren con projects.create o en /proyectos.'
        : `${list.length} ${list.length === 1 ? 'proyecto' : 'proyectos'}; ${
            alerting.length
              ? `${alerting.length} con alertas: ${alerting
                  .slice(0, 5)
                  .map((p) => `${p.code} (${p.alerts[0]?.split(':')[0]})`)
                  .join(', ')}`
              : 'ninguno con alertas'
          }. Cada uno tiene su página en /proyectos.`,
    };
  },
});

function describe(p: z.infer<typeof PROJECT_OUT>, currency: string): string {
  const money = (n: number) => formatMoney(n, currency);
  const parts = [
    `${p.code} «${p.title}» está ${p.status.toLowerCase()}`,
    p.progressPct !== null ? `con ${p.progressPct} % de avance (${p.tasks} tareas)` : 'sin tareas',
  ];
  const lines = [`${parts.join(' ')}.`];
  lines.push(
    `Horas: ${formatHours(p.hoursUsed)}${p.hoursBudget !== null ? ` de ${formatHours(p.hoursBudget)}` : ''}. Costo: ${money(p.costTotal)}${p.costBudget !== null ? ` de ${money(p.costBudget)} presupuestados` : ''}.`,
  );
  if (p.margin !== null)
    lines.push(
      `Margen ${p.revenueBasis === 'contrato' ? 'proyectado' : p.revenueBasis === 'horas' ? 'sobre las horas cobrables' : 'sobre lo facturado'}: ${money(p.margin)} (${p.marginPct} %).`,
    );
  if (p.alerts.length) lines.push(`Alertas — ${p.alerts.join(' ')}`);
  return lines.join(' ');
}

// ---------------------------------------------------------------------------

export const projectsLogTime = registerTool({
  id: 'projects.log_time',
  description:
    'Registrar horas trabajadas en una orden de servicio o proyecto: «registra 6 horas hoy en la OS-0007», «Andrés trabajó 4 horas ayer en el montaje de Nexa, no cobrables». Por defecto son de quien habla, de hoy y cobrables; la tarifa de costo y de venta se toma de la persona (o la de la empresa) y queda congelada. Las horas de otra persona sólo las registra quien administra o el responsable del proyecto. Pide confirmación.',
  inputSchema: z.object({
    project: PROJECT_REF,
    hours: z.number().positive().max(24),
    date: isoDay.optional().describe('Día trabajado (AAAA-MM-DD). Por defecto, hoy.'),
    person: z.string().max(160).optional().describe('De quién son, si no son de quien habla.'),
    billable: z.boolean().optional(),
    note: z.string().max(500).optional(),
  }),
  outputSchema: z.object({
    projectCode: z.string(),
    hours: z.number(),
    date: z.string(),
    person: z.string(),
    hoursUsed: z.number(),
    hoursBudget: z.number().nullable(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const project = await requireProject(ctx.db, input.project).catch(inputError);
    if (['cancelado', 'cerrado'].includes(project.status))
      throw new Error(
        `${project.code} está ${PROJECT_STATUS_LABEL[project.status].toLowerCase()}: no recibe horas.`,
      );
    const people = await workDirectory(ctx.db);
    let userId: string = ctx.userId;
    let personName = people.find((p) => p.id === ctx.userId)?.name ?? 'Tú';
    if (input.person) {
      const m = resolvePerson(people, input.person);
      if (m.kind === 'ambiguous')
        throw new Error(
          `«${input.person}» puede ser ${m.candidates.map((c) => c.label).join(' o ')}. ¿Quién?`,
        );
      if (m.kind !== 'found') throw new Error(`No encontré a «${input.person}» en el equipo.`);
      userId = m.id;
      personName = m.label;
    }
    if (
      userId !== ctx.userId &&
      project.owner_id !== ctx.userId &&
      !(await isCompanyManager(ctx.db, ctx.userId))
    )
      throw new Error(
        'Sólo quien administra la empresa o el responsable del proyecto registra horas de otra persona. Cada quien puede registrar las suyas.',
      );
    const entry = await logTime(
      ctx.db,
      {
        projectId: project.id,
        userId,
        workedOn: input.date ?? today,
        hours: input.hours,
        billable: input.billable ?? true,
        note: input.note ?? null,
      },
      { recordedBy: ctx.userId, today },
    ).catch(inputError);
    const d = await loadProjectDetail(ctx.db, project.id, today);
    const used = d?.metrics.hours.used ?? entry.hours;
    const budget = d?.metrics.hours.budget ?? null;
    const notes = [
      `Registré ${formatHours(entry.hours)} de ${personName} el ${entry.workedOn} en ${project.code}${entry.billable ? '' : ' (no cobrables)'}.`,
      `Lleva ${formatHours(used)}${budget !== null ? ` de ${formatHours(budget)}` : ''}.`,
    ];
    if (entry.costRate === 0)
      notes.push(
        'Esa persona no tiene costo por hora: la mano de obra cuenta en cero hasta que se fije en /proyectos › Tarifas.',
      );
    if (budget !== null && used > budget) notes.push('Ya pasó las horas presupuestadas.');
    return {
      projectCode: project.code,
      hours: entry.hours,
      date: entry.workedOn,
      person: personName,
      hoursUsed: used,
      hoursBudget: budget,
      guidance: notes.join(' '),
    };
  },
});

// ---------------------------------------------------------------------------

export const projectsProfitability = registerTool({
  id: 'projects.profitability',
  description:
    '¿Me deja plata? La rentabilidad de una orden de servicio o proyecto (o de todos): ingreso (contrato, lo facturado o las horas cobrables) menos mano de obra (horas × costo por hora), materiales (salidas de inventario y compras), gastos y subcontratos, con el margen en pesos y en %. «¿cuánto nos dejó el proyecto de Nexa?», «¿cuáles proyectos pierden plata?». Sólo lee; nunca calcules el margen a mano.',
  inputSchema: z.object({
    project: PROJECT_REF.optional(),
    scope: z
      .enum(['activos', 'terminados', 'todos'])
      .optional()
      .describe('Sin project: cuáles (por defecto todos menos cancelados).'),
  }),
  outputSchema: z.object({
    projects: z.array(
      z.object({
        code: z.string(),
        title: z.string(),
        client: z.string().nullable(),
        revenue: z.number(),
        revenueBasis: z.string(),
        labor: z.number(),
        materials: z.number(),
        expenses: z.number(),
        subcontracts: z.number(),
        other: z.number(),
        costTotal: z.number(),
        margin: z.number().nullable(),
        marginPct: z.number().nullable(),
        href: z.string(),
      }),
    ),
    totals: z.object({
      revenue: z.number(),
      cost: z.number(),
      margin: z.number(),
      marginPct: z.number().nullable(),
    }),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    let summaries: Array<{ project: ProjectRow; metrics: ProjectMetrics }>;
    if (input.project) {
      const row = await requireProject(ctx.db, input.project).catch(inputError);
      const d = await loadProjectDetail(ctx.db, row.id, today);
      if (!d) throw new Error('Ese proyecto ya no existe.');
      summaries = [{ project: d.project, metrics: d.metrics }];
    } else {
      const statuses: ProjectStatus[] =
        input.scope === 'activos'
          ? ['abierto', 'en_curso', 'en_pausa']
          : input.scope === 'terminados'
            ? ['terminado', 'facturado', 'cerrado']
            : ['cotizado', 'abierto', 'en_curso', 'en_pausa', 'terminado', 'facturado', 'cerrado'];
      summaries = (await loadProjectsOverview(ctx.db, today, { statuses })).projects;
    }
    const rows = summaries.map(({ project: p, metrics: m }) => ({
      code: p.code,
      title: p.title,
      client: p.client_name,
      revenue: m.revenue.amount,
      revenueBasis: m.revenue.basis,
      labor: m.costs.labor,
      materials: m.costs.materials,
      expenses: m.costs.expenses,
      subcontracts: m.costs.subcontracts,
      other: m.costs.other,
      costTotal: m.costs.total,
      margin: m.margin.amount,
      marginPct: m.margin.pct,
      href: href(p.id),
    }));
    const withRevenue = rows.filter((r) => r.revenue > 0);
    const revenue = withRevenue.reduce((s, r) => s + r.revenue, 0);
    const cost = withRevenue.reduce((s, r) => s + r.costTotal, 0);
    const margin = revenue - cost;
    const currency = summaries[0]?.project.currency ?? 'COP';
    const losing = rows.filter((r) => r.margin !== null && r.margin < 0);
    const noBase = rows.filter((r) => r.revenueBasis === 'ninguno');
    const notes: string[] = [];
    if (!rows.length) notes.push('No hay proyectos que medir.');
    else if (rows.length === 1 && rows[0]) {
      const r = rows[0];
      notes.push(
        r.margin === null
          ? `${r.code} no tiene valor de contrato, facturas ni horas cobrables: no hay contra qué medir el margen. Lleva ${formatMoney(r.costTotal, currency)} de costo.`
          : `${r.code}: ingreso ${formatMoney(r.revenue, currency)} (${r.revenueBasis}) − costo ${formatMoney(r.costTotal, currency)} = margen ${formatMoney(r.margin, currency)} (${r.marginPct} %).`,
      );
    } else {
      notes.push(
        `${withRevenue.length} proyectos con ingreso: ${formatMoney(revenue, currency)} − ${formatMoney(cost, currency)} = ${formatMoney(margin, currency)}${revenue > 0 ? ` (${Math.round((margin / revenue) * 1000) / 10} %)` : ''}.`,
      );
      if (losing.length) notes.push(`Pierden plata: ${losing.map((r) => r.code).join(', ')}.`);
      if (noBase.length)
        notes.push(
          `${noBase.length} sin ingreso con qué medir (sin contrato, factura ni horas cobrables).`,
        );
    }
    notes.push('«contrato» es margen proyectado; «facturado», sobre lo ya facturado.');
    return {
      projects: rows,
      totals: {
        revenue,
        cost,
        margin,
        marginPct: revenue > 0 ? Math.round((margin / revenue) * 1000) / 10 : null,
      },
      guidance: notes.join(' '),
    };
  },
});

// ---------------------------------------------------------------------------

export const projectsInvoice = registerTool({
  id: 'projects.invoice',
  description:
    'Facturar una orden de servicio o proyecto: un hito («factura el anticipo de la OS-0007») o lo que falte por facturar. Deja el pedido y la factura electrónica en BORRADOR en Ventas — no la emite: para emitirla ante la DIAN usa después sales.invoice_emit con aprobación. Con un pedido de ventas atado y sin hito, la factura sale de ese pedido. Pide confirmación.',
  inputSchema: z.object({
    project: PROJECT_REF,
    milestone: z.string().max(200).optional().describe('El hito: su nombre o id.'),
    amount: z
      .number()
      .positive()
      .optional()
      .describe('Valor antes de IVA, si no es un hito ni todo lo pendiente.'),
  }),
  outputSchema: z.object({
    projectCode: z.string(),
    invoiceId: z.string(),
    invoiceLabel: z.string(),
    amount: z.number(),
    existed: z.boolean(),
    href: z.string(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const project = await requireProject(ctx.db, input.project).catch(inputError);
    let milestoneId: string | null = null;
    if (input.milestone) {
      const d = await loadProjectDetail(ctx.db, project.id, today);
      const key = input.milestone.trim().toLowerCase();
      const hit =
        d?.milestones.find((m) => m.id === input.milestone) ??
        d?.milestones.find((m) => m.title.toLowerCase() === key) ??
        d?.milestones.find((m) => m.title.toLowerCase().includes(key));
      if (!hit) throw new Error(`${project.code} no tiene un hito «${input.milestone}».`);
      milestoneId = hit.id;
    }
    const out = await invoiceProject(ctx.db, project.id, {
      userId: ctx.userId,
      today,
      milestoneId,
      amount: input.amount ?? null,
    }).catch(inputError);
    if (!milestoneId && !input.amount && project.status === 'terminado') {
      await updateProject(ctx.db, project.id, { status: 'facturado' }, { today }).catch(
        () => undefined,
      );
    }
    return {
      projectCode: project.code,
      ...out,
      href: `/ventas/${out.invoiceId}`,
      guidance: out.existed
        ? `${project.code} ya tenía la factura ${out.invoiceLabel}: no hice otra.`
        : `Dejé la factura ${out.invoiceLabel} en borrador por ${formatMoney(out.amount, project.currency)} antes de IVA. NO está emitida: para emitirla ante la DIAN, usa sales.invoice_emit con «${out.invoiceLabel}».`,
    };
  },
});
