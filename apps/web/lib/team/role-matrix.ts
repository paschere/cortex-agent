/**
 * QUÉ PUEDE HACER CADA ROL: la única fuente, para que lo que se explica no se
 * separe de lo que se aplica.
 *
 * Hay cuatro roles que una persona reconoce, aunque por debajo sean dos tablas
 * (ver founder-rules.ts): `owner` y `admin` salen de `ba_member.role`;
 * `team_admin` y `member` de `public.users.role`, ambos con membresía `member`.
 *
 * Cada fila de `CAPABILITIES` cita la comprobación real que la sostiene. La
 * pantalla «¿Qué puede hacer cada rol?», el diálogo de «Hacer cofundador» y el
 * artículo de ayuda leen de aquí; si un permiso cambia en el código, se cambia
 * esta fila y los tres se corrigen a la vez. Puro y sin imports de servidor:
 * la prueba lo cruza con las reglas de founder-rules.ts.
 */

export type RoleKey = 'owner' | 'admin' | 'team_admin' | 'member';

export const ROLE_KEYS: readonly RoleKey[] = ['owner', 'admin', 'team_admin', 'member'];

export interface RoleInfo {
  key: RoleKey;
  /** Como lo nombra una persona; es la etiqueta de la fila y de la matriz. */
  label: string;
  /** Una frase para el encabezado de la matriz. */
  blurb: string;
  /** Clases del chip (tokens del sistema; ningún tamaño arbitrario). */
  chip: string;
}

export const ROLES_INFO: Record<RoleKey, RoleInfo> = {
  owner: {
    key: 'owner',
    label: 'Cofundador',
    blurb: 'Es dueño de la empresa. Puede haber varios.',
    chip: 'border-primary/40 bg-primary-soft text-primary-ink',
  },
  admin: {
    key: 'admin',
    label: 'Administrador',
    blurb: 'Maneja el día a día de la empresa, menos la propiedad.',
    chip: 'border-primary/30 bg-surface text-primary-ink',
  },
  team_admin: {
    key: 'team_admin',
    label: 'Líder de equipo',
    blurb: 'Ve y acompaña a su equipo.',
    chip: 'border-sky/40 bg-sky-soft text-sky',
  },
  member: {
    key: 'member',
    label: 'Miembro',
    blurb: 'Trabaja con Cortex en lo suyo.',
    chip: 'border-border bg-surface-2 text-ink-muted',
  },
};

/** `yes` lo hace; `partial` lo hace acotado (la nota dice cómo); `no` no. */
export type Level = 'yes' | 'partial' | 'no';

export interface Capability {
  id: string;
  label: string;
  /** Una línea de contexto bajo la etiqueta. */
  hint?: string;
  levels: Record<RoleKey, Level>;
  /** Aclaración por rol cuando `partial` necesita explicarse. */
  notes?: Partial<Record<RoleKey, string>>;
  /**
   * Sólo los fundadores. Son las filas que el diálogo de «Hacer cofundador»
   * enumera como «lo que se suma», porque es lo que un administrador NO puede.
   */
  founderOnly?: boolean;
}

const ALL: Record<RoleKey, Level> = {
  owner: 'yes',
  admin: 'yes',
  team_admin: 'yes',
  member: 'yes',
};
const MANAGERS: Record<RoleKey, Level> = {
  owner: 'yes',
  admin: 'yes',
  team_admin: 'no',
  member: 'no',
};
const FOUNDERS: Record<RoleKey, Level> = {
  owner: 'yes',
  admin: 'no',
  team_admin: 'no',
  member: 'no',
};

export const CAPABILITIES: readonly Capability[] = [
  {
    id: 'work',
    label: 'Trabajar con Cortex en lo suyo',
    hint: 'Chat, rutinas, compromisos y herramientas permitidas.',
    levels: ALL,
  },
  {
    id: 'see-all',
    label: 'Ver lo de toda la empresa',
    hint: 'Personas, auditoría y la actividad de todos.',
    levels: { owner: 'yes', admin: 'yes', team_admin: 'partial', member: 'no' },
    notes: { team_admin: 'Solo a su equipo' },
  },
  {
    id: 'approve',
    label: 'Aprobar lo que Cortex pide confirmar',
    hint: 'Cada quien aprueba lo que sale de su propio trabajo.',
    levels: ALL,
  },
  {
    id: 'mandates',
    label: 'Darle permisos permanentes a Cortex',
    hint: 'Que haga cierto tipo de cosas sin preguntar cada vez.',
    levels: MANAGERS,
  },
  {
    id: 'invite',
    label: 'Invitar y retirar personas',
    hint: 'También cambiar el rol de quien no es cofundador.',
    levels: MANAGERS,
  },
  {
    id: 'connect',
    label: 'Conectar fuentes y contabilidad',
    hint: 'Correo, calendario, Siigo, Alegra, QuickBooks…',
    levels: MANAGERS,
  },
  {
    id: 'plan',
    label: 'Cambiar el plan y el pago',
    levels: MANAGERS,
  },
  {
    id: 'export',
    label: 'Descargar todos los datos de la empresa',
    levels: MANAGERS,
  },
  {
    id: 'founders',
    label: 'Nombrar o retirar cofundadores',
    hint: 'Y pasar la propiedad. Siempre queda al menos uno.',
    levels: FOUNDERS,
    founderOnly: true,
  },
  {
    id: 'delete-company',
    label: 'Borrar la empresa',
    hint: 'Con 30 días de gracia antes de que se purgue.',
    levels: FOUNDERS,
    founderOnly: true,
  },
];

/** Lo que se suma al pasar de administrador a cofundador (para el diálogo). */
export function founderOnlyCapabilities(): readonly Capability[] {
  return CAPABILITIES.filter((capability) => capability.founderOnly);
}

/** Lo que ya puede un administrador y por tanto también un cofundador. */
export function sharedWithAdmins(): readonly Capability[] {
  return CAPABILITIES.filter(
    (capability) =>
      !capability.founderOnly &&
      capability.levels.admin === 'yes' &&
      capability.levels.team_admin !== 'yes',
  );
}

/**
 * El rol visible de una persona, a partir de las dos tablas.
 * `owner` y `admin` ganan sobre el directorio (ver `standingOf` en la pantalla).
 */
export function roleKeyOf(membershipRole: string, directoryRole: string | null): RoleKey {
  if (membershipRole === 'owner') return 'owner';
  if (membershipRole === 'admin') return 'admin';
  return directoryRole === 'team_admin' ? 'team_admin' : 'member';
}
