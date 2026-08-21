import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * El bot de reuniones no es un navegador: no trae cookie de sesión. Si estas
 * rutas salen de PUBLIC_PATHS, el middleware redirige el POST a /login y
 * Cortex se queda mudo en la llamada (HTTP 405). Se lee SÓLO el array, no el
 * archivo entero: el comentario que documenta el fallo nombra las rutas, y
 * una prueba contra el archivo entero no mordería al quitarlas de la lista.
 */
const WEB = fileURLToPath(new URL('../', import.meta.url));

describe('el bot de reuniones puede llamar a Cortex sin cookie', () => {
  it('voice-answer y archive están en PUBLIC_PATHS', () => {
    const src = readFileSync(`${WEB}middleware.ts`, 'utf8');
    const block = src.slice(src.indexOf('const PUBLIC_PATHS'), src.indexOf('interface SessionPayload'));
    expect(block).toContain("'/api/meetings/live/voice-answer'");
    expect(block).toContain("'/api/meetings/live/archive'");
  });
});
