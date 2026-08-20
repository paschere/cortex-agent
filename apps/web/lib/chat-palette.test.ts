import { listTools } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import {
  MENTION_MIN_CHARS,
  type PaletteGroup,
  STATIC_COMMAND_GROUP,
  filterPalette,
  flattenPalette,
  fold,
  mentionAtCaret,
  paletteSize,
  slashQuery,
} from './chat-palette-shape';
import {
  TOOL_PHRASE,
  type ToolAvailability,
  cronPhrase,
  dropDuplicateCommands,
  siteName,
  toolPaletteGroups,
  usableToolIds,
} from './chat-palette-tools';

/**
 * Lo que se prueba aquí es el filtrado y el agrupado, que es donde vive todo lo
 * que puede salir mal sin que nadie lo note: una sección que falló dibujada
 * como una sección vacía, una tilde que esconde el trámite que sí existe, una
 * herramienta ofrecida a quien su equipo se la bloqueó. Nada de esto se ve en
 * una captura de pantalla, y todo se ve aquí.
 */

function group(id: string, labels: string[], extra: Partial<PaletteGroup> = {}): PaletteGroup {
  return {
    id,
    heading: id,
    icon: 'Wrench',
    items: labels.map((label) => ({ id: label, label, hint: null, expands: `${label} ` })),
    ...extra,
  };
}

describe('fold', () => {
  it('quita tildes y baja a minúsculas', () => {
    expect(fold('Trámite Ágil')).toBe('tramite agil');
  });

  it('deja la eñe en paz — «ñ» y «n» son letras distintas', () => {
    expect(fold('Mañana')).toBe('mañana');
  });
});

describe('filterPalette', () => {
  const groups = [
    group('rutinas', ['Informe semanal', 'Cobro de cartera']),
    group('tramites', ['Certificado de tradición', 'Paz y salvo']),
  ];

  it('sin consulta deja los grupos en su orden y sin recortar cuando caben', () => {
    const out = filterPalette(groups, '');
    expect(out.map((g) => g.id)).toEqual(['rutinas', 'tramites']);
    expect(paletteSize(out)).toBe(4);
    expect(out.every((g) => g.more === undefined)).toBe(true);
  });

  it('empareja sin tildes en los dos sentidos', () => {
    expect(filterPalette(groups, 'tradicion')[0]?.items[0]?.label).toBe('Certificado de tradición');
    expect(filterPalette(groups, 'TRADICIÓN')[0]?.items[0]?.label).toBe('Certificado de tradición');
  });

  it('exige TODAS las palabras de la consulta, en cualquier orden', () => {
    expect(paletteSize(filterPalette(groups, 'informe semanal'))).toBe(1);
    expect(paletteSize(filterPalette(groups, 'semanal informe'))).toBe(1);
    expect(paletteSize(filterPalette(groups, 'informe mensual'))).toBe(0);
  });

  it('también busca en la pista y en las palabras invisibles', () => {
    const withKeywords = [
      {
        ...group('herramientas', ['Busca en Gmail']),
        items: [
          {
            id: 'gmail.search',
            label: 'Busca en Gmail',
            hint: 'Gmail',
            expands: 'Busca en Gmail ',
            keywords: 'gmail.search',
          },
        ],
      },
    ];
    expect(paletteSize(filterPalette(withKeywords, 'gmail.search'))).toBe(1);
  });

  it('bota los grupos que se quedan sin filas', () => {
    const out = filterPalette(groups, 'informe');
    expect(out.map((g) => g.id)).toEqual(['rutinas']);
  });

  it('CONSERVA un grupo que falló aunque no tenga filas, con y sin consulta', () => {
    const broken = [group('rutinas', [], { error: 'No pude leer tus rutinas.' })];
    expect(filterPalette(broken, '')[0]?.error).toBe('No pude leer tus rutinas.');
    expect(filterPalette(broken, 'lo que sea')[0]?.error).toBe('No pude leer tus rutinas.');
  });

  it('en reposo recorta cada grupo y cuenta lo que escondió', () => {
    const many = [group('herramientas', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])];
    const out = filterPalette(many, '', 6);
    expect(out[0]?.items).toHaveLength(6);
    expect(out[0]?.more).toBe(2);
  });

  it('en cuanto hay consulta muestra todo lo que empareja, sin tope', () => {
    const many = [group('herramientas', ['ax', 'bx', 'cx', 'dx', 'ex', 'fx', 'gx', 'hx'])];
    const out = filterPalette(many, 'x', 6);
    expect(out[0]?.items).toHaveLength(8);
    expect(out[0]?.more).toBeUndefined();
  });
});

