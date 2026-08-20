import { TOPIC_LABELS, draftRepeatsAnsweredTopic, type DialogueState } from "@/core/dialogue-state";
import { auditMoves, type MessagePlan } from "@/core/message-plan";
import { draftMisframesMotivation, type MotivationAssessment } from "@/core/motivation";
import { assessStyle } from "@/core/style";

/**
 * The deterministic audit of a proposed DM.
 *
 * Everything here is a check the model cannot be trusted to run on itself: it
 * cannot reliably remember what the prospect already answered, it cannot judge
 * its own length, and it will happily ask two questions while proposing a call.
 * The audit runs on the draft — so the reviewer is told exactly what to fix —
 * and again on the reviewer's final reply, so a rewrite cannot smuggle the same
 * fault back in.
 */

export type AuditViolation = {
  rule: string;
  detail: string;
  severity: "hard" | "soft";
};

export type DraftAudit = {
  violations: AuditViolation[];
  /** False when a hard violation is present. */
  ok: boolean;
  words: number;
  questions: number;
};

export type AuditInput = {
  dialogue: DialogueState;
  motivation: MotivationAssessment;
  plan: MessagePlan;
};

export function auditDraft(draft: string, input: AuditInput): DraftAudit {
  const violations: AuditViolation[] = [];

  const repeated = draftRepeatsAnsweredTopic(draft, input.dialogue);
  if (repeated) {
    violations.push({
      rule: "already_answered",
      detail: `Asks again about "${TOPIC_LABELS[repeated]}". They already answered: "${input.dialogue.topics[repeated].answer_quote}"`,
      severity: "hard",
    });
  }

  if (draftMisframesMotivation(draft, input.motivation)) {
    violations.push({
      rule: "wrong_frame",
      detail: `Money framing at someone motivated by ${input.motivation.primary}. Talk about ${input.motivation.guidance} instead.`,
      severity: "hard",
    });
  }

  const style = assessStyle(draft);
  for (const v of style.violations) violations.push({ rule: `style.${v.rule}`, detail: v.detail, severity: v.severity });

  for (const detail of auditMoves(draft, input.plan).violations) {
    violations.push({ rule: "one_move", detail, severity: "hard" });
  }

  return {
    violations,
    ok: violations.every((v) => v.severity !== "hard"),
    words: style.words,
    questions: style.questions,
  };
}

/** The audit as an instruction block for the reviewer. */
export function auditForReviewer(audit: DraftAudit): string {
  if (audit.violations.length === 0) return "DETERMINISTIC AUDIT\nNo violations found. Judge the draft on substance.";
  const lines = audit.violations.map((v) => `- [${v.severity}] ${v.rule}: ${v.detail}`);
  return `DETERMINISTIC AUDIT — these were found in the draft by code, not judgement. Every one of them must be gone from final_reply:\n${lines.join("\n")}`;
}
