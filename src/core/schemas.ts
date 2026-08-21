export const strategySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    stage: { type: "string" },
    qualification: {
      type: "object",
      additionalProperties: false,
      properties: {
        fit: { type: "integer", minimum: 0, maximum: 2 },
        commercial_goal: { type: "integer", minimum: 0, maximum: 2 },
        media_gap: { type: "integer", minimum: 0, maximum: 2 },
        value_established: { type: "integer", minimum: 0, maximum: 2 },
        service_understanding: { type: "integer", minimum: 0, maximum: 2 },
        interest_signal: { type: "integer", minimum: 0, maximum: 2 },
      },
      required: ["fit", "commercial_goal", "media_gap", "value_established", "service_understanding", "interest_signal"],
    },
    total_score: { type: "integer", minimum: 0, maximum: 12 },
    call_ready: { type: "boolean" },
    service_confusion: { type: "boolean" },
    confusion_reason: { type: ["string", "null"] },
    next_objective: { type: "string" },
    strategy: { type: "string" },
    missing_information: { type: "array", items: { type: "string" } },
    credibility_needed: { type: "boolean" },
    credibility_reason: { type: ["string", "null"] },
    should_explain_service: { type: "boolean" },
    evidence: {
      type: "array",
      description:
        "For every dimension you scored above what qualification_evidence supports, the exact words from the conversation that justify it. Quotes are verified verbatim; an invented quote is discarded and the score capped.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          dimension: { type: "string" },
          quote: { type: "string" },
        },
        required: ["dimension", "quote"],
      },
    },
  },
  required: [
    "stage",
    "qualification",
    "total_score",
    "call_ready",
    "service_confusion",
    "confusion_reason",
    "next_objective",
    "strategy",
    "missing_information",
    "credibility_needed",
    "credibility_reason",
    "should_explain_service",
    "evidence",
  ],
} as const;

export const reviewSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    approved: { type: "boolean" },
    issues: { type: "array", items: { type: "string" } },
    final_reply: { type: "string" },
    message_purpose: { type: "string" },
    desired_response: { type: "string", description: "The reply this message is trying to provoke." },
    next_if_positive: { type: "string" },
    next_if_negative: { type: "string" },
    next_if_no_reply: { type: "string" },
  },
  required: [
    "approved",
    "issues",
    "final_reply",
    "message_purpose",
    "desired_response",
    "next_if_positive",
    "next_if_negative",
    "next_if_no_reply",
  ],
} as const;

/**
 * Schema for the model-driven memory extraction pass.
 *
 * Every item carries the quote it came from. Quotes are checked verbatim
 * against the real messages: one that is found is recorded as a fact, one that
 * is not is recorded as an inference at low confidence. Nothing the model says
 * enters memory as fact on its own authority.
 */
const extractedItems = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      value: { type: "string", description: "The fact, in a short phrase." },
      quote: { type: "string", description: "The exact words from the conversation this came from." },
    },
    required: ["value", "quote"],
  },
} as const;

export const memoryExtractionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    // Interpretations, so they carry the words they were read from. Stored as
    // inferences whatever the model says about them.
    relationship_summary: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        value: { type: "string", description: "Your reading of the relationship." },
        quote: { type: "string", description: "The words that best support it, verbatim, or an empty string." },
      },
      required: ["value", "quote"],
    },
    communication_style: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        value: { type: "string", description: "How they write." },
        quote: { type: "string", description: "The words that best show it, verbatim, or an empty string." },
      },
      required: ["value", "quote"],
    },
    businesses: extractedItems,
    goals: extractedItems,
    personal_goals: extractedItems,
    facts_known: extractedItems,
    pain_points: extractedItems,
    interests: extractedItems,
    media_history: extractedItems,
    opportunities_identified: extractedItems,
    key_entities: extractedItems,
    objections: extractedItems,
    followup_commitments: extractedItems,
  },
  required: [
    "relationship_summary",
    "communication_style",
    "businesses",
    "goals",
    "personal_goals",
    "facts_known",
    "pain_points",
    "interests",
    "media_history",
    "opportunities_identified",
    "key_entities",
    "objections",
    "followup_commitments",
  ],
} as const;