describe('flattenPalette', () => {
  it('devuelve las filas seleccionables en el orden en que se ven', () => {
    const flat = flattenPalette([group('a', ['uno', 'dos']), group('b', ['tres'])]);
    expect(flat.map((row) => `${row.groupId}:${row.item.label}`)).toEqual([
      'a:uno',
      'a:dos',
      'b:tres',
    ]);
  });

  it('no cuenta los encabezados ni los grupos vacíos', () => {
    expect(paletteSize([group('a', []), group('b', ['uno'])])).toBe(1);
  });
});

describe('slashQuery', () => {
  it('devuelve lo tecleado después de la barra', () => {
    expect(slashQuery('/ruti')).toBe('ruti');
    expect(slashQuery('/')).toBe('');
  });

  it('acepta espacios, porque los nombres de las rutinas los tienen', () => {
    expect(slashQuery('/informe sem')).toBe('informe sem');
  });

  it('no es un comando si no empieza con barra', () => {
    expect(slashQuery('hola /ruti')).toBeNull();
  });

  it('se rinde con un párrafo: alguien está escribiendo, no eligiendo', () => {
    expect(slashQuery(`/${'a'.repeat(60)}`)).toBeNull();
    expect(slashQuery('/algo\ny otra línea')).toBeNull();
  });
});

describe('mentionAtCaret', () => {
  it('encuentra la mención que se está tecleando', () => {
    expect(mentionAtCaret('hola @col', 9)).toEqual({ query: 'col', start: 5 });
  });

  it('una dirección de correo no es una mención', () => {
    expect(mentionAtCaret('escribe a juan@empresa.com', 26)).toBeNull();
  });

  it('un espacio la cierra', () => {
    expect(mentionAtCaret('@Coltrans y ', 12)).toBeNull();
  });

  it('mira el cursor, no el final del texto', () => {
    expect(mentionAtCaret('@col y algo más', 4)).toEqual({ query: 'col', start: 0 });
  });

  it('dos letras es el mínimo con el que la ruta contesta', () => {
    expect(MENTION_MIN_CHARS).toBe(2);
  });
});

describe('usableToolIds', () => {
  const tool = (id: string, extra: Partial<ToolAvailability> = {}): ToolAvailability => ({
    id,
    providers: [],
    missingCredentials: [],
    blockingCredential: true,
    ...extra,
  });

  it('un agente con `*` tiene todo', () => {
    const out = usableToolIds([tool('gmail.search'), tool('kb.search')], {
      denied: [],
      granted: ['*'],
      connectedProviders: new Set(),
    });
    expect(out).toEqual(['gmail.search', 'kb.search']);
  });

  it('respeta el comodín por familia y descarta lo no concedido', () => {
    const out = usableToolIds([tool('gmail.search'), tool('kb.search')], {
      denied: [],
      granted: ['gmail.*'],
      connectedProviders: new Set(),
    });
    expect(out).toEqual(['gmail.search']);
  });

  it('lo que un equipo bloquea no se ofrece, aunque el agente lo conceda', () => {
    const out = usableToolIds([tool('gmail.send_draft'), tool('gmail.search')], {
      denied: ['gmail.send_draft'],
      granted: ['*'],
      connectedProviders: new Set(),
    });
    expect(out).toEqual(['gmail.search']);
  });

  it('sin la integración conectada, la herramienta no existe para este menú', () => {
    const out = usableToolIds([tool('gmail.search', { providers: ['google'] })], {
      denied: [],
      granted: ['*'],
      connectedProviders: new Set(),
    });
    expect(out).toEqual([]);
  });

  it('una credencial que sólo DEGRADA no la esconde', () => {
    const out = usableToolIds(
      [
        tool('kb.search', { missingCredentials: ['VOYAGE_API_KEY'], blockingCredential: false }),
        tool('vehicles.check_runt', {
          missingCredentials: ['VEHICLES_SCRAPER_URL'],
          blockingCredential: true,
        }),
      ],
      { denied: [], granted: ['*'], connectedProviders: new Set() },
    );
    expect(out).toEqual(['kb.search']);
  });
});

