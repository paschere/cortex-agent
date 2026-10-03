import { describe, expect, it } from 'vitest';
import type { ClientInvoice } from '../../../clients/hub';
import { nitVariants } from '../../../clients/identity';
import { balanceAnswer, orderAnswer } from '../answers';
import {
  classify,
  extractInvoiceNumber,
  extractNit,
  extractOrderNumber,
  isOptOut,
  isWithinHours,
  matchFaq,
  matchPhone,
  nextOpening,
  normalizeReference,
  samePhone,
  sameReference,
} from '../classify';
import {
  type CustomerDeps,
  type CustomerOutcome,
  type EscalationReason,
  handleCustomerMessage,
  verificationClaim,
} from '../handler';
import {
  type ConversationRow,
  type CustomerSettings,
  DEFAULT_CUSTOMER_SETTINGS,
  type MessageSource,
  replyRefusal,
} from '../shape';
import { rowIsClient } from '../store';

/**
 * LO QUE ESTAS PRUEBAS SOSTIENEN: que a un cliente nunca se le diga nada de
 * otro, que cada cifra salga de una factura, que lo que no se entiende vaya a
 * una persona, y que el número se porte como alguien que contesta — no como un
 * robot que escribe.
 */

// --- El mundo de mentira ----------------------------------------------------

const NEXA = { id: 'c-nexa', name: 'Nexa Logística', tax_id: '900123456' };
const ANDINA = { id: 'c-andina', name: 'Andina Cargo', tax_id: '800555111' };
const CLIENTS = [NEXA, ANDINA];

const NEXA_PHONE = '573001112233';
const ANDINA_PHONE = '573109998877';
const STRANGER = '573205550000';
const SHARED = '573151234567';

const CONTACTS = [
  { id: 'k1', client_id: NEXA.id, phone: '300 111 2233', status: 'active' },
  { id: 'k2', client_id: ANDINA.id, phone: '+57 (310) 999-8877', status: 'active' },
  // El mismo número en los dos clientes: no es de ninguno.
  { id: 'k3', client_id: NEXA.id, phone: '3151234567', status: 'active' },
  { id: 'k4', client_id: ANDINA.id, phone: '315 123 4567', status: 'active' },
];

const inv = (over: Partial<ClientInvoice> & { id: string }): ClientInvoice => ({
  source: 'accounting',
  system: 'Siigo',
  docNumber: null,
  currency: 'COP',
  total: 0,
  balance: 0,
  issuedOn: '2026-09-01',
  dueOn: null,
  daysOverdue: null,
  href: null,
  ...over,
});

const INVOICES: Record<string, ClientInvoice[]> = {
  [NEXA.id]: [
    inv({
      id: 'i-100',
      docNumber: 'FV-100',
      total: 1_200_000,
      balance: 1_200_000,
      dueOn: '2026-09-25',
      daysOverdue: 10,
    }),
    inv({
      id: 'i-101',
      docNumber: 'FV-101',
      total: 500_000,
      balance: 500_000,
      dueOn: '2026-10-20',
    }),
    inv({ id: 'i-090', docNumber: 'FV-90', total: 800_000, balance: 0, dueOn: '2026-08-01' }),
  ],
  [ANDINA.id]: [
    inv({
      id: 'i-200',
      docNumber: 'FV-200',
      total: 3_000_000,
      balance: 3_000_000,
      dueOn: '2026-10-30',
    }),
  ],
};

const ORDER_ROWS = [
  {
    id: 'r-5001',
    values: {
      guia: 'GU-5001',
      estado: 'En tránsito',
      cliente: 'Nexa Logística S.A.S.',
      entrega: '2026-10-07',
      valor: 999_999,
    },
    updated_at: '2026-10-04T12:00:00Z',
  },
];

const ORDER_SOURCE = {
  trackerId: '00000000-0000-4000-8000-000000000001',
  label: 'Guías',
  numberField: 'guia',
  statusField: 'estado',
  etaField: 'entrega',
  clientField: 'cliente',
};

const WEEKDAYS = {
  '1': [['08:00', '18:00']],
  '2': [['08:00', '18:00']],
  '3': [['08:00', '18:00']],
  '4': [['08:00', '18:00']],
  '5': [['08:00', '18:00']],
} as CustomerSettings['businessHours'];

