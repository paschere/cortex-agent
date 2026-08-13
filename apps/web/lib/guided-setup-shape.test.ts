import { COMMITMENT_KINDS as CANON } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import {
  COMMITMENT_KINDS,
  MAX_QUESTIONS,
  MIN_OPENING_CHARS,
  type SetupItem,
  cronPhrase,
  decideStop,
  isThinAnswer,
  itemFields,
  normalizeProposal,
  slugify,
  undoability,
} from './guided-setup-shape';

const TODAY = '2026-03-10';

/** Lo largo que tiene que ser lo primero que se cuenta para que valga. */
const OPENING = 'x'.repeat(MIN_OPENING_CHARS + 10);

describe('el catálogo no se separa del módulo', () => {
  it('tiene exactamente los tipos de vencimiento que acepta Vencimientos', () => {
    // Duplicado a mano porque este archivo lo lee el cliente y no puede
    // importar agent-tools. Este test es lo único que impide que se separen.
    expect([...COMMITMENT_KINDS]).toEqual([...CANON]);
  });
});

describe('lo que está fuera del catálogo se reconoce como tal', () => {
  it('rechaza un tipo que el producto no sabe crear', () => {
    const result = normalizeProposal(
      {
        kind: 'whatsapp_alert',
        title: 'Avisar por WhatsApp cuando cambie el estado en el puerto',
        rationale: 'Lo pidieron',
        payload: { number: '3001234567' },
      },
      TODAY,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no es algo que este producto sepa crear');
  });

  it('rechaza un trámite aunque venga con pinta de flujo', () => {
    // Los trámites son reales pero no se configuran escribiendo. El catálogo de
    // creables no los tiene, así que aquí se caen: van por handoffs.
    const result = normalizeProposal(
      { kind: 'tramite', title: 'Sacar el RUT en la DIAN', rationale: '', payload: {} },
      TODAY,
    );
    expect(result.ok).toBe(false);
  });

  it('no acepta un vencimiento sin fecha', () => {
    const result = normalizeProposal(
      {
        kind: 'commitment',
        title: 'El SOAT de los camiones',
        rationale: 'Dijeron que se renueva cada año',
        payload: { title: 'El SOAT de los camiones', kind: 'soat' },
      },
      TODAY,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Faltan datos');
  });

  it('no acepta una fecha inventada a diez años vista', () => {
    const result = normalizeProposal(
      {
        kind: 'commitment',
        title: 'Renovación del contrato',
        rationale: '',
        payload: { title: 'Renovación del contrato', dueOn: '2099-01-01', kind: 'contract' },
      },
      TODAY,
    );
    expect(result.ok).toBe(false);
  });

  it('no acepta un flujo de un solo paso', () => {
    const result = normalizeProposal(
      {
        kind: 'flow',
        title: 'Recibir carga',
        rationale: '',
        payload: {
          name: 'Recibir carga',
          steps: [{ title: 'Recibir', detail: 'Recibir la carga y ya', checkpoint: false }],
        },
      },
      TODAY,
    );
    expect(result.ok).toBe(false);
  });
});

describe('lo que sí sabe crear', () => {
  it('acepta un vencimiento con fecha y le pone el aviso por defecto del tipo', () => {
    const result = normalizeProposal(
      {
        kind: 'commitment',
        title: 'SOAT del WGX-123',
        rationale: 'Dijiste que se vence en abril',
        payload: { title: 'SOAT del WGX-123', dueOn: '2026-04-18', kind: 'soat', noticeDays: 30 },
      },
      TODAY,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.item.kind).toBe('commitment');
      expect(itemFields(result.item).map((f) => f.label)).toContain('Se vence');
    }
  });

  it('acepta una fecha que se acaba de pasar: sigue mereciendo vigilancia', () => {
    const result = normalizeProposal(
      {
        kind: 'commitment',
        title: 'Póliza vencida la semana pasada',
        rationale: '',
        payload: { title: 'Póliza', dueOn: '2026-03-02', kind: 'policy' },
      },
      TODAY,
    );
    expect(result.ok).toBe(true);
  });

  it('acepta una rutina y la cuenta en español', () => {
    const result = normalizeProposal(
      {
        kind: 'routine',
        title: 'Revisión de los lunes',
        rationale: 'Dijiste que los lunes revisan los despachos',
        payload: {
          name: 'Revisión de los lunes',
          cron: '0 7 * * 1',
          instruction: 'Dime qué despachos quedaron abiertos la semana pasada.',
        },
      },
      TODAY,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const fields = itemFields(result.item);
      expect(fields[0]?.value).toBe('los lunes a las 07:00');
    }
  });
});

/**
 * El bloque que importa si el modelo se porta mal, que es el supuesto con el
 * que hay que diseñar. Ninguna de estas decisiones es suya: son código.
 */
describe('una rutina no puede prometer lo que la fila creada no hace', () => {
  function routine(instruction: string) {
    return normalizeProposal(
      {
        kind: 'routine',
        title: 'Aviso al cliente',
        rationale: '',
        payload: { name: 'Aviso al cliente', cron: '0 7 * * 1', instruction },
      },
      TODAY,
    );
  }

  it('rechaza una rutina que dice que va a mandar algo', () => {
    // Se crea con allow_unattended_writes = false. Diría que manda y no manda.
    const result = routine('Envía un correo al cliente contándole cómo va su carga.');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.route).toBe('scope');
      expect(result.reason).toContain('no manda');
    }
  });

  it('rechaza también las formas con pronombre hacia afuera', () => {
    expect(routine('Avísale al cliente por WhatsApp cuando llegue el contenedor.').ok).toBe(false);
    expect(routine('Llámalo si no ha contestado en dos días.').ok).toBe(false);
    expect(routine('Págale al proveedor lo que quede pendiente.').ok).toBe(false);
  });

  it('pero sí acepta que te informe a ti, que es lo único que sabe hacer', () => {
    expect(routine('Envíame un resumen de los despachos que quedaron abiertos.').ok).toBe(true);
    expect(routine('Mándame el listado de lo que se vence esta semana.').ok).toBe(true);
    expect(routine('Dime qué facturas siguen sin pagar y de quién son.').ok).toBe(true);
  });

  it('manda a trámites lo que exige entrar a un portal', () => {
    const result = routine('Todos los lunes entra al RUNT y revisa los comparendos de la flota.');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.route).toBe('tramite');
  });

  it('no promete leer posiciones en vivo', () => {
    const result = routine('Revisa el GPS de los camiones y dime dónde están en tiempo real.');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.route).toBe('scope');
  });

  it('no le aplica la regla a un flujo: sus pasos los hacen personas', () => {
    const result = normalizeProposal(
      {
        kind: 'flow',
        title: 'Llegada de contenedor',
        rationale: '',
        payload: {
          name: 'Llegada de contenedor',
          steps: [
            { title: 'Revisar', detail: 'Revisar la documentación del contenedor.', checkpoint: false },
            { title: 'Avisar', detail: 'El auxiliar envía el correo al cliente.', checkpoint: true },
          ],
        },
      },
      TODAY,
    );
    expect(result.ok).toBe(true);
  });
});

