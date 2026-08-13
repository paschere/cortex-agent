/**
 * EL MANDATO: la excepción que un cliente declara sobre la doctrina de la casa.
 *
 * ===========================================================================
 * QUÉ ES Y QUÉ NO ES
 * ===========================================================================
 * Hasta esta migración la autonomía de Cortex era binaria: una herramienta
 * pedía permiso o no lo pedía, y lo decidía el producto. Un mandato es la única
 * forma que tiene un dueño de decir «puedes mandar correos a clientes sin
 * preguntarme» o «puedes aprobar hasta $500.000» sin que eso signifique apagar
 * la capa de seguridad.
 *
 * Las tres funciones corren SIEMPRE en este orden y ninguna sustituye a otra:
 *
 *   classify()     -> Classification   qué es la llamada. Pura, intacta, y no
 *                                      la toca nadie: si el mandato bajara el
 *                                      riesgo, `audit_events.risk_level`
 *                                      empezaría a mentir sobre lo que la
 *                                      llamada ERA.
 *   decide()       -> Decision         la doctrina: qué hace la casa con eso.
 *   applyMandate() -> Decision         la excepción: qué dijo este cliente.
 *
 * ===========================================================================
 * LA INVARIANTE QUE ESTE ARCHIVO NO PUEDE ROMPER
 * ===========================================================================
 * `block` ENTRA, `block` SALE. Sin excepción, sin bandera, sin superficie y sin
 * mandato. En `registry.ts` la rama de `block` se evalúa antes de mirar
 * `opts.confirmed` y no la consulta — hoy un `critical` no lo desbloquea ni un
 * humano pulsando confirmar ni una rutina desatendida. Este módulo no crea esa
 * invariante: existe para NO abrir un camino que la rodee.
 *
 * Por eso la única transición implementada es:
 *
 *   confirm -> allow   con concesión vigente que cubra la herramienta
 *
 * `allow -> confirm|block` cabe en el tipo y NO se implementa. Las deny-lists de
 * equipo ya restringen; dos mecanismos que restringen divergen, y el día que
 * divergen nadie sabe cuál de los dos contestó.
 *
 * ===========================================================================
 * POR QUÉ EL TECHO MONETARIO NO LEE EL CUERPO DEL CORREO
 * ===========================================================================
 * `classify()` no extrae cifras de ningún sitio, y leer «$1.200.000» del cuerpo
 * de un correo para decidir si cabe bajo un techo es poco fiable justo en la
 * dirección peligrosa: el falso negativo (no encuentro la cifra, luego cabe)
 * autoriza, y el falso positivo solo molesta.
 *
 * Así que un techo monetario SOLO SE APLICA a herramientas cuyo esquema de
 * entrada declara importe y moneda tipados (`ToolDef.declaredAmount`). Si la
 * herramienta no lo declara, si el importe no viene, si no trae moneda, o si
 * trae una que la concesión no nombra, el mandato NO aplica y se cae a
 * `confirm`. Es el espejo exacto de dos reglas que ya existen: `currency` nunca
 * se asume COP (migración 0076) y `aggregateRecords` nunca mezcla monedas
 * (clave `${key}#${currency}`).
 *
 * Hoy casi ninguna herramienta declara importe. Eso es correcto y esperado: las
 * columnas van desde el día uno, nulables, y el camino está probado contra una
 * herramienta sintética en los tests. Un techo sobre una herramienta que no sabe
 * declarar cuánto mueve no delega nada, que es exactamente lo que debe pasar.
 */

import type {
  BlastRadius,
  Classification,
  Decision,
  RiskLevel,
  Sensitivity,
  Surface,
} from './policy.js';
import { maxLevel } from './policy.js';

/** El techo de riesgo de una concesión. `critical` no cabe, ni en el tipo. */
export type MandateRiskCeiling = Exclude<RiskLevel, 'critical'>;

export const MANDATE_RISK_CEILINGS: readonly MandateRiskCeiling[] = ['low', 'medium', 'high'];

/**
 * Dónde vive el importe dentro del esquema de entrada de una herramienta.
 *
 * Claves de primer nivel a propósito: una ruta anidada (`a.b[0].c`) sería un
 * mini-lenguaje que hay que interpretar, y lo que se interpreta se interpreta
 * mal. Una herramienta que mueve dinero y quiere ser delegable pone el importe
 * y su moneda arriba del todo, donde se ven.
 */
