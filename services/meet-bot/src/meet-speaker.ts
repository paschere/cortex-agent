import { isBotSpeaker } from './voice-brain';

/**
 * Quién dijo una frase en Meet.
 *
 * GPT-Live no trae el nombre de la sala: si el bot lo deja en null, Llamadas
 * pinta «Alguien». Meet sí muestra el roster en el DOM; este módulo elige un
 * nombre usable (quien habla, el único humano, o el último que habló).
 */

export interface HeardPerson {
  name: string;
  speaking?: boolean;
  self?: boolean;
}

const EFFECTS = /visual_effects|backgrounds and effects|fondos y efectos/i;
const PLACEHOLDER =
  /^(you|t[uú]|participant|participante|guest|invitado|unknown|desconocido|user|usuario)(\s+\d+)?$/i;
const CHROME_CHUNK =
  /^(microphone|micr[oó]fono|camera|c[aá]mara|muted|muteado|speaker|altavoz|sharing|compartiendo)\b/i;

export function cleanMeetName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).replace(/\s+/g, ' ').trim();
  if (!s || EFFECTS.test(s)) return null;
  s = s.replace(/\s*\((presenting|presentando|you|t[uú]|yourself)\)\s*$/i, '');
  s = s.replace(/'s screen$/i, '');
  s = s.replace(/\s+está (hablando|presentando)$/i, '');
  s = s.replace(/\s+is (speaking|presenting)$/i, '');
  s = s.replace(/\s+(speaking|hablando|presenting|presentando)$/i, '');
  const parts = s
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const nameParts: string[] = [];
  for (const part of parts) {
    if (CHROME_CHUNK.test(part)) break;
    nameParts.push(part);
  }
  s = (nameParts.join(', ') || parts[0] || s).trim();
  if (PLACEHOLDER.test(s)) return null;
  return s || null;
}

export function usableSpeakerName(name: string | null | undefined, botName = 'Cortex'): string | null {
  const cleaned = cleanMeetName(name);
  if (!cleaned) return null;
  if (/^participante$/i.test(cleaned)) return null;
  if (isBotSpeaker(cleaned, botName)) return null;
  return cleaned;
}

export function resolveHeardSpeaker(input: {
  hinted?: string | null;
  roster: HeardPerson[];
  lastSpeaker?: string | null;
  botName?: string;
}): string | null {
  const botName = input.botName ?? 'Cortex';
  const usable = (name: string | null | undefined) => usableSpeakerName(name, botName);

  const hinted = usable(input.hinted);
  if (hinted) return hinted;

  const others = input.roster.filter((person) => !person.self);
  const talking = others.find((person) => person.speaking);
  const talkingName = talking ? usable(talking.name) : null;
  if (talkingName) return talkingName;

  const unique = [
    ...new Set(others.map((person) => usable(person.name)).filter((name): name is string => Boolean(name))),
  ];
  if (unique.length === 1) return unique[0] ?? null;

  return usable(input.lastSpeaker);
}
