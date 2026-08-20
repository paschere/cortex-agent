import type { BrowserContext, Page } from 'patchright';

/**
 * INICIAR SESIÓN DE GOOGLE, SOLO SI HACE FALTA.
 *
 * ===========================================================================
 * POR QUÉ EXISTE
 * ===========================================================================
 * F0 demostró que a Meet solo se entra autenticado. En un Mac de desarrollo el
 * perfil se logueó a mano (login.ts). En Railway no hay nadie frente a la
 * pantalla, así que el bot se loguea solo con las credenciales de la cuenta
 * dedicada del workspace (MEET_GOOGLE_EMAIL / MEET_GOOGLE_PASSWORD), UNA vez —
 * después la sesión vive en el perfil del volumen y esto no vuelve a correr.
 *
 * ===========================================================================
 * LO QUE PUEDE SALIR MAL, DICHO
 * ===========================================================================
 * Google a veces bloquea el login automatizado con «este navegador no es
 * seguro» o pide 2FA. La cuenta del bot debe ser una cuenta DEDICADA sin 2FA
 * para que esto funcione desatendido; si Google planta un desafío, esta
 * función lo detecta y lo reporta claro en vez de colgarse, y el operador
 * termina el login una vez a mano (login.ts contra el mismo volumen). No es
 * una carrera contra Google: es un login normal que casi siempre pasa con una
 * cuenta limpia, y un mensaje honesto cuando no.
 */

export type LoginResult = { ok: true; already: boolean } | { ok: false; reason: string };

/** ¿El perfil ya tiene sesión de Google? Se mira sin tocar Meet. */
async function isSignedIn(page: Page): Promise<boolean> {
  await page
    .goto('https://myaccount.google.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
    .catch(() => undefined);
  // Si sigue en accounts.google.com/signin, no hay sesión.
  return !/accounts\.google\.com\/(signin|v3\/signin|ServiceLogin)/.test(page.url());
}

export async function ensureGoogleSession(
  context: BrowserContext,
  page: Page,
  creds: { email?: string; password?: string },
): Promise<LoginResult> {
  if (await isSignedIn(page)) return { ok: true, already: true };

  if (!creds.email || !creds.password) {
    return {
      ok: false,
      reason:
        'El perfil no tiene sesión de Google y no hay MEET_GOOGLE_EMAIL/PASSWORD para iniciarla. Loguea la cuenta una vez (login.ts) o pon las credenciales.',
    };
  }

  await page.goto('https://accounts.google.com/ServiceLogin', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });

  // Email → Siguiente.
  const emailField = page.locator('input[type="email"]').first();
  if (!(await emailField.isVisible().catch(() => false))) {
    return { ok: false, reason: 'No apareció el campo de correo de Google.' };
  }
  await emailField.fill(creds.email);
  await page
    .getByRole('button', { name: /Siguiente|Next/i })
    .first()
    .click()
    .catch(() => undefined);
  await page.waitForTimeout(2_500);

  // Password → Siguiente.
  const pwField = page.locator('input[type="password"]').first();
  if (
    !(await pwField
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false))
  ) {
    return { ok: false, reason: 'No apareció el campo de contraseña (¿Google pidió otra cosa?).' };
  }
  await pwField.fill(creds.password);
  await page
    .getByRole('button', { name: /Siguiente|Next/i })
    .first()
    .click()
    .catch(() => undefined);
  await page.waitForTimeout(4_000);

  // ¿Desafío? (2FA, «confirma que eres tú», «este navegador no es seguro»).
  const challenge = await page
    .getByText(
      /verifica que eres tú|verify it.s you|2-Step|no es seguro|couldn.t sign you in|isn.t secure/i,
    )
    .first()
    .isVisible()
    .catch(() => false);
  if (challenge) {
    return {
      ok: false,
      reason:
        'Google pidió una verificación adicional (2FA o «navegador no seguro»). Usa una cuenta dedicada sin 2FA, o loguéala una vez a mano contra este volumen.',
    };
  }

  if (await isSignedIn(page)) return { ok: true, already: false };
  return { ok: false, reason: 'El login no terminó de confirmarse.' };
}
