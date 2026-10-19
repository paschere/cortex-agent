import 'server-only';
import type { AppEditorData } from '@/components/apps/editor/shared';
import type { OpenedMemberApp } from '@/lib/apps/access';
import { loadSessionBrand } from '@/lib/branding/store';
import {
  type CustomViewRow,
  attributeValueSuggestions,
  draftStatus,
  getKioskSettings,
  listAppUsers,
  listDevices,
  listDirectory,
  listMembers,
  listPinStates,
  listRoles,
  type listScreens,
  listTrackers,
  listVersions,
  loadUsage,
  personLabel,
  trackersOf,
} from '@cortex/agent-tools';

/**
 * Todo lo que el editor de una app necesita, leído en el servidor. Lo comparten
 * /apps/<id>/edit (página completa) y /panel/apps/<id>/editar (el panel al lado
 * del chat): un solo lugar, dos marcos.
 */
export async function loadAppEditorData(
  opened: OpenedMemberApp,
  screens: Awaited<ReturnType<typeof listScreens>>,
  views: Map<string, CustomViewRow>,
): Promise<AppEditorData> {
  const { user, db, access } = opened;
  const app = access.app;
  const [roles, members, appUsers, directory, trackers, kioskSettings, devices, pins] =
    await Promise.all([
      listRoles(db, app.id),
      listMembers(db, app.id),
      listAppUsers(db, app.id),
      listDirectory(db),
      listTrackers(db, 40),
      getKioskSettings(db, app.id),
      listDevices(db, app.id),
      listPinStates(db, app.id),
    ]);
  // Versiones, borrador y uso (0225): extras que no pueden tumbar el editor si una lectura falla.
  const [versions, draft, usage] = await Promise.all([
    listVersions(db, app.id, 30).catch(() => []),
    draftStatus(db, app).catch(() => null),
    loadUsage(db, app).catch(() => null),
  ]);
  const attributeValues = await attributeValueSuggestions(db, roles);
  const companyBrand = await loadSessionBrand(db, user.organization.name);
  const pinOf = new Map(pins.map((p) => [p.userId, p]));

  // Las tablas que alguna pantalla lee y los botones de fila que declara cada una:
  // sin esto la matriz de permisos no sabría qué ofrecer.
  const used = new Set<string>();
  const actionsByTracker: Record<string, Array<{ id: string; label: string }>> = {};
  for (const view of views.values()) {
    for (const slug of trackersOf(view.spec)) used.add(slug);
    for (const block of view.spec.blocks) {
      if (!('tracker' in block) || !('actions' in block)) continue;
      const list = actionsByTracker[block.tracker] ?? [];
      actionsByTracker[block.tracker] = list;
      for (const a of block.actions as Array<{ id: string; label: string }>)
        if (!list.some((x) => x.id === a.id)) list.push({ id: a.id, label: a.label });
    }
  }

  const people = new Map(directory.map((p) => [p.id, { name: personLabel(p), email: p.email }]));
  const data: AppEditorData = {
    app: {
      id: app.id,
      slug: app.slug,
      name: app.name,
      description: app.description,
      icon: app.icon,
      status: app.status,
      homeScreen: app.home_screen,
      location: app.location,
    },
    screens: screens.map((s) => ({
      id: s.id,
      slug: s.slug,
      title: s.title,
      icon: s.icon,
      roles: s.roles,
      viewName: views.get(s.view_id)?.name ?? s.title,
    })),
    roles: roles.map((r) => ({
      key: r.key,
      name: r.name,
      description: r.description,
      permissions: r.permissions,
    })),
    members: members.map((m) => ({
      userId: m.user_id,
      name: people.get(m.user_id)?.name ?? 'Persona que ya no está',
      email: people.get(m.user_id)?.email ?? '',
      roleKey: m.role_key,
      attributes: m.attributes,
    })),
    appUsers: appUsers.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      roleKey: u.role_key,
      attributes: u.attributes,
      status: u.status,
      lastSeenAt: u.last_seen_at,
      hasPin: pinOf.get(u.id)?.hasPin ?? false,
      pinLockedUntil: pinOf.get(u.id)?.lockedUntil ?? null,
    })),
    entryPath: `/a/${app.id}`,
    kiosk: {
      enabled: kioskSettings.enabled,
      idleMinutes: kioskSettings.idleMinutes,
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        state: d.state,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
      })),
    },
    attributeValues,
    directory: directory.map((p) => ({ id: p.id, name: personLabel(p), email: p.email })),
    trackers: trackers
      .filter((t) => used.has(t.slug))
      .map((t) => ({
        slug: t.slug,
        name: t.name,
        fields: t.fields.map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type,
          ...(f.options ? { options: f.options } : {}),
          ...(f.type === 'relation' && f.tracker ? { tracker: f.tracker } : {}),
        })),
        actions: actionsByTracker[t.slug] ?? [],
        flow: (() => {
          const f = t.fields.find((x) => x.type === 'select' && x.flow);
          return f?.flow ? { field: f.key, def: f.flow } : null;
        })(),
      })),
    // Una tabla usada que no es propia (plataforma/Feed) no sale en la matriz con campos,
    // pero sí con su nombre: el permiso se da por clave.
    unknownTrackers: [...used].filter((slug) => !trackers.some((t) => t.slug === slug)),
    brand: app.brand,
    companyBrand: {
      name: companyBrand.name,
      primary: companyBrand.primary,
      secondary: companyBrand.secondary,
      logoUrl: companyBrand.logoUrl,
    },
    home: app.home,
    homeTrackers: trackers.map((t) => ({
      slug: t.slug,
      name: t.name,
      fields: t.fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        ...(f.options ? { options: f.options } : {}),
        ...(f.type === 'relation' && f.tracker ? { tracker: f.tracker } : {}),
      })),
      actions: [],
    })),
    dashboards: app.dashboards,
    portal: app.portal,
    versions,
    draft: draft
      ? {
          publishedNumber: draft.publishedNumber,
          publishedAt: draft.publishedAt,
          hasChanges: draft.hasChanges,
          summary: draft.summary,
          changes: draft.changes.map((c) => ({ kind: c.kind, text: c.text })),
        }
      : undefined,
    usage,
    screenFilters: Object.fromEntries(
      screens.flatMap((s) => {
        const bar = views.get(s.view_id)?.spec.filtersBar ?? [];
        return bar.length ? [[s.slug, bar.map((b) => ({ id: b.id, label: b.label }))]] : [];
      }),
    ),
  };

  return data;
}
