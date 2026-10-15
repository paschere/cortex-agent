import { describe, expect, it } from 'vitest';
import {
  PANEL_MESSAGE,
  appRefFromResult,
  appRefsFromList,
  appSyncKey,
  availableModes,
  changesApp,
  clampAppPanelWidth,
  defaultAppPanelWidth,
  editNote,
  latestAppRef,
  newChanges,
  parsePanelMessage,
  parseStoredMode,
  parseStoredWidth,
  publishNote,
  resolveMode,
  shouldRefresh,
  shouldSwitchFromDraft,
  statusLabel,
} from './chat-app-panel';
import { artifactMeta } from './chat-artifact';
import { isControlHandoffMessage } from './confirmation-notes';

const app = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  slug: 'control_vuelos',
  name: 'Control de vuelos de carga',
  icon: '✈️',
  status: 'draft',
  updatedAt: '2026-10-15T10:00:00Z',
  ...over,
});

describe('detección de la app en los resultados', () => {
  it('lee la app de create, update, apply_draft, publish y get', () => {
    for (const tool of [
      'apps.create',
      'apps.update',
      'apps.apply_draft',
      'apps.publish',
      'apps.get',
    ])
      expect(appRefFromResult(tool, { app: app() })?.id).toBe('a1');
    expect(appRefFromResult('apps_apply_draft', { app: app() })?.source).toBe('created');
    expect(
      appRefFromResult('apps.publish', { app: app({ status: 'published' }), version: 3 }),
    ).toMatchObject({
      status: 'published',
      version: 3,
      source: 'published',
    });
  });

  it('ignora errores, confirmaciones pendientes y herramientas ajenas', () => {
    expect(appRefFromResult('apps.update', { __error: 'x', app: app() })).toBeNull();
    expect(
      appRefFromResult('apps.update', { __requires_confirmation: true, app: app() }),
    ).toBeNull();
    expect(appRefFromResult('trackers.query', { app: app() })).toBeNull();
    expect(appRefFromResult('apps.get', { app: { id: 'x' } })).toBeNull();
    expect(appRefFromResult('apps.get', null)).toBeNull();
  });

  it('apps.list ofrece cada app para elegir una', () => {
    const refs = appRefsFromList({ apps: [app(), app({ id: 'a2', name: 'Otra' }), { nope: 1 }] });
    expect(refs.map((r) => r.id)).toEqual(['a1', 'a2']);
    expect(appRefsFromList({})).toEqual([]);
  });

  it('la app de la conversación es la última; una lectura no pisa un cambio de la misma app', () => {
    const calls = [
      { toolName: 'apps.create', state: 'result', result: { app: app() } },
      { toolName: 'apps.get', state: 'result', result: { app: app({ name: 'viejo' }) } },
    ];
    expect(latestAppRef(calls)?.name).toBe('Control de vuelos de carga');
    const other = [
      ...calls,
      { toolName: 'apps.get', state: 'result', result: { app: app({ id: 'b' }) } },
    ];
    expect(latestAppRef(other)?.id).toBe('b');
    expect(latestAppRef([{ toolName: 'apps.update', state: 'call' }])).toBeNull();
  });

  it('qué herramientas cambian la app', () => {
    expect(changesApp('apps.update')).toBe(true);
    expect(changesApp('apps.apply_draft')).toBe(true);
    expect(changesApp('apps.publish')).toBe(true);
    expect(changesApp('apps.get')).toBe(false);
  });

  it('artifactMeta registra la app como algo que se abre al lado', () => {
    const meta = artifactMeta('apps.apply_draft', { app: app() });
    expect(meta?.kind).toBe('app');
    expect(meta?.app?.id).toBe('a1');
    expect(meta?.title).toBe('Control de vuelos de carga');
    expect(artifactMeta('apps.update', { __error: 'x' })).toBeNull();
    expect(artifactMeta('apps.list', { apps: [app()] })).toBeNull();
    expect(artifactMeta('apps.design', { draft: {} })?.kind).toBe('summary');
  });
});

