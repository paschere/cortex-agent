import 'server-only';

import type { AppPayload, AutomationPayload, ViewPayload } from '@/lib/guided-setup-shape';
import { runViewDesign } from '@/lib/views/design-run';
import {
  type AppTemplate,
  NO_THINKING,
  appsAutomationsCreate,
  appsDesign,
  chatModel,
  checkMeter,
  consumeToken,
  createAutomation,
  installAppTemplate,
  isRefused,
  listRoles,
  listScreens,
  listTrackers,
  repairStructured,
  reviewAppDraft,
  roleInputSchema,
  viewSpecSchema,
} from '@cortex/agent-tools';
import { ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { generateObject } from 'ai';
import { z } from 'zod';

/**
 * LOS DISEÑADORES QUE USA LA ENTREVISTA AL APLICAR.
 *
 * ===========================================================================
 * NO HAY LÓGICA DE DISEÑO NUEVA AQUÍ
 * ===========================================================================
 * Una vista la diseña el diseñador de vistas de siempre (`runViewDesign`, el
 * mismo de /api/views/design). Una aplicación pasa por `reviewAppDraft`, que es
 * el revisor de `apps.design`, y se instala con `installAppTemplate`, que es lo
 * que `apps.create` hace por dentro. Una automatización se valida y se guarda
 * con `createAutomation`, la misma función de `apps.automations.create`. Lo
 * único propio de este archivo es el pegamento: convertir lo que la persona
 * dijo en el borrador que esos módulos esperan, usando la GRAMÁTICA que las
 * propias herramientas le dan al chat (su `description`).
 *
 * Todos devuelven `{ ok: false, reason }` en vez de lanzar cuando el diseño no
 * cuadra: quien llama lo convierte en «seguir en el chat», con el pedido
 * escrito, que es mejor que una pantalla roja.
 *
 * ===========================================================================
 * LO QUE SALE ES UN BORRADOR, SIEMPRE
 * ===========================================================================
 * La vista nace interna (sin enlace público). La aplicación nace sin publicar
 * y sin miembros. La automatización nace en pausa. Quien activa cada una es una
 * persona, mirando lo que quedó.
 */

export type Designed<T> = { ok: true; value: T } | { ok: false; reason: string };

const NO_ANSWERS = 'No quedan respuestas disponibles en el plan.';

/** Cada diseño es una llamada al modelo que la persona pidió: cuenta como una respuesta. */
async function spend(db: SupabaseClient, userId: string, toolId: string): Promise<string | null> {
  try {
    await consumeToken(db, userId, toolId, 4);
    if (isRefused(await checkMeter(db, 'answers'))) return NO_ANSWERS;
    return null;
  } catch {
    return 'Vas muy rápido. Sigue en el chat en un momento.';
  }
}

export interface DesignerUser {
  id: string;
  organizationName: string;
}

// ---------------------------------------------------------------------------
// Vista
// ---------------------------------------------------------------------------

export interface DesignedView {
  name: string;
  description: string;
  spec: z.infer<typeof viewSpecSchema>;
  newTrackers: Array<{
    slug: string;
    name: string;
    description: string;
    fields: unknown[];
    duplicates?: unknown;
  }>;
}

export async function designView(
  db: SupabaseClient,
  user: DesignerUser,
  payload: ViewPayload,
): Promise<Designed<DesignedView>> {
  const refused = await spend(db, user.id, 'views.design');
  if (refused) return { ok: false, reason: refused };
  try {
    const prompt = [payload.name, payload.description, payload.request]
      .filter(Boolean)
      .join('. ')
      .slice(0, 3900);
    const outcome = await runViewDesign(
      db,
      { id: user.id, organizationName: user.organizationName },
      { prompt },
    );
    if (outcome.status === 'ready') {
      return {
        ok: true,
        value: {
          name: payload.name,
          description: outcome.draft.description || payload.description,
          spec: outcome.draft.spec,
          newTrackers: outcome.draft.newTrackers as DesignedView['newTrackers'],
        },
      };
    }
    if (outcome.status === 'needs_input') {
      return { ok: false, reason: outcome.questions[0] ?? outcome.explanation };
    }
    return { ok: false, reason: 'No encontré la vista.' };
  } catch (err) {
    return { ok: false, reason: errorText(err) };
  }
}

// ---------------------------------------------------------------------------
// Aplicación
// ---------------------------------------------------------------------------

const AppAsk = z.object({
  questions: z.array(z.string()).max(3).describe('Sólo si de verdad no puedes diseñar.'),
  draftJson: z
    .string()
    .describe(
      'El borrador como texto JSON: {name, description, icon, roles, screens, homeScreen}. Vacío si preguntas.',
    ),
});

const APP_DESIGNER = [
  'Eres Cortex, el gerente operativo de la empresa indicada. Diseñas UNA aplicación a partir de lo que pidió su gerente.',
  'No ejecutas nada: devuelves el borrador como `draftJson` y un revisor lo comprueba contra las tablas reales.',
  'Usa SÓLO tablas que estén en `tables` (con sus claves de campo exactas). Si falta una tabla, no la inventes: pregunta en `questions`.',
  'Pantallas y roles pensados para quien los usa; el operario trabaja en el celular.',
  'Responde en español de Colombia.',
].join('\n');

const AUTOMATION_DESIGNER = [
  'Eres Cortex. Conviertes una regla escrita en palabras («cuando X, si Y, haz Z») en una automatización de una aplicación.',
  'Devuelve `automationJson` como texto JSON: {name, trigger, conditions, actions}. Sin `enabled`: la regla nace en pausa.',
  'Usa SÓLO tablas, campos, pantallas y roles que estén en el contexto. Si no se puede con la gramática, pregunta en `questions`.',
  'Los avisos van por notificación y correo, nunca por WhatsApp.',
].join('\n');

function tablesContext(rows: Awaited<ReturnType<typeof listTrackers>>) {
  return rows.slice(0, 25).map((t) => ({
    slug: t.slug,
    name: t.name,
    description: t.description,
    fields: t.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      ...(f.options ? { options: f.options } : {}),
    })),
  }));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // El modelo a veces envuelve el JSON en una cerca de código.
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

