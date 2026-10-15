/**
 * Español de Colombia, con «tú». Si el modelo se desliza al voseo rioplatense
 * («querés», «tenés»), esto lo devuelve al tuteo. Barato y sin modelo: una
 * tabla de formas comunes, con la mayúscula respetada.
 */
const VOSEO: Record<string, string> = {
  querés: 'quieres',
  tenés: 'tienes',
  podés: 'puedes',
  sabés: 'sabes',
  necesitás: 'necesitas',
  preferís: 'prefieres',
  decís: 'dices',
  hacés: 'haces',
  pensás: 'piensas',
  sentís: 'sientes',
  buscás: 'buscas',
  mirás: 'miras',
  sos: 'eres',
  vos: 'tú',
  contame: 'cuéntame',
  decime: 'dime',
  mirá: 'mira',
  fijate: 'fíjate',
  avisame: 'avísame',
  pasame: 'pásame',
  mostrame: 'muéstrame',
  mandame: 'mándame',
  hacelo: 'hazlo',
  revisá: 'revisa',
  confirmá: 'confirma',
  elegí: 'elige',
  decidí: 'decide',
  decidís: 'decides',
  aprobá: 'aprueba',
};

const PATTERN = new RegExp(`(?<![\\p{L}])(${Object.keys(VOSEO).join('|')})(?![\\p{L}])`, 'giu');

export function toTuteo(text: string): string {
  return text.replace(PATTERN, (match) => {
    const out = VOSEO[match.toLowerCase()];
    if (!out) return match;
    return match[0] === match[0]?.toUpperCase() && match[0] !== match[0]?.toLowerCase()
      ? out.charAt(0).toUpperCase() + out.slice(1)
      : out;
  });
}