describe('sincronía', () => {
  const a = appRefFromResult('apps.update', { app: app() });
  const b = appRefFromResult('apps.update', { app: app({ updatedAt: '2026-10-15T11:00:00Z' }) });
  it('la clave cambia con el sello, la versión o el estado', () => {
    expect(appSyncKey(a)).not.toBe(appSyncKey(b));
    expect(appSyncKey(null)).toBe('');
    expect(appSyncKey(a)).toBe(appSyncKey(appRefFromResult('apps.get', { app: app() })));
  });
  it('refresca sólo si algo cambió', () => {
    expect(shouldRefresh(a, a)).toBe(false);
    expect(shouldRefresh(a, b)).toBe(true);
    expect(shouldRefresh(null, a)).toBe(true);
    expect(shouldRefresh(a, null)).toBe(false);
  });
  it('del borrador a la app real, sólo si hay un borrador abierto y llega la creada', () => {
    const created = appRefFromResult('apps.apply_draft', { app: app() });
    expect(shouldSwitchFromDraft(true, null, created)).toBe(true);
    expect(shouldSwitchFromDraft(false, null, created)).toBe(false);
    expect(shouldSwitchFromDraft(true, created, created)).toBe(false);
    expect(shouldSwitchFromDraft(true, null, a)).toBe(false);
  });
});

describe('estado del panel', () => {
  it('quien no puede editar sólo tiene «Vista»', () => {
    expect(availableModes(false)).toEqual(['vista']);
    expect(availableModes(true)).toEqual(['vista', 'editar']);
    expect(resolveMode('editar', false)).toBe('vista');
    expect(resolveMode('editar', true)).toBe('editar');
    expect(parseStoredMode('editar')).toBe('editar');
    expect(parseStoredMode('x')).toBe('vista');
  });
  it('etiqueta del estado', () => {
    expect(statusLabel('draft', null)).toBe('Borrador');
    expect(statusLabel('published', 4)).toBe('Publicada v4');
    expect(statusLabel('published', null)).toBe('Publicada');
  });
  it('el ancho se acota y se recuerda', () => {
    expect(clampAppPanelWidth(100, 1600)).toBe(400);
    expect(clampAppPanelWidth(5000, 1600)).toBe(940);
    expect(clampAppPanelWidth(700, 1600)).toBe(700);
    expect(defaultAppPanelWidth(2000)).toBe(920);
    expect(parseStoredWidth('640', 1600)).toBe(640);
    expect(parseStoredWidth(null, 1280)).toBe(589);
    expect(parseStoredWidth('basura', 1280)).toBe(589);
  });
});

describe('contarle a Cortex', () => {
  it('las notas son señales de control (no disparan búsqueda en el cerebro)', () => {
    expect(isControlHandoffMessage(editNote('Mi app', ['Se agregó la pantalla Vuelos.']))).toBe(
      true,
    );
    expect(isControlHandoffMessage(publishNote('Mi app', 2, 'primera'))).toBe(true);
  });
  it('dice qué cambió, sin spam ni punto doble', () => {
    const n = editNote('Mi app', ['Se agregó la pantalla Vuelos.', '  ', 'Cambió el rol Operario']);
    expect(n).toContain('cambié Se agregó la pantalla Vuelos; Cambió el rol Operario');
    expect(editNote('Mi app', [])).toContain('hice cambios');
    expect(publishNote('Mi app', 2)).toContain('versión 2');
  });
  it('sólo cuenta lo nuevo', () => {
    expect(newChanges(['a'], ['a', 'b'])).toEqual(['b']);
  });
  it('el mensaje del editor sólo vale para su app', () => {
    const m = { type: PANEL_MESSAGE, event: 'edited', appId: 'a1', stamp: 's' };
    expect(parsePanelMessage(m, 'a1')).not.toBeNull();
    expect(parsePanelMessage(m, 'otra')).toBeNull();
    expect(parsePanelMessage({ type: 'x' }, 'a1')).toBeNull();
    expect(parsePanelMessage(null, 'a1')).toBeNull();
  });
});
