import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * LA PREMISA DE TODO EL PANEL, VIGILADA.
 *
 * ===========================================================================
 * QUÉ SE ESTÁ PROTEGIENDO
 * ===========================================================================
 * El panel existe por UNA razón: hoy, ir a `/payments` desde el chat desmonta
 * `ChatRoot` y con él se van los fotogramas de la pantalla compartida (la
 * migración 0092 no guarda bytes a propósito), la sesión de `getDisplayMedia`,
 * el razonamiento del turno, los avisos de vigilancia, el borrador del
 * compositor y cualquier turno en vuelo. Si abrir el panel desmontara
 * `ChatRoot`, el panel no arreglaría nada: cambiaría una forma de perder la
 * conversación por otra más silenciosa.
 *
 * ===========================================================================
 * POR QUÉ ESTO SE COMPRUEBA LEYENDO EL CÓDIGO Y NO MONTANDO EL ÁRBOL
 * ===========================================================================
 * `vitest.config.ts` corre en `environment: 'node'` y en este repositorio no
 * hay jsdom ni una librería de render de pruebas — y no se va a añadir una
 * dependencia para esto. Así que se comprueba lo que de verdad decide el
 * resultado, que es ESTRUCTURAL y se lee en el archivo:
 *
 *   1. `PanelProvider` recibe `{children}` COMO PROP. Cuando su estado cambia,
 *      React vuelve a renderizarlo y se encuentra con que el elemento
 *      `children` es el mismo objeto que la vez anterior —el proveedor no lo
 *      construye, le llega hecho—, así que descarta ese subárbol sin
 *      recorrerlo. `ChatRoot` ni se vuelve a renderizar.
 *   2. `PanelHost` es HERMANO de `{children}`, nunca su padre. Un padre que
 *      aparece y desaparece cambiaría la posición de `ChatRoot` en el árbol, y
 *      cambiar de posición sí es desmontar.
 *   3. Nada en el camino del panel toca el router. `router.replace()` remonta
 *      la ruta; está documentado en `ChatRoot.tsx`, donde ya se llevó por
 *      delante los mensajes de un stream. La dirección se escribe con
 *      `window.history.replaceState`, igual que allí.
 *
 * La prueba viva de que el mecanismo funciona lleva meses en producción:
 * `CommandMenuProvider` está montado exactamente así y abrir ⌘K estando en
 * `/chat` no ha costado nunca un mensaje.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = fileURLToPath(new URL('../..', import.meta.url));

function read(relative: string): string {
  return readFileSync(join(WEB, relative), 'utf8');
}

/**
 * Sin los comentarios.
 *
 * En este repositorio los archivos EXPLICAN por qué no hacen algo, así que
 * `router.replace()` aparece escrito —en prosa, para contar que remonta la
 * ruta— en los mismos archivos que tienen prohibido llamarlo. Una prueba que
 * mirara el texto entero castigaría precisamente al que se molestó en dejarlo
 * dicho.
 */
function code(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

describe('abrir el panel no puede desmontar ChatRoot', () => {
  const shell = code(read('components/nav/AppShell.tsx'));

  it('el proveedor recibe children como prop, no lo construye', () => {
    const provider = shell.indexOf('<PanelProvider>');
    const children = shell.indexOf('{children}');
    const closing = shell.indexOf('</PanelProvider>');

    expect(provider, 'AppShell debe montar <PanelProvider>').toBeGreaterThan(-1);
    expect(children, 'AppShell debe pasar {children} dentro del proveedor').toBeGreaterThan(
      provider,
    );
    expect(children).toBeLessThan(closing);
  });

  it('PanelHost es hermano de children, no su padre', () => {
    const children = shell.indexOf('{children}');
    const host = shell.indexOf('<PanelHost />');

    expect(host, 'AppShell debe montar <PanelHost />').toBeGreaterThan(-1);
    // Después de `{children}` y en el mismo nivel: si algún día alguien lo
    // envolviera alrededor del contenido, `ChatRoot` cambiaría de posición cada
    // vez que se abriera un panel, que es exactamente desmontarlo.
    expect(host).toBeGreaterThan(children);
    expect(shell).not.toMatch(/<PanelHost[^/]*>[\s\S]*\{children\}/);
  });

  it('el shell sigue siendo componente de servidor', () => {
    // Un `'use client'` aquí arrastraría el rail, los conteos y los dos layouts
    // al cliente, y haría imposible que `countNavSignals` viviera en un solo
    // sitio.
    expect(read('components/nav/AppShell.tsx')).not.toContain("'use client'");
  });
});

describe('el camino del panel no toca el router', () => {
  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) sources(full, out);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  const files = [...sources(HERE), ...sources(join(WEB, 'lib/panels'))];

  it('ni useRouter ni router.push/replace en ninguna pieza del panel', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = code(readFileSync(file, 'utf8'));
      if (/\buseRouter\b/.test(src) || /\brouter\.(push|replace|refresh)\s*\(/.test(src)) {
        offenders.push(file.slice(WEB.length));
      }
    }
    expect(
      offenders,
      'Una navegación del router remonta la ruta y se lleva el turno en vuelo. La ' +
        'dirección del panel se escribe con window.history.replaceState — la misma ' +
        'razón que ChatRoot.tsx documenta en su onResponse.',
    ).toEqual([]);
  });

  it('la dirección se escribe con history.replaceState', () => {
    const host = read('components/panel/PanelHost.tsx');
    expect(host).toContain('window.history.replaceState');
  });
});

describe('el árbol del panel no puede arrastrar node:dns al navegador', () => {
  it('de @cortex/agent-tools sólo entran TIPOS, nunca valores', () => {
    // El mismo espejo que `components/chat/results/registry.test.ts`, por la
    // misma razón: un valor importado desde un componente de cliente compila en
    // local, pasa el typecheck y rompe el build de producción.
    const offenders: string[] = [];
    const clientTrees = [HERE, join(WEB, 'lib/panels')];

    for (const dir of clientTrees) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
        if (/\.test\.tsx?$/.test(entry.name)) continue;
        const src = readFileSync(join(dir, entry.name), 'utf8');
        for (const line of src.split('\n')) {
          if (!line.includes('@cortex/agent-tools')) continue;
          if (!line.trimStart().startsWith('import')) continue;
          if (/^\s*import\s+type\s/.test(line)) continue;
          offenders.push(`${entry.name}: ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
