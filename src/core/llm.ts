import type { LeadContext } from "@/core/context";
import type { Review, Strategy } from "@/lib/types";

/** The three passes of the setter pipeline, behind one interface. */
export interface SetterLlm {
  readonly engine: "openai" | "offline";
  strategy(ctx: LeadContext, contextJson: string): Promise<Strategy>;
  reply(ctx: LeadContext, contextJson: string, strategy: Strategy): Promise<string>;
  /** `audit` is the deterministic finding list the reviewer must clear. */
  review(ctx: LeadContext, contextJson: string, strategy: Strategy, draft: string, audit: string): Promise<Review>;
}
