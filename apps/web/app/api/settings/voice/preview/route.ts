import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { canManageWorkspaceVoice, findWorkspaceVoice } from '@/lib/workspace-voice';
import { consumeToken } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const Body = z.object({ profileId: z.string().uuid() }).strict();
const PREVIEW_TEXT =
  'Listo, revisemos la información de la empresa. Si encuentro algo que necesite tu atención, te lo explico con calma.';

export async function POST(req: NextRequest) {
  const user = await requireSession();
  if (!canManageWorkspaceVoice(user.organization.role))
    return NextResponse.json(
      { error: 'Solo propietarios y administradores pueden probar esta voz.' },
      { status: 403 },
    );
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'Perfil inválido.' }, { status: 400 });
  const voice = await findWorkspaceVoice(user.organization.id, body.data.profileId);
  if (!voice) return NextResponse.json({ error: 'Ese perfil de voz no existe.' }, { status: 404 });
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key)
    return NextResponse.json(
      { error: 'La voz no está configurada en el servidor.' },
      { status: 503 },
    );

  try {
    await consumeToken(
      getOrgScopedClient(user.organization.id),
      user.id,
      'voice.custom.preview',
      5,
    );
  } catch {
    return NextResponse.json(
      { error: 'Espera un momento antes de probar la voz otra vez.' },
      { status: 429 },
    );
  }
  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        voice: { id: voice.providerId },
        input: PREVIEW_TEXT,
        response_format: 'mp3',
        instructions: 'Habla en español colombiano, con tono conversacional y pausas naturales.',
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      return NextResponse.json(
        {
          error:
            response.status === 429
              ? 'OpenAI alcanzó el límite de solicitudes.'
              : 'No se pudo generar la prueba de voz.',
        },
        { status: response.status === 429 ? 429 : 502 },
      );
    return new Response(response.body, {
      headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'La prueba de voz tardó demasiado.' }, { status: 502 });
  }
}
