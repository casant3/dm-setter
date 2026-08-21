import type { LeadContext } from "@/core/context";
import type { ExtractedMemory } from "@/core/memory-extract";
import type { Review, Strategy } from "@/lib/types";

/** The three passes of the setter pipeline, behind one interface. */
export interface SetterLlm {
  readonly engine: "openai" | "offline";
  strategy(ctx: LeadContext, contextJson: string): Promise<Strategy>;
  reply(ctx: LeadContext, contextJson: string, strategy: Strategy): Promise<string>;
  /** `audit` is the deterministic finding list the reviewer must clear. */
  review(ctx: LeadContext, contextJson: string, strategy: Strategy, draft: string, audit: string): Promise<Review>;
  /**
   * Optional fourth pass: durable memory extraction after an exchange really
   * happened. Absent on the offline stand-in, which has no judgement to add.
   *
   * `transcript` is only the new part of the conversation; `alreadyKnown` is
   * what is already remembered, so the same facts are not re-derived every time.
   */
  extractMemory?(transcript: string, alreadyKnown?: string): Promise<ExtractedMemory>;
}
