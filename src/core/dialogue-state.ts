import type { LeadMemory, Message } from "@/lib/types";

/**
 * Semantic dialogue state.
 *
 * Exact-string question tracking is not enough. "What are you focused on growing
 * right now?" and "What's the main thing you're building?" are the same question,
 * and a prospect who answered either has answered both. This module reduces both
 * sides of the conversation to *topics*, so the setter can tell what is genuinely
 * still open from what it merely has not asked in those exact words.
 *
 * Everything here is deterministic. The model receives the resulting ledger as
 * fact rather than being asked to remember the conversation itself.
 */

/** Conversation topics the setter can open or close. */
export const TOPICS = [
  "commercial_goal",
  "media_gap",
  "media_history",
  "openness_interest",
  "service_model",
  "pricing",
  "timing",
  "audience",
  "call_scheduling",
  "contact_details",
] as const;
export type Topic = (typeof TOPICS)[number];

export const TOPIC_LABELS: Record<Topic, string> = {
  commercial_goal: "What they are building / working toward",
  media_gap: "What currently comes up when they are looked up",
  media_history: "Their past media and podcast experience",
  openness_interest: "Whether they are open to hearing more",
  service_model: "What we actually do",
  pricing: "What it costs",
  timing: "Their timeline or deadlines",
  audience: "Who they are trying to reach",
  call_scheduling: "Arranging a call",
  contact_details: "Email or contact details",
};

