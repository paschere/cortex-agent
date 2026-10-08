import type { ToolInvocation } from 'ai';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskRows } from './TaskRows';

const running = {
  state: 'call',
  toolCallId: 'c1',
  toolName: 'gdrive_folder_tree',
  args: {},
} as ToolInvocation;
const done = { ...running, state: 'result', result: { ok: true } } as ToolInvocation;

function html(inv: ToolInvocation, progress?: Map<string, string>) {
  return renderToStaticMarkup(
    createElement(TaskRows, { invocations: [inv], metrics: null, isStreaming: true, progress }),
  );
}

describe('avance en el chip de la herramienta', () => {
  it('muestra la última línea mientras corre, accesible y truncada', () => {
    const out = html(running, new Map([['c1', 'Listé 1.200 archivos en 40 carpetas…']]));
    expect(out).toContain('Listé 1.200 archivos en 40 carpetas…');
    expect(out).toContain('aria-live="polite"');
    expect(out).toContain('truncate');
  });
  it('desaparece al terminar y no aparece para otra llamada', () => {
    expect(html(done, new Map([['c1', 'x']]))).not.toContain('tool-progress');
    expect(html(running, new Map([['otra', 'x']]))).not.toContain('tool-progress');
  });
});
