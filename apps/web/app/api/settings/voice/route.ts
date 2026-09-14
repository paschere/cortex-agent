import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  SPANISH_CONSENT_PHRASE,
  activateWorkspaceVoice,
  canManageWorkspaceVoice,
  listWorkspaceVoices,
  saveWorkspaceVoice,
} from '@/lib/workspace-voice';
import { consumeToken } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 4_400_000;
const SUPPORTED_MIME = new Map([
  ['audio/mpeg', 'audio/mpeg'],
  ['audio/mp3', 'audio/mpeg'],
  ['audio/wav', 'audio/wav'],
  ['audio/x-wav', 'audio/wav'],
  ['audio/ogg', 'audio/ogg'],
  ['application/ogg', 'audio/ogg'],
  ['audio/aac', 'audio/aac'],
  ['audio/flac', 'audio/flac'],
  ['audio/x-flac', 'audio/flac'],
  ['audio/webm', 'audio/webm'],
  ['video/webm', 'audio/webm'],
  ['audio/mp4', 'audio/mp4'],
  ['audio/x-m4a', 'audio/mp4'],
  ['audio/m4a', 'audio/mp4'],
  ['video/mp4', 'audio/mp4'],
]);

const JsonAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('check-access') }).strict(),
  z.object({ action: z.literal('activate'), profileId: z.string().uuid().nullable() }).strict(),
]);

function noStore<T>(body: T, init?: { status?: number }) {
  return NextResponse.json(body, {
    ...init,
    headers: { 'cache-control': 'no-store' },
  });
}

function providerHeaders(): HeadersInit | null {
  const key = process.env.OPENAI_API_KEY?.trim();
  return key ? { Authorization: `Bearer ${key}` } : null;
}

async function providerError(
  response: Response,
): Promise<{ error: string; code: string; status: number }> {
  const text = await response.text().catch(() => '');
  const quota = response.status === 429 || /quota|limit|too many/i.test(text);
  const access = response.status === 401 || response.status === 403 || response.status === 404;
  if (quota)
    return {
      error:
        'OpenAI alcanzó el límite de voces o solicitudes. Revisa la cuota del proyecto antes de reintentar.',
      code: 'provider_quota',
      status: 429,
    };
  if (access)
    return {
      error:
        'No se pudo confirmar el acceso a voces personalizadas. Revisa la elegibilidad y los permisos api.voices del proyecto.',
      code: 'access_not_confirmed',
      status: 403,
    };
  return {
    error: 'OpenAI no pudo procesar la voz. Revisa las grabaciones y vuelve a intentarlo.',
    code: 'provider_error',
    status: 502,
  };
}

async function checkAccess() {
  const headers = providerHeaders();
  if (!headers)
    return {
      access: 'blocked' as const,
      consentPhrase: SPANISH_CONSENT_PHRASE,
      message: 'La clave de OpenAI no está configurada en el servidor.',
    };
  try {
    const response = await fetch('https://api.openai.com/v1/audio/consent_phrases', {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      const failure = await providerError(response);
      return {
        access: 'blocked' as const,
        consentPhrase: SPANISH_CONSENT_PHRASE,
        message: failure.error,
      };
    }
    const body: unknown = await response.json().catch(() => null);
    const records = Array.isArray(body)
      ? body
      : body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
        ? (body as { data: unknown[] }).data
        : [];
    const spanish = records.find((item): item is { language: string; phrase: string } =>
      Boolean(
        item &&
          typeof item === 'object' &&
          (item as { language?: unknown }).language === 'es' &&
          typeof (item as { phrase?: unknown }).phrase === 'string' &&
          (item as { phrase: string }).phrase.trim(),
      ),
    );
    if (!spanish) {
      return {
        access: 'blocked' as const,
        consentPhrase: SPANISH_CONSENT_PHRASE,
        message:
          'OpenAI respondió sin una frase de consentimiento en español. No se habilitó la creación.',
      };
    }
    return {
      access: 'enabled' as const,
      consentPhrase: spanish.phrase.trim(),
      message: 'El proyecto puede leer las frases de consentimiento para voces personalizadas.',
    };
  } catch {
    return {
      access: 'blocked' as const,
      consentPhrase: SPANISH_CONSENT_PHRASE,
      message: 'No se pudo confirmar el acceso a voces personalizadas. Intenta de nuevo.',
    };
  }
}

export async function GET() {
  const user = await requireSession();
  const profiles = await listWorkspaceVoices(user.organization.id);
  return noStore({
    profiles,
    activeId: profiles.find((item) => item.active)?.id ?? null,
    canManage: canManageWorkspaceVoice(user.organization.role),
    configured: Boolean(providerHeaders()),
    consentPhrase: SPANISH_CONSENT_PHRASE,
  });
}

function normalizedAudio(value: FormDataEntryValue | null, field: string): File | string {
  if (!(value instanceof File)) return `Falta la grabación ${field}.`;
  if (!value.size) return `La grabación ${field} está vacía.`;
  if (value.size > MAX_FILE_BYTES) return `La grabación ${field} supera 2 MiB.`;
  const baseType = value.type.toLowerCase().split(';', 1)[0]?.trim() ?? '';
  const normalized = SUPPORTED_MIME.get(baseType);
  if (!normalized) return `El formato de la grabación ${field} no es compatible.`;
  return new File([value], value.name || `${field}.webm`, { type: normalized });
}

async function providerPost(path: string, form: FormData): Promise<Response> {
  const headers = providerHeaders();
  if (!headers) throw new Error('provider-not-configured');
  return fetch(`https://api.openai.com/v1/audio/${path}`, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(45_000),
  });
}