const SETTINGS: CustomerSettings = {
  ...DEFAULT_CUSTOMER_SETTINGS,
  enabled: true,
  businessHours: WEEKDAYS,
  companyInfo: 'Estamos en la Calle 80 # 45-10, Bogotá.',
  faq: [
    {
      q: '¿Hacen envíos a Medellín?',
      a: 'Sí, despachamos a Medellín todos los días hábiles.',
      keywords: ['medellin'],
    },
  ],
  orderSources: [ORDER_SOURCE],
  escalationUserId: 'u-ana',
  escalationTeam: 'servicio al cliente',
  maxRepliesPerHour: 12,
};

// Lunes 5 de octubre de 2026, 10:00 en Bogotá.
const MONDAY_10AM = new Date('2026-10-05T15:00:00Z');
// Domingo 4 de octubre, 21:00 en Bogotá.
const SUNDAY_NIGHT = new Date('2026-10-05T02:00:00Z');

interface World {
  deps: CustomerDeps;
  conv: () => ConversationRow;
  sent: Array<{ text: string; intent: string; sources: MessageSource[] }>;
  escalations: EscalationReason[];
  clock: { now: Date };
}

function world(
  over: Partial<CustomerSettings> = {},
  opts: { invoicesFail?: boolean; now?: Date } = {},
): World {
  const settings = { ...SETTINGS, ...over };
  const clock = { now: opts.now ?? MONDAY_10AM };
  let conv: ConversationRow | null = null;
  const seen = new Set<string>();
  const sent: World['sent'] = [];
  const replies: Array<{ intent: string; created_at: string }> = [];
  const escalations: EscalationReason[] = [];

  const deps: CustomerDeps = {
    now: () => clock.now,
    settings: async () => settings,
    conversation: async (input) => {
      conv ??= {
        id: 'conv-1',
        phone: input.phone,
        jid: input.jid,
        push_name: input.pushName,
        client_id: null,
        contact_id: null,
        status: 'abierta',
        assigned_to: null,
        verification: 'ninguna',
        verified_until: null,
        verify_attempts: 0,
        pending_intent: null,
        opted_out: false,
        opted_out_at: null,
        last_message_at: clock.now.toISOString(),
        last_inbound_at: null,
        escalated_at: null,
        escalation_reason: null,
        closed_at: null,
        work_item_id: null,
        created_at: clock.now.toISOString(),
      };
      return { ...conv };
    },
    recordInbound: async (_c, msg) => {
      if (msg.waMessageId && seen.has(msg.waMessageId)) return 'duplicate';
      if (msg.waMessageId) seen.add(msg.waMessageId);
      return 'ok';
    },
    recordOutbound: async (_c, msg) => {
      sent.push(msg);
      replies.unshift({ intent: msg.intent, created_at: clock.now.toISOString() });
    },
    patchConversation: async (_id, patch) => {
      conv = { ...(conv as ConversationRow), ...patch };
    },
    botRepliesSince: async (_id, since) => replies.filter((r) => r.created_at >= since),
    clientByPhone: async (phone) => matchPhone(CONTACTS, phone),
    verifyClaim: async (nit, invoice) => {
      const variants = nitVariants(nit);
      const owners = CLIENTS.filter((c) => variants.includes(c.tax_id)).filter((c) =>
        (INVOICES[c.id] ?? []).some((i) => sameReference(invoice, i.docNumber)),
      );
      return owners.length === 1 ? { clientId: (owners[0] as { id: string }).id } : null;
    },
    clientName: async (id) => CLIENTS.find((c) => c.id === id)?.name ?? null,
    invoices: async (id) => {
      if (opts.invoicesFail) throw new Error('db down');
      return INVOICES[id] ?? [];
    },
    findOrder: async (sources, number, clientId) => {
      const client = CLIENTS.find((c) => c.id === clientId) ?? null;
      for (const s of sources) {
        for (const row of ORDER_ROWS) {
          const values = row.values as Record<string, unknown>;
          if (normalizeReference(String(values[s.numberField])) !== normalizeReference(number))
            continue;
          if (s.clientField && client && !rowIsClient(values[s.clientField], client)) continue;
          return {
            sourceLabel: s.label,
            rowId: row.id,
            number: String(values[s.numberField]),
            status: String(values[s.statusField]),
            eta: s.etaField ? String(values[s.etaField]) : null,
            updatedAt: row.updated_at,
          };
        }
      }
      return null;
    },
    escalate: async (c, input) => {
      escalations.push(input.reason);
      conv = { ...(conv as ConversationRow), ...c, status: 'escalada', assigned_to: 'u-ana' };
    },
  };
  return { deps, conv: () => conv as ConversationRow, sent, escalations, clock };
}

