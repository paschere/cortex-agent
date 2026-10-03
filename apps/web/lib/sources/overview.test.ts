import { describe, expect, it } from 'vitest';
import { buildCatalog } from './catalog';
import {
  type SourcesSnapshot,
  buildConnectedSources,
  plainProblem,
  summarizeSources,
  unreadParts,
} from './overview';

const NOW = new Date('2026-10-02T15:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function snap(patch: Partial<SourcesSnapshot> = {}): SourcesSnapshot {
  return {
    userId: 'me',
    canManage: false,
    hubspotWorkspace: false,
    integrations: [],
    accounting: [],
    drive: [],
    tableSyncs: [],
    feedSources: [],
    bank: [],
    whatsapp: { status: 'disconnected', lastSeenAt: null, groups: 0, links: 0, mineLinked: false },
    inbox: { count: 0, latestAt: null },
    people: {},
    ...patch,
  };
}

const drive = {
  id: '00000000-0000-4000-8000-000000000001',
  folder_name: 'Guías aéreas',
  tracker_name: 'Guías',
  tracker_slug: 'guias',
  enabled: true,
  interval_minutes: 10,
  last_run_at: ago(5),
  last_status: 'ok',
  last_error: null,
  last_files: 38,
  last_inserted: 12,
  last_updated: 0,
  last_needs_review: 2,
  last_failed: 0,
  created_by: 'ana',
};

describe('buildConnectedSources', () => {
  it('an empty company has nothing connected, and says so', () => {
    const list = buildConnectedSources(snap(), NOW);
    expect(list).toEqual([]);
    expect(summarizeSources(list).label).toBe('Nada conectado todavía');
  });

  it('puts what is failing first and counts it in the summary', () => {
    const list = buildConnectedSources(
      snap({
        drive: [
          drive,
          {
            ...drive,
            id: 'x2',
            folder_name: 'Facturas',
            last_status: 'error',
            last_error: 'invalid_grant',
          },
        ],
        integrations: [
          {
            provider: 'google',
            scopes: ['gmail', 'calendar', 'drive', 'spreadsheets'],
            updated_at: ago(60),
            user_id: 'me',
          },
        ],
      }),
      NOW,
    );
    expect(list[0]?.name).toBe('Facturas');
    expect(list[0]?.tone).toBe('error');
    expect(list[0]?.problem?.fix).toEqual({
      label: 'Volver a conectar',
      href: '/api/integrations/google?preset=all',
    });
    expect(summarizeSources(list).label).toBe('3 conectadas · 1 con error');
  });

  it('describes a drive folder with what it brought and who owns it', () => {
    const [card] = buildConnectedSources(snap({ drive: [drive], people: { ana: 'Ana' } }), NOW);
    expect(card?.detail).toBe('→ Guías');
    expect(card?.items).toBe('38 archivos leídos · 12 filas nuevas · 2 por revisar');
    expect(card?.owner).toBe('Conectada por Ana');
    expect(card?.lastSyncLabel).toBe('Última vez hace 5 min');
    expect(card?.manage?.href).toBe('/trackers/guias');
  });

  it('offers «Sincronizar ahora» only to whoever may ask for it', () => {
    const someone = buildConnectedSources(snap({ drive: [drive] }), NOW)[0];
    const owner = buildConnectedSources(snap({ drive: [{ ...drive, created_by: 'me' }] }), NOW)[0];
    const admin = buildConnectedSources(snap({ drive: [drive], canManage: true }), NOW)[0];
    expect(someone?.sync).toBeNull();
    expect(owner?.sync).toEqual({ kind: 'drive_folder', id: drive.id });
    expect(admin?.sync).toEqual({ kind: 'drive_folder', id: drive.id });
  });

  it('flags a Google account missing a permission, with the button that grants it', () => {
    const [card] = buildConnectedSources(
      snap({
        integrations: [
          { provider: 'google', scopes: ['gmail', 'calendar'], updated_at: null, user_id: 'me' },
        ],
      }),
      NOW,
    );
    expect(card?.tone).toBe('attention');
    expect(card?.problem?.text).toContain('Drive y hojas de cálculo');
  });

  it('marks a stale bank statement and an offline WhatsApp', () => {
    const list = buildConnectedSources(
      snap({
        bank: [
          {
            account: 'bancolombia corriente',
            movements: 120,
            unmatched: 4,
            lastImportAt: ago(60 * 24 * 40),
            lastBy: 'me',
          },
        ],
        whatsapp: {
          status: 'connected',
          lastSeenAt: ago(30),
          groups: 3,
          links: 5,
          mineLinked: true,
        },
      }),
      NOW,
    );
    expect(list.map((s) => [s.kind, s.tone])).toEqual([
      ['whatsapp', 'error'],
      ['bank', 'attention'],
    ]);
    expect(list[1]?.items).toBe('120 movimientos · 4 sin factura');
  });

  it('never reads a failed query as «nothing connected»', () => {
    expect(unreadParts(snap({ drive: null, whatsapp: null }))).toEqual([
      'las carpetas de Drive',
      'WhatsApp',
    ]);
  });
});

describe('plainProblem', () => {
  it('turns a transient failure into a retry when the person can sync', () => {
    const p = plainProblem('ETIMEDOUT after 30000ms', {
      kind: 'table_sync',
      name: 'Ventas',
      canSync: true,
    });
    expect(p.fix).toEqual({ label: 'Intentar de nuevo', sync: true });
    expect(p.raw).toBe('ETIMEDOUT after 30000ms');
  });

  it('hands unknown errors to Cortex with the raw message in the prompt', () => {
    const p = plainProblem('weird thing', { kind: 'feed_source', name: 'ERP', canSync: false });
    expect('href' in p.fix && decodeURIComponent(p.fix.href)).toContain('weird thing');
  });
});

describe('buildCatalog', () => {
  const groups = buildCatalog({
    googleConnected: false,
    microsoftConnected: false,
    microsoftConfigured: false,
    hubspot: 'none',
    github: false,
    linear: false,
    whatsapp: 'off',
    bankAccounts: 0,
    mcpServers: 0,
  });

  it('groups by what people want, with the developer tools folded', () => {
    expect(groups.map((g) => g.title)).toEqual([
      'Correo y calendario',
      'Programa contable',
      'Banco',
      'Archivos y carpetas',
      'Hojas de cálculo',
      'WhatsApp',
      'Otro sistema o API',
      'Herramientas para desarrolladores',
    ]);
    expect(groups.find((g) => g.folded)?.id).toBe('desarrolladores');
  });

  it('keeps every intake path reachable', () => {
    const hrefs = groups.flatMap((g) =>
      g.items.flatMap((i) => (i.action.type === 'link' ? [i.action.href] : [])),
    );
    for (const path of [
      '/feed',
      '/kb',
      '/tools#custom-tools',
      '#mcp',
      '/finance#sources',
      '/payments#extractos',
      '/feed?mode=api',
      '/integrations/whatsapp',
      '/api/integrations/google?preset=all',
    ])
      expect(hrefs).toContain(path);
  });

  it('drive and sheet cards ask for the link and open the chat prompt', () => {
    const drive = groups.flatMap((g) => g.items).find((i) => i.id === 'drive-folder');
    expect(drive?.action.type).toBe('url');
    if (drive?.action.type === 'url') {
      expect(drive.action.needsGoogle).toBe(true);
      expect(
        new RegExp(drive.action.pattern).test('https://drive.google.com/drive/folders/1'),
      ).toBe(true);
      expect(drive.action.prompt).toContain('{url}');
    }
  });
});
