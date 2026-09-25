import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Los enlaces compartidos se abren sin cookie: el token es la credencial. Si
 * sus rutas salen de PUBLIC_PATHS, el middleware manda al visitante a /login y
 * el enlace deja de servirle justo a quien iba dirigido — que es exactamente
 * como estuvo roto el de los informes desde la 0079 hasta que se escribió esto.
 * Se lee SÓLO el array, igual que meet-bot-public-paths.test.ts.
 */
const WEB = fileURLToPath(new URL('../', import.meta.url));

describe('los enlaces compartidos abren sin sesión', () => {
  it('informes, vistas y sus endpoints públicos están en PUBLIC_PATHS', () => {
    const src = readFileSync(`${WEB}middleware.ts`, 'utf8');
    const block = src.slice(
      src.indexOf('const PUBLIC_PATHS'),
      src.indexOf('interface SessionPayload'),
    );
    expect(block).toContain("'/api/files/report'");
    expect(block).toContain("'/v'");
    expect(block).toContain("'/api/views/public'");
    // Sólo la subcarpeta pública: el resto de /api/views es del equipo.
    expect(block).not.toContain("'/api/views'");
  });
});
