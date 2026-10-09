import { type GlobalNotificationView, parseNotificationActions } from '@/lib/notifications-shape';
import { describe, expect, it } from 'vitest';
import {
  type NotificationQuery,
  findNotificationActions,
  listGlobalNotifications,
  markGlobalRead,
  notificationSnapshotKey,
} from './global-repository';

describe('global notification membership boundary', () => {
  it('derives every workspace and directory owner from the BA identity', async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const db: NotificationQuery = {
      async query<T extends Record<string, unknown>>(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        return { rows: [] as T[] };
      },
    };
    await listGlobalNotifications(db, 'ba-ana');
    expect(calls[0]?.values).toEqual(['ba-ana', 160]);
    expect(calls[0]?.sql).toContain('membership."userId" = $1');
    expect(calls[0]?.sql).toContain('notification.user_id = directory.id');
    expect(calls[0]?.sql).not.toMatch(/organization_id\s*=\s*\$[12]/);
  });

  it('marks an exact notification+workspace pair behind the current membership', async () => {
    let statement = '';
    let values: unknown[] | undefined;
    const db: NotificationQuery = {
      async query<T extends Record<string, unknown>>(sql: string, input?: unknown[]) {
        statement = sql;
        values = input;
        return { rows: [{ id: 'notice' }] as unknown as T[], rowCount: 1 };
      },
    };
    const marked = await markGlobalRead(db, 'ba-ana', [
      {
        id: '11111111-1111-4111-8111-111111111111',
        organizationId: 'org-acme',
      },
    ]);
    expect(marked).toBe(1);
    expect(values).toEqual(['ba-ana', ['11111111-1111-4111-8111-111111111111'], ['org-acme']]);
    expect(statement).toContain('membership."organizationId" = target.organization_id');
    expect(statement).toContain('notification.user_id = directory.id');
  });

  it('changes the stream snapshot on grouping, reading, or membership removal', () => {
    const item = {
      id: 'n1',
      organizationId: 'org-a',
      organizationName: 'Acme',
      organizationKind: 'company',
      kind: 'routine_failed',
      tone: 'bad',
      title: 'Falló',
      body: null,
      href: '/schedules',
      occurrences: 1,
      occurredAt: '2026-09-06T12:00:00Z',
      readAt: null,
      actions: [],
    } satisfies GlobalNotificationView;
    expect(notificationSnapshotKey([{ ...item, occurrences: 2 }])).not.toBe(
      notificationSnapshotKey([item]),
    );
    expect(notificationSnapshotKey([{ ...item, readAt: '2026-09-06T12:01:00Z' }])).not.toBe(
      notificationSnapshotKey([item]),
    );
    expect(notificationSnapshotKey([])).not.toBe(notificationSnapshotKey([item]));
  });
});

describe('notification action buttons', () => {
  it('finds the buttons only behind the current membership and never trusts a client user id', async () => {
    let statement = '';
    let values: unknown[] | undefined;
    const db: NotificationQuery = {
      async query<T extends Record<string, unknown>>(sql: string, input?: unknown[]) {
        statement = sql;
        values = input;
        return {
          rows: [
            {
              directory_user_id: 'dir-1',
              actions: [
                {
                  kind: 'autopilot_item',
                  itemId: '11111111-1111-4111-8111-111111111111',
                  contentHash: 'abcdef123456',
                  title: 'Reintentar',
                },
                { kind: 'raw_tool', toolId: 'gmail.send_message', input: {} },
              ],
            },
          ] as unknown as T[],
        };
      },
    };
    const found = await findNotificationActions(db, 'ba-ana', {
      id: '22222222-2222-4222-8222-222222222222',
      organizationId: 'org-acme',
    });
    expect(values).toEqual(['ba-ana', 'org-acme', '22222222-2222-4222-8222-222222222222']);
    expect(statement).toContain('membership."userId" = $1');
    expect(statement).toContain('notification.user_id = directory.id');
    expect(found?.directoryUserId).toBe('dir-1');
    // Una acción que no es del piloto (una herramienta suelta) se descarta al leer.
    expect(found?.actions).toHaveLength(1);
  });

  it('parseNotificationActions descarta lo mal formado', () => {
    expect(parseNotificationActions(null)).toEqual([]);
    expect(
      parseNotificationActions([{ kind: 'autopilot_item', itemId: 'x', contentHash: 'y' }]),
    ).toEqual([]);
  });
});
