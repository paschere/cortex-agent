import { generateText } from 'ai';
import { isPlausibleDueDate, quoteSupportsDate } from '../commitments/extract';
import { documentText } from '../documents/extract';
import {
  type DocumentChunk,
  locateQuote,
  normalize,
  prepareChunks,
  quoteSupportsText,
} from '../documents/verify';
import { UTILITY_MODEL, utilityModel } from '../model';
import { findDates, quoteStatesDate, readValidity } from './dates';
import {
  type Confidence,
  EXPIRATION_KINDS,
  type ExpirationKind,
  SUBJECT_KINDS,
  type SubjectKind,
  defaultSubjectKind,
  normalizePlate,
} from './kinds';

/**
 * ¿Es este documento un papel que vence? Y si lo es: qué, de quién, desde y
 * hasta cuándo — con la frase que dice cada fecha.
 *
 * Mismo molde que `documents/extract.ts` y `commitments/extract.ts`: el modelo
 * PROPONE y reglas deterministas DISPONEN, y cada regla sólo puede quitar:
 *
 *   1. LA CITA TIENE QUE EXISTIR, literal (salvo espacios, mayúsculas y
 *      puntuación), en un fragmento del documento.
 *   2. LA FECHA TIENE QUE ESTAR ESCRITA EN ESA CITA, y aquí la lee `dates.ts`
 *      por su cuenta. «Vigencia de un año desde el 1 de abril de 2026»
 *      propuesto como 2027-04-01 es aritmética y se rechaza: el papel queda
 *      sin fecha y en «por revisar», para que una persona la escriba.
 *   3. EL SUJETO, EL EMISOR Y EL NÚMERO TIENEN QUE APARECER en el texto; una
 *      placa se normaliza (WGY 482 → WGY482) y tiene que tener forma de placa.
 *
 * La CONFIANZA no la dice el modelo: sale de cuántas de esas reglas pasaron.
 *
 * ANTES DEL MODELO, UN FILTRO GRATIS. Leer cada documento con el modelo
 * costaría una llamada por factura, guía y acta. `worthReading` mira el texto
 * sin modelo: si no hay ni una fecha escrita, o ninguna palabra de vigencia,
 * no se paga nada.
 */

export const EXPIRATIONS_EXTRACTOR_VERSION = 'v1';

/** Palabras que aparecen en casi cualquier papel con vigencia. Sin tildes. */
const VALIDITY_CUES = [
  'vigencia',
  'vigente',
  'vence',
  'vencimiento',
  'valido hasta',
  'valida hasta',
  'expira',
  'caduca',
  'hasta el',
  'fin de vigencia',
  'renovacion',
  'duracion del contrato',
  'termino de duracion',
];

/** Lo que el documento dice que es; basta una para justificar la llamada. */
const KIND_CUES = [
  'soat',
  'seguro obligatorio',
  'tecnico mecanica',
  'tecnico-mecanica',
  'tecnicomecanica',
  'tecnomecanica',
  'revision tecnico',
  'poliza',
  'licencia',
  'permiso',
  'habilitacion',
  'certificado',
  'certificacion',
  'contrato',
  'concepto sanitario',
  'registro sanitario',
];

function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * ¿Vale la pena pagar una llamada por este texto? Sin modelo.
 *
 * Hace falta una fecha escrita, una palabra de vigencia y una de las cosas que
 * vencen. Una factura con «fecha de vencimiento» pasa el filtro (dice «vence»,
 * tiene fechas) pero no dice «póliza» ni «licencia» ni «contrato»… salvo que
 * lo diga, y entonces el modelo decide.
 */
export function worthReading(text: string): { ok: boolean; reason: string } {
  const head = text.slice(0, 30_000);
  if (findDates(head).length === 0) {
    return { ok: false, reason: 'no tiene ninguna fecha escrita' };
  }
  const folded = fold(head);
  if (!VALIDITY_CUES.some((c) => folded.includes(c))) {
    return { ok: false, reason: 'no habla de vigencia ni de vencimiento' };
  }
  if (!KIND_CUES.some((c) => folded.includes(c))) {
    return {
      ok: false,
      reason: 'no parece una póliza, licencia, permiso, contrato ni certificado',
    };
  }
  return { ok: true, reason: '' };
}

/** Señales de que es un certificado de Cámara de Comercio o un RUT. */
export function isChamberOrRut(text: string): boolean {
  const folded = fold(text.slice(0, 6000));
  return (
    (folded.includes('camara de comercio') &&
      (folded.includes('existencia y representacion') || folded.includes('matricula mercantil'))) ||
    /registro unico tributario|formulario del registro unico tributario/.test(folded)
  );
}