export interface DeclaredAmount {
  amountKey: string;
  currencyKey: string;
}

/** La cara mínima de una herramienta que este módulo necesita conocer. */
export interface MandateTool {
  id: string;
  requiresConfirmation?: boolean;
  declaredAmount?: DeclaredAmount;
}

/**
 * Una concesión vigente, ya leída de `mandates` y con su consumo del día.
 *
 * `coveredToolIds` es la INSTANTÁNEA tomada al conceder, y es lo que decide de
 * verdad. `toolPatterns` se guarda porque es lo que la persona escribió y lo que
 * la pantalla enseña, pero el conjunto efectivo es la intersección de los dos.
 * Para CAPACIDAD (`filterTools`) un `gmail.*` que incluya lo que todavía no
 * existe es correcto, y `registry.ts:60` lo argumenta bien. Para AUTONOMÍA es al
 * revés: una herramienta desplegada el mes que viene quedaría autodelegada sin
 * que nadie lo hubiera decidido. Por lo mismo `*` a secas se rechaza al
 * conceder, y se vuelve a rechazar aquí.
 */
export interface MandateGrant {
  id: string;
  label: string;
  toolPatterns: string[];
  coveredToolIds: string[];
  maxRiskLevel: MandateRiskCeiling;
  /** Par con `currency`: los dos, o ninguno. */
  amountCeiling: number | null;
  currency: string | null;
  appliesUnattended: boolean;
  maxUsesPerDay: number | null;
  /** Usos ya registrados hoy (día de Bogotá). 0 cuando no hay presupuesto. */
  usesToday: number;
}

export interface ApplyMandateArgs {
  classification: Classification;
  /** Lo que dijo `decide()`. Nunca se recalcula aquí. */
  decision: Decision;
  tool: MandateTool;
  input: unknown;
  surface: Surface;
  /**
   * Concesiones vigentes que ya cubren `tool.id` según la base. Vacío cuando no
   * hay ninguna Y TAMBIÉN cuando no se pudieron leer — ver `loadMandates`, que
   * falla CERRADO a propósito.
   */
  mandates: MandateGrant[];
}

export interface MandateOutcome {
  decision: Decision;
  /** La concesión que respondió, o null. Es lo que se registra en la auditoría. */
  mandate: MandateGrant | null;
}

// ---------------------------------------------------------------------------
// Exclusiones duras
// ---------------------------------------------------------------------------

/**
 * Familias que ningún mandato puede delegar jamás, por lo que SON y no por el
 * riesgo que la matriz les calcule.
 *
 *   security   Las herramientas de seguridad leen y explican la propia capa.
 *   mandates   Un mandato que se amplía a sí mismo no es un mandato.
 *   custom     Herramientas HTTP que definió el cliente (migración 0067). Su
 *              radio de acción lo describe una FILA, y esa fila se puede editar
 *              DESPUÉS de concedido el mandato: la instantánea de ids seguiría
 *              diciendo `custom.consultar_saldo` mientras la URL detrás pasó a
 *              ser otra cosa. La instantánea protege contra herramientas nuevas;
 *              no puede proteger contra una herramienta que cambió por dentro.
 */
export const NEVER_DELEGATED_FAMILIES: readonly string[] = ['security', 'mandates', 'custom'];

/**
 * Señales en el cuerpo de la llamada que apagan cualquier mandato.
 *
 * Las dos dicen lo mismo dos veces: esta llamada lleva encima algo que no es
 * asunto de una regla escrita hace tres meses. Un mandato se concede sobre una
 * CAPACIDAD («puedes mandar correos a clientes»); el día que ese correo lleva
 * una cédula o una tabla de salarios, la pregunta vuelve a la persona.
 */
export const NEVER_DELEGATED_SIGNALS = [
  'personal-id-in-payload',
  'compensation-in-payload',
] as const;

function familyOfId(toolId: string): string {
  const dot = toolId.indexOf('.');
  return dot === -1 ? toolId : toolId.slice(0, dot);
}

