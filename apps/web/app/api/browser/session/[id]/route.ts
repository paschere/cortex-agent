import { requireSession } from '@/lib/session';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
/** A resumed errand is a whole errand: the same ceiling the run route uses. */
export const maxDuration = 300;

/**
 * LOOKING AT, AND TOUCHING, A TAB THAT STOPPED AT A CAPTCHA.
 *
 * ===========================================================================
 * WHY THIS EXISTS AT ALL
 * ===========================================================================
 * A trámite replays with no model in the loop, which is what makes it cost
 * nothing — and it means the moment a portal asks «¿eres un robot?» there is
 * nobody to answer. Before this, that was the end of the errand: the tab was
 * destroyed and the run filed as failed. Reopening later is no help, because
 * the challenge is waiting again on the other side.
 *
 * So the browser service keeps the tab alive for a few minutes and this route
 * is the window onto it. A person sees the page, ticks the box, and the errand
 * carries on from the step it stopped at — in the same session, with the same
 * cookies, which is the only place the unlock is worth anything.
 *
 * ===========================================================================
 * A PROXY, AND NOTHING MORE
 * ===========================================================================
 * The browser service is reachable only with a shared secret that lives in this
 * process's environment. It is not on the public internet and the browser must
 * never hold that token, so every gesture goes through here. What this route
 * adds on top of forwarding is the two things the service cannot know:
 *
 *   WHO IS ASKING. `requireSession` first, always. A session id is a short
 *   random string and nothing else; without this check, guessing one would let
 *   anybody drive somebody else's half-authenticated portal tab.
 *
 *   WHAT MAY BE SENT. The union below is closed on purpose. This endpoint
 *   exists so somebody can tick a checkbox, not so a client can script a
 *   browser: no `goto`, no evaluate, no file upload. If this ever needs a fifth
 *   gesture, that is a decision to make deliberately, here, in one place.
 *
 * WHAT IT CANNOT DO, AND WHY THAT IS FINE. It cannot tell one workspace's
 * session from another's, because the service does not record who opened one.
 * The mitigation is that the ids are unguessable and last minutes, not that the
 * check exists — stated plainly rather than implied, so nobody later reads a
 * tenancy guarantee into this file that is not here. Making it a real one means
 * the service keeping an owner per session, and that is worth doing the day
 * these tabs live longer than a coffee.
 */

const Input = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('click'),
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  z.object({ kind: z.literal('type'), text: z.string().max(200) }),
  z.object({ kind: z.literal('key'), text: z.string().max(40) }),
  z.object({ kind: z.literal('scroll'), y: z.number().finite() }),
  z.object({
    kind: z.literal('continue'),
    // `nullish`, not `optional`: the client keeps this in state and sends it as
    // whatever it holds, and `JSON.stringify` serialises a null.
    fromIndex: z.number().int().min(0).max(500).nullish(),
  }),
]);

function service(): { base: string; token: string } | null {
  const base = process.env.BROWSER_SERVICE_URL?.replace(/\/+$/, '');
  const token = process.env.BROWSER_SERVICE_TOKEN;
  return base && token ? { base, token } : null;
}

async function forward(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs: number },
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
  const cfg = service();
  if (!cfg) {
    return { ok: false, status: 503, error: 'El servicio de navegador no está configurado.' };
  }
  try {
    const response = await fetch(`${cfg.base}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    if (response.status === 404) {
      // The commonest ending, and not an error: nobody came in time and the
      // sweeper took the tab. Said in words somebody can act on.
      return {
        ok: false,
        status: 410,
        error: 'La sesión ya se cerró. Vuelve a ejecutar el trámite para intentarlo de nuevo.',
      };
    }
    if (!response.ok) {
      // The path only — never the token, never the body.
      logger.error({ path, status: response.status }, 'browser session request refused');
      return { ok: false, status: 502, error: 'El servicio de navegador rechazó la petición.' };
    }
    return { ok: true, data: await response.json() };
  } catch (err) {
    logger.warn({ err, path }, 'browser session request failed');
    return { ok: false, status: 502, error: 'No pude comunicarme con el servicio de navegador.' };
  }
}

/** A picture of the tab as it is right now. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await ctx.params;
  const result = await forward(`/session/${encodeURIComponent(id)}/view`, {
    method: 'GET',
    timeoutMs: 20_000,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.data);
}

/** One gesture, or «ya está, sigue tú». */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await ctx.params;

  const parsed = Input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'No entendí lo que llegó.' }, { status: 400 });
  }
  const input = parsed.data;
  const session = encodeURIComponent(id);

  if (input.kind === 'continue') {
    const result = await forward(`/session/${session}/continue`, {
      method: 'POST',
      body: { fromIndex: input.fromIndex ?? 0 },
      // The whole rest of the errand runs inside this call.
      timeoutMs: 200_000,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result.data);
  }

  const result = await forward(`/session/${session}/input`, {
    method: 'POST',
    body: input,
    timeoutMs: 20_000,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}
