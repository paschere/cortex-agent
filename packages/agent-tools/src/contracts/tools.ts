import { z } from 'zod';
import { addDays, bogotaToday, isoDate } from '../commitments/shape';
import { isCompanyManager } from '../directory/store';
import { registerTool } from '../index';
import { type CounterpartyLink, draftContract, extractContractObligations } from './ops';
import { findClientByName, findSupplierByName, findUserByEmail } from './resolve';
import {
  CONTRACT_STATUSES,
  CONTRACT_TYPES,
  COUNTERPARTY_KINDS,
  type ContractRow,
  RENEWALS,
  canSeeContract,
  plural,
} from './shape';
import { getContract, listContracts, listObligations, loadContractNames } from './store';
import { BUILTIN_TEMPLATES } from './templates';
import { foldText } from './text';
import {
  type ContractView,
  adaptContract,
  adaptObligation,
  contractViewSchema,
  obligationViewSchema,
} from './view';

/**
 * Las cuatro herramientas de contratos (0195).
 *
 *   contracts.draft                Redactar un borrador desde una plantilla, con
 *                                  lo que se sabe de la contraparte (con
 *                                  confirmación). Lo que no se sabe queda como
 *                                  «[COMPLETAR: …]».
 *   contracts.list                 Lectura: qué contratos hay, cuáles vencen y
 *                                  hasta cuándo se puede avisar que no se renuevan.
 *   contracts.obligations          Lectura: qué hay que cumplir y para cuándo.
 *   contracts.extract_obligations  Leer el contrato firmado y proponer sus
 *                                  obligaciones con su frase (con confirmación).
 *
 * NADA DE ESTO ES ASESORÍA LEGAL, y cada respuesta lo recuerda: el borrador es
 * para revisión de un abogado.
 */

const TEMPLATE_KEYS = BUILTIN_TEMPLATES.map((t) => t.key) as [string, ...string[]];
const LEGAL_REMINDER =
  'Es un BORRADOR para revisión de un abogado, no asesoría legal: dilo así y no afirmes que es válido o suficiente.';

async function viewer(ctx: { db: Parameters<typeof isCompanyManager>[0]; userId: string }) {
  return { userId: ctx.userId, manager: await isCompanyManager(ctx.db, ctx.userId) };
}

// ---------------------------------------------------------------------------
// contracts.draft
// ---------------------------------------------------------------------------