let n = 0;
async function say(
  w: World,
  phone: string,
  text: string,
): Promise<CustomerOutcome & { handled: true }> {
  n += 1;
  const outcome = await handleCustomerMessage(w.deps, {
    phone,
    jid: `${phone}@s.whatsapp.net`,
    pushName: 'Carlos Pérez',
    text,
    messageId: `m-${n}`,
  });
  if (!outcome.handled) throw new Error('no lo manejó');
  return outcome;
}

const ALL_OTHER_CLIENT_MARKERS = ['FV-200', '3.000.000', 'Andina'];

// --- Identificación y verificación ------------------------------------------

describe('identificación: nunca los datos de un cliente a otro', () => {
  it('apagado, no es asunto de este módulo', async () => {
    const w = world({ enabled: false });
    const out = await handleCustomerMessage(w.deps, {
      phone: NEXA_PHONE,
      jid: 'x',
      pushName: null,
      text: '¿cuánto debo?',
      messageId: 'a',
    });
    expect(out.handled).toBe(false);
  });

  it('el teléfono de un contacto de Nexa ve el saldo de Nexa y sólo el de Nexa', async () => {
    const w = world();
    const out = await say(w, NEXA_PHONE, 'Hola, ¿cuánto debo?');
    expect(out.reply).toContain('$1.700.000');
    expect(out.reply).toContain('FV-100');
    expect(out.reply).toContain('FV-101');
    expect(out.reply).not.toContain('FV-90');
    for (const marker of ALL_OTHER_CLIENT_MARKERS) expect(out.reply).not.toContain(marker);
    expect(w.conv().verification).toBe('telefono');
    expect(w.conv().client_id).toBe(NEXA.id);
    expect(
      w.sent
        .at(-1)
        ?.sources.map((s) => s.id)
        .sort(),
    ).toEqual(['i-100', 'i-101']);
  });

  it('un número desconocido no ve nada hasta verificar NIT y factura del MISMO cliente', async () => {
    const w = world();
    const first = await say(w, STRANGER, '¿cuánto debo?');
    expect(first.reply).toMatch(/NIT/);
    expect(first.reply).not.toMatch(/\$/);
    expect(w.conv().verification).toBe('pendiente');

    // NIT de Andina con una factura de Nexa: no cuadra, no sale nada.
    const mixed = await say(w, STRANGER, 'NIT 800555111, factura FV-100');
    expect(mixed.reply).toMatch(/No logré confirmar/);
    expect(mixed.reply).not.toMatch(/\$/);
    expect(w.conv().client_id).toBeNull();

    const ok = await say(w, STRANGER, 'NIT 900.123.456-? no, es 900123456 y la factura FV-101');
    // El mensaje de arriba es ruidoso a propósito: igual tiene NIT y factura.
    expect(ok.reply).toContain('$1.700.000');
    expect(ok.reply).not.toContain('FV-200');
    expect(w.conv().verification).toBe('verificado');
    expect(w.conv().client_id).toBe(NEXA.id);
  });

  it('tres intentos fallidos bloquean y pasan a una persona, sin datos', async () => {
    const w = world();
    await say(w, STRANGER, 'quiero ver mis facturas');
    await say(w, STRANGER, 'NIT 900123456 factura FV-999');
    await say(w, STRANGER, 'NIT 900123456 factura FV-998');
    const last = await say(w, STRANGER, 'NIT 900123456 factura FV-997');
    expect(last.reply).toMatch(/te paso con una persona/i);
    expect(last.reply).not.toMatch(/\$/);
    expect(w.conv().verification).toBe('bloqueada');
    expect(w.escalations).toContain('verificacion');
  });

  it('un número que es contacto de dos clientes no es de ninguno', async () => {
    const w = world();
    const out = await say(w, SHARED, 'mi saldo por favor');
    expect(out.reply).toMatch(/NIT/);
    expect(out.reply).not.toMatch(/\$/);
    expect(w.conv().client_id).toBeNull();
  });

  it('la verificación de Andina abre sólo lo de Andina', async () => {
    const w = world();
    await say(w, STRANGER, 'facturas pendientes');
    const out = await say(w, STRANGER, 'NIT 800555111 factura 200');
    expect(out.reply).toContain('FV-200');
    expect(out.reply).not.toContain('FV-100');
  });

  it('si no se pudieron leer las facturas, no dice «no debes nada»', async () => {
    const w = world({}, { invoicesFail: true });
    const out = await say(w, NEXA_PHONE, '¿cuánto debo?');
    expect(out.reply).not.toMatch(/no tiene facturas/i);
    expect(out.escalated).toBe(true);
    expect(w.escalations).toEqual(['error']);
  });
});

