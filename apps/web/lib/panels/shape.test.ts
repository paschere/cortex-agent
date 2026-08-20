import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTool } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import {
  PANELS,
  type PanelId,
  isPanelId,
  panelForHref,
  panelFromSearch,
  panelKeyFromSearch,
  resolvePanelInput,
  searchWithPanel,
} from './shape';

/**
 * Este test vive en `lib/` y no en el árbol de `panels/` de cliente a
 * propósito: es el ÚNICO sitio de todo el camino del panel donde se puede
 * importar un valor de `@cortex/agent-tools`. Un test corre en Node; un
 * componente de cliente no. Y es justo lo que hace falta para comprobar que los
 * `toolId` de `shape.ts` existen de verdad — una cadena mal escrita ahí
 * es un panel que abre un 404 y nada más lo vería.
 */

describe('los paneles apuntan a herramientas que existen', () => {
  it('cada toolId está registrado', () => {
    for (const [id, shape] of Object.entries(PANELS)) {
      expect(getTool(shape.toolId), `el panel «${id}» apunta a ${shape.toolId}`).toBeTruthy();
    }
  });

  it('la entrada fija pasa el esquema de su herramienta', () => {
    // Un panel con una entrada que no valida no falla al escribirlo: falla la
    // primera vez que alguien lo abre, con un error de validación en vez de
    // datos. Aquí se ve al guardar el archivo. Las superficies con clave no
    // tienen una entrada completa hasta que llega la clave, y eso lo cubre
    // `resolvePanelInput`.
    for (const [id, shape] of Object.entries(PANELS)) {
      if (shape.keyed) continue;
      const tool = getTool(shape.toolId);
      const parsed = tool?.inputSchema.safeParse(shape.input);
      expect(parsed?.success, `la entrada del panel «${id}» no valida`).toBe(true);
    }
  });

  it('cada panel sin clave resume una pantalla distinta', () => {
    const hrefs = Object.values(PANELS)
      .filter((p) => !p.keyed)
      .map((p) => p.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('una superficie con clave declara el campo donde va', () => {
    for (const [id, shape] of Object.entries(PANELS)) {
      if (!shape.keyed) continue;
      expect(shape.keyField, `«${id}» es keyed sin keyField`).toBeTruthy();
    }
  });
});

describe('lo que llega del navegador es una palabra, no una herramienta', () => {
  it('sólo pasan los ids de la tabla', () => {
    expect(isPanelId('payments')).toBe(true);
    expect(isPanelId('clients')).toBe(true);
    expect(isPanelId('client')).toBe(true);
    // La razón por la que el `toolId` no viaja: si viajara, esto sería un
    // ejecutor de herramientas arbitrario con la sesión de quien pulsa.
    expect(isPanelId('gmail.send_message')).toBe(false);
    expect(isPanelId('clients.overview')).toBe(false);
    expect(isPanelId('__proto__')).toBe(false);
    expect(isPanelId('toString')).toBe(false);
    expect(isPanelId(null)).toBe(false);
    expect(isPanelId(42)).toBe(false);
  });
});

describe('qué pantalla abre panel', () => {
  it('encuentra el panel de una pantalla que lo tiene', () => {
    expect(panelForHref('/payments')).toBe('payments');
    expect(panelForHref('/commitments')).toBe('commitments');
    expect(panelForHref('/clients')).toBe('clients');
  });

  it('un destino sin panel sigue siendo un destino', () => {
    // Diecinueve de los veinticuatro destinos del rail no tienen panel y
    // navegan como siempre. `/actions` está aquí a propósito: es la otra cola
    // de «esperando tu sí» y NO es la misma que `/approvals` — ver PANELS.
    expect(panelForHref('/actions')).toBeNull();
    expect(panelForHref('/kb')).toBeNull();
  });
});

describe('el panel en la dirección', () => {
  it('va y vuelve', () => {
    const search = searchWithPanel('', 'reports');
    expect(search).toBe('?panel=reports');
    expect(panelFromSearch(search)).toBe('reports');
  });

  it('una ficha lleva la clave y no un toolId', () => {
    const search = searchWithPanel('', 'client', 'coltrans-id');
    expect(search).toBe('?panel=client&key=coltrans-id');
    expect(panelFromSearch(search)).toBe('client');
    expect(panelKeyFromSearch(search)).toBe('coltrans-id');
  });

  it('cerrar un panel con clave también quita la clave', () => {
    expect(searchWithPanel('?panel=client&key=x', null)).toBe('');
  });

  it('no se lleva por delante lo que ya había', () => {
    const search = searchWithPanel('?desde=2026-01-01', 'payments');
    expect(panelFromSearch(search)).toBe('payments');
    expect(new URLSearchParams(search).get('desde')).toBe('2026-01-01');
  });

  it('cerrar deja la dirección como estaba', () => {
    expect(searchWithPanel('?panel=payments', null)).toBe('');
    expect(searchWithPanel('?panel=payments&desde=ayer', null)).toBe('?desde=ayer');
  });

  it('un panel inventado en la URL no abre nada', () => {
    expect(panelFromSearch('?panel=gmail.send_message')).toBeNull();
    expect(panelFromSearch('')).toBeNull();
  });

  it('los ids del tipo y los de la tabla son los mismos', () => {
    const ids: PanelId[] = [
      'payments',
      'commitments',
      'errands',
      'reports',
      'approvals',
      'clients',
      'client',
      'trackers',
      'tracker',
    ];
    expect(Object.keys(PANELS).sort()).toEqual([...ids].sort());
  });
});

describe('la entrada se arma en el servidor', () => {
  it('sin clave, la ficha no se abre', () => {
    expect(resolvePanelInput('client', null)).toEqual({
      ok: false,
      message: 'Falta qué abrir.',
    });
    expect(resolvePanelInput('client', '')).toMatchObject({ ok: false });
  });

  it('con clave, la pone en el campo que el servidor eligió', () => {
    expect(resolvePanelInput('client', '  andina  ')).toEqual({
      ok: true,
      input: { client: 'andina' },
    });
    expect(resolvePanelInput('tracker', 'remates')).toEqual({
      ok: true,
      input: { limit: 40, tracker: 'remates' },
    });
  });

  it('un panel sin clave ignora lo que venga de más', () => {
    expect(resolvePanelInput('payments', 'gmail.send_message')).toEqual({
      ok: true,
      input: {},
    });
  });
});

describe('la API de datos se entera de las tablas nuevas', () => {
  /**
   * El panel de «Tablas» fue quien descubrió el hueco: la 0115 creó `trackers`
   * DESPUÉS del cutover a Railway, `deploy-migrate` la aplicó bien, y aun así
   * el panel abría con «Could not find the table 'public.trackers' in the
   * schema cache» — el PostgREST de `services/pgrest` cachea el esquema al
   * arrancar y nadie le avisaba de los DDL (en Supabase avisan sus event
   * triggers de fábrica; en Railway no existían).
   *
   * Esto pinza la 0117: mientras haya una migración que instale un event
   * trigger sobre DDL que haga NOTIFY al canal `pgrst`, cada tabla futura
   * aparece en la API sin reiniciar nada. Si alguien la borra o le cambia el
   * canal, el siguiente panel nuevo volvería a nacer roto en producción y
   * verde en local — exactamente el fallo que no se ve hasta que lo ve el
   * dueño.
   */
  it('hay un vigía de DDL que recarga la caché de PostgREST', () => {
    const migrations = join(
      fileURLToPath(new URL('../../../../', import.meta.url)),
      'infra/supabase/migrations',
    );
    const texts = readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readFileSync(join(migrations, name), 'utf8'));

    const watcher = texts.find(
      (sql) => /create event trigger/i.test(sql) && /ddl_command_end/i.test(sql),
    );
    expect(watcher, 'ninguna migración instala el event trigger de DDL').toBeTruthy();
    // El canal es el que PostgREST escucha de fábrica (db-channel = pgrst);
    // `services/pgrest/start.sh` no lo cambia, así que aquí tampoco.
    expect(watcher).toMatch(/notify pgrst, 'reload schema'/i);
  });
});