export interface DesignedApp {
  appId: string;
  slug: string;
  name: string;
  screens: number;
}

export async function designAndCreateApp(
  db: SupabaseClient,
  user: DesignerUser,
  payload: AppPayload,
): Promise<Designed<DesignedApp>> {
  const refused = await spend(db, user.id, 'apps.design');
  if (refused) return { ok: false, reason: refused };
  try {
    const tables = tablesContext(await listTrackers(db, 40));
    const ask = (extra?: Record<string, unknown>) =>
      generateObject({
        model: chatModel(),
        schema: AppAsk,
        experimental_repairText: repairStructured(['questions', 'draftJson']),
        experimental_providerMetadata: NO_THINKING,
        maxTokens: 12000,
        abortSignal: AbortSignal.timeout(75_000),
        system: `${APP_DESIGNER}\n\nGRAMÁTICA (la de la herramienta apps.design):\n${appsDesign.description}`,
        prompt: JSON.stringify({
          company: user.organizationName,
          request: {
            name: payload.name,
            description: payload.description,
            detail: payload.request,
          },
          tables,
          ...extra,
        }),
      });

    let { object } = await ask();
    if (!object.draftJson.trim()) {
      return { ok: false, reason: object.questions[0] ?? 'Me faltan datos para diseñarla.' };
    }
    let review = await reviewAppDraft(db, parseJson(object.draftJson), { viewerId: user.id });
    if (!review.ok) {
      ({ object } = await ask({
        previousAttempt: object.draftJson.slice(0, 20_000),
        problems: review.problems,
        instruction: 'Corrige exactamente estos problemas y devuelve el borrador completo.',
      }));
      review = await reviewAppDraft(db, parseJson(object.draftJson), { viewerId: user.id });
    }
    if (!review.ok || !review.draft) {
      return { ok: false, reason: review.problems[0] ?? 'El diseño no cuadró con tus tablas.' };
    }

    const draft = review.draft;
    // La misma plantilla a medida que arma `apps.create` por dentro.
    const template: AppTemplate = {
      id: 'custom',
      name: draft.name,
      icon: draft.icon ?? '📱',
      body: draft.description,
      accent: 'primary',
      trackers: [],
      roles: draft.roles.map((r) => roleInputSchema.parse(r)),
      screens: draft.screens.map((s, i) => ({
        slug: s.slug ?? `pantalla_${i + 1}`,
        title: s.title,
        icon: s.icon || 'LayoutPanelTop',
        roles: s.roles ?? [],
        spec: viewSpecSchema.parse(s.spec),
      })),
      homeScreen: draft.homeScreen ?? draft.screens[0]?.slug ?? 'pantalla_1',
    };
    const { app, screens } = await installAppTemplate(db, template, {
      userId: user.id,
      name: payload.name,
      description: payload.description || undefined,
    });
    return {
      ok: true,
      value: { appId: app.id, slug: app.slug, name: app.name, screens: screens.length },
    };
  } catch (err) {
    return { ok: false, reason: errorText(err) };
  }
}