describe('toolPaletteGroups', () => {
  it('agrupa por capacidad y no por familia, en el orden fijo del catálogo', () => {
    const out = toolPaletteGroups(['gmail.search', 'gcal.list_events', 'hubspot.search_deals']);
    // «Clientes y negocios» va antes que «Escribir y responder», y ésa antes que
    // «Agenda y reuniones»: es el orden de CAPABILITY_GROUPS y no el alfabético.
    expect(out.map((g) => g.heading)).toEqual([
      'Clientes y negocios',
      'Escribir y responder',
      'Agenda y reuniones',
    ]);
  });

  it('la fila dice la frase en español y eso mismo es lo que se escribe', () => {
    const [comms] = toolPaletteGroups(['gmail.search']);
    const item = comms?.items[0];
    expect(item?.label).toBe('Busca en Gmail');
    expect(item?.expands).toBe('Busca en Gmail ');
    expect(item?.hint).toBe('Gmail');
    // El id crudo se busca pero no se muestra.
    expect(item?.keywords).toBe('gmail.search');
  });

  it('una herramienta sin frase curada NO se ofrece — no se cae al inglés', () => {
    expect(toolPaletteGroups(['inventada.sin_frase'])).toEqual([]);
  });

  it('las herramientas propias entran con el nombre que les puso la empresa', () => {
    const out = toolPaletteGroups(
      [],
      [{ id: 'facturacion', name: 'Consultar cartera', description: 'API interna' }],
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.heading).toBe('Herramientas propias');
    expect(out[0]?.items[0]?.expands).toBe('Usa «Consultar cartera» para ');
  });
});

describe('dropDuplicateCommands', () => {
  it('quita del catálogo lo que un comando fijo ya ofrece con la misma frase', () => {
    const out = dropDuplicateCommands(toolPaletteGroups(['errands.start', 'kb.search']));
    const expansions = out.flatMap((g) => g.items.map((i) => i.expands));
    // `/encargo` ya expande a «Investígame ».
    expect(expansions).not.toContain('Investígame ');
    // `/buscar` expande a otra frase más larga, así que kb.search se queda.
    expect(expansions).toContain('Busca en Brain Knowledge ');
  });

  it('deja intacto un grupo que falló', () => {
    const broken: PaletteGroup[] = [group('rutinas', [], { error: 'No pude leer tus rutinas.' })];
    expect(dropDuplicateCommands(broken)).toHaveLength(1);
  });
});

