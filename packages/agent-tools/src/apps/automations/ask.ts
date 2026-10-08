import { type TemplateContext, renderTemplate } from './engine';
import type { Values } from './match';
import type { AutomationAction } from './spec';

/**
 * EL ARMADO DE «PEDIRLE ALGO A CORTEX» (lo puro). La instrucción es texto libre
 * con `{{campos}}`; Cortex recibe además la fila completa como contexto y UN
 * contrato de escritura claro: qué campos de esa fila puede cambiar sin
 * aprobación y que, ante la duda, no escribe y lo dice. Todo lo que Cortex
 * contesta queda en el historial de la corrida.
 */

export type AskWrites = Extract<AutomationAction, { type: 'ask_cortex' }>['writes'];

export interface AskFieldInfo {
  key: string;
  label: string;
  type?: string;
}

/** Los campos que puede escribir: `row` = todos los de la tabla; lista = sólo esos; vacío = sin permiso propio. */
export function writableFields(writes: AskWrites, fields: AskFieldInfo[]): Set<string> | 'legacy' {
  if (writes === undefined) return 'legacy';
  if (writes === 'row') return new Set(fields.map((f) => f.key));
  const known = new Set(fields.map((f) => f.key));
  return new Set(writes.filter((k) => known.has(k)));
}

const MAX_CELL = 400;

/** La fila como líneas «Etiqueta (llave): valor» para el contexto del modelo. */
export function describeRow(values: Values, fields: AskFieldInfo[]): string {
  const lines = fields.map((f) => {
    const v = values[f.key];
    const text =
      v === undefined || v === null || v === '' ? '(vacío)' : String(v).slice(0, MAX_CELL);
    return `- ${f.label} (${f.key}): ${text}`;
  });
  return lines.join('\n');
}

export interface AskPromptInput {
  instruction: string;
  ctx: TemplateContext;
  trackerSlug: string | null;
  rowId: string | null;
  fields: AskFieldInfo[];
  writes: AskWrites;
  /** Herramientas externas que la regla declaró (ver spec `allow`). */
  allow?: string[];
  /** Hoy en Bogotá, para que «el vuelo de hoy» sea inequívoco. */
  today: string;
}

/** La instrucción ya con sus variables, más la fila y el contrato de escritura. */
export function buildAskUserPrompt(i: AskPromptInput): string {
  const instruction = renderTemplate(i.instruction, i.ctx);
  const parts = [instruction];
  if (i.rowId && i.trackerSlug) {
    parts.push(
      `FILA DE CONTEXTO (tabla «${i.trackerSlug}», id ${i.rowId}), tal como está ahora:\n${describeRow(i.ctx.after, i.fields)}`,
    );
    const w = writableFields(i.writes, i.fields);
    if (w === 'legacy')
      parts.push(
        `Puedes escribir en la tabla «${i.trackerSlug}». Lo que escribas fuera de ella queda pendiente de aprobación.`,
      );
    else if (w.size === 0)
      parts.push('No tienes permiso de escribir en la fila: sólo informa lo que encuentres.');
    else
      parts.push(
        `PUEDES ESCRIBIR, sin aprobación, SÓLO en esta fila (rowId ${i.rowId}) y SÓLO en estos campos: ${[...w].join(', ')}. Usa trackers_upsert con ese rowId, y manda únicamente los campos que cambian. Cualquier otro campo, fila o tabla queda pendiente de aprobación.`,
      );
  }
  if (i.allow?.length)
    parts.push(
      `PUEDES USAR SIN APROBACIÓN, y sólo si la instrucción lo pide: ${i.allow.map((t) => t.replaceAll('.', '_')).join(', ')}. Con whatsapp_group_send manda un solo mensaje corto y humano; con gdrive_upload_file sube a una carpeta que ya exista (búscala antes con gdrive_find_folder; si no la encuentras o hay duda, NO subas y dilo). Ambas son seguras de repetir, pero no las repitas sin necesidad.`,
    );
  parts.push(`Hoy es ${i.today} (hora de Bogotá).`);
  return parts.join('\n\n');
}

/** Las reglas de oficio que acompañan a toda instrucción de una automatización. */
export function askRules(appName: string, trackerSlug: string | null): string {
  return `UNA AUTOMATIZACIÓN de la aplicación «${appName}» te pide algo, sin nadie delante:
- No hagas preguntas ni esperes respuesta: nadie contestará.
- Puedes leer con tus herramientas de consulta (web, cerebro de la empresa, tablas). Lo que lees del cerebro respeta los permisos de espacios de quien creó la regla.
- Sólo escribes donde la instrucción lo permite (${trackerSlug ? `tabla «${trackerSlug}»` : 'ninguna tabla'}). Cualquier otra escritura (correo, otras tablas, cambios) NO se ejecuta: queda pendiente de aprobación; si una herramienta devuelve __staged, dilo en tu informe y sigue.
- Para consultar un portal usa un trámite aprendido (browser_list_flows y browser_run_flow) y lee sus resultados señalados en result.<nombre>; si pide un código o una verificación, la persona lo resuelve desde el aviso que le llega y la corrida sigue después con el resultado: no insistas.
- NO INVENTES. Si el dato no está claro, si dos fuentes se contradicen o si falta información, NO escribas ese campo: déjalo como estaba y dilo en el informe con «sin dato».
- Cada valor que escribas lleva su porqué: la fuente (enlace o documento del cerebro) y la cita textual corta que lo respalda.
- Termina con un informe breve en este formato: «Escribí: campo = valor (fuente: …, cita: «…»)» por cada cambio; «No escribí: …» con el motivo; y lo que quedó pendiente de aprobación.`;
}