/**
 * ¿Puede esta llamada ser delegada por ALGÚN mandato? Puro, sin concesiones a la
 * vista: si esto dice que no, ninguna fila de la tabla cambia la respuesta.
 */
export function isDelegatable(c: Classification, toolId: string): boolean {
  // Nunca `critical`. Es la regla que se escribe dos veces —aquí y como CHECK en
  // `mandates.max_risk_level`— para que un mandato crítico no pueda ni existir
  // como fila NI ser obedecido si alguien la escribiera por otro camino.
  if (c.riskLevel === 'critical') return false;

  // Nunca una exportación masiva de datos personales o de nómina. Es la
  // categoría que el negocio quiere vigilada, y delegarla es exactamente lo
  // contrario de vigilarla.
  if (c.blastRadius === 'bulk' && (c.sensitivity === 'financial' || c.sensitivity === 'pii')) {
    return false;
  }

  for (const s of NEVER_DELEGATED_SIGNALS) {
    if (c.signals.includes(s)) return false;
  }

  return !NEVER_DELEGATED_FAMILIES.includes(familyOfId(toolId));
}

// ---------------------------------------------------------------------------
// Cobertura
// ---------------------------------------------------------------------------

/**
 * ¿Cubre este patrón la herramienta? Como `registry.ts:matchPattern`, MENOS el
 * comodín: `*` a secas se rechaza, aquí y en el CHECK de la tabla.
 */
export function mandatePatternMatches(pattern: string, toolId: string): boolean {
  if (pattern === '*') return false;
  if (pattern.endsWith('.*')) return toolId.startsWith(pattern.slice(0, -1));
  return pattern === toolId;
}

/**
 * El importe tipado de una llamada, o null si no lo hay de forma fiable.
 *
 * `null` significa «no lo sé», nunca «no hay dinero». Quien lo llame tiene que
 * tratar el null como motivo para NO delegar.
 */
export function typedAmount(
  input: unknown,
  declared: DeclaredAmount | undefined,
): { amount: number; currency: string } | null {
  if (!declared) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const row = input as Record<string, unknown>;

  const amount = row[declared.amountKey];
  // Solo `number`. Una cadena «1.200.000» tiene tres lecturas distintas según
  // el locale de quien la escribió, y elegir una de ellas para autorizar dinero
  // es exactamente la clase de suposición que esta capa no hace.
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null;

  const currency = row[declared.currencyKey];
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency.trim())) return null;

  return { amount, currency: currency.trim().toUpperCase() };
}

/** ¿La superficie desde la que llega la llamada está cubierta por la concesión? */
export function surfaceCovered(m: MandateGrant, surface: Surface): boolean {
  // 'web' y 'mcp' tienen a una persona conduciendo el turno; 'schedule' no.
  //
  // Vale la pena decir en voz alta lo que esto NO habilita: `surface==='schedule'`
  // añade la señal `unattended` en `classify()`, y esa señal convierte cualquier
  // `external_send` en `critical`, que se bloquea. O sea que ni con
  // `applies_unattended = true` puede un mandato hacer que Cortex le mande un
  // correo a un cliente a las 3am por su cuenta. La bandera existe para lo que
  // queda debajo de esa línea, y existe apagada por defecto.
  return surface === 'schedule' ? m.appliesUnattended : true;
}

/** Por qué una concesión NO respondió. Solo para explicar, nunca para decidir. */
export type MandateMiss =
  | 'pattern'
  | 'snapshot'
  | 'risk'
  | 'surface'
  | 'budget'
  | 'amount-undeclared'
  | 'amount-over-ceiling';

/**
 * ¿Cubre esta concesión esta llamada concreta? Devuelve null cuando sí, y el
 * motivo cuando no.
 */