async function providerId(response: Response, prefix: 'voice_' | 'cons_'): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
  return typeof body?.id === 'string' && body.id.startsWith(prefix) && body.id.length <= 200
    ? body.id
    : null;
}

async function createVoice(req: NextRequest, user: Awaited<ReturnType<typeof requireSession>>) {
  const requestBytes = Number(req.headers.get('content-length') || 0);
  if (requestBytes > MAX_REQUEST_BYTES)
    return noStore({ error: 'Las grabaciones superan el tamaño permitido.' }, { status: 413 });

  const access = await checkAccess();
  if (access.access !== 'enabled')
    return noStore(
      { error: access.message, code: 'access_not_confirmed', consentPhrase: access.consentPhrase },
      { status: 403 },
    );

  let data: FormData;
  try {
    data = await req.formData();
  } catch {
    return noStore({ error: 'No se pudieron leer las grabaciones.' }, { status: 400 });
  }
  if (data.get('action') !== 'create')
    return noStore({ error: 'Acción inválida.' }, { status: 400 });
  const name = typeof data.get('name') === 'string' ? String(data.get('name')).trim() : '';
  const language = data.get('language');
  const consentConfirmed = data.get('consentConfirmed');
  if (!name || name.length > 80)
    return noStore({ error: 'El nombre debe tener entre 1 y 80 caracteres.' }, { status: 400 });
  if (language !== 'es')
    return noStore(
      { error: 'Esta configuración requiere una grabación de consentimiento en español.' },
      { status: 400 },
    );
  if (consentConfirmed !== 'true')
    return noStore(
      {
        error:
          'Confirma que ambas grabaciones pertenecen a la misma persona y que autorizó su uso.',
      },
      { status: 400 },
    );
  const consentRecording = normalizedAudio(data.get('consentRecording'), 'de consentimiento');
  if (typeof consentRecording === 'string')
    return noStore(
      { error: consentRecording },
      { status: consentRecording.includes('2 MiB') ? 413 : 400 },
    );
  const sampleRecording = normalizedAudio(data.get('sampleRecording'), 'de muestra');
  if (typeof sampleRecording === 'string')
    return noStore(
      { error: sampleRecording },
      { status: sampleRecording.includes('2 MiB') ? 413 : 400 },
    );

  try {
    await consumeToken(getOrgScopedClient(user.organization.id), user.id, 'voice.custom.create', 1);
  } catch {
    return noStore({ error: 'Espera un minuto antes de crear otra voz.' }, { status: 429 });
  }

  try {
    const consentForm = new FormData();
    consentForm.set('name', `${name} - consentimiento`);
    consentForm.set('language', 'es');
    consentForm.set('recording', consentRecording);
    const consentResponse = await providerPost('voice_consents', consentForm);
    if (!consentResponse.ok) {
      const failure = await providerError(consentResponse);
      return noStore({ error: failure.error, code: failure.code }, { status: failure.status });
    }
    const consentId = await providerId(consentResponse, 'cons_');
    if (!consentId)
      return noStore(
        { error: 'OpenAI no devolvió un consentimiento válido.', code: 'provider_error' },
        { status: 502 },
      );

    const voiceForm = new FormData();
    voiceForm.set('name', name);
    voiceForm.set('audio_sample', sampleRecording);
    voiceForm.set('consent', consentId);
    const voiceResponse = await providerPost('voices', voiceForm);
    if (!voiceResponse.ok) {
      const failure = await providerError(voiceResponse);
      return noStore({ error: failure.error, code: failure.code }, { status: failure.status });
    }
    const voiceId = await providerId(voiceResponse, 'voice_');
    if (!voiceId)
      return noStore(
        { error: 'OpenAI no devolvió una voz válida.', code: 'provider_error' },
        { status: 502 },
      );
    const saved = await saveWorkspaceVoice({
      ownerId: user.organization.id,
      name,
      language: 'es',
      providerVoiceId: voiceId,
      providerConsentId: consentId,
      createdBy: user.id,
      consentConfirmedAt: new Date().toISOString(),
    });
    const profiles = await listWorkspaceVoices(user.organization.id);
    return noStore(
      { profile: saved, activeId: profiles.find((item) => item.active)?.id ?? null },
      { status: 201 },
    );
  } catch {
    return noStore(
      { error: 'No se pudo completar la creación de la voz.', code: 'provider_unavailable' },
      { status: 502 },
    );
  }
}

export async function POST(req: NextRequest) {
  const user = await requireSession();
  if (!canManageWorkspaceVoice(user.organization.role))
    return noStore(
      { error: 'Solo propietarios y administradores pueden cambiar la voz.' },
      { status: 403 },
    );

  if ((req.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data'))
    return createVoice(req, user);

  const parsed = JsonAction.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return noStore({ error: 'Acción inválida.' }, { status: 400 });
  if (parsed.data.action === 'check-access') return noStore(await checkAccess());

  const activeId = await activateWorkspaceVoice(user.organization.id, parsed.data.profileId);
  if (activeId === undefined)
    return noStore({ error: 'Ese perfil de voz no existe.' }, { status: 404 });
  return noStore({ activeId });
}
