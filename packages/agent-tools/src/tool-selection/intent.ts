/**
 * REGLAS DE INTENCIÓN: familias que un flujo necesita cuando el flujo aplica.
 *
 * El ranking semántico compara la frase con las descripciones de las
 * herramientas, y un enlace pegado («https://docs.google.com/spreadsheets/d/…»)
 * no se parece a ninguna: el system prompt le ordena al modelo usar
 * `trackers.propose_from_source` / `feed.connect_google_sheet` /
 * `gdrive.folder_tree`, y esas familias quedaban fuera de la selección. El modelo
 * llamaba una herramienta que no estaba declarada y el turno moría con
 * «AI_NoSuchToolError».
 *
 * Aquí no se puntúa nada: si el texto reciente tiene la huella de un flujo, sus
 * familias entran como las de base. Sólo AGREGA — el filtro de permisos
 * (allowedTools, denegaciones, módulos) ya ocurrió antes y una familia que no
 * existe o no está permitida es simplemente inerte.
 */

interface IntentRule {
  name: string;
  test: RegExp;
  families: readonly string[];
}

const GOOGLE_LINK =
  /(?:docs|drive|sheets)\.google\.com\/|\b(?:spreadsheets|drive)\/(?:d|folders)\/[\w-]{10,}/i;

const TABULAR_WORDS =
  /\b(?:hojas?|pesta(?:ñ|n)as?|carpetas?|tablas?|aplicaci(?:ó|o)n(?:es)?|vistas?|spreadsheets?|sheets?|google drive|drive)\b/i;

export const INTENT_RULES: readonly IntentRule[] = [
  {
    name: 'google-links',
    test: GOOGLE_LINK,
    families: ['feed', 'trackers', 'gdrive', 'gsheets', 'apps', 'views'],
  },
  {
    name: 'tabular-words',
    test: TABULAR_WORDS,
    families: ['feed', 'trackers', 'gdrive', 'gsheets', 'apps', 'views'],
  },
];

/** Familias que el texto reciente obliga a incluir (sin repetidos). */
export function intentFamilies(query: string): string[] {
  const out = new Set<string>();
  for (const rule of INTENT_RULES) {
    if (rule.test.test(query)) for (const f of rule.families) out.add(f);
  }
  return [...out];
}