export function mandateMiss(
  m: MandateGrant,
  args: { classification: Classification; tool: MandateTool; input: unknown; surface: Surface },
): MandateMiss | null {
  const { classification: c, tool, input, surface } = args;

  if (!m.toolPatterns.some((p) => mandatePatternMatches(p, tool.id))) return 'pattern';
  // La intersección con la instantánea. Un patrón sin instantánea detrás no
  // delega nada, que es el punto entero de guardar las dos cosas.
  if (!m.coveredToolIds.includes(tool.id)) return 'snapshot';

  // `maxLevel(a, b) === b` es «a cabe en b». `critical` ya quedó fuera arriba.
  if (maxLevel(c.riskLevel, m.maxRiskLevel) !== m.maxRiskLevel) return 'risk';

  if (!surfaceCovered(m, surface)) return 'surface';

  if (m.maxUsesPerDay !== null && m.usesToday >= m.maxUsesPerDay) return 'budget';

  if (m.amountCeiling !== null && m.currency !== null) {
    const money = typedAmount(input, tool.declaredAmount);
    // Sin importe tipado no hay nada que comparar contra el techo, y comparar
    // contra nada es autorizar. Se cae a `confirm`.
    if (!money) return 'amount-undeclared';
    if (money.currency !== m.currency.toUpperCase()) return 'amount-undeclared';
    if (money.amount > m.amountCeiling) return 'amount-over-ceiling';
  }

  return null;
}

// ---------------------------------------------------------------------------
// applyMandate
// ---------------------------------------------------------------------------

/**
 * La excepción del cliente, aplicada sobre la doctrina de la casa.
 *
 * Pura. Las concesiones llegan ya leídas; si la lectura falló, llegan vacías, y
 * vacío significa «no hay mandato» — nunca «adelante».
 */
export function applyMandate(args: ApplyMandateArgs): MandateOutcome {
  const { decision, classification, tool, input, surface, mandates } = args;

  // ---- LA INVARIANTE. Primero, sin condiciones, y sin mirar nada más. -------
  if (decision === 'block') return { decision: 'block', mandate: null };

  // Un mandato solo sabe hacer una cosa: levantar una pregunta que iba a
  // hacerse. Si nadie pregunta, no hay nada que levantar y no se toca nada.
  //
  // Las DOS puertas cuentan como pregunta, y esta línea es la mitad del valor
  // del cambio: `decide()` es la puerta de seguridad, y `requiresConfirmation`
  // es una puerta INDEPENDIENTE que la herramienta se puso a sí misma
  // (`gmail.send_draft` la lleva). Un mandato que resolviera solo la primera no
  // haría absolutamente nada visible: el correo seguiría parándose en la
  // segunda. Ver el enganche en `registry.ts`.
  const gated = decision === 'confirm' || tool.requiresConfirmation === true;
  if (!gated) return { decision, mandate: null };

  if (!isDelegatable(classification, tool.id)) return { decision, mandate: null };

  const grant =
    mandates.find((m) => mandateMiss(m, { classification, tool, input, surface }) === null) ?? null;
  if (!grant) return { decision, mandate: null };

  // La ÚNICA transición implementada. Un `allow` que venía con la puerta de la
  // herramienta puesta sigue siendo `allow`: lo que la concesión levanta ahí es
  // esa segunda puerta, no el veredicto de seguridad, que ya decía que sí.
  return { decision: decision === 'confirm' ? 'allow' : decision, mandate: grant };
}

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------

const SENSITIVITY_ES: Record<Sensitivity, string> = {
  financial: 'datos de nómina o compensación',
  pii: 'datos personales',
  client: 'datos de clientes',
  internal: 'datos internos',
  public: 'datos públicos',
};

const BLAST_ES: Record<BlastRadius, string> = {
  read: 'una consulta',
  internal_write: 'una escritura interna',
  external_send: 'contenido que sale de la empresa',
  bulk: 'una operación masiva',
};

/**
 * La frase que acompaña a una llamada delegada. Se le entrega al modelo para
 * que la diga con sus palabras: qué se hizo sin preguntar y por decisión de
 * quién. Una delegación silenciosa es indistinguible de un fallo de la capa.
 */
export function explainDelegation(c: Classification, m: MandateGrant): string {
  return (
    `Esto normalmente te preguntaría antes de hacerlo (${SENSITIVITY_ES[c.sensitivity]} vía ` +
    `${BLAST_ES[c.blastRadius]}). Lo hice sin preguntar porque está dentro del mandato ` +
    `«${m.label}» que un administrador concedió. Quedó registrado en la auditoría, y el mandato ` +
    `se puede revocar en cualquier momento desde Administración › Mandatos.`
  );
}
