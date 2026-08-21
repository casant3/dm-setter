import { randomUUID } from "node:crypto";
import { emptyMemory, makeItem } from "@/core/memory";
import type {
  AiSuggestion,
  CoachingExample,
  ConversationChunk,
  ConversationEvent,
  CredibilityAsset,
  Lead,
  LeadMemory,
  Message,
  SetterPreference,
  SourceConversation,
} from "@/lib/types";

/**
 * Demo content for the local development store only.
 *
 * The credibility assets here are placeholders, deliberately generic: the real
 * table must contain verified, approved claims before the agent may cite anything.
 */

function daysAgo(n: number, hour = 12): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

function lead(partial: Partial<Lead> & Pick<Lead, "id" | "instagram_handle">): Lead {
  return {
    name: null,
    company: null,
    job_title: null,
    industry: null,
    niche: null,
    followers: null,
    location: null,
    lead_status: "active",
    interest_level: null,
    conversation_stage: "NEW_LEAD",
    priority: "medium",
    media_experience: null,
    authority_level: null,
    media_gap: null,
    commercial_goal: null,
    first_contact_at: null,
    last_contact_at: null,
    next_followup_at: null,
    followup_status: "none",
    followup_note: null,
    booked_call: false,
    booked_call_at: null,
    outcome: null,
    created_at: daysAgo(30),
    updated_at: daysAgo(1),
    ...partial,
  };
}

