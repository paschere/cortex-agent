import { pairingRateLimited, redeemCode } from '@/lib/browser-device/auth';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

/**
 * La extensión canjea el código corto que la persona vio en Ajustes por su
 * token de dispositivo. Sin sesión: el código (de un solo uso, 10 minutos) es
 * la credencial. El token se devuelve UNA vez y aquí solo queda su hash.
 */
export async function POST(request: Request) {
  const ip =
    (request.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0]?.trim() ?? 'unknown';
  if (pairingRateLimited(ip)) {
    return NextResponse.json({ error: 'Demasiados intentos. Espera un minuto.' }, { status: 429 });
  }
  const body = (await request.json().catch(() => null)) as {
    code?: unknown;
    deviceName?: unknown;
    extVersion?: unknown;
  } | null;
  if (!body || typeof body.code !== 'string' || body.code.length > 20) {
    return NextResponse.json({ error: 'Falta el código.' }, { status: 400 });
  }
  const deviceName = typeof body.deviceName === 'string' ? body.deviceName : 'Chrome';
  const extVersion = typeof body.extVersion === 'string' ? body.extVersion : undefined;
  const result = await redeemCode(body.code, {
    deviceName,
    ...(extVersion ? { extVersion } : {}),
    userAgent: request.headers.get('user-agent') ?? '',
  });
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 400 });
  return NextResponse.json(
    {
      token: result.token,
      deviceId: result.device.id,
      deviceName: result.device.name,
      expiresAt: result.expiresAt,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