// --- Pedidos y guías ----------------------------------------------------------

describe('estado de pedido o guía', () => {
  it('con el número de guía dice estado y fecha, y nada más de la fila', async () => {
    const w = world();
    const out = await say(w, STRANGER, '¿cómo va la guía GU-5001?');
    expect(out.reply).toContain('En tránsito');
    expect(out.reply).toContain('7 de octubre de 2026');
    expect(out.reply).not.toContain('999');
    expect(out.reply).not.toContain('Nexa');
  });

  it('un cliente identificado no ve la guía de otro cliente', async () => {
    const w = world();
    const out = await say(w, ANDINA_PHONE, 'estado de la guía GU-5001');
    expect(out.reply).toMatch(/No encontré/);
    expect(out.reply).not.toContain('En tránsito');
  });

  it('sin número lo pide, y con el número suelto contesta', async () => {
    const w = world();
    const ask = await say(w, NEXA_PHONE, '¿dónde va mi pedido?');
    expect(ask.reply).toMatch(/número de guía/);
    const out = await say(w, NEXA_PHONE, 'gu5001');
    expect(out.reply).toContain('En tránsito');
  });

  it('sin tablas configuradas no inventa: pasa a una persona', async () => {
    const w = world({ orderSources: [] });
    const out = await say(w, NEXA_PHONE, 'estado de mi guía GU-5001');
    expect(out.escalated).toBe(true);
    expect(out.reply).not.toContain('tránsito');
  });
});

// --- Intención y escalamiento -------------------------------------------------

describe('qué pide y quién contesta', () => {
  it('cotización, queja, persona y lo que no se entiende van a una persona', async () => {
    for (const [text, reason] of [
      ['¿me cotizan un envío a Cali?', 'cotizacion'],
      ['la mercancía llegó dañada, quiero poner un reclamo', 'queja'],
      ['quiero hablar con un asesor', 'persona'],
      ['blablá xyz', 'otro'],
    ] as const) {
      const w = world();
      const out = await say(w, NEXA_PHONE, text);
      expect(out.escalated).toBe(true);
      expect(w.escalations).toEqual([reason]);
      expect(w.conv().status).toBe('escalada');
    }
  });

  it('saludo, pregunta frecuente aprobada y datos públicos se contestan sin persona', async () => {
    const w = world();
    expect((await say(w, STRANGER, 'Hola buenas tardes')).reply).toMatch(/Hola, Carlos/);
    expect((await say(w, STRANGER, '¿hacen envíos a Medellín?')).reply).toBe(
      'Sí, despachamos a Medellín todos los días hábiles.',
    );
    const info = await say(w, STRANGER, '¿cuál es la dirección?');
    expect(info.reply).toContain('Calle 80');
    expect(info.reply).toContain('lunes a viernes 08:00–18:00');
    expect(w.escalations).toEqual([]);
  });

  it('lo que la empresa no deja compartir no sale', async () => {
    const w = world({ shareBalance: false });
    const out = await say(w, NEXA_PHONE, '¿cuánto debo?');
    expect(out.reply).toMatch(/no la puedo compartir/);
    expect(out.reply).not.toMatch(/\$/);
  });

  it('con una persona a cargo, el bot acusa recibo una vez por hora y se calla', async () => {
    const w = world();
    await say(w, NEXA_PHONE, 'quiero hablar con un asesor');
    const ack = await say(w, NEXA_PHONE, '¿hola?');
    expect(ack.reply).toMatch(/ya le llegó/);
    const quiet = await say(w, NEXA_PHONE, '¿cuánto debo?');
    expect(quiet.reply).toBeNull();
  });
});