describe('lo rechazado va al cajón correcto', () => {
  it('un tipo que es un trámite se reconoce como trámite, no como "error"', () => {
    const result = normalizeProposal(
      { kind: 'tramite', title: 'Sacar el RUT', rationale: '', payload: {} },
      TODAY,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.route).toBe('tramite');
  });

  it('un tipo que no existe se cuenta como fuera de alcance', () => {
    const result = normalizeProposal(
      { kind: 'erp_sync', title: 'Sincronizar con el ERP', rationale: '', payload: {} },
      TODAY,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.route).toBe('scope');
  });

  it('un dato que faltó no se le presenta a nadie como una limitación', () => {
    // «Faltó la fecha» es una pregunta pendiente, no algo que el producto no
    // sepa hacer. Se calla y se vuelve a preguntar.
    const result = normalizeProposal(
      {
        kind: 'commitment',
        title: 'El SOAT',
        rationale: '',
        payload: { title: 'El SOAT', kind: 'soat' },
      },
      TODAY,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.route).toBeNull();
  });
});

describe('cuántas preguntas y cuándo callarse', () => {
  it('no propone nada si lo único que se dijo fueron cuatro palabras', () => {
    // El piso. Ni el modelo ni el botón se lo saltan: proponer sobre 20
    // caracteres es adivinar.
    expect(
      decideStop({ askedCount: 0, modelSaysEnough: true, answers: ['somos una empresa'] }),
    ).toBeNull();
    expect(
      decideStop({
        askedCount: 0,
        modelSaysEnough: false,
        answers: ['somos una empresa'],
        forced: true,
      }),
    ).toBeNull();
  });

  it('para cuando el modelo dice que ya puede proponer', () => {
    expect(decideStop({ askedCount: 1, modelSaysEnough: true, answers: [OPENING, 'sí'] })).toBe(
      'enough',
    );
  });

  it('para al llegar al tope aunque el modelo quiera seguir', () => {
    expect(
      decideStop({
        askedCount: MAX_QUESTIONS,
        modelSaysEnough: false,
        answers: [OPENING, 'a', 'b', 'c', 'd', 'e'],
      }),
    ).toBe('cap');
  });

  it('para cuando la persona ya se cansó', () => {
    expect(
      decideStop({ askedCount: 2, modelSaysEnough: false, answers: [OPENING, 'no', 'no sé'] }),
    ).toBe('thin');
  });

  it('para cuando la persona lo pide', () => {
    expect(
      decideStop({
        askedCount: 2,
        modelSaysEnough: false,
        answers: [OPENING, 'una respuesta larga y útil', 'otra'],
        forced: true,
      }),
    ).toBe('asked');
  });

  it('sigue preguntando mientras haya respuestas con sustancia y quede cupo', () => {
    expect(
      decideStop({
        askedCount: 2,
        modelSaysEnough: false,
        answers: [OPENING, 'despachamos carga refrigerada a Buenaventura', 'usamos tres termoking'],
      }),
    ).toBeNull();
  });

  it('reconoce una respuesta que no aporta', () => {
    expect(isThinAnswer('no')).toBe(true);
    expect(isThinAnswer('  ')).toBe(true);
    expect(isThinAnswer('no sé')).toBe(true);
    expect(isThinAnswer('cadena de frío a -18 grados')).toBe(false);
  });
});