// ---------------------------------------------------------------------------
// Lo que propone el modelo
// ---------------------------------------------------------------------------

export interface ExpirationClaim {
  kind: string;
  label: string | null;
  kindQuote: string;
  subjectKind: string | null;
  subject: string | null;
  issuer: string | null;
  number: string | null;
  issuedOn: string | null;
  issuedQuote: string;
  expiresOn: string | null;
  expiresQuote: string;
}

/** Lo que una persona ya sabe cuando sube una renovación desde la pantalla. */
export interface ExpirationHint {
  kind: ExpirationKind;
  subject: string | null;
  subjectKind: SubjectKind;
}

function prompt(hint: ExpirationHint | null): string {
  const hintLine = hint
    ? `\nCONTEXTO: alguien subió este documento como la RENOVACIÓN de: ${hint.kind}${hint.subject ? ` de ${hint.subject}` : ''}. Úsalo para saber qué buscar, pero las reglas no cambian: si el documento no dice la fecha, no la devuelvas.\n`
    : '';
  return `Estás revisando un documento de una empresa colombiana para saber si es un PAPEL QUE VENCE y hay que renovar: SOAT, revisión técnico-mecánica, póliza de seguro, licencia, permiso de funcionamiento, habilitación, certificado con vigencia o contrato con fecha de terminación.
${hintLine}
Tipos (campo "kind"): poliza, soat, tecnomecanica, licencia, permiso, contrato, certificado, habilitacion, otro.
Sujeto (campo "subjectKind"): vehiculo (el sujeto es la PLACA), cliente (la empresa cliente con la que es el contrato), empleado (la persona, p. ej. una licencia de conducción), empresa (la propia empresa), otro.

Devuelve SÓLO JSON:
{"items":[{"kind":"…","label":"<nombre corto del papel, p. ej. Póliza de responsabilidad civil>","kindQuote":"<frase exacta donde el documento dice qué es>","subjectKind":"…","subject":"<placa, cliente o persona, o null>","issuer":"<aseguradora, entidad o contraparte que lo expide, o null>","number":"<número de póliza, licencia o contrato, o null>","issuedOn":"<YYYY-MM-DD o null>","issuedQuote":"<frase exacta con la fecha de expedición o inicio, o \\"\\">","expiresOn":"<YYYY-MM-DD o null>","expiresQuote":"<frase exacta con la fecha de vencimiento o fin de vigencia>"}]}

REGLAS QUE NO PUEDES ROMPER:
1. Cada cita tiene que estar en el texto que te di, LITERAL. Si tienes que cambiar una palabra, no la devuelvas.
2. La fecha tiene que estar ESCRITA en su cita: día, mes y año. Si tendrías que calcularla («un año desde…», «doce meses»), devuelve expiresOn null y deja la cita de la vigencia. Calcular no es leer.
3. Si el documento NO es un papel que vence (una factura, una guía, un acta, un correo), devuelve {"items":[]}. Una factura con «fecha de vencimiento» de pago NO es un papel que vence.
4. Un certificado de Cámara de Comercio o un RUT: devuelve {"items":[]} — la renovación de la matrícula se lleva en otro lado.
5. Máximo 3 items, uno por papel distinto (por ejemplo, una póliza de flota con varias placas: uno por placa, hasta 3).`;
}

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() && value.trim() !== 'null'
    ? value.trim().slice(0, max)
    : null;
}

export function parseClaims(raw: string): ExpirationClaim[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  let parsed: { items?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { items?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.items)) return [];
  return parsed.items.slice(0, 3).flatMap((entry): ExpirationClaim[] => {
    if (!entry || typeof entry !== 'object') return [];
    const e = entry as Record<string, unknown>;
    return [
      {
        kind: str(e.kind, 40) ?? 'otro',
        label: str(e.label, 120),
        kindQuote: str(e.kindQuote, 600) ?? '',
        subjectKind: str(e.subjectKind, 20),
        subject: str(e.subject, 200),
        issuer: str(e.issuer, 200),
        number: str(e.number, 120),
        issuedOn: str(e.issuedOn, 10),
        issuedQuote: str(e.issuedQuote, 600) ?? '',
        expiresOn: str(e.expiresOn, 10),
        expiresQuote: str(e.expiresQuote, 600) ?? '',
      },
    ];
  });
}