export function seedData(): {
  leads: Lead[];
  messages: Message[];
  memories: LeadMemory[];
  events: (ConversationEvent & { lead_id: string })[];
  credibility: CredibilityAsset[];
  chunks: ConversationChunk[];
  suggestions: AiSuggestion[];
  source_conversations: SourceConversation[];
  setter_preferences: SetterPreference[];
  coaching_examples: CoachingExample[];
} {
  const cody = "11111111-1111-4111-8111-111111111111";
  const mara = "22222222-2222-4222-8222-222222222222";
  const nia = "33333333-3333-4333-8333-333333333333";

  const leads: Lead[] = [
    lead({
      id: cody,
      instagram_handle: "codyalt",
      name: "Cody Alton",
      company: "Ledgerline",
      job_title: "Founder",
      industry: "Fintech",
      niche: "SMB accounting software",
      followers: 18400,
      location: "Austin, TX",
      conversation_stage: "SERVICE_CONFUSION",
      interest_level: "warm",
      priority: "high",
      commercial_goal: "Raising a seed round and wants credible third-party coverage first",
      media_gap: "No written press; nothing ranks for his name in search",
      media_experience: "Two small niche podcasts, no written media",
      followup_status: "owed_reply",
      followup_note: "He asked what podcast this is for — clarify the model before any call talk.",
      first_contact_at: daysAgo(6),
      last_contact_at: daysAgo(0, 9),
      next_followup_at: daysAgo(-1, 15),
    }),
    lead({
      id: mara,
      instagram_handle: "marasellsdesign",
      name: "Mara Whitfield",
      company: "Whitfield Studio",
      job_title: "Principal Designer",
      industry: "Interior design",
      niche: "Luxury residential",
      followers: 62100,
      location: "Miami, FL",
      conversation_stage: "VALUE_BUILDING",
      interest_level: "hot",
      priority: "urgent",
      commercial_goal: "Launching a paid design course and wants authority to justify the price",
      media_gap: "Strong social presence but zero third-party credibility or search footprint",
      media_experience: "One local magazine feature years ago",
      followup_status: "waiting_on_them",
      followup_note: "Sent the authority angle; she said she'd think it over this week.",
      first_contact_at: daysAgo(12),
      last_contact_at: daysAgo(2, 16),
      next_followup_at: daysAgo(-2, 14),
    }),
    lead({
      id: nia,
      instagram_handle: "drniawellness",
      name: "Dr. Nia Okafor",
      company: "Okafor Longevity",
      job_title: "Clinic Director",
      industry: "Health",
      niche: "Longevity medicine",
      followers: 9300,
      location: "London, UK",
      conversation_stage: "OPENING_SENT",
      priority: "medium",
      followup_status: "waiting_on_them",
      first_contact_at: daysAgo(3),
      last_contact_at: daysAgo(3, 10),
    }),
  ];

  const messages: Message[] = [];
  const push = (
    lead_id: string,
    sender: Message["sender"],
    message_text: string,
    sent_at: string,
    extra: Partial<Message> = {},
  ) => {
    messages.push({
      id: randomUUID(),
      lead_id,
      sender,
      message_text,
      message_type: "text",
      sent_at,
      channel: "instagram",
      is_question: message_text.includes("?"),
      is_cta: null,
      is_objection: null,
      is_buying_signal: null,
      sent_by_ai: false,
      ai_suggestion_id: null,
      ...extra,
    });
  };

  push(cody, "setter", "Cody — saw the Ledgerline thread about reconciliation for multi-entity books. How far along are you with the raise you mentioned on your profile?", daysAgo(6, 14));
  push(cody, "prospect", "haha the raise is very much in progress. we're prepping a seed round for Q3", daysAgo(6, 18));
  push(cody, "setter", "Makes sense. When investors or prospects look you up right now, what actually comes up?", daysAgo(5, 15));
  push(cody, "prospect", "honestly not much. our site, LinkedIn, and a couple of podcast episodes nobody listened to", daysAgo(5, 19));
  push(cody, "setter", "That's the gap most founders hit before a raise — the product is real but there's no third-party proof anywhere a diligence search would land.", daysAgo(3, 13));
  push(cody, "prospect", "yeah that's fair. so how long is the pod? and what show is this for", daysAgo(0, 9), { is_question: true });

  push(mara, "setter", "Mara — the Coral Gables renovation you posted last month was excellent. Are you doing anything with that work beyond Instagram?", daysAgo(12, 15));
  push(mara, "prospect", "thank you! and no, not really. everything lives on IG which honestly worries me", daysAgo(12, 17));
  push(mara, "setter", "Why does it worry you?", daysAgo(11, 14));
  push(mara, "prospect", "I'm launching a course in the fall at a fairly high price point and I don't have anything outside my own feed that says I'm credible", daysAgo(11, 16), { is_buying_signal: true });
  push(mara, "setter", "That's the exact problem. A course at that price is sold on authority, not reach — buyers check whether anyone other than you vouches for you. Written media and search presence do that quietly in the background.", daysAgo(9, 15));
  push(mara, "prospect", "that makes a lot of sense. what does working with you actually look like", daysAgo(8, 12), { is_buying_signal: true, is_question: true });
  push(mara, "setter", "We work with clients on placement across podcasts and written media, then make sure it's positioned around what you're actually selling rather than generic exposure. For your launch that means credibility that's live before the course opens.", daysAgo(5, 14));
  push(mara, "prospect", "ok I like that. so what would the pricing look like for something like that?", daysAgo(2, 16), { is_buying_signal: true, is_question: true });

  push(nia, "setter", "Dr. Okafor — your breakdown of biological age testing was the clearest I've seen on here. Is the clinic your main focus right now, or are you building something around it?", daysAgo(3, 10));

  const codyMemory: LeadMemory = {
    ...emptyMemory(cody),
    relationship_summary:
      makeItem(
      "Fintech founder prepping a seed raise. Friendly, informal, replies in short bursts. Has openly admitted he has no search footprint. Currently confused about what the service is.",
      "inference",
    ),
    facts_known: [
      makeItem("Raising a seed round in Q3", "fact"),
      makeItem("Multi-entity reconciliation is the product wedge", "fact"),
      makeItem("Nothing credible ranks for his name", "fact"),
    ],
    businesses: [makeItem("Ledgerline", "fact")],
    goals: [makeItem("Close a seed round", "fact"), makeItem("Look credible in investor diligence", "inference")],
    pain_points: [makeItem("No third-party proof", "fact"), makeItem("Past podcasts had no audience", "fact")],
    interests: [makeItem("Fintech", "inference"), makeItem("Startup fundraising", "fact")],
    media_history: [makeItem("Two small niche podcasts", "fact")],
    opportunities_identified: [makeItem("Pre-raise credibility package", "inference")],
    questions_already_asked: [
      makeItem("How far along are you with the raise you mentioned on your profile?", "fact"),
      makeItem("When investors or prospects look you up right now, what actually comes up?", "fact"),
    ],
    communication_style: makeItem("Casual, lowercase, short replies", "inference"),
    current_strategy: "Resolve the podcast/guesting confusion, then rebuild value around the raise",
    service_explained: false,
    service_understanding: 0,
    updated_at: daysAgo(0, 9),
  };

  const maraMemory: LeadMemory = {
    ...emptyMemory(mara),
    relationship_summary:
      makeItem(
      "Luxury interior designer launching a high-ticket course in September. Understands the authority argument and has asked about pricing. Warm, thoughtful, writes in full sentences.",
      "inference",
    ),
    facts_known: [
      makeItem("Course launches in September", "fact"),
      makeItem("High price point", "fact"),
      makeItem("All credibility currently lives on Instagram", "fact"),
    ],
    businesses: [makeItem("Whitfield Studio", "fact")],
    goals: [makeItem("Launch the course", "fact"), makeItem("Justify premium pricing with authority", "fact")],
    pain_points: [makeItem("No third-party credibility", "fact"), makeItem("No search footprint", "fact")],
    interests: [makeItem("Luxury residential design", "fact"), makeItem("Education", "inference")],
    media_history: [makeItem("One local magazine feature", "fact")],
    opportunities_identified: [makeItem("Pre-launch authority runway", "inference")],
    questions_already_asked: [
      makeItem("Are you doing anything with that work beyond Instagram?", "fact"),
      makeItem("Why does it worry you?", "fact"),
    ],
    offers_explained: [makeItem("Explained that this is a professional paid media/authority service", "fact")],
    buying_signals: [makeItem("Asked about price", "fact")],
    timing_constraints: [makeItem("Course launch in September", "fact")],
    communication_style: makeItem("Warm, reflective, full sentences", "inference"),
    current_strategy: "She is close to call-ready; confirm timing pressure and hand to Avo",
    service_explained: true,
    service_explained_at: daysAgo(5, 14),
    service_explained_count: 1,
    service_understanding: 2,
    updated_at: daysAgo(2, 16),
  };

  const niaMemory: LeadMemory = {
    ...emptyMemory(nia),
    relationship_summary: makeItem(
      "Opening sent, no reply yet. Longevity clinic director in London.",
      "inference",
    ),
    businesses: [makeItem("Okafor Longevity", "fact")],
    interests: [makeItem("Longevity medicine", "fact")],
    questions_already_asked: [makeItem("Is the clinic the main focus or are you building around it?", "fact")],
    current_strategy: "Wait for a reply, follow up once if silent",
    updated_at: daysAgo(3, 10),
  };

  const events: (ConversationEvent & { lead_id: string })[] = [
    {
      lead_id: cody,
      event_type: "SERVICE_CONFUSION",
      description: "Asked how long the pod is and what show it is for — believes he is being invited as a guest.",
      importance: 3,
      happened_at: daysAgo(0, 9),
    },
    {
      lead_id: cody,
      event_type: "GOAL_IDENTIFIED",
      description: "Seed round in Q3 is the commercial goal driving urgency.",
      importance: 3,
      happened_at: daysAgo(6, 18),
    },
    {
      lead_id: mara,
      event_type: "BUYING_SIGNAL",
      description: "Asked what working together looks like, then asked about pricing.",
      importance: 3,
      happened_at: daysAgo(8, 12),
    },
  ];

  const credibility: CredibilityAsset[] = [
    {
      id: randomUUID(),
      asset_type: "case_study",
      name: "PLACEHOLDER — replace with a verified case study",
      approved_claim:
        "Placeholder record for local development. Real rows must contain claims verified by the team before the agent may cite them.",
      niches: [],
      industries: [],
    },
  ];

  const chunk = (
    outcome: string,
    tier: ConversationChunk["outcome_tier"],
    stage: string,
    niche: string,
    industry: string,
    setter: string,
    content: string,
    metadata: Record<string, unknown>,
    quality: number,
  ): ConversationChunk => ({
    id: randomUUID(),
    source_conversation_id: null,
    outcome,
    outcome_tier: tier,
    stage,
    niche,
    industry,
    setter_name: setter,
    content,
    metadata,
    quality_score: quality,
    similarity: null,
  });

  const chunks: ConversationChunk[] = [
    chunk(
      "📞 Onboarding Call", "A", "VALUE_BUILDING", "Founder / fundraising", "Fintech", "Cassey",
      "Prospect was raising and had no search footprint. Setter tied written media and search presence directly to investor diligence instead of talking about exposure. Prospect asked what it costs, setter said Avo handles the numbers on the call, and the call was booked and later onboarded.",
      { angle: "diligence credibility", worked: "linked media to the raise, not to reach", service_confusion: false }, 5,
    ),
    chunk(
      "📞 Onboarding Call", "A", "SERVICE_CONFUSION", "Coaching / course launch", "Coaching", "Cassey",
      "Prospect assumed she was being invited onto a podcast. Setter clarified plainly that this is a media and authority service the client works with us on, not a guest invitation, then immediately re-anchored on her launch. She said 'oh that makes more sense' and the conversation continued to a booked call.",
      { angle: "clarify then re-anchor", worked: "clarified without apologising", service_confusion: true }, 5,
    ),
    chunk(
      "📞 Discovery Call", "B", "VALUE_BUILDING", "Luxury services", "Interior design", "William",
      "Setter built value around a specific upcoming launch with a fixed date, which created natural urgency without pressure. Booked a discovery call the same week and the prospect attended.",
      { angle: "deadline-driven authority", worked: "used the prospect's own timeline", service_confusion: false }, 4,
    ),
    chunk(
      "❌ Not Interested", "F", "SERVICE_CONFUSION", "Fintech", "Fintech", "William",
      "Prospect asked how long the podcast was. Setter answered the question literally with an episode length and kept selling the call. Prospect replied 'I don't pay to be on podcasts' and disengaged. The confusion was never actually resolved.",
      { failure: "answered the surface question instead of correcting the premise", service_confusion: true }, 1,
    ),
    chunk(
      "❌ Not Interested", "F", "INTEREST", "Health / clinic", "Health", "Jack",
      "Setter pushed a call after a single positive reply, before any commercial goal was established. Prospect went quiet, then said it was not a priority.",
      { failure: "booked on politeness, not on a qualified goal", service_confusion: false }, 1,
    ),
    chunk(
      "⚫ No show", "E", "CALL_READY", "Founder / fundraising", "Fintech", "William",
      "Prospect agreed to a call quickly but had never articulated what he was trying to achieve. He accepted the slot to be polite and did not attend.",
      { failure: "agreement without a stated commercial goal predicts a no show", service_confusion: false }, 1,
    ),
  ];

  return {
    leads,
    messages,
    memories: [codyMemory, maraMemory, niaMemory],
    events,
    credibility,
    chunks,
    suggestions: [],
    source_conversations: [],
    setter_preferences: [],
    coaching_examples: [],
  };
}
