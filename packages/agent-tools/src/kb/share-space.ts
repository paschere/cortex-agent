import { NotFoundError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';
import {
  assertCanAdminSpace,
  grantSpaceAccess,
  listSpaceAccess,
  listVisibleSpaces,
  resolveSpaceByName,
  revokeSpaceAccess,
} from './spaces';

/**
 * kb.share_space — repartir un espacio del cerebro por su nombre.
 *
 * POR QUÉ EXISTIENDO YA LA PANTALLA. Porque la frase con la que la gente pide
 * esto —«que Finanzas pueda meter cosas en Tarifas»— llega en el chat, en mitad
 * de otra cosa, y mandar a alguien a una pantalla para completar una frase que
 * ya dijo entera es cómo se queda sin hacer. Lo que la pantalla tiene y esto no
 * es la LISTA: ver de un golpe quién entra a cada espacio se mira, no se
 * escucha.
 *
 * NOMBRES, NUNCA IDS, en las dos direcciones: el espacio se resuelve por su
 * nombre como en toda esta familia de herramientas, y el sujeto también, contra
 * los equipos y las personas de este espacio de trabajo. Un modelo que tuviera
 * que repetir un uuid acabaría inventándose uno, y un uuid inventado en una
 * herramienta que concede acceso no es un error, es un incidente.
 *
 * QUITAR ES TAN IMPORTANTE COMO DAR, y por eso está en la misma herramienta:
 * separarlas hace que «quítale el acceso a Ana» dependa de que el modelo
 * conozca una segunda herramienta que quizá no está en su lista este turno.
 */
export const kbShareSpace = registerTool({
  id: 'kb.share_space',
  description:
    'Change who can reach one Brain Knowledge space, by name. Use it when somebody asks to give — or take away — access to a space: "que Comercial vea Tarifas", "deja que Ana guarde ahí", "quítale el acceso a Finanzas", "que esto no lo vea toda la empresa". ' +
    "`subject` is a TEAM name, a PERSON's name or email, or the word \"everyone\" for the whole company. `level` is 'view' (search and read), 'contribute' (also save documents there) or 'admin' (also decide who else gets in). Pass `remove: true` to take the access away instead. " +
    'You must administer the space to do this — check `can` in kb.list_spaces first, and if it is not "admin", say who they should ask instead of trying. A personal notebook can be lent (view or contribute) but never opened to the whole company and never delegated. ' +
    'Say out loud what changed and for whom: an access change nobody announced is one nobody can undo.',
  inputSchema: z.object({
    space: z.string().min(1).max(200).describe('Name of the space, e.g. "Tarifas 2026"'),
    subject: z
      .string()
      .min(1)
      .max(200)
      .describe('A team name, a person\'s name or email, or "everyone" / "toda la empresa"'),
    level: z.enum(['view', 'contribute', 'admin']).default('view'),
    remove: z.boolean().default(false).describe('Take the access away instead of giving it'),
  }),
  outputSchema: z.object({
    space: z.string(),
    subject: z.string(),
    /** Qué pasó, en una frase que se puede repetir tal cual. */
    summary: z.string(),
    /** Quién entra ahora, para que la respuesta pueda decirlo sin otra llamada. */
    access: z.array(
      z.object({
        who: z.string(),
        kind: z.enum(['everyone', 'team', 'user']),
        level: z.enum(['view', 'contribute', 'admin']),
      }),
    ),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const space = await resolveSpaceByName(ctx.db, ctx.userId, input.space);
    if (!space) {
      const names = (await listVisibleSpaces(ctx.db, ctx.userId)).map((s) => s.name);
      throw new NotFoundError(
        names.length > 0
          ? `No hay ningún espacio llamado «${input.space}». Los que ves son: ${names.join(', ')}.`
          : `No hay ningún espacio llamado «${input.space}».`,
      );
    }
    // Antes de mirar a quién: si no lo administra, la pregunta de a quién dárselo
    // no llega a hacerse, y el error nombra el espacio y no a la persona.
    await assertCanAdminSpace(ctx.db, ctx.userId, space.id);

    const wanted = input.subject.trim().toLowerCase();
    const EVERYONE = new Set([
      'everyone',
      'todos',
      'toda la empresa',
      'la empresa',
      'todo el mundo',
      'toda la organización',
    ]);

    let subject: { kind: 'everyone' | 'team' | 'user'; id?: string | null };
    let subjectLabel: string;

    if (EVERYONE.has(wanted)) {
      subject = { kind: 'everyone' };
      subjectLabel = 'toda la empresa';
    } else {
      const [teams, people] = await Promise.all([
        ctx.db.from('teams').select('id, name'),
        ctx.db.from('users').select('id, name, email'),
      ]);

      const team = ((teams.data ?? []) as Array<{ id: string; name: string }>).find(
        (t) => t.name.trim().toLowerCase() === wanted,
      );
      const person = (
        (people.data ?? []) as Array<{ id: string; name: string | null; email: string }>
      ).find(
        (p) =>
          p.email.trim().toLowerCase() === wanted || (p.name ?? '').trim().toLowerCase() === wanted,
      );

      // Un equipo y una persona con el mismo nombre es raro y no se adivina: dar
      // acceso al equipo equivocado son diez personas de más leyendo algo.
      if (team && person) {
        throw new NotFoundError(
          `«${input.subject}» es a la vez un equipo y una persona. Dime cuál de los dos — para la persona, usa su correo.`,
        );
      }
      if (team) {
        subject = { kind: 'team', id: team.id };
        subjectLabel = `el equipo ${team.name}`;
      } else if (person) {
        subject = { kind: 'user', id: person.id };
        subjectLabel = person.name?.trim() || person.email;
      } else {
        throw new NotFoundError(
          `No encuentro ningún equipo ni ninguna persona que se llame «${input.subject}» en este espacio de trabajo.`,
        );
      }
    }

    // zod deja el campo opcional en el tipo de ENTRADA aunque tenga `.default()`,
    // así que el defecto se vuelve a decir aquí en vez de afirmar que ya está.
    const level = input.level ?? 'view';

    if (input.remove) {
      await revokeSpaceAccess(ctx.db, ctx.userId, space.id, subject);
    } else {
      await grantSpaceAccess(ctx.db, ctx.userId, space.id, subject, level);
    }

    const access = await listSpaceAccess(ctx.db, ctx.userId, space.id);
    const verb = { view: 'ver', contribute: 'aportar a', admin: 'administrar' }[level];

    return {
      space: space.name,
      subject: subjectLabel,
      summary: input.remove
        ? `${subjectLabel === 'toda la empresa' ? 'La empresa ya no ve' : `${subjectLabel} ya no ve`} «${space.name}».`
        : `${subjectLabel} ahora puede ${verb} «${space.name}».`,
      access: access.map((g) => ({
        who: g.subjectName,
        kind: g.subjectKind,
        level: g.level,
      })),
    };
  },
});
