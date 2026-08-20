import type { ConversationLabels } from "@/ingest/labels";
import type { TranscribedMessage } from "@/ingest/transcribe";
import type { ConversationChunk, OutcomeTier } from "@/lib/types";

/**
 * Turns a verified conversation into retrievable chunks.
 *
 * Chunks are cut at conversational turning points rather than every N
 * characters, because what the setter needs to retrieve is a *moment* — how a
 * confusion was handled, how value was built, how the call was proposed — not an
 * arbitrary window of text.
 */

export type ChunkInput = {
  conversationId: string | null;
  messages: TranscribedMessage[];
  labels: ConversationLabels;
  outcome: string;
  outcome_tier: OutcomeTier;
  niche: string | null;
  industry: string | null;
  setter_name: string | null;
  handle: string | null;
};

export const MAX_CHUNK_MESSAGES = 8;

type Segment = { stage: string; messages: TranscribedMessage[] };

/** Cuts the conversation at the points where the sales stage changes. */
function segment(messages: TranscribedMessage[], labels: ConversationLabels): Segment[] {
  const segments: Segment[] = [];
  let current: Segment = { stage: "OPENING", messages: [] };

  const flush = () => {
    if (current.messages.length) segments.push(current);
  };

  messages.forEach((message, index) => {
    let stage = current.stage;

    if (index === labels.messages_before_cta) stage = "CTA";
    else if (labels.service_confusion && /\b(pod|podcast|guest|collab|free|cost)\b/i.test(message.text) && message.sender === "prospect") {
      stage = "SERVICE_CONFUSION";
    } else if (message.sender === "setter" && /\b(credibility|authority|search|written media|syndication)\b/i.test(message.text)) {
      stage = "VALUE_BUILDING";
    } else if (message.sender === "setter" && message.text.includes("?") && current.stage === "OPENING") {
      stage = "DISCOVERY";
    }

    if (stage !== current.stage || current.messages.length >= MAX_CHUNK_MESSAGES) {
      flush();
      current = { stage, messages: [] };
    }
    current.messages.push(message);
  });
  flush();

  return segments;
}

/**
 * Renders a chunk as a description of what happened, not as raw DM text.
 *
 * Storing the exchange plus its outcome means retrieval surfaces evidence the
 * writer can reason about, and a failure chunk reads unmistakably as a warning
 * rather than as a template to copy.
 */
function renderChunk(seg: Segment, input: ChunkInput): string {
  const header = [
    `Stage: ${seg.stage}`,
    `Outcome: ${input.outcome} (tier ${input.outcome_tier})`,
    input.labels.premature_cta ? "NOTE: the CTA in this conversation was premature." : null,
    input.labels.service_confusion
      ? `NOTE: the prospect misunderstood the service; ${input.labels.confusion_resolved ? "it was corrected" : "it was NEVER corrected"}.`
      : null,
  ]
    .filter(Boolean)
    .join(" | ");

  const body = seg.messages.map((m) => `${m.sender === "setter" ? "Setter" : "Prospect"}: ${m.text}`).join("\n");

  return `${header}\n${body}`;
}

export function buildChunks(input: ChunkInput): Omit<ConversationChunk, "id" | "similarity">[] {
  const segments = segment(input.messages, input.labels);

  return segments.map((seg) => ({
    source_conversation_id: input.conversationId,
    outcome: input.outcome,
    outcome_tier: input.outcome_tier,
    stage: seg.stage,
    niche: input.niche,
    industry: input.industry,
    setter_name: input.setter_name,
    content: renderChunk(seg, input),
    quality_score: input.labels.quality_score,
    metadata: {
      handle: input.handle,
      opener_type: input.labels.opener_type,
      value_props_used: input.labels.value_props_used,
      objections: input.labels.objections,
      buying_signals: input.labels.buying_signals,
      service_confusion: input.labels.service_confusion,
      confusion_resolved: input.labels.confusion_resolved,
      premature_cta: input.labels.premature_cta,
      cta_used: input.labels.cta_used,
      messages_before_cta: input.labels.messages_before_cta,
      commercial_goal_discovered: input.labels.commercial_goal_discovered,
      media_gap_identified: input.labels.media_gap_identified,
      successful_angle: input.labels.successful_angle,
      failed_angle: input.labels.failed_angle,
      objection_type: input.labels.objections[0] ?? null,
    },
  }));
}
