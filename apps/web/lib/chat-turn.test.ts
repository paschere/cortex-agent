import { describe, expect, it } from 'vitest';
import {
  buildActivityRows,
  buildSourceRows,
  conversationMarkdown,
  markdownFileName,
} from './chat-turn';
import { riskOfTool, waitingAge } from './risk';

const inv = (toolName: string, args: unknown, result: unknown = { ok: true }) => ({
  toolCallId: `${toolName}-1`,
  toolName,
  state: 'result',
  args,
  result,
});

describe('riskOfTool', () => {
  it('rotula por lo que la acción hace', () => {
    expect(riskOfTool('gmail.send_email').level).toBe('alto');
    expect(riskOfTool('payments.create').level).toBe('alto');
    expect(riskOfTool('trackers.upsert').level).toBe('medio');
    expect(riskOfTool('sheets.read_range').level).toBe('bajo');
  });
});

describe('waitingAge', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  it('dice la edad en palabras', () => {
    expect(waitingAge('2026-10-08T12:00:00Z', now)).toBe('espera hace 2 días');
    expect(waitingAge('2026-10-10T09:00:00Z', now)).toBe('espera hace 3 horas');
    expect(waitingAge(null, now)).toBeNull();
  });
});

describe('buildActivityRows', () => {
  it('une duración y aprobación por orden y herramienta', () => {
    const rows = buildActivityRows(
      [inv('gmail_send_email', { to: 'a@b.co' }), inv('sheets_read_range', {}, { __error: 'x' })],
      [
        { toolId: 'gmail.send_email', ms: 820, status: 'ok', decision: 'confirmed', at: 'T' },
        { toolId: 'sheets.read_range', ms: 100, status: 'error' },
      ],
    );
    expect(rows[0]?.approval).toEqual({ kind: 'person', at: 'T' });
    expect(rows[0]?.ms).toBe(820);
    expect(rows[1]?.status).toBe('error');
  });
});

describe('buildSourceRows', () => {
  it('lista cerebro y lecturas, no escrituras ni fallos', () => {
    const rows = buildSourceRows(
      [
        inv('drive_list_folder', { folder: 'https://drive.google.com/drive/folders/abc' }),
        inv('gmail_send_email', { to: 'x' }),
        inv('sheets_read_range', {}, { __error: 'x' }),
      ],
      [{ documentId: 'd1', title: 'Contrato', relevance: 'weak' }],
    );
    expect(rows.map((r) => r.kind)).toEqual(['brain', 'tool']);
    expect(rows[0]?.weak).toBe(true);
    expect(rows[1]?.href).toContain('drive.google.com');
  });
});

describe('conversationMarkdown', () => {
  it('escribe turnos y salta los vacíos', () => {
    const md = conversationMarkdown('Mi chat', [
      { role: 'user', content: 'Hola' },
      { role: 'assistant', content: '  ' },
      { role: 'assistant', content: 'Buenas' },
    ]);
    expect(md).toBe('# Mi chat\n\n## Tú\n\nHola\n\n## Cortex\n\nBuenas\n');
    expect(markdownFileName('¿Quién me debe?')).toBe('quien-me-debe.md');
  });
});
