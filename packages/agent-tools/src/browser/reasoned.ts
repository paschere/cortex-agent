import type { Logger } from '@cortex/core';
import { generateText } from 'ai';
import { utilityModel } from '../model';
import type { BrowserTransport } from './client';
import { addSpend, spendOf } from './cost';
import type { ModelSpend, PageSnapshot, Target } from './types';
import { EMPTY_SPEND } from './types';

/**
 * The same errand, done the expensive way.
 *
 * This is the baseline the whole module is measured against, and it exists in
 * the repository rather than in a slide because a claim about speed and cost
 * that cannot be re-run is not a measurement. `scripts/browser-benchmark.ts`
 * runs this and `execute.runFlow` against the same site and prints the two
 * numbers; `docs/operations/browser.md` § 5 carries the result.
 *
 * It is also a genuine fallback: a flow nobody has taught can still be done
 * this way, once, slowly. What it must never be is the normal path -- a portal
 * driven by a model takes a model call per click, which is one to three seconds
 * and a fraction of a cent each, on an errand that has a dozen clicks and is
 * run forty times a month.
 *
 * The loop below is the honest, ordinary shape of a browser agent: look at the
 * page, decide one action, do it, look again. Nothing about it is
 * strawmanned -- it gets the same snapshot the repairer gets, the same
 * semantic locators, and the same browser.
 */

const MAX_TURNS = 25;

export interface ReasonedResult {
  ok: boolean;
  message: string;
  output: Record<string, unknown>;
  turns: number;
  durationMs: number;
  spend: ModelSpend;
}

function renderSnapshot(snapshot: PageSnapshot): string {
  const elements = snapshot.elements
    .slice(0, 60)
    .map((el) => {
      const target = el.targets[0];
      const how = target
        ? `${target.kind}=${target.value}${target.name ? `|${target.name}` : ''}`
        : '(sin localizador)';
      return `  ${el.ref} ${el.role}${el.name ? ` "${el.name}"` : ''} [${how}]${
        el.disabled ? ' (deshabilitado)' : ''
      }`;
    })
    .join('\n');
  return `URL: ${snapshot.url}
Título: ${snapshot.title}
Encabezados: ${snapshot.headings.slice(0, 6).join(' | ') || '(ninguno)'}
${snapshot.alerts.length > 0 ? `Avisos: ${snapshot.alerts.join(' | ')}\n` : ''}Texto de la página: ${
    snapshot.text.slice(0, 1200) || '(vacía)'
  }
Elementos:
${elements || '  (ninguno)'}`;
}

function parseJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function runReasoned(input: {
  goal: string;
  startUrl: string;
  inputs: Record<string, string>;
  transport: BrowserTransport;
  logger: Logger;
}): Promise<ReasonedResult> {
  const startedAt = Date.now();
  let spend = EMPTY_SPEND;
  const output: Record<string, unknown> = {};

  const opened = await input.transport.openSession(input.startUrl);
  if (!opened.ok) {
    return {
      ok: false,
      message: opened.reason,
      output,
      turns: 0,
      durationMs: Date.now() - startedAt,
      spend,
    };
  }
  const { sessionId } = opened.data;
  let snapshot = opened.data.snapshot;
  const history: string[] = [];

  try {
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      const result = await generateText({
        model: utilityModel(),
        system: `Estás operando un navegador para completar un trámite en un portal web. En cada turno ves la página y eliges UNA acción.

Responde sólo con JSON:
{"accion":"click|fill|select|check|press|goto|listo|rendirse","ref":"e12","texto":"...","url":"...","datos":{"clave":"valor"},"porque":"una frase"}

- "ref" es el identificador de un elemento de la lista. Obligatorio salvo para goto, listo y rendirse.
- "listo" cuando el trámite esté completo. Pon en "datos" lo que hubiera que devolver, leído del texto de la página.
- "rendirse" si el portal rechazó la consulta o no hay forma de avanzar.
- No repitas una acción que ya hiciste y no cambió nada.`,
        prompt: `OBJETIVO: ${input.goal}

DATOS DISPONIBLES: ${JSON.stringify(input.inputs)}

LO QUE YA HICISTE:
${history.length > 0 ? history.map((h, i) => `  ${i + 1}. ${h}`).join('\n') : '  (nada todavía)'}

LA PÁGINA AHORA:
${renderSnapshot(snapshot)}`,
        maxTokens: 500,
      });
      spend = addSpend(spend, spendOf(result.usage));

      const decision = parseJson(result.text);
      const action = String(decision?.accion ?? '').toLowerCase();

      if (action === 'listo') {
        const data = decision?.datos;
        if (data && typeof data === 'object') Object.assign(output, data);
        return {
          ok: true,
          message: String(decision?.porque ?? 'Listo.'),
          output,
          turns: turn,
          durationMs: Date.now() - startedAt,
          spend,
        };
      }
      if (action === 'rendirse' || !action) {
        return {
          ok: false,
          message: String(decision?.porque ?? 'El modelo no supo cómo continuar.'),
          output,
          turns: turn,
          durationMs: Date.now() - startedAt,
          spend,
        };
      }

      const ref = String(decision?.ref ?? '');
      const element = snapshot.elements.find((el) => el.ref === ref);
      const target: Target | null = element?.targets[0] ?? null;
      const text = String(decision?.texto ?? '');

      const acted = await input.transport.act({
        sessionId,
        action,
        target,
        text,
        url: String(decision?.url ?? ''),
      });
      if (!acted.ok) {
        return {
          ok: false,
          message: acted.reason,
          output,
          turns: turn,
          durationMs: Date.now() - startedAt,
          spend,
        };
      }
      snapshot = acted.data.snapshot;
      history.push(
        acted.data.ok
          ? `${action} sobre ${element?.name || ref || decision?.url}`
          : `intenté ${action} sobre ${ref} y falló: ${acted.data.error}`,
      );
    }

    return {
      ok: false,
      message: `Di ${MAX_TURNS} vueltas sin terminar el trámite.`,
      output,
      turns: MAX_TURNS,
      durationMs: Date.now() - startedAt,
      spend,
    };
  } finally {
    await input.transport.closeSession(sessionId).catch(() => undefined);
  }
}
