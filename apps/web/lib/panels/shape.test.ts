import { getTool } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import {
  PANELS,
  type PanelId,
  isPanelId,
  panelForHref,
  panelFromSearch,
  searchWithPanel,
} from './shape';

/**
 * Este test vive en `lib/` y no en el árbol de `panels/` de cliente a
 * propósito: es el ÚNICO sitio de todo el camino del panel donde se puede
 * importar un valor de `@cortex/agent-tools`. Un test corre en Node; un
 * componente de cliente no. Y es justo lo que hace falta para comprobar que los
 * cinco `toolId` de `shape.ts` existen de verdad — una cadena mal escrita ahí
 * es un panel que abre un 404 y nada más lo vería.
 */

describe('los cinco paneles apuntan a herramientas que existen', () => {
  it('cada toolId está registrado', () => {
    for (const [id, shape] of Object.entries(PANELS)) {
      expect(getTool(shape.toolId), `el panel «${id}» apunta a ${shape.toolId}`).toBeTruthy();
    }
  });

  it('la entrada fija pasa el esquema de su herramienta', () => {
    // Un panel con una entrada que no valida no falla al escribirlo: falla la
    // primera vez que alguien lo abre, con un error de validación en vez de
    // datos. Aquí se ve al guardar el archivo.
    for (const [id, shape] of Object.entries(PANELS)) {
      const tool = getTool(shape.toolId);
      const parsed = tool?.inputSchema.safeParse(shape.input);
      expect(parsed?.success, `la entrada del panel «${id}» no valida`).toBe(true);
    }
  });

  it('cada panel resume una pantalla distinta', () => {
    const hrefs = Object.values(PANELS).map((p) => p.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe('lo que llega del navegador es una palabra, no una herramienta', () => {
  it('sólo pasan los cinco ids', () => {
    expect(isPanelId('payments')).toBe(true);
    // La razón por la que el `toolId` no viaja: si viajara, esto sería un
    // ejecutor de herramientas arbitrario con la sesión de quien pulsa.
    expect(isPanelId('gmail.send_message')).toBe(false);
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
    const ids: PanelId[] = ['payments', 'commitments', 'errands', 'reports', 'approvals'];
    expect(Object.keys(PANELS).sort()).toEqual([...ids].sort());
  });
});
