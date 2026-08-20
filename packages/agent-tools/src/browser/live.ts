import { z } from 'zod';
import { registerTool } from '../index';
import { createHttpTransport } from './client';
import { forbiddenTargetReason } from './live-target';
import type { PageSnapshot, SnapshotEntry, Target } from './types';

/**
 * Navegación libre: Cortex al volante de una pestaña de verdad, con la persona
 * mirando en vivo desde el chat.
 *
 * ===========================================================================
 * QUÉ ES ESTO Y QUÉ NO ES
 * ===========================================================================
 * Los trámites (`browser.run_flow`) siguen siendo el camino normal: aprendidos
 * una vez, repetidos sin modelo, baratos. Esto es el OTRO camino — el sitio
 * que nadie ha enseñado, la diligencia de una sola vez, el «entra y mira qué
 * dice» — hecho como lo hace una persona: mirar la página, decidir un paso,
 * darlo, volver a mirar.
 *
 * Lo caro está declarado en reasoned.ts: una llamada de modelo por click.
 * Por eso este camino no reemplaza a los trámites; los alimenta. Un recorrido
 * que salió bien es exactamente lo que extract.ts sabe convertir en flow.
 *
 * ===========================================================================
 * LA PERSONA VE TODO, Y ESA ES LA GOBERNANZA
 * ===========================================================================
 * Abrir la pestaña pide confirmación — una vez, como enviar un correo. Desde
 * ahí cada acto pasa por `runTool` (auditado, con límite de frecuencia) y la
 * pestaña se pinta EN VIVO en el chat. Tres cosas solo pueden hacerse desde
 * esa tarjeta, nunca desde aquí:
 *
 *   * TOMAR EL VOLANTE. La persona conduce, el bot recibe 409 y espera.
 *     El bot puede PEDIR ayuda (`browser.ask_person`); tomar es de humanos.
 *   * ESCRIBIR UN SECRETO. `browser.request_secret` señala el campo y le pone
 *     nombre; el valor viaja del teclado de la persona a la página y el modelo
 *     no lo ve jamás — ni en el transcript, ni en un log, ni aquí.
 *   * DEVOLVER EL VOLANTE, que es lo que le dice al bot que siga.
 *
 * ===========================================================================
 * CÓMO SE SEÑALA UN ELEMENTO SIN PODER MENTIR
 * ===========================================================================
 * El modelo actúa por `ref` (e1, e2…) del último vistazo. Pero una ref es un
 * índice sobre una página que puede haber cambiado, así que actuar exige
 * también el `name` que el modelo leyó: la herramienta vuelve a mirar la
 * página, resuelve la ref contra ESA mirada fresca y comprueba que el nombre
 * coincida. Si no coincide, no actúa — devuelve la página como está ahora y
 * la frase «mira de nuevo». La misma tesis del gateway de OpenBot, con la
 * mecánica de snapshot.ts que ya teníamos: la política jamás decide sobre una
 * etiqueta que puso quien pide.
 */

const sessionField = z
  .string()
  .min(1)
  .max(60)
  .describe('El id de la pestaña, tal como lo devolvió browser.open_page');

/**
 * Lo que el modelo ve de la página. Acotado: es contexto, no un volcado.
 *
 * DOS TAMAÑOS, Y EL PORQUÉ EN TOKENS. Una navegación son diez o doce actos, y
 * cada acto devuelve la página fresca; a vista completa (~1.500 tokens) el
 * transcript del turno engorda cuadráticamente y se paga en cada paso
 * siguiente. Así que actuar devuelve la vista de MANIOBRA — dónde estoy y con
 * qué puedo actuar: url, avisos, elementos y un pellizco de texto — y LEER
 * (browser.read_page) devuelve la página entera. Es la misma división del
 * prompt del sistema: snapshot→act→read; el texto largo se pide cuando toca
 * responder con él, no en cada click.
 */
function viewOf(snapshot: PageSnapshot, size: 'full' | 'lite' = 'full') {
  const lite = size === 'lite';
  return {
    url: snapshot.url,
    title: snapshot.title,
    ...(lite ? {} : { headings: snapshot.headings.slice(0, 8) }),
    alerts: snapshot.alerts.slice(0, 6),
    text: snapshot.text.slice(0, lite ? 700 : 2_500),
    elements: snapshot.elements.slice(0, lite ? 35 : 50).map((el) => ({
      ref: el.ref,
      role: el.role,
      name: el.name,
      ...(el.value !== null && el.value !== '' ? { value: el.value } : {}),
      ...(el.disabled ? { disabled: true } : {}),
    })),
  };
}