// --- Horario, ritmo, baja -------------------------------------------------------

describe('horario, ritmo y baja', () => {
  it('fuera de horario sin bot: avisa una vez y luego guarda silencio', async () => {
    const w = world({ botAfterHours: false }, { now: SUNDAY_NIGHT });
    const first = await say(w, NEXA_PHONE, '¿cuánto debo?');
    expect(first.reply).toMatch(/fuera de horario/);
    expect(first.reply).toMatch(/mañana a las 08:00/);
    expect(first.reply).not.toMatch(/\$/);
    expect((await say(w, NEXA_PHONE, '¿hola?')).reply).toBeNull();
  });

  it('fuera de horario con bot: contesta datos, y al escalar dice cuándo responden', async () => {
    const w = world({}, { now: SUNDAY_NIGHT });
    expect((await say(w, NEXA_PHONE, '¿cuánto debo?')).reply).toContain('$1.700.000');
    const handoff = await say(w, NEXA_PHONE, 'necesito una cotización');
    expect(handoff.reply).toMatch(/fuera de horario: te responden mañana a las 08:00/);
  });

  it('el techo por hora pasa la conversación a una persona', async () => {
    const w = world({ maxRepliesPerHour: 2 });
    await say(w, NEXA_PHONE, 'hola');
    await say(w, NEXA_PHONE, 'gracias');
    const third = await say(w, NEXA_PHONE, '¿cuánto debo?');
    expect(third.escalated).toBe(true);
    expect(w.escalations).toEqual(['limite']);
    expect(third.reply).not.toMatch(/\$/);
  });

  it('la baja se respeta: un acuse, silencio, y ACTIVAR la levanta', async () => {
    const w = world();
    expect((await say(w, NEXA_PHONE, 'No me escriban más')).reply).toMatch(/No te volveremos/);
    expect(w.conv().opted_out).toBe(true);
    expect((await say(w, NEXA_PHONE, '¿cuánto debo?')).reply).toBeNull();
    expect((await say(w, NEXA_PHONE, 'ACTIVAR')).reply).toMatch(/activado/);
    expect((await say(w, NEXA_PHONE, '¿cuánto debo?')).reply).toContain('$1.700.000');
  });

  it('el mismo mensaje entregado dos veces se contesta una', async () => {
    const w = world();
    const input = {
      phone: NEXA_PHONE,
      jid: 'j',
      pushName: null,
      text: 'hola',
      messageId: 'dup-1',
    };
    const a = await handleCustomerMessage(w.deps, input);
    const b = await handleCustomerMessage(w.deps, input);
    expect(a.handled && a.reply).toBeTruthy();
    expect(b.handled && b.reply).toBeNull();
    expect(w.sent).toHaveLength(1);
  });
});

// --- Piezas puras ---------------------------------------------------------------

