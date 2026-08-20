import type { Message } from "@/lib/types";
import type { DialogueState } from "@/core/dialogue-state";

/**
 * Relationship temperature.
 *
 * How hard to push is not a function of the qualification score — it is a
 * function of how this person is actually engaging. A guarded prospect answering
 * in three words needs a different move from one asking about pricing, even when
 * both score the same.
 */

export const TEMPERATURES = ["guarded", "neutral", "engaged", "warm", "high_intent"] as const;
export type Temperature = (typeof TEMPERATURES)[number];

export const TEMPERATURE_GUIDANCE: Record<Temperature, string> = {
  guarded:
    "Short, low-pressure, relationship first. One light question at most. Do not pitch, do not propose a call.",
  neutral: "Normal discovery. One question, keep it easy to answer.",
  engaged: "Progress discovery and start connecting value to what they told you.",
  warm: "Stop asking discovery questions you do not need. Build specific value and check the commercial model has landed.",
  high_intent:
    "They want this. Fill the last gap and move toward a concrete call. Do not re-open discovery.",
};

export type TemperatureAssessment = {
  temperature: Temperature;
  score: number;
  signals: string[];
  guidance: string;
};

const HIGH_INTENT = [
  { re: /\bhow much|what do you charge|pricing|cost\b/i, label: "asked about price" },
  { re: /\b(let'?s|happy to|down to) (talk|chat|jump on|hop on|do a call)\b/i, label: "offered to talk" },
  { re: /\bsend (me )?(the|a) (link|invite|details)\b/i, label: "asked for the next step" },
  { re: /\bwhen (can|are) (we|you)\b/i, label: "asked about timing of a call" },
  { re: /\b[\w.+-]+@[\w-]+\.[\w.]+\b/, label: "gave an email address" },
];

const WARM = [
  { re: /\bwhat does (this|it|working with you) (look like|involve)\b/i, label: "asked what it involves" },
  { re: /\btell me more\b/i, label: "asked for more" },
  { re: /\b(i'?m|im) (interested|keen)\b/i, label: "stated interest" },
  { re: /\bthat (makes sense|resonates|is interesting)\b/i, label: "engaged with the argument" },
  { re: /\bhear it out\b/i, label: "willing to hear it out" },
];

const ENGAGED = [
  { re: /\b(i'?m|im|we'?re) (building|launching|working on|focused on|raising)\b/i, label: "shared what they are building" },
  { re: /\b(honestly|to be fair|good question)\b/i, label: "conversational engagement" },
  { re: /\?/, label: "asked a question back" },
];

const GUARDED = [
  { re: /^(ok|okay|k|sure|yeah|yep|cool|thanks|ty)\.?$/i, label: "one-word replies" },
  { re: /\bwho is this\b/i, label: "does not know who we are" },
  { re: /\bwhat'?s this (about|regarding)\b/i, label: "asked what this is about" },
  { re: /\b(busy|slammed|swamped)\b/i, label: "signalled they are busy" },
];

/**
 * Scores temperature from the prospect's recent behaviour.
 *
 * Recency is weighted: a prospect who was warm five messages ago and is now
 * giving one-word replies has cooled, and the setter should follow them down
 * rather than keep pushing at the old temperature.
 */
export function assessTemperature(messages: Message[], dialogue: DialogueState): TemperatureAssessment {
  const prospect = messages.filter((m) => m.sender === "prospect");
  if (prospect.length === 0) {
    return {
      temperature: "neutral",
      score: 0,
      signals: ["No reply yet"],
      guidance: TEMPERATURE_GUIDANCE.neutral,
    };
  }

  const recent = prospect.slice(-4);
  const signals: string[] = [];
  let score = 0;

  recent.forEach((message, i) => {
    const text = message.message_text ?? "";
    // The most recent message counts double.
    const weight = i === recent.length - 1 ? 2 : 1;

    for (const { re, label } of HIGH_INTENT) {
      if (re.test(text)) {
        score += 4 * weight;
        signals.push(label);
        break;
      }
    }
    for (const { re, label } of WARM) {
      if (re.test(text)) {
        score += 2 * weight;
        signals.push(label);
        break;
      }
    }
    for (const { re, label } of ENGAGED) {
      if (re.test(text)) {
        score += 1 * weight;
        signals.push(label);
        break;
      }
    }
    for (const { re, label } of GUARDED) {
      if (re.test(text.trim())) {
        score -= 2 * weight;
        signals.push(label);
        break;
      }
    }

    // Very short replies are a cooling signal in their own right.
    if (text.trim().split(/\s+/).length <= 3 && weight === 2) {
      score -= 1;
      signals.push("very short latest reply");
    }
  });

  // Openness already expressed is a floor, not a ceiling.
  if (dialogue.topics.openness_interest.answered) score += 2;

  let temperature: Temperature;
  if (score >= 8) temperature = "high_intent";
  else if (score >= 4) temperature = "warm";
  else if (score >= 1) temperature = "engaged";
  else if (score <= -2) temperature = "guarded";
  else temperature = "neutral";

  return { temperature, score, signals: [...new Set(signals)], guidance: TEMPERATURE_GUIDANCE[temperature] };
}
