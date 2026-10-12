import { describe, expect, it } from 'vitest';
import { messagesSignature, taskIsLive, taskIsRunning, toBanner } from './banner';

describe('banner de la tarea', () => {
  it('lee la fila de la base y el registro por igual', () => {
    const fromRow = toBanner({
      id: 't1',
      title: 'Cartera',
      status: 'needs_you',
      conversation_id: 'c1',
      steps_count: 7,
      pending_approvals: [{ id: 'a', toolId: 'gmail.send', summary: 'Enviar' }],
    });
    const fromRecord = toBanner({
      id: 't1',
      title: 'Cartera',
      status: 'needs_you',
      conversationId: 'c1',
      stepsCount: 7,
      approvals: [{ id: 'a', toolId: 'gmail.send', summary: 'Enviar' }],
    });
    expect(fromRow).toEqual(fromRecord);
    expect(fromRow.stepsCount).toBe(7);
    expect(fromRow.approvals).toHaveLength(1);
  });

  it('un estado desconocido cae a «en cola»', () => {
    expect(toBanner({ id: 'x', title: 't', status: 'raro' }).status).toBe('queued');
  });

  it('viva = no terminó; corriendo = cola o trabajando', () => {
    expect(taskIsLive({ status: 'needs_you' })).toBe(true);
    expect(taskIsLive({ status: 'done' })).toBe(false);
    expect(taskIsLive(null)).toBe(false);
    expect(taskIsRunning({ status: 'working' })).toBe(true);
    expect(taskIsRunning({ status: 'needs_you' })).toBe(false);
  });

  it('la huella cambia si crece el texto o cambia el estado de una invocación', () => {
    const base = [
      { id: 'm1', content: 'hola', toolInvocations: [{ toolCallId: 'c', state: 'call' }] },
    ];
    const a = messagesSignature(base);
    expect(messagesSignature(base)).toBe(a);
    expect(messagesSignature([{ ...base[0], content: 'hola!' } as never])).not.toBe(a);
    expect(
      messagesSignature([
        { id: 'm1', content: 'hola', toolInvocations: [{ toolCallId: 'c', state: 'result' }] },
      ]),
    ).not.toBe(a);
  });
});
