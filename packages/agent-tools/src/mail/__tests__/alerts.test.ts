import { describe, expect, it } from 'vitest';
import { planMailAlerts, withinQuietHours } from '../alerts';
import { type AttentionThread, needsYourAttention, worthRemembering } from '../attention';

const MAILBOX = 'ana@acme.com';

function thread(over: Partial<AttentionThread> = {}): AttentionThread {
  return {
    threadId: 't1',
    subject: 'Contrato de bodegaje',
    lastMessageAt: '2026-08-30T14:00:00Z',
    internalOnly: false,
    lastFromEmail: 'jefe@coltrans.com',
    lastFrom: 'Jefe <jefe@coltrans.com>',
    lastLabelIds: ['INBOX'],
    lastHeaders: [],
    counterpartDomain: 'coltrans.com',
    ...over,
  };
}

function input(over: Partial<Parameters<typeof planMailAlerts>[0]> = {}) {
  return {
    threads: [thread()],
    mailbox: MAILBOX,
    alreadyAlerted: new Set<string>(),
    clientsByDomain: new Map<string, string>(),
    commitmentsByClient: new Map<string, { title: string; dueLabel: string }>(),
    budget: 5,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// El filtro compartido con las propuestas
// ---------------------------------------------------------------------------

describe('needsYourAttention', () => {
  it('lo interno no le toca a Cortex', () => {
    expect(needsYourAttention(thread({ internalOnly: true }), MAILBOX)).toEqual({
      needsYou: false,
      why: 'internal',
    });
  });

  it('si el último que habló fue el dueño del buzón, está esperando él', () => {
    expect(needsYourAttention(thread({ lastFromEmail: MAILBOX }), MAILBOX)).toEqual({
      needsYou: false,
      why: 'you_spoke_last',
    });
  });

  it('un boletín no merece una interrupción, igual que no merece un borrador', () => {
    const verdict = needsYourAttention(
      thread({
        lastFromEmail: 'news@boletin.com',
        lastFrom: 'Boletín <news@boletin.com>',
        lastHeaders: [{ name: 'List-Unsubscribe', value: '<mailto:no@boletin.com>' }],
      }),
      MAILBOX,
    );
    expect(verdict).toEqual({ needsYou: false, why: 'bulk' });
  });
});

// ---------------------------------------------------------------------------
// Qué merece interrumpir
// ---------------------------------------------------------------------------

describe('planMailAlerts', () => {
  it('un compromiso con fecha gana a todo lo demás, y lo dice', () => {
    const out = planMailAlerts(
      input({
        clientsByDomain: new Map([['coltrans.com', 'Coltrans']]),
        commitmentsByClient: new Map([
          ['coltrans', { title: 'Renovar la póliza', dueLabel: 'para el 2026-09-02' }],
        ]),
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.reason).toBe('commitment');
    expect(out[0]?.detail).toContain('Renovar la póliza');
    expect(out[0]?.detail).toContain('Coltrans');
  });

  it('un dominio registrado a nombre de un cliente basta', () => {
    const out = planMailAlerts(input({ clientsByDomain: new Map([['coltrans.com', 'Coltrans']]) }));
    expect(out[0]?.reason).toBe('client');
  });

  it('y si no es nadie conocido, queda «alguien de fuera esperando»', () => {
    const out = planMailAlerts(input());
    expect(out[0]?.reason).toBe('waiting');
    expect(out[0]?.detail).toContain('jefe@coltrans.com');
  });

  it('las razones fuertes se llevan el techo cuando no cabe todo', () => {
    // Tres hilos, sitio para uno. El del compromiso tiene que ganar aunque sea
    // el más viejo de los tres: el reloj ya estaba corriendo antes.
    const out = planMailAlerts(
      input({
        threads: [
          thread({
            threadId: 'suelto',
            counterpartDomain: 'nadie.com',
            lastFromEmail: 'x@nadie.com',
            lastMessageAt: '2026-08-30T18:00:00Z',
          }),
          thread({
            threadId: 'cliente',
            counterpartDomain: 'otro.com',
            lastFromEmail: 'y@otro.com',
            lastMessageAt: '2026-08-30T17:00:00Z',
          }),
          thread({ threadId: 'compromiso', lastMessageAt: '2026-08-30T09:00:00Z' }),
        ],
        clientsByDomain: new Map([
          ['coltrans.com', 'Coltrans'],
          ['otro.com', 'Otro SAS'],
        ]),
        commitmentsByClient: new Map([
          ['coltrans', { title: 'Pagar la factura', dueLabel: 'vencido el 2026-08-28' }],
        ]),
        budget: 1,
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.thread.threadId).toBe('compromiso');
  });

  it('un hilo que ya interrumpió no vuelve a interrumpir', () => {
    const out = planMailAlerts(input({ alreadyAlerted: new Set(['t1']) }));
    expect(out).toEqual([]);
  });

  it('sin techo no suena nada', () => {
    expect(planMailAlerts(input({ budget: 0 }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Las horas
// ---------------------------------------------------------------------------

describe('withinQuietHours', () => {
  const bogota = 'America/Bogota';
  // 14:00 UTC = 09:00 en Bogotá.
  const nineAm = new Date('2026-08-30T14:00:00Z');
  // 06:00 UTC = 01:00 en Bogotá.
  const oneAm = new Date('2026-08-30T06:00:00Z');

  it('deja pasar dentro de la franja y calla fuera', () => {
    expect(withinQuietHours(nineAm, bogota, '07:00', '21:00')).toBe(true);
    expect(withinQuietHours(oneAm, bogota, '07:00', '21:00')).toBe(false);
  });

  it('entiende una franja que cruza la medianoche', () => {
    // Quien trabaja de noche la escribe así, y una franja vacía silenciaría la
    // función entera sin decir por qué.
    expect(withinQuietHours(oneAm, bogota, '22:00', '07:00')).toBe(true);
    expect(withinQuietHours(nineAm, bogota, '22:00', '07:00')).toBe(false);
  });

  it('una franja que no se entiende no calla a nadie', () => {
    expect(withinQuietHours(oneAm, bogota, 'ayer', 'mañana')).toBe(true);
    expect(withinQuietHours(oneAm, 'Zona/Inventada', '07:00', '21:00')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Qué merece ser memoria
// ---------------------------------------------------------------------------

const human = {
  from: 'jefe@coltrans.com',
  labelIds: ['INBOX'],
  headers: [] as { name: string; value: string }[],
};
const newsletter = {
  from: 'news@marca.com',
  labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'],
  headers: [{ name: 'List-Unsubscribe', value: '<mailto:baja@marca.com>' }],
};

describe('worthRemembering', () => {
  it('un boletín no entra al cerebro', () => {
    const verdict = worthRemembering([newsletter]);
    expect(verdict.remember).toBe(false);
    if (!verdict.remember) expect(verdict.reason).toBeTruthy();
  });

  it('una conversación con una persona sí', () => {
    expect(worthRemembering([human]).remember).toBe(true);
  });

  it('si contestaste el boletín, el hilo se queda entero', () => {
    // Es el caso que obliga a mirar el hilo y no el último mensaje: preguntar
    // «¿cuánto vale el plan de arriba?» convierte una campaña en
    // correspondencia, y el último en hablar suele volver a ser el robot.
    expect(worthRemembering([newsletter, human, newsletter]).remember).toBe(true);
  });

  it('una campaña de doce mensajes sigue siendo una campaña', () => {
    expect(worthRemembering(Array(12).fill(newsletter)).remember).toBe(false);
  });

  it('un hilo sin mensajes no es memoria', () => {
    expect(worthRemembering([]).remember).toBe(false);
  });
});