export const contractsDraft = registerTool({
  id: 'contracts.draft',
  description: `Draft a company contract from a template, as a DRAFT FOR A LAWYER TO REVIEW (never legal advice): prestación de servicios, confidencialidad/NDA, laboral a término fijo or indefinido, compraventa, arrendamiento comercial, otrosí, or a termination / no-renewal letter. Fills the company's data from its profile and the counterparty's from the client, supplier or team-member record; everything else comes ONLY from what the person said — never invent a figure, a date, an ID number or a clause fact. Unknown fields stay as «[COMPLETAR: …]» placeholders, which the answer lists. Use \`values\` for template fields the person stated (objeto, cargo, canon…), and \`extraClauses\` only for clauses the person asked for, written from what they said. Templates: ${TEMPLATE_KEYS.join(', ')}. The draft opens at /contratos/<id> where it can be edited, exported to PDF or Word and sent to review. Requires confirmation.`,
  inputSchema: z.object({
    template: z
      .string()
      .min(3)
      .max(60)
      .describe(`One of: ${TEMPLATE_KEYS.join(', ')} (or «propia:<id>» for a company template)`),
    title: z.string().max(200).optional(),
    counterparty: z.object({
      kind: z.enum(COUNTERPARTY_KINDS).describe('cliente | proveedor | empleado | otro'),
      name: z
        .string()
        .max(200)
        .optional()
        .describe('Client or supplier name as it is known, or the person/company name for «otro»'),
      idNumber: z.string().max(40).optional().describe('NIT or cédula, ONLY if the person said it'),
      employeeEmail: z
        .string()
        .email()
        .optional()
        .describe('For «empleado»: the team member email, if they have an account'),
    }),
    values: z
      .record(z.string().max(60), z.string().max(4000))
      .optional()
      .describe(
        'Template fields the person stated, by field key (e.g. objeto, cargo, funciones, salario, canon, inmueble)',
      ),
    startOn: isoDate.optional(),
    endOn: isoDate.optional(),
    valueAmount: z
      .number()
      .min(0)
      .optional()
      .describe('Total value, salary or monthly rent, ONLY if stated'),
    valueNote: z.string().max(300).optional(),
    renewal: z.enum(RENEWALS).optional(),
    noticeDays: z.number().int().min(0).max(730).optional(),
    extraClauses: z
      .array(z.object({ title: z.string().min(3).max(120), text: z.string().min(10).max(4000) }))
      .max(8)
      .optional(),
  }),
  outputSchema: z.object({
    contract: contractViewSchema,
    missing: z.array(z.string()),
    missingRequired: z.array(z.string()),
    legalNotes: z.array(z.string()),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const link: CounterpartyLink = {
      kind: input.counterparty.kind,
      idNumber: input.counterparty.idNumber ?? null,
    };
    const notes: string[] = [];
    if (input.counterparty.kind === 'cliente' && input.counterparty.name) {
      const found = await findClientByName(ctx.db, input.counterparty.name);
      if (found) link.clientId = found.id;
      else {
        link.name = input.counterparty.name;
        notes.push(
          `No encontré un único cliente «${input.counterparty.name}»: quedó escrito sin enlazar.`,
        );
      }
    } else if (input.counterparty.kind === 'proveedor' && input.counterparty.name) {
      const found = await findSupplierByName(ctx.db, input.counterparty.name);
      if (found) link.supplierId = found.id;
      else {
        link.name = input.counterparty.name;
        notes.push(
          `No encontré un único proveedor «${input.counterparty.name}»: quedó escrito sin enlazar.`,
        );
      }
    } else if (input.counterparty.kind === 'empleado' && input.counterparty.employeeEmail) {
      link.employeeUserId = await findUserByEmail(ctx.db, input.counterparty.employeeEmail);
      if (!link.employeeUserId) link.name = input.counterparty.name ?? null;
    } else {
      link.name = input.counterparty.name ?? null;
    }

    const result = await draftContract(
      ctx.db,
      {
        templateKey: input.template,
        title: input.title ?? null,
        link,
        values: input.values ?? {},
        startOn: input.startOn ?? null,
        endOn: input.endOn ?? null,
        valueAmount: input.valueAmount ?? null,
        valueNote: input.valueNote ?? null,
        renewal: input.renewal ?? null,
        noticeDays: input.noticeDays ?? null,
        extraClauses: input.extraClauses ?? [],
        draftedWith: 'chat',
      },
      { userId: ctx.userId, organizationId: ctx.organizationId, today },
    );
    const names = await loadContractNames(ctx.db, [result.row]);
    const contract = adaptContract(result.row, today, names);
    const missing = result.fill.missing;
    return {
      contract,
      missing,
      missingRequired: result.missingRequired,
      legalNotes: result.template.legalNotes,
      guidance: [
        `Borrador creado: «${contract.title}» → ${contract.link} (PDF y Word desde ahí).`,
        missing.length
          ? `Quedaron ${plural(missing.length, 'dato')} por completar: ${missing.slice(0, 12).join('; ')}${missing.length > 12 ? '…' : ''}. Pídelos o deja que la persona los llene en la pantalla.`
          : 'No quedaron datos por completar.',
        ...notes,
        result.template.legalNotes.length
          ? `Antes de firmar, que el abogado mire: ${result.template.legalNotes.join(' ')}`
          : '',
        LEGAL_REMINDER,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
});

// ---------------------------------------------------------------------------
// contracts.list
// ---------------------------------------------------------------------------

export const contractsList = registerTool({
  id: 'contracts.list',
  description:
    'The company contracts: drafts, in review, signed, in force, expired and terminated — with counterparty, value, dates, whether they renew automatically, and the NOTICE DEADLINE (último día para avisar que no se renueva). Answers «¿qué contratos tenemos con Coltrans?», «¿qué contratos vencen este trimestre?», «¿hasta cuándo puedo avisar que no renuevo el arriendo?», «¿qué borradores faltan por firmar?». Labor contracts are only listed to company managers and their owner.',
  inputSchema: z.object({
    status: z.enum(CONTRACT_STATUSES).optional(),
    type: z.enum(CONTRACT_TYPES).optional(),
    counterparty: z
      .string()
      .max(200)
      .optional()
      .describe('Client, supplier or person name to narrow to'),
    endingWithinDays: z
      .number()
      .int()
      .min(0)
      .max(730)
      .optional()
      .describe(
        'Only signed contracts whose term ends or whose notice deadline falls within this many days',
      ),
    limit: z.number().int().min(1).max(100).default(30),
  }),
  outputSchema: z.object({
    today: z.string(),
    contracts: z.array(contractViewSchema),
    hidden: z.number(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const rows = await listContracts(ctx.db, {
      types: input.type ? [input.type] : undefined,
      limit: 500,
    });
    const who = await viewer(ctx);
    const visible = rows.filter((r) => canSeeContract(r, who));
    const names = await loadContractNames(ctx.db, visible);
    const key = input.counterparty ? foldText(input.counterparty) : '';
    let views = visible.map((r) => adaptContract(r, today, names));
    if (input.status) views = views.filter((v) => v.status === input.status);
    if (key)
      views = views.filter((v) => foldText(`${v.counterparty ?? ''} ${v.title}`).includes(key));
    if (input.endingWithinDays !== undefined) {
      const horizon = addDays(today, input.endingWithinDays);
      views = views.filter(
        (v) =>
          (v.noticeDeadline && v.noticeDeadline >= today && v.noticeDeadline <= horizon) ||
          (v.currentEnd &&
            (v.status === 'vigente' || v.status === 'firmado') &&
            v.currentEnd <= horizon),
      );
    }
    views.sort((a, b) =>
      (a.noticeDeadline ?? a.currentEnd ?? '9999').localeCompare(
        b.noticeDeadline ?? b.currentEnd ?? '9999',
      ),
    );
    const shown = views.slice(0, input.limit ?? 30);
    return {
      today,
      contracts: shown,
      hidden: rows.length - visible.length,
      guidance: listGuidance(shown, rows.length - visible.length),
    };
  },
});

function listGuidance(views: ContractView[], hidden: number): string {
  if (views.length === 0) {
    return `No hay contratos con ese filtro.${hidden ? ` (${plural(hidden, 'contrato laboral')} no se muestran a quien no administra la empresa.)` : ''} Se crean en /contratos o con contracts.draft.`;
  }
  const lines = views.slice(0, 20).map((v) => {
    const bits = [
      `«${v.title}» (${v.typeLabel}, ${v.statusLabel})`,
      v.counterparty ? `con ${v.counterparty}` : '',
      v.currentEnd
        ? `termina ${v.currentEnd}${v.renewals ? ` tras ${plural(v.renewals, 'renovación automática', 'renovaciones automáticas')}` : ''}`
        : 'sin fecha de fin',
      v.noticeDeadline
        ? `aviso de no renovación hasta ${v.noticeDeadline} (${v.daysToNotice} días)`
        : '',
      v.placeholders ? `${plural(v.placeholders, 'dato')} por completar` : '',
    ].filter(Boolean);
    return `- ${bits.join('; ')} → ${v.link}`;
  });
  return [
    ...lines,
    'Las fechas de aviso salen de lo que se registró en cada contrato; antes de decidir, confirma el plazo y la forma de aviso en el texto firmado.',
    hidden
      ? `${plural(hidden, 'contrato laboral')} no se muestran a quien no administra la empresa.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// contracts.obligations
// ---------------------------------------------------------------------------

export const contractsObligations = registerTool({
  id: 'contracts.obligations',
  description:
    'What the company and its counterparties must do under their contracts — payments, deliveries, reports, renewals, guarantees — with due dates, who answers for each, the penalty if stated, and the exact sentence of the contract each one was read from. Answers «¿qué tenemos que cumplir este mes por contratos?», «¿qué le debe entregar el proveedor?», «¿cuál es la multa si no pagamos a tiempo?». Proposals not yet confirmed by a person are listed apart and are NOT watched.',
  inputSchema: z.object({
    contractId: z.string().uuid().optional(),
    withinDays: z
      .number()
      .int()
      .min(0)
      .max(365)
      .optional()
      .describe('Only confirmed obligations due within this many days'),
    includeProposals: z.boolean().default(true),
  }),
  outputSchema: z.object({
    obligations: z.array(obligationViewSchema),
    proposals: z.array(obligationViewSchema),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const who = await viewer(ctx);
    const contracts = input.contractId
      ? ([await getContract(ctx.db, input.contractId)].filter(Boolean) as ContractRow[])
      : await listContracts(ctx.db, { limit: 500 });
    const allowed = new Map(contracts.filter((c) => canSeeContract(c, who)).map((c) => [c.id, c]));
    if (input.contractId && !allowed.size) {
      return {
        obligations: [],
        proposals: [],
        guidance: 'Ese contrato no existe o no lo puedes ver.',
      };
    }
    const rows = (
      await listObligations(ctx.db, {
        contractId: input.contractId,
        statuses: ['propuesta', 'confirmada'],
        limit: 500,
      })
    ).filter((o) => allowed.has(o.contract_id));
    const names = await loadContractNames(
      ctx.db,
      rows.map((r) => ({
        owner_user_id: r.owner_user_id,
        client_id: null,
        supplier_id: null,
        employee_user_id: null,
      })),
    );
    const horizon = input.withinDays !== undefined ? addDays(today, input.withinDays) : null;
    const confirmed = rows
      .filter((o) => o.status === 'confirmada')
      .filter((o) => !horizon || (o.due_on !== null && o.due_on <= horizon))
      .map((o) => adaptObligation(o, names.people));
    const proposals =
      input.includeProposals === false
        ? []
        : rows.filter((o) => o.status === 'propuesta').map((o) => adaptObligation(o, names.people));
    const title = (id: string) => allowed.get(id)?.title ?? 'contrato';
    const lines = confirmed
      .slice(0, 25)
      .map(
        (o) =>
          `- ${o.partyLabel}: ${o.description}${o.dueOn ? ` — para el ${o.dueOn}` : o.dueNote ? ` — ${o.dueNote}` : ' — sin fecha'}${o.recurrence !== 'none' ? ` (${o.recurrenceLabel.toLowerCase()})` : ''}${o.owner ? `; responde ${o.owner}` : ''}${o.penalty ? `; sanción: «${o.penalty.slice(0, 160)}»` : ''} [«${title(o.contractId)}»]${o.quote ? ` Dice: «${o.quote.slice(0, 220)}»` : ''}`,
      );
    return {
      obligations: confirmed,
      proposals,
      guidance: [
        confirmed.length ? 'CONFIRMADAS:' : 'No hay obligaciones confirmadas con ese filtro.',
        ...lines,
        proposals.length
          ? `${plural(proposals.length, 'obligación leída espera', 'obligaciones leídas esperan')} que alguien las confirme en /contratos (no se vigilan todavía).`
          : '',
        'Cita la frase del contrato al hablar de una obligación; no interpretes su alcance legal.',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
});

// ---------------------------------------------------------------------------
// contracts.extract_obligations
// ---------------------------------------------------------------------------

export const contractsExtractObligations = registerTool({
  id: 'contracts.extract_obligations',
  description:
    'Read a signed contract (its uploaded copy in Brain Knowledge, or another document id) and PROPOSE its obligations and key dates — who must do what, when, how often, the penalty — each with the exact sentence it came from; nothing is watched until a person confirms each one in /contratos. Also proposes start, end, automatic renewal and notice days, checked against their sentences. Replaces earlier unconfirmed proposals of the same contract. Requires confirmation (it costs a model call).',
  inputSchema: z.object({
    contractId: z.string().uuid(),
    documentId: z
      .string()
      .uuid()
      .optional()
      .describe('Only if the contract text is a different document than its signed copy'),
  }),
  outputSchema: z.object({
    proposed: z.number(),
    rejected: z.array(z.object({ description: z.string(), reason: z.string() })),
    term: z.object({
      startOn: z.string().nullable(),
      endOn: z.string().nullable(),
      renewal: z.string().nullable(),
      noticeDays: z.number().nullable(),
      valueAmount: z.number().nullable(),
    }),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 5 },
  handler: async (input, ctx) => {
    const contract = await getContract(ctx.db, input.contractId);
    if (!contract || !canSeeContract(contract, await viewer(ctx))) {
      throw new Error(
        'Ese contrato no existe o no lo puedes ver. Pide la lista con contracts.list.',
      );
    }
    const result = await extractContractObligations(
      ctx.db,
      { contractId: input.contractId, documentId: input.documentId ?? null },
      { userId: ctx.userId, organizationId: ctx.organizationId },
    );
    const t = result.reading.term;
    return {
      proposed: result.inserted.length,
      rejected: result.reading.rejected,
      term: {
        startOn: t.startOn.value,
        endOn: t.endOn.value,
        renewal: t.renewal.value,
        noticeDays: t.noticeDays.value,
        valueAmount: t.valueAmount.value,
      },
      guidance: result.reading.modelCalled
        ? `Propuse ${plural(result.inserted.length, 'obligación', 'obligaciones')} con su frase${
            result.reading.rejected.length
              ? ` y descarté ${result.reading.rejected.length} sin evidencia en el texto`
              : ''
          }. Ninguna se vigila hasta que alguien la confirme en /contratos/${input.contractId}. ${
            t.endOn.value
              ? `El contrato dice que termina el ${t.endOn.value}`
              : 'No encontré la fecha de terminación escrita'
          }${t.noticeDays.value !== null ? ` y pide ${t.noticeDays.value} días de aviso` : ''}: confírmalo en la pantalla para vigilar el aviso previo.`
        : `No leí nada: ${result.reading.reason ?? 'el documento no tiene texto'}.`,
    };
  },
});