export async function proposeExpirations(
  chunks: DocumentChunk[],
  hint: ExpirationHint | null,
): Promise<ExpirationClaim[]> {
  if (chunks.length === 0) return [];
  const result = await generateText({
    model: utilityModel(),
    system: prompt(hint),
    prompt: documentText(chunks),
    maxTokens: 1200,
  });
  return parseClaims(result.text);
}

// ---------------------------------------------------------------------------
// Lo que se cree
// ---------------------------------------------------------------------------

export interface VerifiedExpiration {
  kind: ExpirationKind;
  label: string | null;
  subjectKind: SubjectKind;
  subject: string | null;
  issuer: string | null;
  number: string | null;
  issuedOn: string | null;
  issuedQuote: string | null;
  expiresOn: string | null;
  expiresQuote: string | null;
  chunkId: string | null;
  confidence: Confidence;
  /** Por qué revisarla con cuidado, en palabras. Null si todo pasó. */
  reviewNote: string | null;
}

function asKind(value: string): ExpirationKind {
  const v = fold(value).replace(/[^a-z]/g, '');
  if ((EXPIRATION_KINDS as readonly string[]).includes(v)) return v as ExpirationKind;
  if (v.includes('rtm') || v.includes('tecnico')) return 'tecnomecanica';
  if (v.includes('seguro')) return 'poliza';
  return 'otro';
}

function asSubjectKind(value: string | null, kind: ExpirationKind): SubjectKind {
  const v = fold(value ?? '');
  return (SUBJECT_KINDS as readonly string[]).includes(v)
    ? (v as SubjectKind)
    : defaultSubjectKind(kind);
}

/**
 * La puerta. Lo que sobrevive es todavía una PROPUESTA: se guarda con
 * `needs_review` y espera a una persona (0184), igual que en 0069.
 */
