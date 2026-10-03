import { z } from 'zod';
import { registerTool } from '../index';
import { MODULE_KEYS, moduleByKey } from './catalog';
import { readModuleStates, setModule } from './store';

/**
 * LOS INTERRUPTORES EN EL CHAT:
 *
 *   modules.list  «¿qué módulos tengo prendidos?» — cada área con su estado.
 *   modules.set   «prende el módulo de nómina», «apaga inventario» — sólo
 *                 administradores o el dueño; pide confirmación. Prender
 *                 prende también lo que el módulo necesita.
 *
 * Ninguna de las dos es de un módulo (no empiezan por ningún prefijo del
 * catálogo), así que nunca se apagan a sí mismas.
 */

const moduleOut = z.object({
  key: z.string(),
  label: z.string(),
  area: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  beta: z.boolean(),
  requires: z.array(z.string()),
});

export const modulesList = registerTool({
  id: 'modules.list',
  description:
    "«¿Qué módulos tengo prendidos?», «¿tengo nómina?», «¿por qué no veo inventario?»: every Cortex module (finance, payables, sales, inventory, taxes, payroll, fleet, CRM, autopilot…) with whether it is on or off for this company, what it covers and what it needs. A module that is off is hidden from the menu, the agent's tools and the autopilot; its data is kept. Read-only.",
  inputSchema: z.object({}),
  outputSchema: z.object({ modules: z.array(moduleOut), markdown: z.string() }),
  handler: async (_input, ctx) => {
    const states = await readModuleStates(ctx.db);
    const modules = states.map((s) => {
      const m = moduleByKey(s.key);
      return {
        key: m.key,
        label: m.label,
        area: m.area,
        description: m.description,
        enabled: s.enabled,
        beta: Boolean(m.beta),
        requires: (m.requires ?? []).map((k) => moduleByKey(k).label),
      };
    });
    const on = modules.filter((m) => m.enabled);
    const off = modules.filter((m) => !m.enabled);
    const line = (m: (typeof modules)[number]) =>
      `- **${m.label}**${m.beta ? ' (beta)' : ''}: ${m.description}`;
    const markdown = [
      `**Prendidos (${on.length})**\n${on.map(line).join('\n')}`,
      off.length ? `**Apagados (${off.length})**\n${off.map(line).join('\n')}` : '',
      'Se cambian en Ajustes › Módulos (/settings/modulos), o pídemelo si administras la empresa.',
    ]
      .filter(Boolean)
      .join('\n\n');
    return { modules, markdown };
  },
});

export const modulesSet = registerTool({
  id: 'modules.set',
  description: `«Prende el módulo de nómina», «apaga inventario», «activa flota y rutas», «quita la atención por WhatsApp»: turn one Cortex module on or off for this company (admins or the company owner only; requires confirmation). Turning one on also turns on the modules it needs; turning off one that another enabled module needs is refused with what to turn off first. Turning off hides the module from the menu, the agent's tools and the autopilot — it never deletes data. Module keys: ${MODULE_KEYS.join(', ')}.`,
  inputSchema: z.object({
    module: z.enum(MODULE_KEYS),
    enabled: z.boolean(),
  }),
  outputSchema: z.object({
    changed: z.array(z.object({ key: z.string(), label: z.string(), enabled: z.boolean() })),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const result = await setModule(ctx.db, {
      key: input.module,
      enabled: input.enabled,
      userId: ctx.userId,
      via: 'chat',
    });
    const changed = result.changed.map((c) => ({
      key: c.key,
      label: moduleByKey(c.key).label,
      enabled: c.enabled,
    }));
    const m = moduleByKey(input.module);
    const markdown = !changed.length
      ? `${m.label} ya estaba ${input.enabled ? 'prendido' : 'apagado'}. No cambié nada.`
      : [
          ...changed.map((c) => `- ${c.label}: ${c.enabled ? 'prendido' : 'apagado'}`),
          input.enabled
            ? `\nYa aparece en el menú y puedo usar sus herramientas desde el próximo mensaje${m.routes[0] ? ` (${m.routes[0]})` : ''}.`
            : '\nSale del menú, de mis herramientas y del piloto automático. Los datos quedan guardados: si lo vuelves a prender, todo sigue ahí.',
        ].join('\n');
    return { changed, markdown };
  },
});