describe('las piezas', () => {
  it('extrae NIT, factura y guía', () => {
    expect(extractNit('NIT 900.123.456-7')).toBe('900123456-7');
    expect(extractNit('mi nit es 900123456')).toBe('900123456');
    expect(extractNit('900123456')).toBeNull();
    expect(extractInvoiceNumber('la factura FV-1234 está mal')).toBe('FV-1234');
    expect(extractInvoiceNumber('factura n° 88')).toBe('88');
    expect(extractInvoiceNumber('me llegó la FE 77')).toBe('FE77');
    expect(extractOrderNumber('¿y la guía # 12345?')).toBe('12345');
    expect(extractOrderNumber('mi pedido llegó?')).toBeNull();
    expect(verificationClaim('NIT 900123456 1234')).toEqual({ nit: '900123456', invoice: '1234' });
    expect(verificationClaim('900123456 1234')).toEqual({ nit: '900123456', invoice: '1234' });
  });

  it('compara referencias sin signos y por dígitos sólo si escribieron sólo dígitos', () => {
    expect(sameReference('fv 100', 'FV-100')).toBe(true);
    expect(sameReference('100', 'FV-100')).toBe(true);
    expect(sameReference('FE-100', 'FV-100')).toBe(false);
    expect(sameReference('10', 'FV-10')).toBe(false);
  });

  it('teléfonos: con o sin indicativo, nunca por menos de diez dígitos', () => {
    expect(samePhone('300 111 2233', '573001112233')).toBe(true);
    expect(samePhone('111 2233', '573001112233')).toBe(false);
    expect(matchPhone(CONTACTS, SHARED).kind).toBe('ambiguous');
    expect(
      matchPhone([{ id: 'x', client_id: 'c', phone: '3001112233', status: 'left' }], NEXA_PHONE)
        .kind,
    ).toBe('none');
  });

  it('la baja es el mensaje entero, no una palabra suelta', () => {
    expect(isOptOut('STOP')).toBe(true);
    expect(isOptOut('no me escriban más!')).toBe(true);
    expect(isOptOut('la baja de inventario salió mal')).toBe(false);
  });

  it('clasifica sin modelo y lo dudoso es «otro»', () => {
    expect(classify('¿cuánto le debo a ustedes?').intent).toBe('saldo');
    expect(classify('mándame las facturas vencidas').intent).toBe('facturas');
    expect(classify('¿a qué hora abren?').intent).toBe('empresa');
    expect(classify('el perro de mi vecino').intent).toBe('otro');
    expect(matchFaq('envíos', SETTINGS.faq)).toBeNull();
  });

  it('horario en la zona de la empresa', () => {
    expect(isWithinHours(WEEKDAYS, 'America/Bogota', MONDAY_10AM)).toBe(true);
    expect(isWithinHours(WEEKDAYS, 'America/Bogota', SUNDAY_NIGHT)).toBe(false);
    expect(isWithinHours({}, 'America/Bogota', SUNDAY_NIGHT)).toBe(true);
    expect(nextOpening(WEEKDAYS, 'America/Bogota', SUNDAY_NIGHT)).toBe('mañana a las 08:00');
    // Viernes 19:00 → el lunes.
    expect(nextOpening(WEEKDAYS, 'America/Bogota', new Date('2026-10-10T00:00:00Z'))).toBe(
      'el lunes a las 08:00',
    );
  });

  it('una persona sólo contesta dentro de las 24 h, abierta y sin baja', () => {
    const now = MONDAY_10AM;
    const base = {
      status: 'escalada' as const,
      opted_out: false,
      last_inbound_at: new Date(now.getTime() - 60_000).toISOString(),
    };
    expect(replyRefusal(base, now)).toBeNull();
    expect(replyRefusal({ ...base, status: 'cerrada' }, now)).toMatch(/cerrada/);
    expect(replyRefusal({ ...base, opted_out: true }, now)).toMatch(/no recibir/);
    expect(replyRefusal({ ...base, last_inbound_at: null }, now)).toMatch(/nunca escribe primero/);
    expect(replyRefusal({ ...base, last_inbound_at: '2026-10-03T10:00:00Z' }, now)).toMatch(
      /24 horas/,
    );
  });

  it('cada cifra del saldo sale de una factura', () => {
    const answer = balanceAnswer('Nexa', INVOICES[NEXA.id] as ClientInvoice[]);
    expect(answer.sources.map((s) => s.label)).toEqual(['FV-100', 'FV-101']);
    expect(answer.text).toContain('$1.200.000 ya está vencido');
    const usd = balanceAnswer('Nexa', [
      inv({ id: 'u', docNumber: 'EX-1', currency: 'USD', balance: 100, total: 100 }),
      inv({ id: 'c', docNumber: 'FV-1', balance: 1000, total: 1000 }),
    ]);
    expect(usd.text).toContain('$1.000');
    expect(usd.text).toContain('USD 100');
    expect(usd.text).not.toContain('$1.100');
  });

  it('la guía dice estado y nada más', () => {
    const a = orderAnswer({
      sourceLabel: 'Guías',
      rowId: 'r',
      number: 'GU-1',
      status: 'Entregada',
      eta: null,
      updatedAt: '2026-10-01T00:00:00Z',
    });
    expect(a.text).toBe('Guía *GU-1*: *Entregada*.\n_Actualizado el 1 de octubre de 2026._');
  });

  it('la columna de cliente de una fila se compara por NIT o por nombre', () => {
    expect(rowIsClient('Nexa Logística S.A.S.', NEXA)).toBe(true);
    expect(rowIsClient('900.123.456-6', NEXA)).toBe(
      nitVariants('900.123.456-6').includes('900123456'),
    );
    expect(rowIsClient('Andina Cargo', NEXA)).toBe(false);
  });
});