describe('detalles que se ven en pantalla', () => {
  it('dice los horarios como los diría una persona', () => {
    expect(cronPhrase('0 8 * * *')).toBe('todos los días a las 08:00');
    expect(cronPhrase('30 6 * * 1,2,3,4,5')).toBe('de lunes a viernes a las 06:30');
    expect(cronPhrase('0 9 1 * *')).toBe('el 1 de cada mes a las 09:00');
    // Lo que no entiende lo muestra crudo en vez de inventar una frase.
    expect(cronPhrase('*/15 * * * *')).toBe('*/15 * * * *');
  });

  it('convierte un nombre en un identificador válido para un flujo', () => {
    expect(slugify('Recepción de carga refrigerada')).toBe('recepcion-de-carga-refrigerada');
    expect(slugify('  ¡!  ')).toMatch(/^flujo-/);
  });
});

describe('qué se puede deshacer', () => {
  const base: SetupItem = {
    id: 'i1',
    kind: 'client',
    title: 'Alpina',
    rationale: '',
    payload: { name: 'Alpina' },
    status: 'created',
    targetTable: 'clients',
    targetId: 'c1',
    error: null,
  };

  it('lo creado se deshace', () => {
    expect(undoability(base).can).toBe(true);
  });

  it('un cliente que ya existía no se borra, y se dice por qué', () => {
    const merged = undoability({ ...base, status: 'merged' });
    expect(merged.can).toBe(false);
    expect(merged.note).toContain('ya existía');
  });

  it('lo que nunca se creó no ofrece deshacer', () => {
    expect(undoability({ ...base, status: 'proposed' }).can).toBe(false);
    expect(undoability({ ...base, status: 'failed' }).can).toBe(false);
  });
});
