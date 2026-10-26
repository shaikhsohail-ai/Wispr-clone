import type { DictionaryEntry } from './types.js';

/**
 * Hesitation sounds removed by default. Anything that could be a real word is left out: "mm" (millimetres),
 * "er" (ER, the emergency room) and "hm" (HM Treasury) are deliberately not on this list.
 */
export const DEFAULT_FILLERS = ['um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'hmm', 'mhm'];

/** Average typing speed used to estimate time saved by dictating instead of typing. */
export const TYPING_WPM = 40;

export interface CleanupOptions {
  /** Strip hesitation sounds such as "um" and "uh". Default: true. */
  removeFillers?: boolean;
  /** Override the filler list. Default: DEFAULT_FILLERS. */
  fillerWords?: string[];
  /** Turn spoken commands such as "comma", "new line" and "scratch that" into punctuation. Default: true. */
  spokenPunctuation?: boolean;
  /** Capitalise the first letter of each sentence and the pronoun "I". Default: true. */
  capitalize?: boolean;
  /** Add a full stop when the text ends without punctuation. Default: true. */
  ensureTerminalPunctuation?: boolean;
  /** Personal dictionary: whole-word, case-insensitive replacements applied in order. */
  dictionary?: DictionaryEntry[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `(?<!\w)` / `(?!\w)` instead of `\b` so entries like "c++" or ".net" still match whole words. */
function wholePhrase(phrase: string, flags = 'gi'): RegExp {
  const body = escapeRegExp(phrase.trim()).replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\w])${body}(?![\\w])`, flags);
}

interface SpokenCommand {
  phrases: string[];
  /** Replacement text. Closing punctuation attaches to the previous word; opening marks attach to the next. */
  replacement: string;
  kind: 'closing' | 'opening' | 'break';
}

const SPOKEN_COMMANDS: SpokenCommand[] = [
  { phrases: ['new paragraph'], replacement: '\n\n', kind: 'break' },
  { phrases: ['new line', 'newline'], replacement: '\n', kind: 'break' },
  { phrases: ['full stop', 'period'], replacement: '.', kind: 'closing' },
  { phrases: ['comma'], replacement: ',', kind: 'closing' },
  { phrases: ['question mark'], replacement: '?', kind: 'closing' },
  { phrases: ['exclamation mark', 'exclamation point'], replacement: '!', kind: 'closing' },
  { phrases: ['semicolon', 'semi colon', 'semi-colon'], replacement: ';', kind: 'closing' },
  { phrases: ['colon'], replacement: ':', kind: 'closing' },
  { phrases: ['close quote', 'end quote', 'close quotes', 'end quotes'], replacement: '"', kind: 'closing' },
  { phrases: ['open quote', 'begin quote', 'open quotes', 'begin quotes'], replacement: '"', kind: 'opening' },
  { phrases: ['close paren', 'close parenthesis', 'close bracket'], replacement: ')', kind: 'closing' },
  { phrases: ['open paren', 'open parenthesis', 'open bracket'], replacement: '(', kind: 'opening' },
];

/**
 * "scratch that" / "delete that" removes the sentence the command appears in, back to the previous sentence
 * boundary. Several commands in one sentence each delete back to the previous command. Engines may put a
 * terminator before as well as after the command (". Scratch that."); a command that starts its own sentence
 * (optionally after "actually", "no", "wait", "sorry" or "oh") refers to the sentence before it.
 */
const SCRATCH_THAT =
  /([.!?\n]|^)(?:[^.!?\n]*?[.!?]?\s*(?:(?:actually|no|wait|sorry|oh),?\s+)?(?<![\w])(?:scratch that|delete that)(?![\w])[,.!?]?)+/gi;

/**
 * Expand spoken punctuation commands. Engines sometimes add their own mark after the word ("period."), which is
 * absorbed. A command word joined by a hyphen ("comma-separated", "end-of-period") is left alone. The scratch pass
 * runs last so that spoken sentence breaks already exist as boundaries.
 */
export function applySpokenPunctuation(text: string): string {
  let out = text;
  for (const cmd of SPOKEN_COMMANDS) {
    for (const phrase of cmd.phrases) {
      const body = escapeRegExp(phrase).replace(/\s+/g, '\\s+');
      if (cmd.kind === 'closing') {
        out = out.replace(new RegExp(`\\s*(?<![\\w-])${body}(?![\\w-])[,.!?;:]?`, 'gi'), cmd.replacement);
      } else if (cmd.kind === 'opening') {
        out = out.replace(new RegExp(`(?<![\\w-])${body}(?![\\w-])[,.!?;:]?\\s*`, 'gi'), ` ${cmd.replacement}`);
      } else {
        out = out.replace(new RegExp(`\\s*(?<![\\w-])${body}(?![\\w-])[,.!?;:]?\\s*`, 'gi'), cmd.replacement);
      }
    }
  }
  return out.replace(SCRATCH_THAT, '$1');
}

/** Remove hesitation sounds. Parenthetical fillers (", um,") collapse to a single comma. */
export function removeFillerWords(text: string, fillers: string[] = DEFAULT_FILLERS): string {
  const words = fillers.map((f) => f.trim()).filter(Boolean);
  if (words.length === 0) return text;
  const alternation = words.map((w) => escapeRegExp(w).replace(/\s+/g, '\\s+')).join('|');
  const parenthetical = new RegExp(`,\\s*(?<![\\w])(?:${alternation})(?![\\w])\\s*,`, 'gi');
  // Only horizontal whitespace before the filler, so a "new paragraph" or engine line break survives.
  const standalone = new RegExp(`[ \\t]*(?<![\\w])(?:${alternation})(?![\\w]),?(?=\\s|$|[.!?;:,])`, 'gi');
  return text
    .replace(parenthetical, ',')
    .replace(standalone, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/^[ \t]+/, '');
}

/** Apply the personal dictionary: whole-word, case-insensitive, in the order given. */
export function applyDictionary(text: string, dictionary: DictionaryEntry[] = []): string {
  let out = text;
  for (const entry of dictionary) {
    const from = entry.from?.trim();
    if (!from) continue;
    out = out.replace(wholePhrase(from), entry.to ?? '');
  }
  return out;
}

/** Normalise spacing and tidy punctuation artefacts left by the other passes. */
export function tidyWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ +([,!?;:)])/g, '$1')
    .replace(/ +\.(?![\p{L}\p{N}])/gu, '.')
    .replace(/\( +/g, '(')
    .replace(/([,?!;:])(?=[A-Za-zÀ-ɏ])/g, '$1 ')
    .replace(/([,;:?!])\1+/g, '$1')
    .replace(/(?<!\.)\.\.(?!\.)/g, '.')
    .replace(/([?!])\./g, '$1')
    .replace(/,([.?!])/g, '$1')
    .replace(/^[\s,;:]+/, '')
    .trim();
}

/**
 * Capitalise sentence starts and the pronoun "I". A full stop that ends a dotted initialism ("e.g.", "U.S.", "p.m.")
 * or a common title ("Dr.", "Mrs.", "vs.") does not end a sentence. An opening quote or parenthesis may sit between
 * the boundary and the first letter, and typographic quotes and apostrophes count like straight ones.
 */
export function capitalizeSentences(text: string): string {
  return text
    .replace(
      /(^|[.!?](?<![A-Za-z]\.[A-Za-z]\.)(?<!\b(?:[Vv]s|[Dd]r|[Mm]rs?|[Mm]s|[Ss]t|[Jj]r|[Ss]r|[Pp]rof)\.)["'”’)]?\s+|\n\s*)(["“'‘(]?\s*)([a-zà-ÿ])/g,
      (_m, pre: string, open: string, ch: string) => pre + open + ch.toUpperCase(),
    )
    .replace(/(^|[\s("“‘])i(?=['’\s,!?;:)]|\.(?![A-Za-z])|$)/g, '$1I');
}

/** Add a full stop when the text ends without one. A trailing comma (a cut-off phrase, or a spoken "comma") is replaced. */
export function ensureTerminalPunctuation(text: string): string {
  const trimmed = text.trimEnd().replace(/[,\s]+$/, '');
  if (!trimmed) return trimmed;
  if (/[.!?…:;"'”’)\]]$/.test(trimmed)) return trimmed;
  return `${trimmed}.`;
}

/** Full cleanup pipeline: spoken punctuation → fillers → dictionary → tidy → capitalise → terminal punctuation. */
export function cleanTranscript(raw: string, options: CleanupOptions = {}): string {
  const {
    removeFillers = true,
    fillerWords = DEFAULT_FILLERS,
    spokenPunctuation = true,
    capitalize = true,
    ensureTerminalPunctuation: ensureTerminal = true,
    dictionary = [],
  } = options;

  let text = (raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (!text) return '';
  if (spokenPunctuation) text = applySpokenPunctuation(text);
  if (removeFillers) text = removeFillerWords(text, fillerWords);
  text = applyDictionary(text, dictionary);
  text = tidyWhitespace(text);
  // Fillers or commands alone can leave only punctuation behind ("Um." → "."); that is nothing to keep.
  if (!/[\p{L}\p{N}]/u.test(text)) return '';
  if (capitalize) text = capitalizeSentences(text);
  if (ensureTerminal) text = ensureTerminalPunctuation(text);
  return text.trim();
}

export function countWords(text: string): number {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export function wordsPerMinute(words: number, durationMs: number): number {
  if (durationMs <= 0 || words <= 0) return 0;
  return Math.round((words / (durationMs / 60_000)) * 10) / 10;
}

/** Time saved versus typing the same words at `typingWpm`, never negative. */
export function timeSavedMs(words: number, durationMs: number, typingWpm = TYPING_WPM): number {
  if (words <= 0) return 0;
  const typingMs = (words / typingWpm) * 60_000;
  return Math.max(0, Math.round(typingMs - Math.max(0, durationMs)));
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
