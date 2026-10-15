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

describe('un paso que falló', () => {
  const failedInv = {
    ...running,
    toolName: 'payroll_payroll_stats',
    state: 'result',
    result: {
      __error: true,
      tool: 'payroll.payroll_stats',
      message: 'Payroll integration not configured (PAYROLL_API_URL missing) [INTEGRATION_ERROR]',
    },
  } as ToolInvocation;
  it('dice una frase en español y deja el JSON plegado', () => {
    const out = html(failedInv);
    expect(out).toContain('todavía no está conectado');
    expect(out).toContain('tool-error-summary');
    expect(out).not.toMatch(/<pre[^>]*>[^<]*PAYROLL_API_URL/);
  });
});
