# The agent brain

How the setter decides what to say, and why each safeguard exists.

## Pipeline

```
lead context (profile + long-term memory + bounded recent window + events)
      ↓
strategist (GPT-5.6)                         ← proposes qualification + objective
      ↓
evidence reconciliation                      ← the prospect's own words overrule the model
      ↓
deterministic qualification gate             ← code, not the model, decides call-readiness
      ↓
retrieval + credibility ranking              ← winners, partial wins, failures, voice
      ↓
reply writer (GPT-5.6)
      ↓
reviewer (GPT-5.6, 18-point checklist)
      ↓
one exact DM
      ↓
human: used / edited / rejected
      ↓
message persisted → long-term memory advances → feedback becomes analytics
```

Retrieval runs *after* the strategy pass on purpose: the objective is part of the
retrieval query, and a lead we may not act on never costs an embedding.

## The qualification gate

`src/core/gate.ts`. Six dimensions, each 0–2:

| Dimension | Zero means |
| --- | --- |
| `fit` | We don't yet know this is the right kind of prospect |
| `commercial_goal` | Nothing for the service to attach to |
| `media_gap` | There is no problem to solve |
| `value_established` | They have no reason to take a call |
| `service_understanding` | They haven't shown they know this is paid |
| `interest_signal` | They haven't indicated they want this |

A call requires **every dimension above zero**, **total ≥ 9/12**, and **no
unresolved SERVICE_CONFUSION**. A high total can never compensate for a zero:
2/2/0/2/2/2 scores 10 and is still blocked, because a prospect with no identified
media gap has nothing to buy.

The gate is deterministic code. When the model says call-ready and the gate
disagrees, the gate wins and the UI shows that it overruled the model.

## service_explained vs service_understanding

These are different things and conflating them is how prospects get booked while
still believing they were invited onto a podcast.

- **`service_explained`** — an action *we* took. Set when we send an explanation.
- **`service_understanding`** — a state of the *prospect*, scored 0–2 **only**
  from their own messages (`src/core/understanding.ts`).

Strong evidence: asking about pricing, scope or process; referring to us helping
clients; engaging with written media, syndication or search presence; explicitly
distinguishing this from a guest invitation.

Not evidence: "cool", "sure", "sounds good", "ok". Acknowledging an explanation
proves nothing.

Confusion collapses understanding to 0 *while it stands unanswered*. If the
prospect asks "how long is the pod?" after previously engaging well, the gate
re-closes. If they then ask about pricing, the confusion is treated as resolved.

The pipeline takes `min(model score, evidenced score)`, so model optimism can
never open the gate.

## Long-term memory

`src/core/memory.ts`. Every remembered item carries provenance:

```json
{ "value": "SkyMD", "provenance": "fact", "confidence": 0.9,
  "source_message_id": "…", "quote": "I run SkyMD and FitProtection.",
  "recorded_at": "…", "verified": false }
```

- `fact` — quoted from the prospect.
- `inference` — the model's reading, labelled as such in context.
- `human` — a correction someone made; always confidence 1 and `verified`.

Updates are incremental and additive. Fields listed in `verified_fields` are
skipped entirely by automatic updates, so a human correction is never overwritten
by a weaker guess.

Memory is what makes the product promise work: a fact stated once, forty messages
ago, still reaches the model even though the recent window holds only 16 messages.

## Historical outcome tiers

`src/core/outcomes.ts`. A booked call is not evidence of a good conversation.

| Tier | Meaning | Class |
| --- | --- | --- |
| A | Onboarded / closed | strong winner |
| B | Qualified discovery that showed or progressed | partial win |
| C | Discovery booked, downstream unknown | neutral |
| D | Nurture / follow-up / info packet | neutral |
| E | No show | failure |
| F | Not interested | failure |

Tiers are derived from real Trello card movement, not from where a card sits. A
Discovery that later moved to No Show is Tier E with `booking_not_honoured` set.

In the supplied corpus, **32 of 67 bookings (48%) were not honoured downstream** —
which is precisely why raw bookings are not treated as winners.

## Retrieval

`src/core/retrieval.ts`. Semantic similarity is reranked on outcome tier, niche,
industry, stage, next objective, SERVICE_CONFUSION state, objection type,
qualification shape and media experience.

Results are bucketed and labelled:

- **similar_strong_winners** — learn strategy from these.
- **similar_partial_wins** — the call happened but didn't clearly convert.
- **similar_failures** — explicitly labelled as what *not* to repeat.

Failures are retrieved deliberately, including when they are the most similar
examples. Each failure chunk is rendered with a warning header, so it cannot read
as a template.

## Cassey's voice vs the team's strategy

`voice_examples` are drawn only from the configured setter (`SETTER_VOICE`,
default Cassey) and never from a failure. Strategy may come from any setter's
winning conversations; phrasing, length and rhythm come only from the voice
bucket.

**Constraint worth knowing:** in the supplied corpus only **3 of 67**
conversations are attributed to Cassey (William 26, Jack 14, 12 unattributed).
Voice learning has a thin base. The separation is implemented and tested, but it
will be weak until more Cassey conversations are verified.

## Credibility

`src/core/credibility.ts` ranks approved assets against the prospect's industry,
niche, goal and gap, and returns at most five. When nothing is relevant it
returns **nothing**, and the context tells the writer to cite nothing rather than
reach for an unrelated proof point. Assets only ever come from the verified
`credibility_assets` table.

## What the model cannot override

Deterministic code owns:

- the call gate;
- service understanding (evidence-derived);
- SERVICE_CONFUSION detection;
- outcome tiers and example bucketing;
- credibility selection;
- which transcripts are eligible for retrieval.

The model proposes; these decide.
