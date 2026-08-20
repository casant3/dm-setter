import type { GateResult, Qualification, Strategy } from "@/lib/types";

/**
 * The deterministic call gate.
 *
 * A call is recommended only when EVERY qualification dimension has been
 * established. A high total must never compensate for a dimension that is
 * completely absent: a prospect with no identified media gap has nothing to buy,
 * and a prospect with no interest signal has not asked to be sold to, however
 * well they score elsewhere.
 */

export const REQUIRED_TOTAL = 9;
export const MAX_TOTAL = 12;

export const DIMENSION_LABELS: Record<keyof Qualification, string> = {
  fit: "Fit",
  commercial_goal: "Commercial or authority goal",
  media_gap: "Media/authority gap",
  value_established: "Value established for their goal",
  service_understanding: "Understands this is a paid professional service",
  interest_signal: "Interest signal",
};

/** Why a zero on each dimension is disqualifying, phrased for the copilot panel. */
const ZERO_BLOCKERS: Record<keyof Qualification, string> = {
  fit: "No established fit — we do not yet know this is the right kind of prospect",
  commercial_goal: "No commercial or authority goal — nothing for the service to attach to",
  media_gap: "No identified media/authority gap — there is no problem to solve yet",
  value_established: "No value established for their goal — they have no reason to take a call",
  service_understanding: "Prospect has not shown they understand this is a paid professional service",
  interest_signal: "No interest signal — they have not indicated they want this",
};

export const QUALIFICATION_DIMENSIONS = Object.keys(DIMENSION_LABELS) as (keyof Qualification)[];

export function totalScore(q: Qualification): number {
  return QUALIFICATION_DIMENSIONS.reduce((sum, key) => sum + (q[key] ?? 0), 0);
}

/**
 * Evaluates the hard gate. Every blocker is reported, not just the first, so the
 * setter can see everything standing between this lead and a justified call.
 */
export function evaluateGate(strategy: Strategy): GateResult {
  const q = strategy.qualification;
  const blockers: string[] = [];
  const missing_dimensions: (keyof Qualification)[] = [];

  for (const key of QUALIFICATION_DIMENSIONS) {
    if ((q[key] ?? 0) <= 0) {
      blockers.push(ZERO_BLOCKERS[key]);
      missing_dimensions.push(key);
    }
  }

  const total = totalScore(q);
  if (total < REQUIRED_TOTAL) {
    blockers.push(`Qualification total ${total}/${MAX_TOTAL} is below the ${REQUIRED_TOTAL} needed`);
  }

  if (strategy.service_confusion) {
    blockers.push(
      strategy.confusion_reason
        ? `SERVICE_CONFUSION is unresolved: ${strategy.confusion_reason}`
        : "SERVICE_CONFUSION is unresolved",
    );
  }

  return {
    passed: blockers.length === 0,
    blockers,
    missing_dimensions,
    total_score: total,
    model_said_call_ready: strategy.call_ready,
  };
}