export function verifyClaims(
  claims: ExpirationClaim[],
  chunks: DocumentChunk[],
  today: string,
): VerifiedExpiration[] {
  const prepared = prepareChunks(chunks);
  const whole = chunks.map((c) => c.content).join('\n');
  const wholeNorm = normalize(whole);
  const out: VerifiedExpiration[] = [];

  for (const claim of claims) {
    const kind = asKind(claim.kind);
    const notes: string[] = [];
    let points = 0;

    // ¿El documento se nombra a sí mismo?
    const kindChunk = claim.kindQuote ? locateQuote(claim.kindQuote, prepared) : null;
    if (kindChunk) points += 1;
    else notes.push('no encontré la frase donde el documento dice qué es');

    // La fecha de vencimiento: la cita existe Y dice la fecha.
    let expiresOn: string | null = null;
    let expiresQuote: string | null = null;
    let chunkId: string | null = null;
    let dateVerified = false;
    const expiresChunk = claim.expiresQuote ? locateQuote(claim.expiresQuote, prepared) : null;
    if (expiresChunk) {
      expiresQuote = claim.expiresQuote;
      chunkId = expiresChunk.id;
      const validity = readValidity(claim.expiresQuote);
      const proposed =
        claim.expiresOn && /^\d{4}-\d{2}-\d{2}$/.test(claim.expiresOn) ? claim.expiresOn : null;
      if (proposed && quoteStatesDate(claim.expiresQuote, proposed)) {
        if (validity.until && validity.until.iso !== proposed && validity.from?.iso === proposed) {
          // El modelo tomó el comienzo por el fin; la cita dice cuál es cuál.
          expiresOn = validity.until.iso;
          notes.push(`la cita dice «hasta» ${validity.until.raw}; se tomó esa fecha`);
        } else {
          expiresOn = proposed;
          dateVerified = true;
          points += 2;
        }
      } else if (!proposed && validity.until) {
        expiresOn = validity.until.iso;
        notes.push(
          `la fecha se leyó de la cita («${validity.until.raw}»), no la propuso el modelo`,
        );
        points += 1;
      } else if (proposed && quoteSupportsDate(claim.expiresQuote, proposed)) {
        // Día, mes y año están en la frase pero en una forma que `dates.ts`
        // no entiende: se guarda, con la advertencia.
        expiresOn = proposed;
        notes.push('la fecha está en la cita pero escrita de una forma rara: revísala');
      } else if (proposed) {
        notes.push(`la cita no dice ${proposed}: la fecha sería calculada, no leída`);
      } else {
        notes.push('el documento no dice la fecha de vencimiento con día, mes y año');
      }
    } else {
      notes.push('no encontré escrita la fecha de vencimiento');
    }
    if (expiresOn && !isPlausibleDueDate(expiresOn, today)) {
      notes.push(`${expiresOn} no es una fecha de vencimiento creíble`);
      expiresOn = null;
      dateVerified = false;
    }
    if (!expiresOn) {
      // Sin fecha no hay cita que guardar como evidencia de una fecha.
      expiresQuote = expiresChunk ? claim.expiresQuote : null;
    }

    // La fecha de expedición: opcional, con las mismas reglas.
    let issuedOn: string | null = null;
    let issuedQuote: string | null = null;
    if (claim.issuedOn && claim.issuedQuote && locateQuote(claim.issuedQuote, prepared)) {
      if (quoteStatesDate(claim.issuedQuote, claim.issuedOn)) {
        issuedOn = claim.issuedOn;
        issuedQuote = claim.issuedQuote;
      }
    }
    if (!issuedOn && expiresQuote) {
      const validity = readValidity(expiresQuote);
      if (validity.from && (!expiresOn || validity.from.iso <= expiresOn)) {
        issuedOn = validity.from.iso;
        issuedQuote = expiresQuote;
      }
    }
    if (issuedOn && expiresOn && issuedOn > expiresOn) {
      issuedOn = null;
      issuedQuote = null;
    }

    // De quién es.
    const subjectKind = asSubjectKind(claim.subjectKind, kind);
    let subject: string | null = null;
    if (claim.subject) {
      if (subjectKind === 'vehiculo') {
        const plate = normalizePlate(claim.subject);
        const compactDoc = whole.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (plate && compactDoc.includes(plate)) subject = plate;
        else notes.push(`no encontré la placa «${claim.subject}» en el documento`);
      } else if (quoteSupportsText(whole, claim.subject)) {
        subject = claim.subject;
      } else {
        notes.push(`no encontré «${claim.subject}» en el documento`);
      }
    }
    if (subject) points += 1;
    else if (subjectKind === 'vehiculo') notes.push('falta la placa');

    const issuer = claim.issuer && quoteSupportsText(whole, claim.issuer) ? claim.issuer : null;
    const number =
      claim.number &&
      wholeNorm.replace(/\s+/g, '').includes(normalize(claim.number).replace(/\s+/g, ''))
        ? claim.number
        : null;

    const confidence: Confidence = !expiresOn
      ? 'baja'
      : dateVerified && points >= 4
        ? 'alta'
        : dateVerified || points >= 2
          ? 'media'
          : 'baja';

    out.push({
      kind,
      label: claim.label,
      subjectKind,
      subject,
      issuer,
      number,
      issuedOn,
      issuedQuote,
      expiresOn,
      expiresQuote,
      chunkId,
      confidence,
      reviewNote: notes.length ? notes.join('; ').slice(0, 600) : null,
    });
  }

  // Dos propuestas del mismo papel son una.
  const seen = new Set<string>();
  return out.filter((v) => {
    const key = `${v.kind}#${(v.subject ?? '').toLowerCase()}#${v.expiresOn ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface ExpirationReading {
  items: VerifiedExpiration[];
  modelCalled: boolean;
  /** Pasó el filtro pero no había presupuesto para la llamada: queda para después. */
  deferred?: boolean;
  modelId: string | null;
  /** Por qué no salió nada, en palabras. */
  reason: string | null;
}

/**
 * Leer un documento de punta a punta: filtro gratis, una llamada, la puerta.
 * Con `hint` (una renovación subida desde la pantalla) el filtro se salta: la
 * persona ya dijo qué es.
 */
export async function readExpirations(
  chunks: DocumentChunk[],
  today: string,
  hint: ExpirationHint | null = null,
  opts: { allowModel?: boolean } = {},
): Promise<ExpirationReading> {
  const text = documentText(chunks);
  if (!hint) {
    if (isChamberOrRut(text)) {
      return {
        items: [],
        modelCalled: false,
        modelId: null,
        reason:
          'Es un certificado de Cámara de Comercio o un RUT: la renovación de la matrícula la lleva el calendario tributario (/impuestos).',
      };
    }
    const gate = worthReading(text);
    if (!gate.ok) return { items: [], modelCalled: false, modelId: null, reason: gate.reason };
  }
  if (opts.allowModel === false) {
    return { items: [], modelCalled: false, modelId: null, reason: null, deferred: true };
  }
  const claims = await proposeExpirations(chunks, hint);
  const items = verifyClaims(claims, chunks, today).map((item) =>
    hint && item.kind === 'otro' ? { ...item, kind: hint.kind } : item,
  );
  return {
    items,
    modelCalled: true,
    modelId: UTILITY_MODEL,
    reason: items.length === 0 ? 'no es un papel que venza' : null,
  };
}
