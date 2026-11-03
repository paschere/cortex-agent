import { describe, expect, it } from 'vitest';
import { diagnosticsFor, parseBuildDiagnostics } from './code-log';

describe('parseBuildDiagnostics', () => {
  it('lee la línea simple de esbuild', () => {
    const d = parseBuildDiagnostics('screens/x.tsx:12:5: ERROR: No se pudo resolver "foo"');
    expect(d).toEqual([
      {
        path: 'screens/x.tsx',
        line: 12,
        col: 5,
        severity: 'error',
        message: 'No se pudo resolver "foo"',
      },
    ]);
  });

  it('lee el formato multilínea de formatMessages (mensaje en la línea ✘)', () => {
    const log = [
      '$ npm install (3 s)',
      '✘ [ERROR] Could not resolve "foo"',
      '',
      '    lib/util.ts:4:18:',
      '      4 │ import foo from "foo";',
      '        ╵                 ~~~~~',
      '',
      '▲ [WARNING] Unused thing',
      '',
      '    screens/a.tsx:2:1:',
      '      2 │ x',
    ].join('\n');
    const d = parseBuildDiagnostics(log);
    expect(d).toHaveLength(2);
    expect(d[0]).toMatchObject({
      path: 'lib/util.ts',
      line: 4,
      col: 18,
      severity: 'error',
      message: 'Could not resolve "foo"',
    });
    expect(d[1]).toMatchObject({
      path: 'screens/a.tsx',
      line: 2,
      severity: 'warning',
      message: 'Unused thing',
    });
  });

  it('lee errores de tsc y quita el ./ inicial', () => {
    const d = parseBuildDiagnostics("./screens/b.tsx(7,3): error TS2304: Cannot find name 'q'.");
    expect(d[0]).toMatchObject({
      path: 'screens/b.tsx',
      line: 7,
      col: 3,
      message: "TS2304: Cannot find name 'q'.",
    });
  });

  it('un error sin posición queda como global y no se pinta en un archivo', () => {
    const d = parseBuildDiagnostics('✘ [ERROR] Algo raro pasó\n');
    expect(d).toEqual([
      { path: null, line: 0, col: 0, severity: 'error', message: 'Algo raro pasó' },
    ]);
    expect(diagnosticsFor(d, 'screens/x.tsx')).toEqual([]);
  });

  it('no duplica y filtra por archivo', () => {
    const log = 'screens/x.tsx:1:1: ERROR: a\nscreens/x.tsx:1:1: ERROR: a\nlib/y.ts:3:2: ERROR: b';
    const d = parseBuildDiagnostics(log);
    expect(d).toHaveLength(2);
    expect(diagnosticsFor(d, 'lib/y.ts')).toHaveLength(1);
  });

  it('ignora el texto que no es un error', () => {
    expect(
      parseBuildDiagnostics('$ npm install (2 s)\nlisto\nhttp://localhost:3000/a.js:1:2'),
    ).toEqual([]);
  });
});
