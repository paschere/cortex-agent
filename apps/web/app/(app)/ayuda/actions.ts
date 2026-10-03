'use server';

import { randomUUID } from 'node:crypto';
import { sendEmail } from '@/lib/email';
import { type HelpPanelData, type PanelArticle, screenLabel } from '@/lib/help/shape';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  draftProblem,
  sanitizeContext,
  screenshotProblem,
  supportChannel,
  supportEmail,
} from '@/lib/support/shape';
import {
  SUPPORT_BUCKET,
  createTicket,
  markTicketEmail,
  saveHelpFeedback,
} from '@/lib/support/store';
import {
  type HelpArticle,
  helpArticle,
  helpArticles,
  helpArticlesForRoute,
  helpEnabledModules,
  helpExcerpt,
  helpIndex,
  putFile,
  searchHelp,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { revalidatePath } from 'next/cache';

/**
 * Las acciones de la ayuda: el panel «?», la búsqueda del panel, «¿Te sirvió?»
 * y «Escribir a soporte». Todo con la empresa de la sesión clavada.
 */

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function toPanel(article: HelpArticle, query?: string): PanelArticle {
  return {
    slug: article.slug,
    title: article.title,
    summary: article.summary,
    route: article.route,
    ...(query ? { excerpt: helpExcerpt(article, query, 180) } : {}),
  };
}

function cleanPath(path: string): string {
  const p = typeof path === 'string' ? (path.split(/[?#]/)[0] ?? '/') : '/';
  return p.startsWith('/') ? p.slice(0, 300) : '/';
}

/** Lo que muestra el panel «?» al abrirse en una pantalla. */
export async function helpPanelAction(path: string): Promise<HelpPanelData> {
  const user = await requireSession();
  const route = cleanPath(path);
  const enabled = await helpEnabledModules(getOrgScopedClient(user.organization.id));
  let articles = helpArticlesForRoute(helpArticles(), route, { enabled, limit: 5 });
  // Una pantalla sin artículo propio enseña por dónde empezar, no un vacío.
  if (articles.length === 0) {
    articles = helpArticles()
      .filter((a) => a.category === 'empezar')
      .slice(0, 3);
  }
  return {
    screen: screenLabel(route),
    articles: articles.map((a) => toPanel(a)),
    supportEnabled: supportChannel(process.env.SUPPORT_CHANNEL) !== 'off',
  };
}

/** La búsqueda del panel (sin tildes, como la de /ayuda). */
export async function searchHelpAction(query: string): Promise<PanelArticle[]> {
  const user = await requireSession();
  const q = typeof query === 'string' ? query.slice(0, 200) : '';
  if (!q.trim()) return [];
  const enabled = await helpEnabledModules(getOrgScopedClient(user.organization.id));
  return searchHelp(helpIndex(), q, { enabled, limit: 6 }).map((hit) => toPanel(hit.article, q));
}

export type FeedbackResult = { ok: true } | { ok: false; error: string };

export async function helpFeedbackAction(input: {
  slug: string;
  helpful: boolean;
  comment?: string;
  route?: string;
}): Promise<FeedbackResult> {
  const user = await requireSession();
  if (!SLUG.test(input.slug) || !helpArticle(input.slug)) {
    return { ok: false, error: 'Ese artículo no existe.' };
  }
  try {
    await saveHelpFeedback(getOrgScopedClient(user.organization.id), {
      userId: user.id,
      slug: input.slug,
      helpful: input.helpful === true,
      comment: typeof input.comment === 'string' ? input.comment : null,
      route: typeof input.route === 'string' ? cleanPath(input.route) : null,
    });
    return { ok: true };
  } catch (err) {
    logger.warn({ err: String(err) }, 'help feedback failed');
    return { ok: false, error: 'No pude guardar tu voto. Inténtalo otra vez.' };
  }
}

export type TicketResult = { ok: true; number: number } | { ok: false; error: string };

const EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * «Escribir a soporte»: guarda el ticket (siempre primero), luego avisa por
 * correo a SUPPORT_EMAIL. Un correo que no sale no pierde el ticket: queda
 * anotado y la bandeja de soporte lo enseña igual.
 */
export async function createSupportTicketAction(form: FormData): Promise<TicketResult> {
  const user = await requireSession();
  if (supportChannel(process.env.SUPPORT_CHANNEL) === 'off') {
    return { ok: false, error: 'El canal de soporte está apagado en esta instalación.' };
  }
  const subject = String(form.get('subject') ?? '');
  const message = String(form.get('message') ?? '');
  const problem = draftProblem({ subject, message });
  if (problem) return { ok: false, error: problem };

  let context = sanitizeContext({});
  try {
    context = sanitizeContext(JSON.parse(String(form.get('context') ?? '{}')));
  } catch {
    // Un contexto ilegible no impide escribir a soporte.
  }

  const raw = form.get('screenshot');
  const file = raw instanceof File && raw.size > 0 ? raw : null;
  const fileProblem = screenshotProblem(file);
  if (fileProblem) return { ok: false, error: fileProblem };

  const db = getOrgScopedClient(user.organization.id);
  let screenshot: { path: string; type: string } | null = null;
  if (file) {
    const path = `${user.id}/${randomUUID()}.${EXTENSION[file.type] ?? 'png'}`;
    try {
      await putFile(db, {
        bucket: SUPPORT_BUCKET,
        path,
        content: new Uint8Array(await file.arrayBuffer()),
        contentType: file.type,
      });
      screenshot = { path, type: file.type };
    } catch (err) {
      logger.warn({ err: String(err) }, 'support screenshot upload failed');
      return { ok: false, error: 'No pude subir el pantallazo. Envía el mensaje sin él.' };
    }
  }

  let ticket: { id: string; number: number };
  try {
    ticket = await createTicket(db, {
      userId: user.id,
      email: user.email,
      subject,
      message,
      context: { ...context, organizationName: user.organization.name },
      screenshot,
    });
  } catch (err) {
    logger.error({ err: String(err) }, 'support ticket failed');
    return { ok: false, error: 'No pude guardar tu mensaje. Inténtalo otra vez en un momento.' };
  }

  const to = process.env.SUPPORT_EMAIL?.trim();
  const base = (process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? '').replace(
    /\/$/,
    '',
  );
  const outcome = to
    ? await sendEmail({
        to,
        ...supportEmail({
          number: ticket.number,
          subject,
          message,
          organizationName: user.organization.name,
          organizationId: user.organization.id,
          fromEmail: user.email,
          fromName: user.name,
          context,
          hasScreenshot: Boolean(screenshot),
          ...(base ? { inboxUrl: `${base}/overview/soporte` } : {}),
        }),
      }).catch((err) => ({ sent: false, reason: String(err).slice(0, 200) }))
    : { sent: false, reason: 'SUPPORT_EMAIL no configurado' };
  await markTicketEmail(db, ticket.id, outcome).catch(() => undefined);

  revalidatePath('/ayuda/soporte');
  return { ok: true, number: ticket.number };
}
