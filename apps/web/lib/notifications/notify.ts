import 'server-only';
import {
  NOTIFICATION_TONE_BY_KIND,
  type NotificationKind,
  type NotificationSource,
  type NotificationTone,
} from '@/lib/notifications-shape';
import { isOrgScoped } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * LA ÚNICA PUERTA POR LA QUE SE ESCRIBE UN AVISO.
 *
 * ===========================================================================
 * POR QUÉ UNA SOLA FUNCIÓN, Y POR QUÉ ESO ES LA MITAD DEL DISEÑO
 * ===========================================================================
 * No hay ningún otro `insert` en `public.notifications` en todo el repositorio
 * — `notifications/tenancy.test.ts` lo comprueba leyendo el código fuente. Eso
 * no es orden por gusto: la migración 0064 le puso `organization_id NOT NULL` a
 * `user_memories` y nunca volvió sobre la función que escribía en ella, así que
 * durante semanas el producto no pudo guardar ni una memoria y nadie se enteró
 * porque la LECTURA seguía funcionando. Con un solo escritor, «revisa que todas
 * las funciones que escriben incluyan la columna nueva» es una frase con un
 * único destinatario.
 *
 * ===========================================================================
 * IMPOSIBLE SIN ESPACIO DE TRABAJO, IMPOSIBLE SIN DESTINATARIO
 * ===========================================================================
 * Las dos se hacen cumplir aquí y NO por convención:
 *
 *   espacio       no es un parámetro. Sale del handle: `createOrgScopedClient`
 *                 estampa `organization_id` en toda inserción. Un handle crudo
 *                 no lo estampa, así que esta función lo RECHAZA con una
 *                 excepción en vez de escribir una fila sin espacio (que la
 *                 base rechazaría de todas formas, pero varias capas más tarde
 *                 y con un 23502 que no explica nada).
 *   destinatario  `userId` es obligatorio en el tipo y se comprueba en tiempo
 *                 de ejecución, porque la mitad de los productores lo leen de
 *                 una fila donde puede ser null (un encargo cuyo dueño ya no
 *                 está en el directorio, por ejemplo).
 *
 * Las dos son `NotificationContractError`: son errores de programación, no
 * fallos de operación, y tienen que romper en desarrollo y en las pruebas.
 *
 * ===========================================================================
 * QUÉ PASA SI LA BASE FALLA: NADA, Y ESO ES DELIBERADO
 * ===========================================================================
 * Un fallo de base al escribir el aviso se registra y se devuelve `null`. Es la
 * excepción al «toda desestructuración comprueba el error y falla ruidosamente»
 * — aquí el error SÍ se comprueba, lo que no se hace es propagarlo. La razón es
 * el orden de las cosas: cuando esto se llama, el trámite ya corrió, el correo
 * ya salió, el encargo ya preguntó. Tumbar el trabajo por no poder escribir el
 * recado sería cambiar un fallo barato por uno caro.
 *
 * La LECTURA de la bandeja es lo contrario y falla a gritos: ver
 * `repository.ts`. Una bandeja vacía y una bandeja rota se ven idénticas y
 * significan lo opuesto.
 *
 * ===========================================================================
 * CERO LLAMADAS AL MODELO
 * ===========================================================================
 * Este archivo no importa ningún proveedor y no puede: recibe el título y el
 * cuerpo ya escritos. Los productores los arman con reglas y plantillas en
 * español (`producers.ts`). Un aviso redactado por un modelo costaría una
 * llamada por suceso, tardaría en escribirse, y diría algo distinto cada vez
 * para el mismo hecho — con lo cual nadie podría comprobar que dice la verdad.
 */

/** Un error de programación en el contrato, no un fallo de la base. */
export class NotificationContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationContractError';
  }
}

export interface NotifyInput {
  /** A quién. Obligatorio: un aviso sin destinatario no es un aviso. */
  userId: string;
  kind: NotificationKind;
  /** Qué pasó, de qué. Una frase, escrita con reglas y no por un modelo. */
  title: string;
  /** Qué puede hacer, o por qué falló. */
  body?: string | null;
  /** A dónde ir. Ruta interna; cualquier otra cosa se descarta (ver abajo). */
  href?: string | null;
  /** De dónde salió. Es también el agrupado por defecto. */
  source?: { kind: NotificationSource; id: string } | null;
  /** Sólo cuando el desenlace cambia el color dentro de la misma clase. */
  tone?: NotificationTone;
  /**
   * Qué cuenta como «lo mismo otra vez». Por defecto, clase + origen.
   *
   * Se puede afinar cuando el origen no es lo que se repite: el barrido de una
   * rutina que no arranca produce un origen distinto cada vez (una corrida
   * nueva) para lo que una persona vive como el mismo problema, así que ahí el
   * agrupado se ancla a la rutina y no a la corrida.
   */
  groupKey?: string;
  /** Cuándo pasó, si no es ahora. */
  occurredAt?: Date;
}

const TITLE_MAX = 160;
const BODY_MAX = 600;
const HREF_MAX = 400;

/** Recorta a lo que la columna admite, con puntos suspensivos si hizo falta. */
function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Una ruta interna, o nada.
 *
 * Un enlace malformado se DESCARTA en vez de tumbar el aviso: el CHECK de la
 * 0096 rechazaría la fila entera, y quedarse sin la noticia por no poder ir a
 * verla es el peor de los dos resultados. Que sólo se admitan rutas internas es
 * la propiedad importante y se defiende en la base; esto es sólo no llegar allí
 * con algo que se sabe que va a rebotar.
 */
function safeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
  if (trimmed.length < 2) return null;
  return trimmed.slice(0, HREF_MAX);
}

interface OpenRow {
  id: string;
  occurrences: number;
}

/**
 * Escribe un aviso, o lo funde con el que ya estaba sin leer.
 *
 * @param db handle con alcance de organización. No hay parámetro de espacio de
 *   trabajo a propósito: el handle ES el espacio.
 * @returns el id de la fila, o `null` si la base no dejó escribirla.
 */
export async function notify(db: SupabaseClient, input: NotifyInput): Promise<string | null> {
  if (!isOrgScoped(db)) {
    throw new NotificationContractError(
      'notify() recibió un handle sin espacio de trabajo. Un aviso pertenece a la empresa dentro de la cual pasó el hecho: pásale getOrgScopedClient(organizationId).',
    );
  }
  const userId = input.userId?.trim();
  if (!userId) {
    throw new NotificationContractError(
      'notify() sin destinatario. Si quien pedía la cosa ya no está en el directorio, no escribas el aviso: no hay a quién avisar.',
    );
  }
  const title = clip(input.title ?? '', TITLE_MAX);
  if (!title) {
    throw new NotificationContractError('notify() sin título. Un aviso vacío es una fila.');
  }

  const bodyRaw = input.body ? clip(input.body, BODY_MAX) : '';
  const body = bodyRaw.length > 0 ? bodyRaw : null;
  const href = safeHref(input.href);
  const source = input.source ?? null;
  const groupKey = clip(
    input.groupKey ?? (source ? `${input.kind}:${source.kind}:${source.id}` : input.kind),
    200,
  );
  const tone = input.tone ?? NOTIFICATION_TONE_BY_KIND[input.kind];
  const occurredAt = (input.occurredAt ?? new Date()).toISOString();

  const shared = { kind: input.kind, tone, title, body, href, occurred_at: occurredAt };

  // ── 1. ¿Ya hay uno igual sin leer? ────────────────────────────────────────
  // Se funde con él: sube el contador y se refresca el texto y la hora, para
  // que la bandeja diga «pasó 4 veces» y la última vez sea la que se cuenta.
  const folded = await foldIntoOpen(db, userId, groupKey, shared);
  if (folded !== 'none') return folded;

  // ── 2. No lo había: fila nueva ────────────────────────────────────────────
  const inserted = await db
    .from('notifications')
    .insert({
      user_id: userId,
      group_key: groupKey,
      source_kind: source?.kind ?? null,
      source_id: source?.id ?? null,
      occurrences: 1,
      ...shared,
    })
    .select('id')
    .single();

  if (inserted.error) {
    // 23505 = el índice único parcial de la 0096. Otro proceso abrió el mismo
    // grupo entre nuestra lectura y nuestra inserción, que es exactamente el
    // caso para el que ese índice existe. Se funde con el suyo y nadie ve dos
    // campanadas iguales.
    if (inserted.error.code === '23505') {
      const second = await foldIntoOpen(db, userId, groupKey, shared);
      if (second !== 'none') return second;
    }
    logger.error('notifications: no se pudo escribir el aviso', {
      kind: input.kind,
      groupKey,
      error: inserted.error.message,
    });
    return null;
  }

  return (inserted.data as { id: string } | null)?.id ?? null;
}

/**
 * Sube el contador del aviso sin leer de este grupo, si lo hay.
 *
 * @returns el id de la fila fundida, o `'none'` si no había ninguna.
 *
 * EL CONTADOR SE LEE Y SE ESCRIBE EN DOS PASOS, y en una carrera se queda
 * corto: dos procesos que lean 3 escriben 4 en vez de 5. Se acepta a
 * conciencia. Lo que NO puede pasar es que aparezcan dos filas iguales sin
 * leer, y de eso se encarga el índice único de la base, no esta función. Un
 * «pasó 4 veces» que debería decir 5 no le miente a nadie sobre lo que pasó;
 * dos campanadas por el mismo suceso, sí.
 */
async function foldIntoOpen(
  db: SupabaseClient,
  userId: string,
  groupKey: string,
  shared: Record<string, unknown>,
): Promise<string | 'none' | null> {
  const open = await db
    .from('notifications')
    .select('id, occurrences')
    .eq('user_id', userId)
    .eq('group_key', groupKey)
    .is('read_at', null)
    .maybeSingle();

  if (open.error) {
    logger.error('notifications: no se pudo mirar si el aviso ya estaba abierto', {
      groupKey,
      error: open.error.message,
    });
    return null;
  }

  const row = open.data as OpenRow | null;
  if (!row) return 'none';

  const bumped = await db
    .from('notifications')
    .update({ ...shared, occurrences: (row.occurrences ?? 1) + 1 })
    .eq('id', row.id)
    // Se repite el destinatario en la condición aunque el id ya lo determine:
    // es la misma cláusula que protege «marcar como leído», y tenerla en las
    // dos escrituras significa que ninguna ruta puede tocar la fila de otra
    // persona ni por un id equivocado.
    .eq('user_id', userId)
    .is('read_at', null);

  if (bumped.error) {
    logger.error('notifications: no se pudo agrupar el aviso repetido', {
      groupKey,
      error: bumped.error.message,
    });
    return null;
  }

  return row.id;
}
