import { requireSession } from '@/lib/session';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LA VENTANA DEL CHAT SOBRE UNA PESTAÑA VIVA (browser v2)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La tarjeta `BrowserLive` del chat habla SOLO con esta ruta. Es el mismo
 * papel que `/api/browser/session/[id]` cumple para el captcha de un trámite
 * — un proxy que añade quién pregunta y qué se puede mandar — con dos
 * diferencias que son la razón de que sea otra ruta:
 *
 *   EL DUEÑO VIAJA. Las sesiones de navegación libre nacen con dueño (el id
 *   de la organización) y el servicio contesta 404 a quien no lo sea. La ruta
 *   vieja no puede mandarlo sin romper a sus llamadores de handoff, que
 *   miran sesiones sin dueño.
 *
 *   EL VOLANTE EXISTE. Tomar y devolver el control, y entregar un secreto,
 *   son gestos de esta superficie. La vieja no los conoce y no debe: su
 *   contrato dice «cuatro gestos y no crece» y crece aquí, no allá.
 *
 * EL SECRETO, DICHO UNA VEZ. `op: 'secret'` lleva el valor que la persona
 * tecleó en la caja enmascarada. Pasa por aquí porque el navegador jamás tiene
 * el token de servicio, y de aquí sale DIRECTO al servicio: no se loguea (ni
 * en error), no se guarda, no vuelve en la respuesta. Lo único que regresa es
 * cuántos caracteres eran, que es lo que la auditoría puede decir.
 */

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('take') }),
  z.object({ op: z.literal('release') }),
  z.object({ op: z.literal('secret'), value: z.string().min(1).max(500) }),
  z.object({
    op: z.literal('input'),
    kind: z.enum(['click', 'type', 'key', 'scroll', 'back', 'refresh']),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    text: z.string().max(200).optional(),
  }),
]);

function service(): { base: string; token: string } | null {
  const base = process.env.BROWSER_SERVICE_URL?.replace(/\/+$/, '');
  const token = process.env.BROWSER_SERVICE_TOKEN;
  return base && token ? { base, token } : null;
}

async function forward(
  path: string,
  owner: string,
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
        'x-cortex-owner': owner,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    if (response.status === 404) {
      return {
        ok: false,
        status: 410,
        error: 'Esa pestaña ya se cerró. Pídele a Cortex que la abra de nuevo si hace falta.',
      };
    }
    if (!response.ok) {
      // La ruta y el estado. Nunca el body: por aquí pasa un secreto.
      logger.error({ path, status: response.status }, 'browser live request refused');
      return { ok: false, status: 502, error: 'El servicio de navegador rechazó la petición.' };
    }
    return { ok: true, data: await response.json() };
  } catch (err) {
    logger.warn({ err: (err as Error).message, path }, 'browser live request failed');
    return { ok: false, status: 502, error: 'No pude comunicarme con el servicio de navegador.' };
  }
}

/**
 * El estado que la tarjeta polea: quién conduce, qué pide el bot, dónde está
 * la página y — salvo que se pida `?state=1` — la foto de ahora mismo. La
 * foto es lo caro; el modo state existe para que el poleo de control durante
 * el streaming no pague un PNG por segundo que nadie mira.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await ctx.params;
  const owner = session.organization.id;
  const sid = encodeURIComponent(id);

  const control = await forward(`/session/${sid}/control`, owner, {
    method: 'GET',
    timeoutMs: 15_000,
  });
  if (!control.ok) return NextResponse.json({ error: control.error }, { status: control.status });

  if (req.nextUrl.searchParams.get('state') === '1') {
    return NextResponse.json({ control: control.data });
  }

  const view = await forward(`/session/${sid}/view`, owner, { method: 'GET', timeoutMs: 20_000 });
  if (!view.ok) return NextResponse.json({ error: view.error }, { status: view.status });
  return NextResponse.json({ control: control.data, view: view.data });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await ctx.params;
  const owner = session.organization.id;
  const sid = encodeURIComponent(id);

  const parsed = Op.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'No entendí lo que llegó.' }, { status: 400 });
  }
  const input = parsed.data;

  if (input.op === 'take' || input.op === 'release') {
    const result = await forward(`/session/${sid}/control`, owner, {
      method: 'POST',
      body: { op: input.op },
      timeoutMs: 15_000,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ control: result.data });
  }

  if (input.op === 'secret') {
    const result = await forward(`/session/${sid}/secret`, owner, {
      method: 'POST',
      body: { value: input.value },
      timeoutMs: 30_000,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    // El servicio ya contesta solo {ok, length, error?}; se reenvía tal cual.
    return NextResponse.json(result.data);
  }

  const result = await forward(`/session/${sid}/input`, owner, {
    method: 'POST',
    body: { kind: input.kind, x: input.x, y: input.y, text: input.text },
    timeoutMs: 20_000,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}