const viewSchema = z.object({
  url: z.string(),
  title: z.string(),
  headings: z.array(z.string()),
  alerts: z.array(z.string()),
  text: z.string(),
  elements: z.array(
    z.object({
      ref: z.string(),
      role: z.string(),
      name: z.string(),
      value: z.string().optional(),
      disabled: z.boolean().optional(),
    }),
  ),
});

/**
 * La ref del modelo, resuelta contra una mirada fresca y verificada contra el
 * nombre que el modelo dice haber leído. Devuelve el elemento o una frase.
 */
function resolveRef(
  snapshot: PageSnapshot,
  ref: string,
  claimedName: string,
): { el: SnapshotEntry } | { stale: string } {
  const el = snapshot.elements.find((e) => e.ref === ref);
  if (!el) {
    return {
      stale: `La página ya no tiene un elemento ${ref}. Cambió desde tu último vistazo: mira los elementos de ahora y elige de nuevo.`,
    };
  }
  const wanted = claimedName.trim().toLowerCase();
  const actual = (el.name ?? '').trim().toLowerCase();
  // Igualdad laxa: el nombre accesible de un botón no cambia por un espacio,
  // y exigir igualdad estricta convertiría cada tilde en un reintento.
  if (wanted && actual && actual !== wanted && !actual.includes(wanted) && !wanted.includes(actual)) {
    return {
      stale: `El elemento ${ref} ahora se llama «${el.name}», no «${claimedName}». La página cambió: mira de nuevo antes de actuar.`,
    };
  }
  return { el };
}

function bestTarget(el: SnapshotEntry): Target | null {
  return el.targets[0] ?? null;
}

export const browserOpenPage = registerTool({
  id: 'browser.open_page',
  description:
    'Abre una página web en una pestaña VIVA que la persona ve en el chat mientras tú navegas — para sitios donde NO hay un trámite aprendido (browser.list_flows dice cuáles hay). Sirve para «entra al portal y mira», «revisa qué dice esa página cuando te logueas», «haz esta diligencia de una vez en este sitio»: navegar, llenar formularios, consultar resultados, con la persona mirando en vivo y pudiendo tomar el control cuando un paso sea suyo (un captcha, una clave). Devuelve el id de la pestaña y lo que hay en la página: úsalo con browser.act para actuar, browser.read_page para leer, browser.ask_person cuando necesites manos humanas y browser.request_secret cuando un campo pida una contraseña. NO es para búsquedas (web.search) ni para leer una página estática (web.scrape): es para OPERAR un sitio.',
  inputSchema: z.object({
    url: z.string().url().max(600).describe('La dirección completa, con https://'),
    purpose: z
      .string()
      .max(200)
      .describe('Qué vas a hacer ahí, en una frase. Es lo que la persona aprueba y lo que queda en la auditoría.'),
  }),
  outputSchema: z.object({
    sessionId: z.string(),
    page: viewSchema,
    guidance: z.string(),
  }),
  // Una vez por pestaña, como enviar un correo: la persona aprueba «voy a
  // entrar a X a hacer Y» y desde ahí mira en vivo. Los actos dentro de la
  // pestaña quedan auditados uno a uno, no confirmados uno a uno.
  requiresConfirmation: true,
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    // El piso SSRF, aquí para que la frase llegue en el turno; el servicio lo
    // vuelve a aplicar aunque este lado falle (live-target.ts dice por qué dos).
    const forbidden = forbiddenTargetReason(input.url);
    if (forbidden) throw new Error(forbidden);
    const transport = createHttpTransport(ctx.logger);
    const opened = await transport.openSession(input.url, ctx.organizationId);
    if (!opened.ok) throw new Error(opened.reason);
    return {
      sessionId: opened.data.sessionId,
      page: viewOf(opened.data.snapshot),
      guidance:
        'La persona está viendo esta pestaña en vivo en el chat. Actúa con browser.act usando la ref Y el name del elemento. ' +
        'Si aparece un captcha, un 2FA o cualquier paso que necesite manos humanas, usa browser.ask_person y DETENTE. ' +
        'Si un campo pide una contraseña u otro secreto, usa browser.request_secret — nunca pidas que te la escriban en el chat. ' +
        'Cuando termines, cierra con browser.close_page.',
    };
  },
});

