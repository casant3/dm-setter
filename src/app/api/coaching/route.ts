import { getStore } from "@/lib/store";
import { fail, handleError, ok, readJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Body = {
  kind: "rule" | "example";
  applies_when?: Record<string, string[]> | null;
  rule?: string;
  applies_to?: string | null;
  priority?: number;
  situation?: string;
  prospect_message?: string | null;
  approved_reply?: string;
  why?: string | null;
  tags?: string[];
};

/** Everything in the coaching layer, including proposals awaiting review. */
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const store = getStore();
    const [preferences, examples] = await Promise.all([
      store.listSetterPreferences(),
      store.listCoachingExamples(),
    ]);
    return ok({
      preferences,
      examples,
      pending: preferences.filter((p) => p.status === "pending_review").length +
        examples.filter((e) => e.status === "pending_review").length,
    });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Adds a rule or example typed by a human.
 *
 * Typed by hand means approved by definition — the person writing it is the
 * person whose judgement the layer exists to carry.
 */
export async function POST(request: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const body = await readJson<Body>(request);
    const store = getStore();
    const setter = process.env.SETTER_VOICE || "Cassey";
    const now = new Date().toISOString();

    if (body.kind === "rule") {
      const rule = body.rule?.trim();
      if (!rule) return fail("A rule is required");
      return ok({
        preference: await store.createSetterPreference({
          setter_name: setter,
          rule,
          applies_to: body.applies_to?.trim() || null,
          source: "human",
          status: "active",
          priority: Number.isFinite(body.priority) ? Number(body.priority) : 0,
          evidence: null,
          approved_at: now,
        }),
      });
    }

    if (body.kind === "example") {
      const reply = body.approved_reply?.trim();
      const situation = body.situation?.trim();
      if (!reply || !situation) return fail("A situation and the approved reply are both required");
      return ok({
        example: await store.createCoachingExample({
          setter_name: setter,
          kind: "good_example",
          situation,
          prospect_message: body.prospect_message?.trim() || null,
          rejected_reply: null,
          operator_feedback: null,
          approved_reply: reply,
          revisions: [],
          why: body.why?.trim() || null,
          source: "human",
          status: "approved",
          tags: body.tags ?? [],
          applies_when: body.applies_when ?? null,
          approved_at: now,
        }),
      });
    }

    return fail("kind must be 'rule' or 'example'");
  } catch (error) {
    return handleError(error);
  }
}
