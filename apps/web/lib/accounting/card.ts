import type {
  AccountingConnectionRow,
  AccountingEntity,
  AccountingProviderInfo,
} from '@cortex/agent-tools';

/**
 * LA TARJETA DE UN PROGRAMA CONTABLE, EN DATOS (migración 0165).
 *
 * Puro y serializable: lo arma la página (servidor) con lo que lee de
 * `accounting_connections` —sin la llave, que nunca se selecciona— y lo dibuja
 * `AccountingProviderCard` (cliente), que sólo importa tipos. Las frases están
 * aquí y no en el componente para poder probarlas sin React.
 */

export const ENTITY_LABELS: Record<AccountingEntity, string> = {
  customers: 'Clientes',
  products: 'Productos',
  invoices: 'Facturas de venta',
  payments: 'Pagos recibidos',
};

export const INTERVAL_OPTIONS = [
  { value: 15, label: 'Cada 15 minutos' },
  { value: 30, label: 'Cada 30 minutos' },
  { value: 60, label: 'Cada hora' },
  { value: 120, label: 'Cada 2 horas' },
  { value: 360, label: 'Cada 6 horas' },
  { value: 1440, label: 'Una vez al día' },
] as const;

export type CardTone = 'ok' | 'working' | 'error' | 'paused' | 'idle';

export interface AccountingCardData {
  provider: AccountingProviderInfo;
  connected: boolean;
  accountLabel: string | null;
  entities: AccountingEntity[];
  intervalMinutes: number;
  notify: boolean;
  enabled: boolean;
  tone: CardTone;
  /** Una frase: «Al día · hace 12 min». */
  status: string;
  error: string | null;
  /** Qué trajo la última corrida, por cosa, en frases cortas. */
  lines: Array<{ entity: AccountingEntity; label: string; text: string; href: string | null }>;
  purchaseStatus: string | null;
}

/** Quién puede conectar o tocar un programa contable: dueños y administradores. */
export function canManageAccounting(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/** «hace 5 min», «hace 3 h», «el 12 de sep.». */
export function ago(iso: string | null, now = new Date()): string {
  if (!iso) return '';
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `el ${new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', timeZone: 'America/Bogota' })}`;
}

function statusOf(conn: AccountingConnectionRow, now: Date): { tone: CardTone; status: string } {
  if (!conn.enabled) return { tone: 'paused', status: 'En pausa: no se está trayendo nada.' };
  if (conn.last_status === 'error')
    return { tone: 'error', status: `Falló la última vez (${ago(conn.last_run_at, now)}).` };
  if (conn.last_status === 'partial')
    return {
      tone: 'working',
      status: 'Trayendo datos. La carga continúa automáticamente.',
    };
  if (conn.last_status === 'ok')
    return { tone: 'ok', status: `Al día · última sincronización ${ago(conn.last_run_at, now)}.` };
  return { tone: 'working', status: 'Conectado. La primera sincronización empieza en un momento.' };
}

export function buildAccountingCards(
  providers: AccountingProviderInfo[],
  connections: AccountingConnectionRow[],
  tableSlugs: (provider: AccountingProviderInfo, entity: AccountingEntity) => string,
  now = new Date(),
): AccountingCardData[] {
  return providers.map((provider) => {
    const conn = connections.find((c) => c.provider === provider.id);
    if (!conn)
      return {
        provider,
        connected: false,
        accountLabel: null,
        entities: [...provider.entities],
        intervalMinutes: 60,
        notify: true,
        enabled: true,
        tone: 'idle',
        status: provider.available ? 'Sin conectar.' : 'Próximamente.',
        error: null,
        lines: [],
        purchaseStatus: null,
      };
    const { tone, status } = statusOf(conn, now);
    const lines = conn.entities.map((entity) => {
      const n = conn.last_counts?.[entity];
      const label = entity === 'payments' ? provider.paymentsLabel : ENTITY_LABELS[entity];
      const activity = n
        ? n.inserted || n.updated
          ? `${n.inserted} nuevos, ${n.updated} actualizados en la última corrida`
          : 'Sin cambios en la última corrida'
        : 'Todavía no se ha traído';
      const text =
        provider.id === 'siigo'
          ? `${conn.cursors?.[entity]?.since ? 'Carga inicial finalizada' : 'Carga inicial pendiente'} · ${activity}`
          : activity;
      return {
        entity,
        label,
        text,
        href: conn.trackers?.[entity] ? `/trackers/${tableSlugs(provider, entity)}` : null,
      };
    });
    return {
      provider,
      connected: true,
      accountLabel: conn.account_label,
      entities: conn.entities,
      intervalMinutes: conn.interval_minutes,
      notify: conn.notify,
      enabled: conn.enabled,
      tone,
      status,
      error: conn.last_status === 'error' ? conn.last_error : null,
      lines,
      purchaseStatus:
        provider.id !== 'siigo'
          ? null
          : conn.cursors?.purchases?.resume
            ? `Compras: ${conn.cursors.purchases.resume.mode === 'initial' ? 'trayendo historial' : 'revisando historial'} (página ${conn.cursors.purchases.resume.page}).`
            : conn.cursors?.purchases?.since
              ? 'Compras: carga histórica finalizada; los cambios se siguen revisando.'
              : 'Compras: esperando la primera carga histórica.',
    };
  });
}
