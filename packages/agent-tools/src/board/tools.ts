import { ValidationError } from '@cortex/core';
import { z } from 'zod';
import { bogotaToday } from '../commitments/shape';
import { gmailFetch } from '../gmail/client';
import { b64url, buildRfc822 } from '../gmail/draft';
import { registerTool } from '../index';
import { GRAPH_SCOPES, graphFetch } from '../msgraph/client';
import type { ToolContext } from '../types';
import { generateBoardReport } from './generate';
import { type BoardReport, PERIOD_RE, defaultPeriod, periodLabel } from './shape';
import {
  ensureBoardLink,
  getBoardReport,
  getBoardReportByPeriod,
  markBoardSent,
  readBoardSettings,
  requireBoardManager,
} from './store';

/**
 * `board.generate` y `board.send` — el informe para socios (0191).
 *
 * Generar arma el borrador del mes con las cifras de la empresa (confirmación;
 * la rutina del día N lo corre con el permiso que se le dio al prenderla).
 * Mandar SIEMPRE lo aprueba una persona: nunca corre desde una rutina.
 */

const appPath = (r: BoardReport) => `/informe-socios/${r.id}`;

export const boardGenerate = registerTool({
  id: 'board.generate',
  description:
    'Armar el «Informe para socios» de un mes (por defecto, el mes anterior): resumen en 5 líneas, resultados contra presupuesto y año anterior, caja y proyección, cartera y cuentas por pagar, indicadores, hitos y decisiones de Gerencia, riesgos y próximos pasos. Todas las cifras salen de los datos de la empresa (un verificador rechaza números inventados) y la nómina va como total confidencial. Queda como borrador en /informe-socios, con PDF con la marca de la empresa; NO lo manda. Úsala para «arma el informe para los socios», «informe de junta», «informe mensual de gerencia». Sólo quien administra. Requiere confirmación (o la rutina mensual que la persona prendió).',
  inputSchema: z.object({
    period: z
      .string()
      .regex(PERIOD_RE)
      .nullish()
      .describe('Mes a informar, AAAA-MM. Por defecto, el mes anterior.'),
  }),
  outputSchema: z.object({
    id: z.string(),
    period: z.string(),
    href: z.string(),
    fallback: z.boolean(),
    report: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 3 },
  handler: async (input, ctx) => {
    await requireBoardManager(ctx.db, ctx.userId);
    const today = bogotaToday();
    const period = input.period ?? defaultPeriod(today);
    if (period > today.slice(0, 7)) throw new ValidationError('Ese mes todavía no ha empezado.');
    const report = await generateBoardReport(ctx.db, {
      period,
      today,
      userId: ctx.userId,
      organizationId: ctx.organizationId,
    });
    const settings = await readBoardSettings(ctx.db).catch(() => null);
    const recipients = settings?.recipients ?? [];
    return {
      id: report.id,
      period,
      href: appPath(report),
      fallback: report.fallback,
      report: [
        `Armé el informe para socios de ${periodLabel(period)}: [ábrelo aquí](${appPath(report)}) (con PDF).`,
        '',
        ...report.content.summary.map((l) => `- ${l}`),
        '',
        report.fallback
          ? 'El resumen lo armó la plantilla: el modelo no contestó o escribió cifras que no están en los datos.'
          : null,
        report.content.gaps.length ? `No pude leer: ${report.content.gaps.join(', ')}.` : null,
        recipients.length
          ? `Está en borrador. Para mandarlo a ${recipients.join(', ')} hace falta tu aprobación (board.send o el botón «Enviar»).`
          : 'Está en borrador. Para mandarlo, configura los correos de los socios en /informe-socios o dime a quién.',
      ]
        .filter((l) => l !== null)
        .join('\n'),
    };
  },
});

async function sendMail(
  ctx: ToolContext,
  mail: { to: string[]; subject: string; body: string },
): Promise<'gmail' | 'outlook'> {
  const gmail = await ctx.integrations
    .hasScopes('google', ['https://www.googleapis.com/auth/gmail.compose'])
    .catch(() => false);
  if (gmail) {
    await gmailFetch(ctx, '/messages/send', {
      method: 'POST',
      body: JSON.stringify({ raw: b64url(buildRfc822(mail)) }),
    });
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
        },
        saveToSentItems: true,
      }),
    });
    return 'outlook';
  }
  throw new ValidationError(
    'Para mandar el informe por correo conecta Gmail u Outlook en Integraciones. Mientras tanto puedes copiar el enlace desde /informe-socios y mandarlo tú.',
  );
}

