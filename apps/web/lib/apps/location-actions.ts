'use server';

import { openApp } from '@/lib/apps/access';
import { notifyAssigned } from '@/lib/apps/assign-notify';
import { createLimiter } from '@/lib/apps/rate-limit';
import {
  type AssignablePerson,
  type LiveTeamPerson,
  type LocationStatus,
  acceptLocationConsent,
  assignTaskFromMap,
  endShift,
  listAssignablePeople,
  listLivePeople,
  locationStatus,
  parsePersonRef,
  recordPosition,
  resolveAssignee,
  revokeLocation,
  runAppAction,
  screenFor,
  screenView,
  startShift,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { z } from 'zod';

/**
 * LA UBICACIÓN DEL EQUIPO Y LAS TAREAS, DESDE EL NAVEGADOR (0216).
 *
 * Cada acción resuelve el acceso de nuevo (`openApp`: sesión + rol GUARDADO) y
 * pasa por las funciones de packages/agent-tools/src/apps/location.ts, que son
 * las que cierran las cuatro puertas (app encendida, rol, consentimiento,
 * turno). El navegador nunca dice QUIÉN es ni QUÉ rol tiene: la persona de una
 * posición es siempre la de la sesión. En «Ver como…» no se comparte nada.
 *
 * Sirven igual a un usuario externo (cookie de la app) que a un miembro de
 * Cortex: son server actions, no rutas, así que no necesitan prefijo público.
 */

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function describe(err: unknown, fallback: string): string {
  if (err instanceof ValidationError || err instanceof NotFoundError) return err.message;
  const message = err instanceof Error ? err.message : '';
  return message && message.length < 240 && !/[{}]|relation|column|violates/.test(message)
    ? message
    : fallback;
}

async function open(appRef: string) {
  const opened = await openApp(z.string().trim().min(1).max(80).parse(appRef));
  if (!opened) throw new NotFoundError('Esa aplicación no existe.');
  return opened;
}

async function openWritable(appRef: string) {
  const opened = await open(appRef);
  if (opened.readOnly)
    throw new ValidationError('En «Ver como…» no se comparte ni se asigna nada.');
  return opened;
}

export async function locationStatusAction(
  appRef: string,
): Promise<Result<{ status: LocationStatus }>> {
  try {
    const { db, access } = await open(appRef);
    return { ok: true, status: await locationStatus(db, access) };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo leer el estado de la ubicación.') };
  }
}

export async function acceptLocationAction(
  appRef: string,
): Promise<Result<{ status: LocationStatus }>> {
  try {
    const { db, access } = await openWritable(appRef);
    await acceptLocationConsent(db, access);
    return { ok: true, status: await locationStatus(db, access) };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo guardar tu autorización.') };
  }
}

export async function revokeLocationAction(
  appRef: string,
): Promise<Result<{ status: LocationStatus }>> {
  try {
    const { db, access } = await openWritable(appRef);
    await revokeLocation(db, access);
    return { ok: true, status: await locationStatus(db, access) };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo retirar tu autorización.') };
  }
}

export async function startShiftAction(
  appRef: string,
): Promise<Result<{ status: LocationStatus }>> {
  try {
    const { db, access } = await openWritable(appRef);
    await startShift(db, access);
    return { ok: true, status: await locationStatus(db, access) };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo iniciar el turno.') };
  }
}

export async function endShiftAction(appRef: string): Promise<Result<{ status: LocationStatus }>> {
  try {
    const { db, access } = await openWritable(appRef);
    await endShift(db, access);
    return { ok: true, status: await locationStatus(db, access) };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo terminar el turno.') };
  }
}

const pingSchema = z.object({
  lat: z.number().finite(),
  lng: z.number().finite(),
  accuracy: z.number().finite().nullish(),
  heading: z.number().finite().nullish(),
  speed: z.number().finite().nullish(),
  battery: z.number().finite().nullish(),
});

/** Una cada 15 s por persona la deja pasar el servidor; este freno sólo protege a la base de un navegador desbocado. */
const pings = createLimiter(20, 60_000);

/**
 * La posición de QUIEN ESTÁ ABIERTO. `inactive` = falta alguna de las cuatro
 * puertas: el navegador deja de pedir el GPS y vuelve a leer su estado.
 */
export async function pingLocationAction(
  appRef: string,
  raw: unknown,
): Promise<Result<{ saved: boolean; reason?: 'rate' | 'invalid' | 'inactive' }>> {
  try {
    const { db, access } = await openWritable(appRef);
    if (!pings.take(`${access.app.id}:${access.user.id}`))
      return { ok: true, saved: false, reason: 'rate' };
    const parsed = pingSchema.safeParse(raw);
    if (!parsed.success) return { ok: true, saved: false, reason: 'invalid' };
    const out = await recordPosition(db, access, parsed.data);
    return out.saved ? { ok: true, saved: true } : { ok: true, saved: false, reason: out.reason };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo enviar tu posición.') };
  }
}

/** Dónde están las personas en turno: el filtro de roles sale del bloque guardado, no del navegador. */
export async function livePeopleAction(
  appRef: string,
  screenRef: string,
  blockId: string,
): Promise<Result<{ people: LiveTeamPerson[]; at: string }>> {
  try {
    const { db, access } = await open(appRef);
    const screen = screenFor(access, screenRef);
    if (!screen) throw new NotFoundError('Esa pantalla no existe.');
    const view = await screenView(db, screen);
    const block = view.spec.blocks.find((b) => b.id === blockId);
    if (!block || block.type !== 'map' || !block.people)
      throw new NotFoundError('Ese mapa no muestra personas.');
    const people = await listLivePeople(db, access, { roles: block.peopleRoles });
    return { ok: true, people, at: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo leer dónde está el equipo.') };
  }
}

/** A quién se puede asignar (sin coordenadas); el filtro de roles sale del bloque o del botón guardados. */
export async function assignablePeopleAction(
  appRef: string,
  screenRef: string,
  blockId: string,
  actionId?: string,
): Promise<Result<{ people: AssignablePerson[] }>> {
  try {
    const { db, access } = await open(appRef);
    const screen = screenFor(access, screenRef);
    if (!screen) throw new NotFoundError('Esa pantalla no existe.');
    const view = await screenView(db, screen);
    const block = view.spec.blocks.find((b) => b.id === blockId.split(':')[0]);
    let roles: readonly string[] | undefined;
    if (block && 'actions' in block && actionId)
      roles = block.actions.find((a) => a.id === actionId)?.roles;
    else if (block?.type === 'map') roles = block.assign?.roles;
    const people = await listAssignablePeople(db, access, { roles });
    return { ok: true, people };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo leer a quién asignar.') };
  }
}

const taskSchema = z.object({
  person: z.string().max(80),
  title: z.string().trim().min(1).max(400),
  description: z.string().trim().max(4000).optional(),
  due: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  dueTime: z
    .string()
    .regex(/^\d{1,2}:\d{2}$/)
    .optional(),
  priority: z.string().trim().max(80).optional(),
  location: z
    .string()
    .regex(/^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/)
    .optional(),
});

/** «Asignar tarea» desde el mapa: crea la fila y avisa a la persona. */
export async function assignTaskAction(
  appRef: string,
  screenRef: string,
  blockId: string,
  raw: unknown,
): Promise<Result<{ message: string }>> {
  try {
    const { db, access } = await openWritable(appRef);
    const screen = screenFor(access, screenRef);
    if (!screen) throw new NotFoundError('Esa pantalla no existe.');
    const input = taskSchema.parse(raw);
    const person = parsePersonRef(input.person);
    if (!person) throw new ValidationError('Elige a una persona de la lista.');
    const view = await screenView(db, screen);
    const done = await assignTaskFromMap(db, access, view, {
      blockId,
      person,
      title: input.title,
      description: input.description,
      due: input.due,
      dueTime: input.dueTime,
      priority: input.priority,
      location: input.location,
    });
    const channel = await notifyAssigned(db, {
      app: access.app,
      person: done.person,
      task: { rowId: done.rowId, label: done.label, due: input.due },
      screen: done.screen,
      by: access.user.name,
    });
    return {
      ok: true,
      message: `Tarea asignada a ${done.person.name}.${
        channel === 'none' ? ' No tiene cómo recibir avisos: se la verá al abrir la app.' : ''
      }`,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo asignar la tarea.') };
  }
}

/** El botón «Asignar a…» de una fila: cambia quién y avisa. */
export async function assignRowAction(
  appRef: string,
  screenRef: string,
  blockId: string,
  actionId: string,
  rowId: string,
  personRef: string,
): Promise<Result<{ message: string }>> {
  try {
    const { db, access } = await openWritable(appRef);
    const screen = screenFor(access, screenRef);
    if (!screen) throw new NotFoundError('Esa pantalla no existe.');
    const person = parsePersonRef(personRef);
    if (!person) throw new ValidationError('Elige a una persona de la lista.');
    const view = await screenView(db, screen);
    const res = await runAppAction(db, access, view, { blockId, actionId, rowId, person });
    if (res.kind !== 'assign') throw new ValidationError('Ese botón no asigna.');
    const who = await resolveAssignee(db, access, person);
    const channel = await notifyAssigned(db, {
      app: access.app,
      person: who,
      task: { rowId: res.rowId, label: res.label },
      screen: res.screen,
      by: access.user.name,
    });
    return {
      ok: true,
      message: `${res.message}${channel === 'none' ? ' No tiene cómo recibir avisos.' : ''}`,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo asignar.') };
  }
}
