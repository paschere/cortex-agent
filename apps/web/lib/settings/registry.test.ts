import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODULES, type ModuleKey } from '@cortex/agent-tools/src/modules/catalog';
import { describe, expect, it } from 'vitest';
import {
  SETTINGS_GROUPS,
  SETTINGS_REGISTRY,
  type SettingsEntry,
  type SettingsViewer,
  entryForAnchor,
  normalize,
  searchSettings,
  visibleSettings,
} from './registry';

const allOn = new Set<ModuleKey>(MODULES.map((m) => m.key));
const viewer = (over: Partial<SettingsViewer> = {}): SettingsViewer => ({
  admin: true,
  teamManager: true,
  modulesOn: allOn,
  ...over,
});

/** Las rutas reales de la app: cada `page.tsx` bajo app/, sin los grupos `(x)`. */
function appRoutes(): string[] {
  const root = fileURLToPath(new URL('../../app/', import.meta.url));
  const out: string[] = [];
  const walk = (dir: string, segs: string[]) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        const isGroup = name.startsWith('(') && name.endsWith(')');
        walk(full, isGroup ? segs : [...segs, name]);
      } else if (name === 'page.tsx') {
        out.push(`/${segs.join('/')}`.replace(/\/$/, '') || '/');
      }
    }
  };
  walk(root, []);
  return out;
}

function isRealRoute(href: string, routes: string[]): boolean {
  const path = href.split('#')[0]?.split('?')[0] ?? href;
  return routes.some((route) => {
    if (route === path) return true;
    if (!route.includes('[')) return false;
    const pattern = new RegExp(`^${route.replace(/\[[^\]]+\]/g, '[^/]+')}$`);
    return pattern.test(path);
  });
}

describe('el registro de ajustes', () => {
  it('cada entrada tiene un id único, un grupo que existe y texto en español', () => {
    const ids = SETTINGS_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size, 'hay un id repetido').toBe(ids.length);
    const groups = new Set(SETTINGS_GROUPS.map((g) => g.id));
    for (const e of SETTINGS_REGISTRY) {
      expect(groups.has(e.group), `${e.id}: grupo desconocido`).toBe(true);
      expect(e.title.length, `${e.id}: sin título`).toBeGreaterThan(2);
      expect(e.description.length, `${e.id}: sin explicación`).toBeGreaterThan(10);
      expect(e.keywords.length, `${e.id}: sin palabras clave`).toBeGreaterThan(0);
    }
  });

  it('cada grupo tiene al menos un ajuste', () => {
    for (const g of SETTINGS_GROUPS) {
      expect(
        SETTINGS_REGISTRY.some((e) => e.group === g.id),
        g.id,
      ).toBe(true);
    }
  });

  it('cada href es una ruta real de la app (o una página legal pública)', () => {
    const routes = appRoutes();
    const bad = SETTINGS_REGISTRY.filter((e) => e.href && !isRealRoute(e.href, routes)).map(
      (e) => `${e.id} → ${e.href}`,
    );
    expect(bad, 'entradas que apuntan a una pantalla que no existe').toEqual([]);
  });

  it('una entrada sin pantalla es Próximamente o trae su control en línea', () => {
    for (const e of SETTINGS_REGISTRY) {
      if (!e.href) expect(e.soon || e.inline, `${e.id} no lleva a ningún lado`).toBeTruthy();
      if (e.soon) expect(e.href, `${e.id} dice Próximamente pero enlaza`).toBeUndefined();
    }
  });

  it('los módulos que nombra existen', () => {
    for (const e of SETTINGS_REGISTRY) {
      if (e.module) expect(allOn.has(e.module), `${e.id}: ${e.module}`).toBe(true);
    }
  });

  it('cubre todo lo que vivía suelto (nada se perdió al reunirlo)', () => {
    const hrefs = new Set(SETTINGS_REGISTRY.map((e) => e.href?.split('#')[0]?.split('?')[0]));
    for (const must of [
      '/company',
      '/admin/users',
      '/admin/teams',
      '/admin/security',
      '/admin/mandates',
      '/admin/usage',
      '/admin/audit',
      '/plan',
      '/integrations',
      '/piloto',
      '/team/medir',
      '/tools',
      '/mcp-tokens',
      '/integrations/whatsapp/atencion',
      '/ayuda/soporte',
      '/impuestos',
      '/settings/voice',
      '/settings/memory',
      '/settings/mail-learning',
      '/settings/modulos',
      '/settings/privacidad',
    ]) {
      expect(hrefs.has(must), `falta ${must}`).toBe(true);
    }
  });
});

