import { ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { bogotaToday } from '../commitments/shape';
import { gmailFetch } from '../gmail/client';
import { registerTool } from '../index';
import { buildMimeWithAttachment, loadPoBrand } from '../inventory/document';
import { GRAPH_SCOPES, graphFetch } from '../msgraph/client';
import type { ToolContext } from '../types';
import {
  CERTIFICATE_KINDS,
  CERTIFICATE_KIND_LABEL,
  type CertificateKind,
  type WithholdingCertificate,
  buildWithholdingCertificates,
  certificateFileName,
  certificatePeriodLabel,
} from './certificates';
import { DRAFT_KINDS, DRAFT_KIND_LABEL, type DraftKind, type DraftTarget } from './draft-shape';
import { buildDraftFromData, readPurchases, readReceivables, readSales } from './draft-sources';
import { issueCertificate, liveDraftFor } from './draft-store';
import { draftMarkdown, draftTargetFor } from './drafts';
import { EXOGENA_FORMATS, buildExogena } from './exogena';
import { renderCertificatePdf } from './pdf';
import { ICA_CITY_LABEL, type TaxObligation } from './shape';
import { listTaxObligations, readTaxProfile } from './store';

/**
 * LAS HERRAMIENTAS DE LOS BORRADORES (migración 0197).
 *
 *   tax.draft           lectura: arma el borrador de una declaración del
 *                       calendario con los datos de la empresa. No guarda nada.
 *   tax.certificates    expide y MANDA por correo los certificados de
 *                       retención a los proveedores. Confirmación.
 *   tax.exogena_export  lectura: el resumen de los formatos 1001/1007/1008/1009
 *                       y dónde descargarlos en CSV.
 *
 * Ninguna presenta nada ante la DIAN: el borrador es para el contador.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** La obligación de un tipo cuyo periodo contiene `month` (o la próxima pendiente). */
export function pickObligation(
  rows: TaxObligation[],
  opts: { kind: DraftKind; month?: string | null; today: string },
): { obligation: TaxObligation; target: DraftTarget } | null {
  const withTarget = rows
    .filter((o) => o.kind === opts.kind)
    .map((o) => ({ obligation: o, target: draftTargetFor(o) }))
    .filter((x): x is { obligation: TaxObligation; target: DraftTarget } => x.target !== null);
  if (opts.month) {
    const day = `${opts.month}-15`;
    return withTarget.find((x) => x.target.period.from <= day && x.target.period.to >= day) ?? null;
  }
  const pending = withTarget
    .filter((x) => x.obligation.status === 'pendiente' && x.obligation.dueDate >= opts.today)
    .sort((a, b) => a.obligation.dueDate.localeCompare(b.obligation.dueDate));
  if (pending[0]) return pending[0];
  // Si no hay nada por venir, el último periodo que ya cerró.
  return (
    withTarget
      .filter((x) => x.target.period.to < opts.today)
      .sort((a, b) => b.target.period.to.localeCompare(a.target.period.to))[0] ?? null
  );
}

export const taxDraft = registerTool({
  id: 'tax.draft',
  description:
    'Armar el BORRADOR de una declaración tributaria del calendario para que el contador la revise: IVA (bimestral/cuatrimestral), retención en la fuente mensual, ICA, anticipo del Régimen Simple o un estimado de renta. Sale de las facturas de venta, las facturas de proveedor, la nómina y el estado de resultados, con el detalle de qué documentos forman cada cifra y la lista de datos que faltan. Úsala para «prepárame el borrador del IVA de septiembre-octubre», «¿cuánta retención vamos a pagar este mes?», «¿cuánto nos daría la renta?». Sólo lectura: no guarda ni presenta nada; el borrador se guarda y se marca en Impuestos.',
  inputSchema: z.object({
    kind: z.enum(DRAFT_KINDS).describe('iva, retencion, ica, simple_anticipo o renta.'),
    month: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .nullish()
      .describe(
        'Un mes dentro del periodo, AAAA-MM («septiembre-octubre de 2026» → 2026-09). Sin él, la próxima que vence.',
      ),
    obligationId: z
      .string()
      .uuid()
      .nullish()
      .describe('El id de la obligación, si lo dio tax.calendar.'),
  }),
  outputSchema: z.object({
    configured: z.boolean(),
    title: z.string().nullable(),
    result: z.number().nullable(),
    missing: z.array(z.string()),
    href: z.string().nullable(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const profile = await readTaxProfile(ctx.db);
    if (!profile)
      return {
        configured: false,
        title: null,
        result: null,
        missing: [],
        href: null,
        markdown:
          'Esta empresa no tiene perfil tributario: sin él no sé qué declara ni cuándo. Se configura en Impuestos o con tax.configure.',
      };
    const year = Number((input.month ?? today).slice(0, 4));
    const rows = await listTaxObligations(ctx.db, {
      kinds: [input.kind],
      from: `${year - 1}-01-01`,
      to: `${year + 1}-12-31`,
      limit: 200,
    });
    const picked = input.obligationId
      ? (() => {
          const o = rows.find((r) => r.id === input.obligationId);
          const t = o ? draftTargetFor(o) : null;
          return o && t ? { obligation: o, target: t } : null;
        })()
      : pickObligation(rows, { kind: input.kind, month: input.month, today });
    if (!picked)
      return {
        configured: true,
        title: null,
        result: null,
        missing: [],
        href: null,
        markdown: `No encuentro una obligación de ${DRAFT_KIND_LABEL[input.kind]} en el calendario para ese periodo. Revisa el perfil tributario (¿la empresa declara ${DRAFT_KIND_LABEL[input.kind]}?) o dime el mes exacto.`,
      };
    const saved = await liveDraftFor(ctx.db, picked.obligation.id);
    const figures =
      saved && saved.status !== 'borrador'
        ? saved.figures
        : await buildDraftFromData(ctx.db, {
            profile,
            target: picked.target,
            today,
            viewerId: ctx.userId,
          });
    const href = `/impuestos/borrador/${picked.obligation.id}`;
    return {
      configured: true,
      title: figures.title,
      result: figures.result.amount,
      missing: figures.missing.map((m) => m.message),
      href,
      markdown: [
        draftMarkdown(figures),
        saved && saved.status !== 'borrador'
          ? `\nEste borrador ya está ${saved.status === 'revisado' ? 'revisado por el contador' : 'presentado'}: son las cifras congeladas de ese momento.`
          : null,
        `\nVence el ${picked.obligation.dueDate}${picked.obligation.needsConfirmation ? ' (fecha por confirmar)' : ''}. El detalle por documento, la descarga y «revisado por el contador» están en ${href}. Cortex no presenta ante la DIAN: lo presenta el contador y lo marca con el formulario.`,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
});

// ---------------------------------------------------------------------------
// Certificados
// ---------------------------------------------------------------------------

async function sendWithAttachment(
  ctx: ToolContext,
  mail: { to: string[]; subject: string; body: string; filename: string; content: Uint8Array },
): Promise<'gmail' | 'outlook'> {
  const gmail = await ctx.integrations
    .hasScopes('google', ['https://www.googleapis.com/auth/gmail.compose'])
    .catch(() => false);
  if (gmail) {
    const raw = Buffer.from(buildMimeWithAttachment(mail), 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    await gmailFetch(ctx, '/messages/send', { method: 'POST', body: JSON.stringify({ raw }) });
    return 'gmail';
  }
  const outlook = await ctx.integrations
    .hasScopes('microsoft', [GRAPH_SCOPES.MAIL_SEND])
    .catch(() => false);
  if (outlook) {
    await graphFetch<void>(ctx, '/me/sendMail', {
      method: 'POST',
      body: JSON.stringify({
        message: {
          subject: mail.subject,
          body: { contentType: 'Text', content: mail.body },
          toRecipients: mail.to.map((address) => ({ emailAddress: { address } })),
          attachments: [
            {
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: mail.filename,
              contentType: 'application/pdf',
              contentBytes: Buffer.from(mail.content).toString('base64'),
            },
          ],
        },
        saveToSentItems: true,
      }),
    });
    return 'outlook';
  }
  throw new ValidationError(
    'Para mandar los certificados por correo conecta Gmail u Outlook en Integraciones. Mientras tanto se descargan en PDF desde Impuestos › Certificados.',
  );
}

async function supplierEmails(db: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const { data, error } = await db.from('suppliers').select('id, email').in('id', ids);
  if (error) throw error;
  for (const r of (data ?? []) as Array<{ id: string; email: string | null }>)
    if (r.email?.includes('@')) out.set(r.id, r.email.trim());
  return out;
}

/** Los certificados de un año/periodo, con los datos de hoy. */
export async function loadCertificates(
  db: SupabaseClient,
  opts: { kind: CertificateKind; year: number; period?: number | null },
): Promise<WithholdingCertificate[]> {
  const from =
    opts.kind === 'iva' && opts.period
      ? `${opts.year}-${pad(opts.period * 2 - 1)}-01`
      : `${opts.year}-01-01`;
  const to =
    opts.kind === 'iva' && opts.period
      ? new Date(Date.UTC(opts.year, opts.period * 2, 0)).toISOString().slice(0, 10)
      : `${opts.year}-12-31`;
  const { purchases } = await readPurchases(db, from, to);
  return buildWithholdingCertificates(purchases, opts);
}

/** La entrada que la persona aprueba: el periodo y a quién. */
export const taxCertificatesInput = z.object({
  kind: z
    .enum(CERTIFICATE_KINDS)
    .describe('renta (retención en la fuente), iva (reteIVA) o ica (reteICA).'),
  year: z.number().int().min(2020).max(2100),
  period: z.number().int().min(1).max(6).nullish().describe('Bimestre 1–6, sólo para IVA.'),
  suppliers: z
    .array(z.string().min(1).max(200))
    .max(50)
    .nullish()
    .describe(
      'NIT o nombre de los proveedores. Sin esto: todos los que tienen retención y correo.',
    ),
  to: z.string().email().nullish().describe('Otro correo, sólo si es UN proveedor.'),
});

export const taxCertificates = registerTool({
  id: 'tax.certificates',
  description:
    'Expedir y MANDAR por correo (desde el Gmail u Outlook de quien confirma) los certificados de retención —en la fuente (renta), de IVA o de ICA— a los proveedores, en PDF con la marca de la empresa, calculados con las facturas de proveedor del año o el bimestre. Úsala para «mándales a los proveedores el certificado de retención de 2025». Antes de mandar, confirma con el contador que las retenciones estén declaradas. Requiere confirmación.',
  inputSchema: taxCertificatesInput,
  outputSchema: z.object({
    sent: z.number(),
    skipped: z.array(z.string()),
    via: z.enum(['gmail', 'outlook']).nullable(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 3 },
  handler: async (input, ctx) => {
    const period = input.kind === 'iva' ? (input.period ?? null) : null;
    let certs = await loadCertificates(ctx.db, { kind: input.kind, year: input.year, period });
    if (input.suppliers?.length) {
      const wanted = input.suppliers.map((s) => s.trim().toLowerCase());
      certs = certs.filter(
        (c) =>
          (c.supplierNit && wanted.includes(c.supplierNit)) ||
          wanted.some((w) => c.supplierName.toLowerCase().includes(w)),
      );
    }
    if (!certs.length)
      return {
        sent: 0,
        skipped: [],
        via: null,
        guidance: `No hay retenciones de ${CERTIFICATE_KIND_LABEL[input.kind].toLowerCase()} anotadas en las facturas de proveedor de ${certificatePeriodLabel({ year: input.year, period })}${input.suppliers?.length ? ' para esos proveedores' : ''}.`,
      };
    if (input.to && certs.length > 1)
      throw new ValidationError('Un correo distinto sólo sirve para un proveedor: dime cuál.');
    const [brand, profile, emails] = await Promise.all([
      loadPoBrand(ctx.db, ctx.organizationId),
      readTaxProfile(ctx.db),
      supplierEmails(ctx.db, certs.map((c) => c.supplierId).filter(Boolean) as string[]),
    ]);
    const today = bogotaToday();
    const city =
      profile?.icaCity && profile.icaCity !== 'otra' ? ICA_CITY_LABEL[profile.icaCity] : null;
    let sent = 0;
    let via: 'gmail' | 'outlook' | null = null;
    const skipped: string[] = [];
    for (const c of certs) {
      const to = input.to ?? (c.supplierId ? emails.get(c.supplierId) : undefined);
      if (!to) {
        skipped.push(`${c.supplierName} (sin correo)`);
        continue;
      }
      const pdf = renderCertificatePdf(c, brand, {
        nit: profile?.nit ?? null,
        dv: profile?.dv ?? null,
        city,
        issuedOn: today,
      });
      via = await sendWithAttachment(ctx, {
        to: [to],
        subject:
          `Certificado de ${CERTIFICATE_KIND_LABEL[c.kind].toLowerCase()} — ${certificatePeriodLabel(c)} — ${brand.name}`.slice(
            0,
            250,
          ),
        body: [
          'Buen día:',
          '',
          `Adjuntamos el certificado de ${CERTIFICATE_KIND_LABEL[c.kind].toLowerCase()} correspondiente a ${certificatePeriodLabel(c).toLowerCase()}: ${c.sources.length} factura${c.sources.length === 1 ? '' : 's'}, valor retenido $ ${Math.round(c.withheld).toLocaleString('es-CO')}.`,
          '',
          'Cualquier diferencia, por favor respóndanos este correo.',
          '',
          'Cordialmente,',
          brand.name,
        ].join('\n'),
        filename: certificateFileName(c),
        content: pdf,
      });
      await issueCertificate(ctx.db, c, { userId: ctx.userId, sentTo: to });
      sent += 1;
    }
    return {
      sent,
      skipped,
      via,
      guidance: [
        sent
          ? `Mandé ${sent} certificado${sent === 1 ? '' : 's'} de ${CERTIFICATE_KIND_LABEL[input.kind].toLowerCase()} (${certificatePeriodLabel({ year: input.year, period })}) desde tu ${via === 'gmail' ? 'Gmail' : 'Outlook'}.`
          : 'No mandé ninguno.',
        skipped.length
          ? `Sin mandar: ${skipped.join(', ')}. Ponles el correo en Por pagar › Proveedores o descárgalos en Impuestos › Certificados.`
          : null,
      ]
        .filter(Boolean)
        .join(' '),
    };
  },
});

// ---------------------------------------------------------------------------
// Exógena
// ---------------------------------------------------------------------------

export const taxExogenaExport = registerTool({
  id: 'tax.exogena_export',
  description:
    'Preparar la información exógena de un año gravable: resumen por formato (1001 pagos y retenciones a terceros, 1007 ingresos por cliente, 1008 cuentas por cobrar y 1009 cuentas por pagar al 31 de diciembre) armado con las facturas de venta, las de proveedor y el libro, con lo que falta (terceros sin NIT…). Los CSV para el contador se descargan en Impuestos › Exógena. Las versiones de los formatos y los códigos de concepto van por confirmar. Sólo lectura.',
  inputSchema: z.object({
    year: z
      .number()
      .int()
      .min(2020)
      .max(2100)
      .describe('El año gravable (el anterior al de la presentación).'),
  }),
  outputSchema: z.object({
    formats: z.array(
      z.object({
        code: z.enum(EXOGENA_FORMATS),
        title: z.string(),
        rows: z.number(),
        total: z.number(),
        missing: z.array(z.string()),
      }),
    ),
    href: z.string(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    const y = input.year;
    const [purchases, sales, receivables] = await Promise.all([
      readPurchases(ctx.db, `${y - 3}-01-01`, `${y}-12-31`),
      readSales(ctx.db, `${y}-01-01`, `${y}-12-31`),
      readReceivables(ctx.db, `${y}-12-31`),
    ]);
    const formats = buildExogena({
      year: y,
      purchases: purchases.purchases,
      sales: sales.sales,
      receivables,
    });
    const href = `/impuestos/exogena?anio=${y}`;
    return {
      formats: formats.map((f) => ({
        code: f.code,
        title: f.title,
        rows: f.rows.length,
        total: f.total,
        missing: f.missing,
      })),
      href,
      guidance: [
        `Exógena del año gravable ${y} (borrador para el contador; versiones de formato por confirmar):`,
        ...formats.map(
          (f) =>
            `- ${f.code} ${f.title}: ${f.rows.length} tercero${f.rows.length === 1 ? '' : 's'}, $ ${Math.round(f.total).toLocaleString('es-CO')}${f.missing.length ? ` · ${f.missing.join(' ')}` : ''}`,
        ),
        `Los CSV están en ${href}. Cortex no genera el XML ni lo sube a la DIAN.`,
      ].join('\n'),
    };
  },
});