describe('cronPhrase', () => {
  it('dice en palabras las formas que la gente usa', () => {
    expect(cronPhrase('0 8 * * 1', 'America/Bogota')).toBe('todos los lunes a las 08:00');
    expect(cronPhrase('30 6 * * *', 'America/Bogota')).toBe('todos los días a las 06:30');
    expect(cronPhrase('0 9 * * 1-5', 'America/Bogota')).toBe('de lunes a viernes a las 09:00');
    expect(cronPhrase('0 7 1 * *', 'America/Bogota')).toBe('el día 1 de cada mes a las 07:00');
  });

  it('nombra la zona sólo cuando es UTC, que es la que nadie tiene en la cabeza', () => {
    expect(cronPhrase('0 8 * * *', 'UTC')).toBe('todos los días a las 08:00 UTC');
  });

  it('ante un cron que no entiende devuelve el cron, no una frase inventada', () => {
    expect(cronPhrase('*/15 * * * *', 'America/Bogota')).toBe('*/15 * * * *');
    expect(cronPhrase('no es un cron', 'America/Bogota')).toBe('no es un cron');
  });

  it('sin cron, la rutina corre una sola vez', () => {
    expect(cronPhrase(null, 'America/Bogota')).toBe('una sola vez');
  });
});

describe('siteName', () => {
  it('deja el host pelado', () => {
    expect(siteName('https://www.runt.gov.co')).toBe('runt.gov.co');
    expect(siteName('http://muisca.dian.gov.co')).toBe('muisca.dian.gov.co');
    expect(siteName(null)).toBeNull();
  });
});

/**
 * El mapa de frases es una copia por id del registro, y las copias derivan. Sin
 * esta prueba, renombrar `gmail.search` deja una fila muerta que nadie ve fallar
 * porque simplemente no aparece.
 */
describe('TOOL_PHRASE contra el registro real', () => {
  it('no nombra ninguna herramienta que no exista', () => {
    const registered = new Set(listTools().map((tool) => tool.id));
    const orphans = Object.keys(TOOL_PHRASE).filter((id) => !registered.has(id));
    expect(orphans).toEqual([]);
  });

  it('cubre el catálogo salvo lo que es fontanería y no una petición', () => {
    // `whatsapp.inbound` la dispara un webhook, no una persona; `test.*` no
    // existe fuera de las pruebas del paquete. Los pasos de la pestaña viva
    // (browser v2) los da el bot dentro de una sesión que abrió open_page:
    // nadie teclea «dame un click en e5» en el menú /.
    const skip = new Set([
      'whatsapp.inbound',
      'browser.act',
      'browser.read_page',
      'browser.ask_person',
      'browser.request_secret',
      'browser.close_page',
    ]);
    const missing = listTools()
      .map((tool) => tool.id)
      .filter((id) => !id.startsWith('test.') && !skip.has(id) && !TOOL_PHRASE[id]);
    expect(missing).toEqual([]);
  });
});

describe('los comandos de siempre', () => {
  it('siguen siendo nueve y siguen siendo los mismos', () => {
    expect(STATIC_COMMAND_GROUP.items.map((item) => item.label)).toEqual([
      '/vencimientos',
      '/placa',
      '/informe',
      '/grafica',
      '/buscar',
      '/rutina',
      '/encargo',
      '/tramite',
      '/briefing',
    ]);
  });

  it('se encuentran tecleando sin tilde lo que se escribe con tilde', () => {
    const out = filterPalette([STATIC_COMMAND_GROUP], 'grafica');
    expect(out[0]?.items[0]?.label).toBe('/grafica');
  });

  it('/briefing pregunta por las colas, no por HubSpot', () => {
    const briefing = STATIC_COMMAND_GROUP.items.find((item) => item.id === '/briefing');
    expect(briefing?.expands).toBe('¿Qué está esperando algo de mí?');
    expect(briefing?.hint).toBe('Qué te espera hoy');
  });

  it('GitHub y Linear no ocupan el / en reposo, y aparecen al buscarlos', () => {
    const eng: PaletteGroup = {
      id: 'tools:eng',
      heading: 'Ingeniería',
      icon: 'Hammer',
      items: [
        {
          id: 'github.list_repositories',
          label: 'Muéstrame los repositorios de GitHub',
          hint: 'GitHub',
          expands: 'Muéstrame los repositorios de GitHub',
        },
      ],
    };
    expect(filterPalette([eng], '')).toEqual([]);
    expect(filterPalette([eng], 'github')[0]?.items).toHaveLength(1);
  });
});
