import { sendEmail } from '@/lib/email';
import { renderViewDigestEmail } from '@/lib/email-templates/view-digest';
import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  type DigestCandidate,
  computeView,
  digestSchema,
  digestSince,
  digestSlotStart,
  getView,
  listDirectory,
  loadViewSources,
  selectDueDigests,
  summarizeSources,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * EL RESUMEN PERIÓDICO DE UNA VISTA (migración 0203, `spec.digest`).
 *
 * Cada hora en punto: qué vistas con resumen tocan ahora (la lógica de
 * «toca» es pura y está probada: packages/agent-tools/src/views/digest.ts).
 * Cada una corre en su propio evento y en su espacio: lee la vista con la
 * identidad de nadie —sin `viewerId`, así que las fuentes personales y las
 * tablas del Feed de cada persona NO se leen y no pueden viajar en un correo
 * a otras— y manda un correo por destinatario, sólo a quien sigue en el
 * directorio del espacio.
 *
 * Sólo correo: WhatsApp saliente no tiene un módulo común que esta función
 * pueda llamar (el canal vive en su propio servicio), así que no se promete.
 *
 * IDEMPOTENCIA. La franja se reclama con un UPDATE condicionado
 * (`digest_last_sent_at` anterior a la franja): un reintento o dos vueltas
 * del reloj mandan UN resumen. Si el envío falla del todo, la marca vuelve a
 * lo que era y la hora siguiente reintenta.
 */

const DISPATCH_CRON = '0 * * * *';

export const viewDigestDispatchJob: JobHandler = async ({ step }) => {
  // Sin alcance, y sólo aquí: «qué vistas tienen resumen» abarca la
  // instalación. Se leen id, espacio y el digest; cada una viaja en su evento.
  const due = await step.run('find-due', async () => {
    const { data, error } = await getSupabaseServiceClient()
      .from('custom_views')
      .select('id, organization_id, digest:spec->digest, digest_last_sent_at')
      .is('archived_at', null)
      .not('spec->>digest', 'is', null)
      .limit(2000);
    if (error) throw error;
    const rows = (data ?? []) as unknown as Array<{
      id: string;
      organization_id: string;
      digest: unknown;
      digest_last_sent_at: string | null;
    }>;
    const candidates: Array<DigestCandidate & { organizationId: string }> = [];
    for (const r of rows) {
      const parsed = digestSchema.safeParse(r.digest);
      if (!parsed.success) continue;
      candidates.push({
        id: r.id,
        organizationId: r.organization_id,
        digest: parsed.data,
        lastSentAt: r.digest_last_sent_at ? new Date(r.digest_last_sent_at) : null,
      });
    }
    return selectDueDigests(candidates, new Date()).map((c) => ({
      viewId: c.id,
      organizationId: c.organizationId,
    }));
  });
  if (due.length)
    await step.sendEvent(
      'digest-each',
      due.map((d) => ({ name: 'views/digest.run' as const, data: d })),
    );
  return { dispatched: due.length };
};

export const viewDigestDispatch = inngest.createFunction(
  { id: 'view-digest-dispatch' },
  { cron: DISPATCH_CRON },
  async (ctx) => viewDigestDispatchJob(ctx as unknown as JobContext),
);

export const viewDigestRunJob: JobHandler = async ({ event, step }) => {
  const d = event.data as { organizationId?: string; viewId?: string };
  if (!d.organizationId || !d.viewId) return { skipped: 'sin espacio o vista' };
  const { organizationId, viewId } = d;
  return step.run('send', async () => {
    const db = getOrgScopedClient(organizationId);
    const view = await getView(db, viewId);
    const digest = view?.spec.digest;
    if (!view || !digest) return { skipped: 'la vista ya no tiene resumen' };
    const now = new Date();

    const { data: stamp, error: stampError } = await db
      .from('custom_views')
      .select('digest_last_sent_at')
      .eq('id', view.id)
      .maybeSingle();
    if (stampError) throw stampError;
    const previousRaw = (stamp as { digest_last_sent_at: string | null } | null)
      ?.digest_last_sent_at;
    const previous = previousRaw ? new Date(previousRaw) : null;

    // Se reclama la franja ANTES de calcular y mandar: gana un solo intento.
    const slot = digestSlotStart(digest, now);
    if (!slot || now < slot) return { skipped: 'todavía no toca' };
    let claim = db
      .from('custom_views')
      .update({ digest_last_sent_at: now.toISOString() })
      .eq('id', view.id);
    claim = previous
      ? claim.lt('digest_last_sent_at', slot.toISOString())
      : claim.is('digest_last_sent_at', null);
    const { data: won, error: claimError } = await claim.select('id');
    if (claimError) throw claimError;
    if (!won?.length) return { skipped: 'otro intento ya lo mandó' };

    try {
      const people = new Map((await listDirectory(db)).map((p) => [p.id, p]));
      const to = digest.recipients
        .map((id) => people.get(id))
        .filter((p): p is NonNullable<typeof p> => Boolean(p?.email.includes('@')));
      if (!to.length) return { skipped: 'ningún destinatario sigue en el equipo' };

      const sources = await loadViewSources(db, view.spec, { audience: 'team' });
      const computed = computeView(view.spec, sources, now, { audience: 'team' });
      const since = digestSince(digest, previous, now);
      const mail = renderViewDigestEmail({
        viewName: view.name,
        viewSlug: view.slug,
        cadence: digest.cadence,
        sinceLabel: previous
          ? 'el último resumen'
          : digest.cadence === 'weekly'
            ? 'hace una semana'
            : 'ayer',
        metrics: computed.blocks.flatMap((b) =>
          b.type === 'metric'
            ? [
                {
                  title: b.title,
                  display: b.display,
                  goal: b.goal?.display ?? null,
                  status: b.goal?.status
                    ? { good: 'en meta', warn: 'cerca', bad: 'lejos' }[b.goal.status]
                    : null,
                },
              ]
            : [],
        ),
        sources: summarizeSources(sources, since),
      });
      let sent = 0;
      for (const person of to) {
        const out = await sendEmail({
          to: person.email,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        });
        if (out.sent) sent += 1;
      }
      if (sent === 0) throw new Error('ningún correo salió');
      return { sent, recipients: to.length };
    } catch (err) {
      // Nada salió: se suelta la franja para que la hora siguiente reintente.
      await db
        .from('custom_views')
        .update({ digest_last_sent_at: previous ? previous.toISOString() : null })
        .eq('id', view.id);
      logger.warn({ err, organizationId, viewId }, 'view digest failed');
      throw err;
    }
  });
};

export const viewDigestRun = inngest.createFunction(
  { id: 'view-digest-run', concurrency: { limit: 5 } },
  { event: 'views/digest.run' },
  async (ctx) => viewDigestRunJob(ctx as unknown as JobContext),
);
