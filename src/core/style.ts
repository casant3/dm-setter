/**
 * DM style.
 *
 * The most common operator rejection after "he already said that" is "this is
 * too long". A setter DM is a text message, not an email: one thought, one
 * move, sent in the length a person would actually type on a phone.
 *
 * These checks are deterministic and are applied to the draft *and* to the
 * reviewer's final reply, so a rewrite cannot reintroduce what the draft was
 * rejected for.
 */

export const MIN_WORDS = 15;
export const MAX_WORDS = 45;
/** Above this it is not a DM any more, whatever the reviewer thinks. */
export const HARD_MAX_WORDS = 70;

export type StyleViolation = {
  rule: string;
  detail: string;
  severity: "hard" | "soft";
};

export type StyleAssessment = {
  words: number;
  sentences: number;
  questions: number;
  violations: StyleViolation[];
  ok: boolean;
};

const CORPORATE = [
  { re: /\bi hope (this|you'?re) (finds?|doing)\b/i, detail: "Email opener, not a DM." },
  { re: /\breach(ing)? out to you (today|regarding)\b/i, detail: "Cold-email phrasing." },
  { re: /\b(leverage|synergy|utilis|utiliz|circle back|touch base|bandwidth|value[- ]add|solutions? provider)\w*\b/i, detail: "Corporate jargon." },
  { re: /\bas (previously )?(mentioned|discussed)\b/i, detail: "Memo phrasing." },
  { re: /\bat your earliest convenience\b/i, detail: "Formal email sign-off phrasing." },
  { re: /\b(dear|greetings)\b/i, detail: "Letter opener." },
  { re: /\blooking forward to hearing from you\b/i, detail: "Form-letter close." },
  { re: /\bkind regards\b|\bbest regards\b/i, detail: "Email sign-off." },
  { re: /\bwe are a (leading|premier|top)\b/i, detail: "Brochure language." },
  { re: /\bunlock\b|\bsupercharge\b|\bgame[- ]chang/i, detail: "Marketing-speak." },
];

const HYPE = [
  { re: /!{2,}/, detail: "Multiple exclamation marks." },
  { re: /\b(amazing|incredible|insane|massive) opportunity\b/i, detail: "Hype language." },
  { re: /\b(100%|guaranteed?)\b/i, detail: "Guarantee language." },
];

/** Emoji beyond the sparse, natural few a person actually texts. */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function countQuestions(text: string): number {
  return (text.match(/\?/g) ?? []).length;
}

function countSentences(text: string): number {
  return text.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 0).length;
}

/** Checks a draft against the house style. */
export function assessStyle(draft: string): StyleAssessment {
  const text = draft.trim();
  const words = countWords(text);
  const questions = countQuestions(text);
  const sentences = countSentences(text);
  const violations: StyleViolation[] = [];

  if (words > HARD_MAX_WORDS) {
    violations.push({
      rule: "length",
      detail: `${words} words. A DM must be under ${HARD_MAX_WORDS}; aim for ${MIN_WORDS}–${MAX_WORDS}.`,
      severity: "hard",
    });
  } else if (words > MAX_WORDS) {
    violations.push({ rule: "length", detail: `${words} words. Aim for ${MIN_WORDS}–${MAX_WORDS}.`, severity: "soft" });
  }

  if (words > 0 && words < MIN_WORDS && questions === 0) {
    violations.push({
      rule: "length",
      detail: `${words} words with no question — too thin to move the conversation.`,
      severity: "soft",
    });
  }

  if (questions > 1) {
    violations.push({
      rule: "one_question",
      detail: `${questions} questions. Ask one thing, so there is one thing to answer.`,
      severity: "hard",
    });
  }

  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim());
  if (paragraphs.length > 2) {
    violations.push({ rule: "shape", detail: `${paragraphs.length} paragraphs. A DM is one, maybe two.`, severity: "hard" });
  }

  if (sentences > 4) {
    violations.push({ rule: "shape", detail: `${sentences} sentences. Cut to the one thought that matters.`, severity: "soft" });
  }

  for (const { re, detail } of CORPORATE) {
    if (re.test(text)) violations.push({ rule: "voice", detail, severity: "hard" });
  }
  for (const { re, detail } of HYPE) {
    if (re.test(text)) violations.push({ rule: "voice", detail, severity: "hard" });
  }

  const emoji = text.match(EMOJI) ?? [];
  if (emoji.length > 1) {
    violations.push({ rule: "voice", detail: `${emoji.length} emoji. At most one, and usually none.`, severity: "soft" });
  }

  if (/\b(firstly|secondly|in conclusion|to summarise|to summarize)\b/i.test(text)) {
    violations.push({ rule: "voice", detail: "Essay structure in a text message.", severity: "hard" });
  }

  return { words, sentences, questions, violations, ok: violations.every((v) => v.severity !== "hard") };
}

/** The style rules as the model should see them. */
export const STYLE_RULES = `MESSAGE SHAPE
- ${MIN_WORDS}–${MAX_WORDS} words. Never more than ${HARD_MAX_WORDS}. It is a text message, not an email.
- One or two short paragraphs at most. No bullet points, no headings, no sign-off.
- Exactly one question, or none. Two questions gives them a reason to answer neither.
- No corporate language, no hype, no guarantees, no essay connectives.
- At most one emoji, usually none. No exclamation stacking.
- Write the way the voice_examples are written.`;
