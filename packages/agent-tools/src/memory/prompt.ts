import type { MemoryContextEntry, MemoryKind } from './types';

/**
 * Turning memories into prompt text, and stopping them coming back out.
 *
 * Pure: no db, no clock, no network. Both halves are unit-testable, which
 * matters because the second half is a privacy control, not a formatting
 * concern.
 */

/** Where the answer is going. It changes what may be said, not what is known. */
export type MemoryAudience = 'private' | 'group';

const KIND_LEAD: Record<MemoryKind, string> = {
  instruction: 'Standing instruction',
  preference: 'How they like things',
  vocabulary: 'What they mean',
  fact: 'About them',
};

/**
 * The block that goes into the system prompt.
 *
 * Deliberately not a JSON blob or a table of fields: the model behaves better
 * with sentences it can act on than with rows it has to interpret, and the same
 * sentence is what the person reads on their settings page. One text, two
 * readers, no translation layer to drift.
 */
export function renderMemoryBlock(
  memories: MemoryContextEntry[],
  audience: MemoryAudience = 'private',
): string {
  if (memories.length === 0) return '';

  const lines = memories.map((m) => `- (${KIND_LEAD[m.kind]}) ${m.content}`);

  const rules = [
    'These are things you have learned about the person you are talking to, from working with them. Treat them as true and act on them without being asked again.',
    audience === 'group'
      ? 'They are context, not content: let them shape what you do and how you say it. Never read them back, never list them, never say "I remember that you…".'
      : 'They are context, not content. Do not recap them, list them, or say "I remember that you…". When a standing instruction changed what you just did or proposed — you skipped a Monday collection, you used usted, you did not mention money — name it in one short clause so they can see why: "el lunes no, instrucción tuya". That is the work showing its reason, not a memory dump. If they ask what you remember, then you may list.',
    'If one of them contradicts what the person says right now, the person wins — what they just said is newer than what you learned.',
  ];

  if (audience === 'group') {
    // The prompt half of the group-space rule. The enforcing half is
    // `findMemoryEcho` below, because a prompt is a request and this needs a
    // guarantee.
    rules.push(
      'You are in a room with other people. These notes are personal to the one person who wrote them, and the others cannot see them. Do NOT quote, restate, summarise or hint at any of them here, and do not act in a way that reveals what one of them says. If answering would require repeating one, take it to a direct message instead.',
    );
  }

  return [
    '<what_you_know_about_this_person>',
    ...rules,
    '',
    ...lines,
    '</what_you_know_about_this_person>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The group-space guard
// ---------------------------------------------------------------------------

/**
 * Diacritics folded, punctuation dropped, function words removed. Both the
 * memory and the answer are reduced to the same content-word stream so that
 * "never CC the client" and "I won't CC the client" compare on the words that
 * carry the meaning rather than on the ones that carry the grammar.
 */
const STOPWORDS = new Set([
  // English
  'a',
  'about',
  'all',
  'also',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'get',
  'go',
  'had',
  'has',
  'have',
  'he',
  'her',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'me',
  'my',
  'no',
  'not',
  'of',
  'on',
  'only',
  'or',
  'our',
  'out',
  'she',
  'so',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'up',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'which',
  'who',
  'will',
  'with',
  'would',
  'you',
  'your',
  // Determiners and quantifiers: a model told not to quote something reworks
  // the grammar around it, and these are what it reworks with.
  'another',
  'both',
  'each',
  'either',
  'every',
  'more',
  'most',
  'much',
  'other',
  'same',
  'some',
  'such',
  'those',
  'very',
  'always',
  'never',
  'still',
  'already',
  'again',
  'right',
  'now',
  'here',
  // Spanish
  'al',
  'como',
  'con',
  'cuando',
  'de',
  'del',
  'desde',
  'donde',
  'el',
  'ella',
  'ellos',
  'en',
  'entre',
  'era',
  'es',
  'esa',
  'ese',
  'eso',
  'esta',
  'este',
  'esto',
  'ha',
  'hay',
  'la',
  'las',
  'le',
  'les',
  'lo',
  'los',
  'mas',
  'me',
  'mi',
  'muy',
  'no',
  'nos',
  'o',
  'para',
  'pero',
  'por',
  'que',
  'se',
  'ser',
  'si',
  'sin',
  'sobre',
  'son',
  'su',
  'sus',
  'tu',
  'un',
  'una',
  'uno',
  'y',
  'ya',
  'yo',
]);

function contentWords(text: string): string[] {
  return (
    text
      .toLowerCase()
      .normalize('NFD')
      // NFD split every accented letter into letter + combining mark; dropping
      // the marks is what makes "intern\u00f3s" and "internos" the same word.
      .replace(/\p{Mn}/gu, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      // Single letters are what contractions leave behind ("won't" → "won", "t");
      // they carry no meaning and would break an otherwise contiguous run.
      .filter((w) => w.length > 1 && !STOPWORDS.has(w))
  );
}

/**
 * When a memory counts as repeated: most of what makes it distinctive has
 * turned up in the answer.
 *
 * Contiguity was the obvious rule and it is the wrong one. A model told not to
 * quote something restates it with the grammar rearranged and a clause dropped
 * — "worth noting he is quietly looking for another job right now" is the whole
 * of a private memory with two words missing from the middle — and any run-based
 * check that survives that is short enough to fire on ordinary phrases.
 *
 * So the test is proportional instead: at least 60% of the memory's own content
 * words, and never fewer than three. That scales with how specific the memory
 * is (a twelve-word note needs eight, a four-word note needs three) and it is
 * hard to hit by accident, because generic overlap is a small fraction of a
 * whole sentence.
 *
 * The 3-word floor means a memory with fewer than three content words can never
 * trigger this. That is a real gap and an accepted one: at that length the words
 * are too common to distinguish a disclosure from a coincidence, and firing on
 * them would withhold ordinary answers all day. Nothing about those two errors
 * is symmetric — a wrongly-withheld answer arrives in a DM a second later, a
 * wrongly-posted personal note cannot be recalled from eight people's screens —
 * so the guard is tuned to catch sentences, not fragments.
 */
const ECHO_RATIO = 0.6;
const ECHO_MIN_WORDS = 3;

/**
 * Does this answer repeat one of the memories that shaped it?
 *
 * This is the enforcing half of the group-space rule. The system prompt asks
 * the model not to restate a personal note into a room; asking is not a
 * guarantee, and the guarantee is what the PRIVACY GUARD in
 * apps/web/app/api/chat-app/google/turn.ts exists to provide. So the finished
 * text is checked before it is posted, and an answer that carries a memory back
 * out goes to the person privately instead of into the space.
 *
 * Returns the id of the first memory found in the text, or null.
 *
 * Note what this does NOT try to do: it does not detect a memory's INFLUENCE.
 * An answer written in Spanish because a memory says the person prefers Spanish
 * has been shaped by a memory and reveals nothing, and it posts normally. Only
 * repetition is a disclosure.
 */
export function findMemoryEcho(answer: string, memories: MemoryContextEntry[]): string | null {
  if (!answer.trim() || memories.length === 0) return null;
  const said = new Set(contentWords(answer));
  if (said.size < ECHO_MIN_WORDS) return null;

  for (const memory of memories) {
    const words = new Set(contentWords(memory.content));
    if (words.size < ECHO_MIN_WORDS) continue;
    let hits = 0;
    for (const word of words) if (said.has(word)) hits++;
    const needed = Math.max(ECHO_MIN_WORDS, Math.ceil(words.size * ECHO_RATIO));
    if (hits >= needed) return memory.id;
  }
  return null;
}