export const browserAct = registerTool({
  id: 'browser.act',
  description:
    'Da UN paso en la pestaña viva que abriste con browser.open_page: click en un botón o enlace, llenar un campo, elegir una opción, marcar una casilla, presionar una tecla o navegar a otra URL. Señala el elemento con su ref y su name tal como los viste en el último vistazo — si la página cambió debajo tuyo, la herramienta no actúa y te devuelve la página como está ahora. Devuelve siempre la página fresca después del paso, así que el patrón es: actuar, leer lo que devolvió, decidir el siguiente paso. Si te contesta que una persona está conduciendo, NO insistas: espera a que te avise.',
  inputSchema: z.object({
    sessionId: sessionField,
    action: z
      .enum(['click', 'fill', 'select', 'check', 'press', 'goto', 'wait'])
      .describe('Qué gesto: click | fill (escribe text en el campo) | select (elige la opción text) | check | press (una tecla, en text) | goto (navega a url) | wait (deja cargar un segundo)'),
    ref: z.string().max(12).optional().describe('La ref del elemento del último vistazo (e5). Obligatoria salvo goto y wait.'),
    name: z
      .string()
      .max(120)
      .optional()
      .describe('El name del elemento tal como lo leíste. Es la verificación de que la página no cambió.'),
    text: z.string().max(500).optional().describe('El texto a escribir, la opción a elegir o la tecla a presionar.'),
    url: z.string().url().max(600).optional().describe('Solo para goto.'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    message: z.string(),
    page: viewSchema.optional(),
  }),
  rateLimit: { perMinute: 40 },
  handler: async (input, ctx) => {
    const transport = createHttpTransport(ctx.logger);
    const owner = ctx.organizationId;

    if (input.action === 'goto' && input.url) {
      const forbidden = forbiddenTargetReason(input.url);
      if (forbidden) return { ok: false, message: forbidden };
    }

    let target: Target | null = null;
    if (input.action !== 'goto' && input.action !== 'wait') {
      if (!input.ref) {
        return { ok: false, message: 'Ese gesto necesita la ref de un elemento del último vistazo.' };
      }
      // La mirada fresca contra la que se resuelve la ref. Es una petición
      // más, y es el precio de no actuar nunca sobre una página imaginada.
      const fresh = await transport.read(input.sessionId, owner);
      if (!fresh.ok) return { ok: false, message: fresh.reason };
      const resolved = resolveRef(fresh.data, input.ref, input.name ?? '');
      if ('stale' in resolved) {
        return { ok: false, message: resolved.stale, page: viewOf(fresh.data, 'lite') };
      }
      target = bestTarget(resolved.el);
      if (!target) {
        return { ok: false, message: `El elemento ${input.ref} no tiene forma estable de señalarse. Prueba otro camino.` };
      }
    }

    const acted = await transport.act({
      sessionId: input.sessionId,
      action: input.action === 'wait' ? 'wait_for' : input.action,
      target,
      text: input.text ?? '',
      url: input.url ?? '',
      owner,
    });
    if (!acted.ok) return { ok: false, message: acted.reason };
    return {
      ok: acted.data.ok,
      message: acted.data.ok
        ? `Hecho${acted.data.matchedTarget ? ` sobre ${acted.data.matchedTarget}` : ''}.`
        : `No se pudo: ${acted.data.error ?? 'sin detalle'}. La página de ahora viene abajo; decide con ella.`,
      // La vista de maniobra. Para LEER el contenido está browser.read_page.
      page: viewOf(acted.data.snapshot, 'lite'),
    };
  },
});

export const browserReadPage = registerTool({
  id: 'browser.read_page',
  description:
    'Vuelve a mirar la pestaña viva sin tocar nada: la URL donde quedó, el texto visible y los elementos con los que se puede actuar. Úsala después de que una persona condujo («ya terminé, sigue»), cuando un paso falló y necesitas orientarte, o para leer el resultado de una consulta antes de contárselo a la persona — la respuesta sale de lo que leíste aquí, no de mandar a nadie a mirar la página.',
  inputSchema: z.object({ sessionId: sessionField }),
  outputSchema: z.object({ page: viewSchema }),
  rateLimit: { perMinute: 40 },
  handler: async (input, ctx) => {
    const transport = createHttpTransport(ctx.logger);
    const fresh = await transport.read(input.sessionId, ctx.organizationId);
    if (!fresh.ok) throw new Error(fresh.reason);
    return { page: viewOf(fresh.data) };
  },
});

export const browserAskPerson = registerTool({
  id: 'browser.ask_person',
  description:
    'Levanta la mano: le pide a la persona que tome el control de la pestaña viva porque el siguiente paso necesita manos humanas — un captcha, un «no soy un robot», un 2FA en su celular, una decisión que no es tuya. La persona ve tu razón en la tarjeta del chat, conduce con su mouse y su teclado, y te avisa cuando devuelve el control. Después de llamarla, DETENTE: termina tu turno diciendo qué esperas, no sigas actuando. Nada de lo que la persona haga mientras conduce te llega — cuando retomes, mira la página con browser.read_page porque pudo cambiar entera.',
  inputSchema: z.object({
    sessionId: sessionField,
    reason: z
      .string()
      .min(5)
      .max(300)
      .describe('Qué necesitas que haga, en sus palabras: «marca la casilla “no soy un robot”», «ingresa el código que te llegó al celular».'),
  }),
  outputSchema: z.object({ ok: z.boolean(), sessionId: z.string(), reason: z.string(), message: z.string() }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const transport = createHttpTransport(ctx.logger);
    const asked = await transport.control(input.sessionId, 'request', input.reason, ctx.organizationId);
    if (!asked.ok) throw new Error(asked.reason);
    return {
      ok: true,
      // La tarjeta del chat se dibuja con esto: qué pestaña y qué se pide.
      sessionId: input.sessionId,
      reason: input.reason,
      message:
        'Listo, la persona ya ve tu pedido sobre la pantalla en vivo. Termina tu turno aquí y dile qué esperas. Cuando te devuelva el control te va a avisar en el chat; entonces mira la página de nuevo antes de seguir.',
    };
  },
});

export const browserRequestSecret = registerTool({
  id: 'browser.request_secret',
  description:
    'Un campo de la página pide una contraseña, un token o cualquier secreto: señálalo con esta herramienta y la persona lo escribirá en una caja enmascarada que va DIRECTO a la página — tú no verás el valor nunca, ni debe aparecer jamás en el chat. Úsala en cuanto un login te lo pida; NUNCA le pidas a nadie que escriba una clave en la conversación, y nunca intentes llenar un campo de contraseña con browser.act. Después de llamarla, detente y espera el aviso de la persona.',
  inputSchema: z.object({
    sessionId: sessionField,
    ref: z.string().max(12).describe('La ref del campo, del último vistazo.'),
    name: z.string().max(120).describe('El name del campo tal como lo leíste.'),
    label: z
      .string()
      .min(3)
      .max(120)
      .describe('Cómo se le nombra el secreto a la persona: «Contraseña del portal de la DIAN».'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    sessionId: z.string().optional(),
    label: z.string().optional(),
    message: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const transport = createHttpTransport(ctx.logger);
    const owner = ctx.organizationId;
    const fresh = await transport.read(input.sessionId, owner);
    if (!fresh.ok) throw new Error(fresh.reason);
    const resolved = resolveRef(fresh.data, input.ref, input.name);
    if ('stale' in resolved) return { ok: false, message: resolved.stale };
    const target = bestTarget(resolved.el);
    if (!target) {
      return { ok: false, message: 'Ese campo no tiene forma estable de señalarse. Mira la página de nuevo.' };
    }
    const asked = await transport.requestSecret(input.sessionId, target, input.label, owner);
    if (!asked.ok) throw new Error(asked.reason);
    return {
      ok: true,
      sessionId: input.sessionId,
      label: input.label,
      message: `La persona ya tiene la caja para escribir «${input.label}» directo en la página. Termina tu turno y espera su aviso; el valor no te va a llegar, y así es como debe ser.`,
    };
  },
});

export const browserClosePage = registerTool({
  id: 'browser.close_page',
  description:
    'Cierra la pestaña viva cuando la diligencia terminó o ya no hace falta. Ciérrala siempre que acabes: una pestaña abierta ocupa un puesto que otra diligencia puede necesitar.',
  inputSchema: z.object({ sessionId: sessionField }),
  outputSchema: z.object({ ok: z.boolean() }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const transport = createHttpTransport(ctx.logger);
    await transport.closeSession(input.sessionId);
    return { ok: true };
  },
});
