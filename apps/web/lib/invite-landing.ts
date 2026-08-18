/**
 * DÓNDE ATERRIZA ALGUIEN QUE ACABA DE ENTRAR, Y SI HAY QUE FABRICARLE UN ESPACIO.
 *
 * ===========================================================================
 * EL FALLO QUE ESTO CIERRA
 * ===========================================================================
 * Invitar a alguien funcionaba de punta a punta salvo en la única parte que
 * importa: la persona no llegaba. La secuencia real era esta —
 *
 *   1. Le llega el correo y abre `/accept-invitation/<id>`.
 *   2. No tiene cuenta, así que se registra. `signup` mandaba a `/` a secas.
 *   3. En `/`, `requireSession` no le encuentra ninguna membresía y le FABRICA
 *      un espacio de trabajo vacío, con ella de dueña.
 *   4. Aterriza en ese espacio vacío. La empresa que la invitó no aparece por
 *      ningún lado, y la invitación sigue sin aceptar en un correo que ya cerró.
 *
 * Nada falla, nada se registra como error, y quien invitó ve «invitación
 * enviada». El síntoma que llega es «no me aparece nada», que no se parece a la
 * causa.
 *
 * ===========================================================================
 * POR QUÉ ESTO ES UN ARCHIVO PURO
 * ===========================================================================
 * Las dos preguntas de aquí —¿le fabrico un espacio?, ¿a dónde lo mando?— se
 * contestan con datos que ya se leyeron, y equivocarse en ellas no rompe nada
 * visible: fabrica un espacio de más, o manda a alguien a la pantalla
 * equivocada. Es exactamente la clase de error que sólo se ve en una prueba, así
 * que la regla es una función que recibe hechos y devuelve una decisión, igual
 * que `directory/line.ts` con los escalados.
 */

/** Lo que se sabe de alguien en el momento de resolver su espacio de trabajo. */
export interface LandingFacts {
  /** El espacio que la sesión dice que estaba activo, si todavía es miembro. */
  activeMembershipId: string | null;
  /** El primer espacio del que es miembro, si es miembro de alguno. */
  firstMembershipId: string | null;
  /** Invitación pendiente y sin vencer para su correo, si la hay. */
  pendingInvitationId: string | null;
}

export type Landing =
  /** Ya pertenece a algún sitio: se entra ahí. */
  | { action: 'use'; organizationId: string }
  /**
   * No pertenece a ninguno TODAVÍA, pero le están esperando. No se fabrica
   * nada: se le manda a aceptar, y al aceptar entra al espacio que la invitó.
   */
  | { action: 'accept-invitation'; invitationId: string }
  /** No pertenece a ninguno y nadie le invitó: este es su primer espacio. */
  | { action: 'provision' };

/**
 * Qué hacer con quien acaba de autenticarse.
 *
 * EL ORDEN ES TODO EL ARGUMENTO:
 *
 *   1. LA MEMBRESÍA GANA SIEMPRE. Quien ya pertenece a un espacio entra a su
 *      espacio, tenga o no invitaciones pendientes a otros sitios. Mandarla a
 *      aceptar una invitación cada vez que abre el producto sería secuestrarle
 *      la sesión por una invitación que a lo mejor no piensa aceptar.
 *
 *   2. LA INVITACIÓN PENDIENTE GANA A FABRICAR. Es la corrección: alguien con
 *      una invitación esperando NO necesita un espacio propio, necesita entrar
 *      al que le invitaron. Fabricárselo antes de preguntarle es crear basura y
 *      esconderle el sitio al que iba.
 *
 *   3. FABRICAR ES EL ÚLTIMO RECURSO, no el primero.
 *
 * `activeMembershipId` va antes que `firstMembershipId` porque la sesión ya
 * eligió y esa elección se respeta; quien llama sólo debe pasarlo cuando la
 * membresía siga siendo válida (salir de un espacio no puede seguir dando
 * acceso a través de una sesión vieja).
 */
export function workspaceLanding(facts: LandingFacts): Landing {
  if (facts.activeMembershipId) return { action: 'use', organizationId: facts.activeMembershipId };
  if (facts.firstMembershipId) return { action: 'use', organizationId: facts.firstMembershipId };
  if (facts.pendingInvitationId) {
    return { action: 'accept-invitation', invitationId: facts.pendingInvitationId };
  }
  return { action: 'provision' };
}

/**
 * El destino de `?next=`, saneado.
 *
 * ===========================================================================
 * ESTO ES UNA GUARDA DE REDIRECCIÓN ABIERTA, NO UNA COMODIDAD
 * ===========================================================================
 * `signup` pasa este valor como `callbackURL` a better-auth y a Google, o sea
 * que decide a dónde va el navegador DESPUÉS de autenticarse. Aceptarlo tal cual
 * convierte la pantalla de registro en un trampolín: `/signup?next=https://…`
 * manda a la persona a un dominio ajeno recién autenticada, que es la mitad de
 * un robo de credenciales creíble — el enlace sale de tu dominio y la víctima ya
 * confió en él.
 *
 * Por eso sólo pasa una RUTA INTERNA, y se comprueba por lo que ES y no por lo
 * que NO ES: tiene que empezar por una sola barra y no seguir con otra. Una
 * lista negra de esquemas («http:», «javascript:») se rodea siempre —con
 * `//evil.com`, con la variante de barra invertida, con espacios y saltos de
 * línea delante— y la historia de estas guardas es la historia de esas vueltas.
 *
 * `/` no se devuelve como destino porque ya es el defecto de quien llama:
 * distinguir «no pidió nada» de «pidió la raíz» no le sirve a nadie aquí.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Los caracteres de control se quitan antes de mirar nada: un salto de línea o
  // un tabulador delante es el truco más viejo para que la comprobación mire la
  // cadena equivocada, y el navegador después los ignora.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: quitarlos es el objetivo.
  const value = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (value.length === 0 || value.length > 512) return null;
  if (!value.startsWith('/')) return null;
  // `//host` y la variante con barra invertida son rutas de protocolo relativo:
  // el navegador las resuelve a OTRO dominio.
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  if (value === '/') return null;
  return value;
}
