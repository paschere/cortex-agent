/**
 * Cómo se PARTE y qué se CONSULTA cuando Cortex habla.
 *
 * Una cifra colombiana («4.247,52») tiene punto y coma. Si cortamos la
 * cláusula en cualquier `[.!?…,;:]` + espacio, el TTS se queda con «4.» o con
 * «4.247,» y el resto de la respuesta (la DIAN, la fuente) nunca se oye.
 *
 * Y un dato que cambia cada día (TRM, plazos DIAN) no puede salir de la
 * memoria del modelo: hay que buscarlo.
 */

/** Fin de oración, no miles/decimales ni comas de inciso. */
const SENTENCE = /^([\s\S]*?(?<!\d)[.!?…]+)(\s+)([\s\S]*)$/;

export function takeSpokenClauses(buf: string): { clauses: string[]; rest: string } {
  const clauses: string[] = [];
  let rest = buf;
  let m = rest.match(SENTENCE);
  while (m) {
    const c = (m[1] ?? '').trim();
    if (c) clauses.push(c);
    rest = m[3] ?? '';
    m = rest.match(SENTENCE);
  }
  return { clauses, rest };
}

/**
 * Preguntas cuya respuesta correcta es un hecho de HOY en internet, no del
 * CRM ni de la memoria del modelo. «hoy» suelto no cuenta: en una reunión
 * casi todo es «hoy».
 */
export function wantsLiveLookup(text: string): boolean {
  const q = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  return /\b(trm|tasa representativa|tipo de cambio|dian|muisca|uvt|ipc|banrep|banco de la republica|dolar|usd\/?cop)\b/.test(
    q,
  );
}

export const VOICE_LIVE_FACTS =
  'Cifras vivas (TRM, dólar, UVT, plazos o trámites de la DIAN, precios oficiales, «de hoy»): no las recites de memoria. Si hay CONSULTA WEB abajo, úsala. Si no, llama web.search antes de decir un número. Si no pudiste consultar, di que no tienes el dato — nunca inventes una cifra. Las cantidades, en números redondos o en palabras («4123 pesos»), no con puntos de miles.';
