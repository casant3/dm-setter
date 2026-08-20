import { TIER_EVIDENCE, type EvidenceClass, type OutcomeTier } from "@/lib/types";

/**
 * Maps Trello list names and downstream movement onto outcome tiers.
 *
 * The central rule, learned from the real corpus: a booked Discovery call is not
 * by itself a win. Some bookings happened before the prospect understood the
 * offer and later became No Show or Not Interested. Where the board tells us what
 * happened after the booking, that trajectory decides the tier.
 */

export const LIST_ONBOARDING = "📞 Onboarding Call";
export const LIST_DISCOVERY = "📞 Discovery Call";
export const LIST_CLOSED = "🤝 Closed Clients";
export const LIST_NOT_INTERESTED = "❌ Not Interested";
export const LIST_NO_SHOW = "⚫ No show";
export const LIST_NURTURING = "Nurturing Process (2-4 weeks)";
export const LIST_FOLLOWUP = "🕒 Future follow-up";
export const LIST_INFO_PACKET = "Info Packet Sent (If prospect asks)";

/** Rank used to decide whether a move was progress or a regression. */
const PROGRESSION_RANK: Record<string, number> = {
  "🧊 New leads (Cold)": 0,
  "🎯 New Leads (Warm)": 1,
  [LIST_INFO_PACKET]: 2,
  [LIST_NURTURING]: 2,
  [LIST_FOLLOWUP]: 2,
  [LIST_DISCOVERY]: 3,
  [LIST_ONBOARDING]: 4,
  [LIST_CLOSED]: 5,
  [LIST_NO_SHOW]: -1,
  [LIST_NOT_INTERESTED]: -2,
};

export type OutcomeMove = { from: string; to: string; at: string };

export type TierAssessment = {
  tier: OutcomeTier;
  evidence_class: EvidenceClass;
  /** Plain-English justification, stored so a human can audit the call. */
  rationale: string;
  /** True when a booking was later contradicted by the downstream result. */
  booking_not_honoured: boolean;
};

function normalizeList(name: string): string {
  return name.trim();
}

/**
 * Decides the tier for one historical conversation.
 *
 * `finalList` is where the card sits now; `history` is its movement trail,
 * oldest first. History is what lets us separate "booked and progressed" from
 * "booked and evaporated".
 */
export function assessOutcome(finalList: string, history: OutcomeMove[] = []): TierAssessment {
  const list = normalizeList(finalList);
  const everBookedCall = list === LIST_DISCOVERY || history.some((m) => normalizeList(m.to) === LIST_DISCOVERY || normalizeList(m.from) === LIST_DISCOVERY);

  if (list === LIST_CLOSED || list === LIST_ONBOARDING) {
    const viaDiscovery = everBookedCall;
    return {
      tier: "A",
      evidence_class: TIER_EVIDENCE.A,
      rationale: viaDiscovery
        ? "Progressed through discovery to onboarding/closed — the strongest available evidence."
        : "Reached onboarding/closed.",
      booking_not_honoured: false,
    };
  }

  if (list === LIST_NO_SHOW) {
    return {
      tier: "E",
      evidence_class: TIER_EVIDENCE.E,
      rationale: everBookedCall
        ? "Booked a call and did not attend — agreement without real commitment."
        : "Did not attend.",
      booking_not_honoured: everBookedCall,
    };
  }

  if (list === LIST_NOT_INTERESTED) {
    return {
      tier: "F",
      evidence_class: TIER_EVIDENCE.F,
      rationale: everBookedCall
        ? "Booked a call and then declined — the booking was not real interest."
        : "Declined.",
      booking_not_honoured: everBookedCall,
    };
  }

  if (list === LIST_DISCOVERY) {
    // Sitting in Discovery with no onward movement: booked, outcome unknown.
    return {
      tier: "C",
      evidence_class: TIER_EVIDENCE.C,
      rationale: "Discovery booked; no downstream outcome recorded yet, so this is not treated as a win.",
      booking_not_honoured: false,
    };
  }

  if (list === LIST_NURTURING || list === LIST_FOLLOWUP || list === LIST_INFO_PACKET) {
    // A prospect who reached Discovery and then fell back to nurture/follow-up is
    // weak evidence at best: the call did not carry the relationship forward.
    if (everBookedCall) {
      return {
        tier: "D",
        evidence_class: TIER_EVIDENCE.D,
        rationale: "Booked a call but slid back to nurture/follow-up — the booking did not hold.",
        booking_not_honoured: true,
      };
    }
    return {
      tier: "D",
      evidence_class: TIER_EVIDENCE.D,
      rationale: "In nurture, follow-up or info-packet state; no call yet.",
      booking_not_honoured: false,
    };
  }

  return {
    tier: "D",
    evidence_class: TIER_EVIDENCE.D,
    rationale: `Unmapped list ${list || "(none)"} — treated as neutral rather than assumed positive.`,
    booking_not_honoured: false,
  };
}

/**
 * Promotes a Tier C booking to Tier B when independent signals show the call was
 * qualified and actually happened.
 */
export function promoteWithSignals(
  base: TierAssessment,
  signals: { showed?: boolean | null; qualified?: boolean | null; closed?: boolean | null; progressed?: boolean | null },
): TierAssessment {
  if (base.tier !== "C") return base;
  if (signals.closed) {
    return { ...base, tier: "A", evidence_class: TIER_EVIDENCE.A, rationale: "Discovery booked and later closed." };
  }
  if (signals.showed || signals.qualified || signals.progressed) {
    const why = [
      signals.showed ? "attended" : null,
      signals.qualified ? "was qualified" : null,
      signals.progressed ? "progressed" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    return { ...base, tier: "B", evidence_class: TIER_EVIDENCE.B, rationale: `Discovery booked and the prospect ${why}.` };
  }
  return base;
}

/** Weight applied during retrieval ranking. Failures keep real weight — they teach. */
export const TIER_WEIGHT: Record<OutcomeTier, number> = {
  A: 1.0,
  B: 0.75,
  C: 0.35,
  D: 0.2,
  E: 0.55,
  F: 0.6,
};

export function isPositiveTier(tier: OutcomeTier): boolean {
  return tier === "A" || tier === "B";
}

export function isNegativeTier(tier: OutcomeTier): boolean {
  return tier === "E" || tier === "F";
}