// ---------------------------------------------------------------------------
// Automatización
// ---------------------------------------------------------------------------

const AutomationAsk = z.object({
  questions: z.array(z.string()).max(3),
  automationJson: z.string().describe('{name, trigger, conditions, actions} como texto JSON.'),
});

export interface DesignedAutomation {
  automationId: string;
  name: string;
}

export async function designAndCreateAutomation(
  db: SupabaseClient,
  user: DesignerUser,
  app: { id: string; name: string },
  payload: AutomationPayload,
): Promise<Designed<DesignedAutomation>> {
  const refused = await spend(db, user.id, 'apps.automations.design');
  if (refused) return { ok: false, reason: refused };
  try {
    const [tables, screens, roles] = await Promise.all([
      listTrackers(db, 40),
      listScreens(db, app.id),
      listRoles(db, app.id),
    ]);
    const ask = (extra?: Record<string, unknown>) =>
      generateObject({
        model: chatModel(),
        schema: AutomationAsk,
        experimental_repairText: repairStructured(['questions', 'automationJson']),
        experimental_providerMetadata: NO_THINKING,
        maxTokens: 4000,
        abortSignal: AbortSignal.timeout(60_000),
        system: `${AUTOMATION_DESIGNER}\n\nGRAMÁTICA (la de la herramienta apps.automations.create):\n${appsAutomationsCreate.description}`,
        prompt: JSON.stringify({
          app: app.name,
          rule: payload.rule,
          nameHint: payload.name,
          tables: tablesContext(tables),
          screens: screens.map((s) => ({ slug: s.slug, title: s.title })),
          roles: roles.map((r) => r.key),
          ...extra,
        }),
      });

    const build = (json: string) => {
      const raw = parseJson(json);
      if (!raw || typeof raw !== 'object') return null;
      // Siempre en pausa: la persona la activa, no el onboarding.
      return { ...(raw as Record<string, unknown>), enabled: false };
    };

    let { object } = await ask();
    let draft = build(object.automationJson);
    if (!draft) return { ok: false, reason: object.questions[0] ?? 'No pude armar la regla.' };
    try {
      const created = await createAutomation(db, app.id, draft, user.id);
      return { ok: true, value: { automationId: created.id, name: created.name } };
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      ({ object } = await ask({
        previousAttempt: object.automationJson.slice(0, 8000),
        problems: [err.message],
        instruction: 'Corrige exactamente estos problemas y devuelve la regla completa.',
      }));
      draft = build(object.automationJson);
      if (!draft) return { ok: false, reason: err.message };
      const created = await createAutomation(db, app.id, draft, user.id);
      return { ok: true, value: { automationId: created.id, name: created.name } };
    }
  } catch (err) {
    return { ok: false, reason: errorText(err) };
  }
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 300 ? `${text.slice(0, 297)}…` : text || 'No se pudo diseñar.';
}