describe('quién ve qué', () => {
  it('quien administra ve todo con todos los módulos prendidos', () => {
    const v = visibleSettings(viewer());
    expect(v.entries).toHaveLength(SETTINGS_REGISTRY.length);
    expect(v.hiddenByModule).toBe(0);
    expect(v.hiddenByRole).toBe(0);
  });

  it('un miembro no ve lo de administración y se cuenta aparte', () => {
    const v = visibleSettings(viewer({ admin: false, teamManager: false }));
    const ids = v.entries.map((e) => e.id);
    for (const hidden of ['personas', 'equipos', 'sin-preguntar', 'auditoria', 'uso', 'medir']) {
      expect(ids, hidden).not.toContain(hidden);
    }
    for (const kept of ['perfil', 'plan', 'datos-empresa', 'modulos', 'mcp-tokens', 'soporte']) {
      expect(ids, kept).toContain(kept);
    }
    expect(v.hiddenByRole).toBeGreaterThan(0);
  });

  it('un fundador sin ser admin ve «Qué se mide» pero no las pantallas de /admin', () => {
    const v = visibleSettings(viewer({ admin: false, teamManager: true }));
    const ids = v.entries.map((e) => e.id);
    expect(ids).toContain('medir');
    expect(ids).not.toContain('personas');
  });

  it('un módulo apagado esconde sus ajustes y los cuenta', () => {
    const on = new Set(allOn);
    on.delete('payroll');
    on.delete('autopilot');
    const v = visibleSettings(viewer({ modulesOn: on }));
    const ids = v.entries.map((e) => e.id);
    expect(ids).not.toContain('ajustes-nomina');
    expect(ids).not.toContain('piloto');
    expect(v.hiddenByModule).toBe(2);
  });

  it('lo que el rol esconde no se cuenta como «módulo apagado»', () => {
    const on = new Set(allOn);
    on.delete('team');
    const v = visibleSettings(viewer({ admin: false, teamManager: false, modulesOn: on }));
    expect(v.entries.map((e) => e.id)).not.toContain('medir');
    expect(v.hiddenByModule).toBe(0);
  });
});

describe('la búsqueda', () => {
  const ids = (q: string) => searchSettings(SETTINGS_REGISTRY, q).map((e) => e.id);

  it('no distingue tildes ni mayúsculas', () => {
    expect(normalize('  NÓMINA  ')).toBe('nomina');
    expect(ids('nomina')).toEqual(ids('NÓMINA'));
    expect(ids('nómina')).toContain('ajustes-nomina');
    expect(ids('contrasena')).toContain('seguridad-cuenta');
    expect(ids('contraseña')).toContain('seguridad-cuenta');
  });

  it('sin consulta devuelve todo en el orden del registro', () => {
    expect(ids('')).toEqual(SETTINGS_REGISTRY.map((e) => e.id));
    expect(ids('   ')).toHaveLength(SETTINGS_REGISTRY.length);
  });

  it('el título pesa más que una palabra clave suelta', () => {
    expect(ids('voz')[0]).toBe('voz');
    expect(ids('modulos')[0]).toBe('modulos');
    expect(ids('plan')[0]).toBe('plan');
  });

  it('encuentra por cómo lo diría la gente, incluidos ajustes de otras pantallas', () => {
    expect(ids('tema oscuro')[0]).toBe('apariencia');
    expect(ids('claude')).toContain('mcp-tokens');
    expect(ids('siigo')).toContain('contables');
    expect(ids('zona horaria')[0]).toBe('notificaciones');
    expect(ids('wompi')).toContain('plan');
    expect(ids('2fa')).toContain('seguridad-cuenta');
    expect(ids('mandatos')).toContain('sin-preguntar');
    expect(ids('logo')).toContain('marca');
  });

  it('exige todas las palabras', () => {
    expect(ids('plan pago')).toContain('plan');
    expect(ids('plan xyzzy')).toEqual([]);
  });

  it('sin coincidencias devuelve vacío', () => {
    expect(ids('zzzz')).toEqual([]);
  });

  it('no inventa resultados sobre una lista ya filtrada por rol y módulo', () => {
    const v = visibleSettings(viewer({ admin: false, teamManager: false }));
    const hit = searchSettings(v.entries, 'auditoria').map((e: SettingsEntry) => e.id);
    expect(hit).not.toContain('auditoria');
  });
});

describe('los enlaces viejos', () => {
  it('cada ancla de antes lleva a la entrada que la heredó', () => {
    expect(entryForAnchor('#correo')?.id).toBe('correo');
    expect(entryForAnchor('resumen')?.id).toBe('notificaciones');
    expect(entryForAnchor('#cuenta')?.id).toBe('perfil');
    expect(entryForAnchor('cerebro')?.id).toBe('memoria');
    expect(entryForAnchor('privacidad')?.id).toBe('tus-datos');
    expect(entryForAnchor('no-existe')).toBeNull();
  });
});