export function boardEmail(r: BoardReport, link: string, note?: string | null) {
  const label = periodLabel(r.period);
  const body = [
    'Hola,',
    '',
    note?.trim() || `Les comparto el informe de gestión de ${label} de ${r.content.company}.`,
    '',
    'En resumen:',
    ...r.content.summary.map((l) => `- ${l}`),
    '',
    `El informe completo, con el PDF para descargar:\n${link}`,
    r.visibility === 'contrasena'
      ? '\nEl enlace pide una contraseña: se la comparto por aparte.'
      : '',
    '',
    'Quedo atento a sus comentarios.',
  ].join('\n');
  return { subject: `Informe para socios — ${label} — ${r.content.company}`.slice(0, 300), body };
}

export const boardSend = registerTool({
  id: 'board.send',
  description:
    'Enviar a los SOCIOS o a la junta el «informe para socios» del mes, ya armado (el informe mensual de gerencia, no cualquier correo): sale desde el Gmail u Outlook de la persona con el resumen y un enlace privado al informe con su PDF (con contraseña si así se configuró). Por defecto a las direcciones de socios configuradas en /informe-socios. Requiere confirmación siempre y nunca corre desde una rutina. Sólo quien administra.',
  inputSchema: z.object({
    report: z
      .string()
      .trim()
      .min(7)
      .max(60)
      .nullish()
      .describe('Id del informe o mes AAAA-MM. Por defecto, el del mes anterior.'),
    to: z
      .array(z.string().email())
      .min(1)
      .max(25)
      .nullish()
      .describe('Correos; por defecto, los configurados.'),
    message: z.string().max(2000).nullish().describe('Primer párrafo en lugar del de siempre.'),
  }),
  outputSchema: z.object({
    sentTo: z.array(z.string()),
    via: z.enum(['gmail', 'outlook']),
    link: z.string(),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 4 },
  handler: async (input, ctx) => {
    if (ctx.surface === 'schedule')
      throw new ValidationError(
        'El informe para socios nunca se manda desde una rutina: apruébalo en /informe-socios o en el chat.',
      );
    await requireBoardManager(ctx.db, ctx.userId);
    const ref = input.report ?? defaultPeriod(bogotaToday());
    const report = PERIOD_RE.test(ref)
      ? await getBoardReportByPeriod(ctx.db, ref)
      : await getBoardReport(ctx.db, ref);
    if (!report)
      throw new ValidationError(
        'Ese informe no existe todavía: ármalo primero con board.generate.',
      );
    const to = input.to?.length ? input.to : (await readBoardSettings(ctx.db)).recipients;
    if (!to.length)
      throw new ValidationError(
        'No hay correos configurados para el informe. ¿A quién se lo mando?',
      );
    const { report: linked, url } = await ensureBoardLink(ctx.db, report, { userId: ctx.userId });
    const via = await sendMail(ctx, { to, ...boardEmail(linked, url, input.message) });
    await markBoardSent(ctx.db, report.id, to, { userId: ctx.userId });
    return {
      sentTo: to,
      via,
      link: url,
      markdown: `Listo: mandé el informe de ${periodLabel(report.period)} a ${to.join(', ')} desde tu ${via === 'gmail' ? 'Gmail' : 'Outlook'}, con el enlace${linked.visibility === 'contrasena' ? ' protegido con contraseña (compártela por aparte)' : ''}.`,
    };
  },
});
