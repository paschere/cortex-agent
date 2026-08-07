/**
 * The client vocabulary, restated for the browser.
 *
 * WHY THIS FILE EXISTS. `@cortex/agent-tools` has no subpath exports, so any
 * import from it pulls the whole barrel — and the barrel reaches the custom-tool
 * HTTP client, which imports `node:dns/promises`. In a server component that is
 * invisible; in a `'use client'` component it fails the production build with a
 * module-not-found for a Node builtin, while `typecheck` and `test` stay green
 * because neither one bundles for the browser. That is exactly how it shipped
 * once: green locally, red in Vercel.
 *
 * `commitments-shape.ts` and `ToolsCatalog.tsx` hit the same wall and solved it
 * the same way. Types are fine to import (they erase); values are not.
 *
 * These are copies, and copies drift. `clients-shape.test.ts` runs in Node,
 * imports the real module, and fails if the two ever disagree — so the
 * duplication is checked rather than trusted.
 */

export const CLIENT_STATUSES = ['prospect', 'active', 'dormant', 'former', 'blocked'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const STATUS_LABEL: Record<ClientStatus, string> = {
  prospect: 'Prospecto',
  active: 'Activo',
  dormant: 'Sin movimiento',
  former: 'Ex cliente',
  blocked: 'Bloqueado',
};

export const STATUS_TONE: Record<ClientStatus, 'emerald' | 'amber' | 'sky' | 'rose'> = {
  prospect: 'sky',
  active: 'emerald',
  dormant: 'amber',
  former: 'amber',
  blocked: 'rose',
};

export const CLIENT_SERVICES = [
  'courier',
  'carga',
  'aduana',
  'almacenamiento',
  'ultima_milla',
  'otro',
] as const;
export type ClientService = (typeof CLIENT_SERVICES)[number];

export const SERVICE_LABEL: Record<ClientService, string> = {
  courier: 'Courier',
  carga: 'Carga',
  aduana: 'Aduana',
  almacenamiento: 'Almacenamiento',
  ultima_milla: 'Última milla',
  otro: 'Otro',
};

export const CUSTOMS_ROLES = ['importador', 'exportador', 'ambos', 'ninguno'] as const;
export type CustomsRole = (typeof CUSTOMS_ROLES)[number];

export const CUSTOMS_ROLE_LABEL: Record<CustomsRole, string> = {
  importador: 'Importador',
  exportador: 'Exportador',
  ambos: 'Importa y exporta',
  ninguno: 'No hace comercio exterior',
};

export const LINK_ENTITY_KINDS = [
  'document',
  'meeting',
  'whatsapp_group',
  'email_thread',
  'vehicle',
  'contact',
] as const;
export type LinkEntityKind = (typeof LINK_ENTITY_KINDS)[number];

export const ENTITY_KIND_LABEL: Record<LinkEntityKind, string> = {
  document: 'Documento',
  meeting: 'Reunión',
  whatsapp_group: 'Grupo de WhatsApp',
  email_thread: 'Correo',
  vehicle: 'Vehículo',
  contact: 'Contacto',
};

export const LINK_METHODS = [
  'email_domain',
  'contact_email',
  'tax_id',
  'name_exact',
  'name_partial',
  'manual',
  'inherited',
] as const;
export type LinkMethod = (typeof LINK_METHODS)[number];

export const METHOD_LABEL: Record<LinkMethod, string> = {
  email_domain: 'Dominio del correo',
  contact_email: 'Correo de un contacto',
  tax_id: 'NIT en el texto',
  name_exact: 'Nombre exacto',
  name_partial: 'Nombre parecido',
  manual: 'Vinculado a mano',
  inherited: 'Heredado de algo ya vinculado',
};

export const METHOD_SENTENCE: Record<LinkMethod, string> = {
  email_domain: 'El dominio del remitente está registrado a nombre de este cliente.',
  contact_email: 'La dirección es la de un contacto registrado de este cliente.',
  tax_id: 'El NIT del cliente aparece tal cual en el texto.',
  name_exact: 'El nombre del cliente aparece completo.',
  name_partial: 'Hay un parecido en el nombre, pero no es exacto.',
  manual: 'Alguien lo vinculó a mano.',
  inherited: 'Llegó adjunto a algo que ya estaba vinculado a este cliente.',
};

/**
 * Which methods are applied without a review, mirrored so the screen can label
 * a link "automático" or "propuesto" without asking the server. The authority
 * is APPLYING_METHODS in packages/agent-tools/src/clients/shape.ts, and the
 * parity test fails if this drifts from it.
 */
export const APPLYING_METHODS: LinkMethod[] = ['email_domain', 'contact_email'];

/** Free mail providers — the register form warns before the insert refuses. */
export const PUBLIC_EMAIL_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'hotmail.es',
  'outlook.com',
  'outlook.es',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.es',
  'icloud.com',
  'me.com',
  'aol.com',
  'protonmail.com',
  'proton.me',
  'gmx.com',
  'zoho.com',
  'mail.com',
  'yandex.com',
];