/** What the SETTER asking about a topic looks like. */
const ASK_PATTERNS: Record<Topic, RegExp[]> = {
  commercial_goal: [
    /\bwhat (are|re) you (building|working on|focused on|growing)\b/i,
    /\bwhat('s| is) the main thing\b/i,
    /\bwhat are you (trying to|looking to)\b/i,
    /\bbuilding toward\b/i,
    /\bwhat('s| is) next for\b/i,
    /\bwhat are you working toward\b/i,
    /\bwhat are you hoping to\b/i,
  ],
  media_gap: [
    /\bwhat (comes|shows) up when\b/i,
    /\b(look|search) (you|them) up\b/i,
    /\bgoogle (you|your name)\b/i,
    /\bwhat('s| is) out there about you\b/i,
  ],
  media_history: [
    /\b(done|been on|appeared on) (any )?(podcasts?|press|media|interviews?)\b/i,
    /\bany (media|press|podcast)s? (before|so far|yet)\b/i,
    /\bhave you (done|been featured)\b/i,
  ],
  openness_interest: [
    /\bwould you be open to\b/i,
    /\bwould that be (something|of interest)\b/i,
    /\b(open|up) (to|for) (hearing|exploring|chatting)\b/i,
    /\binterested in (hearing|seeing|exploring)\b/i,
    /\bwant me to (walk you through|share|explain)\b/i,
    /\bis that something you'?d\b/i,
    /\bworth (a look|exploring)\b/i,
  ],
  service_model: [/\bwhat we do\b/i, /\bhow (this|it) works\b/i, /\bwe work with clients\b/i],
  pricing: [/\bpricing\b/i, /\bwhat it costs\b/i, /\binvestment\b/i],
  timing: [/\b(when|what timeline|how soon|by when)\b/i, /\btimeline\b/i, /\bwhen are you (launching|raising)\b/i],
  audience: [/\bwho (are|re) you trying to reach\b/i, /\byour (ideal )?(audience|clients?|patients?)\b/i],
  call_scheduling: [/\b(call|chat) (with )?avo\b/i, /\b(20|15|30) min(ute)?s?\b/i, /\bthis week or next\b/i, /\bwhat (time|day) works\b/i],
  contact_details: [/\bbest email\b/i, /\bemail to send\b/i, /\bwhat('s| is) your email\b/i],
};

/** What the PROSPECT answering a topic looks like. */
const ANSWER_PATTERNS: Record<Topic, RegExp[]> = {
  commercial_goal: [
    /\b(i'?m|im|we'?re|were) (building|launching|working on|focused on|growing|scaling|raising|opening|starting)\b/i,
    /\b(i|we) run\b/i,
    /\bmy (company|business|clinic|practice|agency|startup)\b/i,
    /\b(launching|raising|releasing) (a|an|my|our)\b/i,
    /\btrying to (grow|scale|launch|raise|reach|educate|build)\b/i,
    /\bmain (focus|priority|thing) (is|right now)\b/i,
  ],
  media_gap: [
    /\b(not much|nothing|barely anything|hardly anything)\b/i,
    /\b(don'?t|do not) (really )?have (any|much)\b/i,
    /\bjust (my|our) (site|website|instagram|linkedin)\b/i,
    /\bno (press|coverage|articles)\b/i,
  ],
  media_history: [
    /\b(i'?ve|ive|i have) (done|been on|appeared on)\b/i,
    /\b(a few|some|couple of) (podcasts?|interviews?|features?)\b/i,
    /\bnever (done|been on)\b/i,
    /\bno podcasts?\b/i,
  ],
  openness_interest: [
    /\b(i'?m|im) (always )?(open|down|keen|game|up for)\b/i,
    /\b(open|down) to (hear|hearing|it|opportunities|chat)\b/i,
    /\b(sure|yeah|yes)[, ]+(i'?d|id|i am|im|that)\b/i,
    /\b(sounds|that sounds) (interesting|good|great)\b/i,
    /\bi'?d be interested\b/i,
    /\btell me more\b/i,
    /\bhear it out\b/i,
    /\b(happy|glad|keen|down) to (hear|see|learn|know)\b/i,
    /\bhear more\b/i,
    /\bwhat did you have in mind\b/i,
    /\bgo on\b/i,
    /\bshoot\b/i,
    /\bi'?m listening\b/i,
  ],
  service_model: [/\bso you (guys )?(help|work with|do)\b/i, /\byour clients\b/i, /\bi see what you\b/i],
  pricing: [/\bhow much\b/i, /\bwhat do you charge\b/i, /\bpricing\b/i, /\bcost\b/i, /\bbudget\b/i],
  timing: [
    /\b(next|this) (week|month|quarter|year)\b/i,
    /\bin (january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
    /\bq[1-4]\b/i,
    /\b(by|before) (the )?(end of|summer|autumn|fall|winter|spring)\b/i,
  ],
  audience: [/\b(my|our) (audience|patients|clients|customers|community)\b/i, /\btrying to reach\b/i],
  call_scheduling: [/\b(works|good) for me\b/i, /\b(tue|wed|thu|fri|mon)\w*\b.{0,12}\b(works|good|fine)\b/i, /\blet'?s do\b/i, /\bi'?m free\b/i],
  contact_details: [/\b[\w.+-]+@[\w-]+\.[\w.]+\b/i],
};

export type TopicState = {
  topic: Topic;
  asked: boolean;
  answered: boolean;
  /** The prospect's words that closed it. */
  answer_quote: string | null;
  answer_message_id: string | null;
  asked_quote: string | null;
};

export type DialogueState = {
  topics: Record<Topic, TopicState>;
  /** Topics that must not be asked again — already answered, in any wording. */
  do_not_ask: Topic[];
  /** Asked but never answered: the genuine open loop. */
  open_loops: Topic[];
  /** Never raised, and still worth raising. */
  unexplored: Topic[];
  /** The prospect's most recent substantive message. */
  last_prospect_message: { text: string; id: string | null; at: string | null } | null;
  /** True when the last message in the thread is ours — they owe us a reply. */
  awaiting_their_reply: boolean;
  setter_message_count: number;
  prospect_message_count: number;
};

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}

function emptyTopicState(topic: Topic): TopicState {
  return { topic, asked: false, answered: false, answer_quote: null, answer_message_id: null, asked_quote: null };
}

/**
 * Reconstructs what has already been established from the full message history
 * plus long-term memory.
 *
 * Memory participates because a fact recorded months ago still closes its topic
 * even when the message that produced it has long fallen out of the window.
 */
export function buildDialogueState(messages: Message[], memory: LeadMemory | null): DialogueState {
  const topics = Object.fromEntries(TOPICS.map((t) => [t, emptyTopicState(t)])) as Record<Topic, TopicState>;

  for (const message of messages) {
    const text = message.message_text ?? "";
    if (!text.trim()) continue;

    if (message.sender === "setter") {
      for (const topic of TOPICS) {
        if (matchesAny(text, ASK_PATTERNS[topic])) {
          topics[topic].asked = true;
          topics[topic].asked_quote = text.slice(0, 200);
        }
      }
      continue;
    }

    if (message.sender !== "prospect") continue;
    for (const topic of TOPICS) {
      if (matchesAny(text, ANSWER_PATTERNS[topic])) {
        topics[topic].answered = true;
        topics[topic].answer_quote = text.slice(0, 200);
        topics[topic].answer_message_id = message.id ?? null;
      }
    }
  }

  // Long-term memory closes topics whose evidence predates the loaded history.
  if (memory) {
    const close = (topic: Topic, items: { value: string; quote?: string | null }[] | undefined) => {
      if (!items?.length) return;
      const first = items[0];
      topics[topic].answered = true;
      topics[topic].answer_quote = topics[topic].answer_quote ?? first.quote ?? first.value;
    };
    close("commercial_goal", memory.goals);
    close("commercial_goal", memory.businesses);
    close("media_history", memory.media_history);
    close("timing", memory.timing_constraints);
    if ((memory.buying_signals?.length ?? 0) > 0) {
      topics.openness_interest.answered = true;
      topics.openness_interest.answer_quote =
        topics.openness_interest.answer_quote ?? memory.buying_signals[0].quote ?? memory.buying_signals[0].value;
    }
  }

  const prospectMessages = messages.filter((m) => m.sender === "prospect");
  const last = prospectMessages[prospectMessages.length - 1];
  const lastOverall = messages[messages.length - 1];

  return {
    topics,
    do_not_ask: TOPICS.filter((t) => topics[t].answered),
    open_loops: TOPICS.filter((t) => topics[t].asked && !topics[t].answered),
    unexplored: TOPICS.filter((t) => !topics[t].asked && !topics[t].answered),
    last_prospect_message: last ? { text: last.message_text, id: last.id ?? null, at: last.sent_at ?? null } : null,
    awaiting_their_reply: lastOverall?.sender === "setter",
    setter_message_count: messages.filter((m) => m.sender === "setter").length,
    prospect_message_count: prospectMessages.length,
  };
}

/**
 * True when a draft asks about a topic the prospect has already answered.
 *
 * This is the deterministic form of the operator's most frequent rejection —
 * "he already said that" — and is enforced by the reviewer rather than left to
 * the model's memory.
 */
export function draftRepeatsAnsweredTopic(draft: string, state: DialogueState): Topic | null {
  for (const topic of state.do_not_ask) {
    if (matchesAny(draft, ASK_PATTERNS[topic])) return topic;
  }
  return null;
}

/** The single highest-value question still genuinely worth asking. */
export function nextBestTopic(state: DialogueState): Topic | null {
  // Ordered by what most changes the decision to book.
  const priority: Topic[] = [
    "commercial_goal",
    "media_gap",
    "openness_interest",
    "media_history",
    "timing",
    "audience",
  ];
  return priority.find((t) => !state.topics[t].answered) ?? null;
}

/** Compact form for the model context. */
export function summariseDialogueState(state: DialogueState) {
  return {
    already_answered_do_not_ask_again: state.do_not_ask.map((t) => ({
      topic: t,
      label: TOPIC_LABELS[t],
      their_words: state.topics[t].answer_quote,
    })),
    asked_but_unanswered: state.open_loops.map((t) => ({ topic: t, label: TOPIC_LABELS[t] })),
    never_raised: state.unexplored.map((t) => ({ topic: t, label: TOPIC_LABELS[t] })),
    next_best_question_topic: nextBestTopic(state),
    awaiting_their_reply: state.awaiting_their_reply,
    exchange_count: { setter: state.setter_message_count, prospect: state.prospect_message_count },
  };
}
