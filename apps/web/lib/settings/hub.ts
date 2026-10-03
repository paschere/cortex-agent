import type { SettingsEntry, SettingsStateKey } from './registry';
import type { SettingsState } from './state-text';

/**
 * Lo que viaja del servidor al recibidor: la entrada del registro ya resuelta
 * para esta persona (dirección con su espacio de trabajo y dato corto puesto).
 * Todo serializable.
 */
export interface HubEntry
  extends Pick<
    SettingsEntry,
    | 'id'
    | 'group'
    | 'title'
    | 'description'
    | 'keywords'
    | 'external'
    | 'inline'
    | 'collapsed'
    | 'soon'
    | 'icon'
    | 'legacyAnchor'
  > {
  /** `null`: no hay pantalla (Próximamente, o sólo control en línea). */
  href: string | null;
  state: SettingsState | null;
}

export function toHubEntries(
  entries: readonly SettingsEntry[],
  states: Partial<Record<SettingsStateKey, SettingsState>>,
  hrefFor: (href: string) => string,
): HubEntry[] {
  return entries.map((e) => ({
    id: e.id,
    group: e.group,
    title: e.title,
    description: e.description,
    keywords: e.keywords,
    external: e.external,
    inline: e.inline,
    collapsed: e.collapsed,
    soon: e.soon,
    icon: e.icon,
    legacyAnchor: e.legacyAnchor,
    href: e.href ? hrefFor(e.href) : null,
    state: (e.state && states[e.state]) || null,
  }));
}
