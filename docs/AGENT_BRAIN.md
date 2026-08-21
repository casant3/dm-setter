# The agent brain

How the setter decides what to say, and why each safeguard exists.

## Pipeline

```
lead context (profile + long-term memory + bounded recent window + events)
      ↓
deterministic reading of the conversation    ← dialogue ledger, motivation, temperature,
                                               brush-off, per-dimension evidence, booking
      ↓
strategist (GPT-5.6)                         ← proposes qualification + objective
      ↓
evidence reconciliation                      ← scores capped at what the thread supports
      ↓
deterministic qualification gate             ← code, not the model, decides call-readiness
      ↓
message plan                                 ← the one move this DM makes, and what
                                               happens after each possible reply
      ↓
retrieval + credibility + coaching layer     ← winners, failures, voice, Cassey's rules
      ↓
reply writer (GPT-5.6)
      ↓
deterministic audit of the draft             ← repeats, framing, length, one-move
      ↓
reviewer (GPT-5.6, 24-point checklist + the audit findings)
      ↓
deterministic audit of the rewrite           ← an approval cannot survive a violation
      ↓
one exact DM
      ↓
human: used / edited / rejected
      ↓
message persisted → memory advances (deterministic + model extraction)
                  → an edit becomes a proposed coaching rule
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

**The narrative fields are interpretations.** `relationship_summary` and
`communication_style` are written by the model, not said by the prospect, so they
carry provenance like everything else and are always stored as `inference`. A
quote that verifies against the real messages raises the confidence and records
where it came from; it never promotes the reading to a fact. Context renders them
labelled, with an explicit instruction not to repeat them back as fact and not to
count them as qualification evidence. "Prospect trusts Cassey" cannot become a
durable fact on the strength of a polite reply. A person who corrects one stores
it as `human` / `verified`, and automatic extraction then leaves it alone.

**Extraction is incremental.** `buildExtractionInput` sends only the messages
since the last run, a short window of context so those messages can still be
interpreted, and a list of what is already remembered so the same facts are not
proposed twice. With nothing new, the model is not called at all. Each run
reports what happened — messages considered, items proposed, quotes verified as
facts, inferences kept, duplicates ignored, fields skipped because a human had
corrected them — as counts only; no remembered text ever reaches the log.

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

## Reading the conversation

Six deterministic assessments run before the model sees anything. Each is
computed from the messages themselves, so the model is told what happened rather
than asked to remember it.

**Dialogue ledger** (`src/core/dialogue-state.ts`). Ten topics, each tracked as
asked / answered by *meaning* rather than wording. "What are you focused on
growing?" and "what's the main thing you're building?" are the same question, and
a prospect who answered either has answered both. Long-term memory closes a topic
too, so a fact stated months ago still counts. `do_not_ask` is the result, and
the audit enforces it.

**Motivation** (`src/core/motivation.ts`). Eighteen frames. A commercial goal is
whatever someone is working toward — patients properly informed, a mission
advanced, a round raised — and a non-commercial frame outranks a commercial one
when both appear, because money-framing a mission-driven prospect costs far more
than the reverse.

**Temperature** (`src/core/temperature.ts`). How they are actually engaging,
weighted toward their latest message, so a lead that has cooled is followed down
instead of pushed through.

**Brush-offs** (`src/core/brush-off.ts`). "I'm good thanks" from someone who never
learned what this is has declined a vague approach: one clarification is allowed,
once, and the allowance cannot be re-spent. The same words from someone who
understands the offer are a real no. A deferral is a timing objection, not a
rejection.

**Qualification evidence** (`src/core/qualification-evidence.ts`). Every
dimension is rebuilt from the thread, the profile and memory, with the quotes
behind it. Two independent sources score 2, one scores 1, nothing scores 0. The
strategist's score is capped at that — it may exceed it by one point only by
quoting the conversation, and the quote is verified verbatim before it counts.
`service_understanding` gets no benefit of the doubt at all.

**Booking** (`src/core/booking.ts`). Six states rather than two, read backwards
from the furthest reached, so a conversation that has already had slots offered
is never sent another pitch for a call.

## Booking is one move, and no-show risk is advice

Once the gate opens, the call and the times go in the same message. "Would you
like a call?" → "yes" → "here are two times" spends a whole turn collecting an
answer we already had, and that turn is where bookings are lost. The plan carries
two concrete slots — next working days, never today, never a weekend, never more
than a week out — and the audit rejects a draft that asks what day suits instead
of naming them. A timezone is only ever one the prospect stated or a human
recorded on the lead; where we do not know it, the prompt says so rather than
guessing, because an invite an hour out is the same thing as not turning up.

Once a time is picked, the only thing left is the email and the invite:
re-proposing the call at that point is an audit violation, not a matter of the
writer remembering.

Nearly half the bookings in the historical corpus were never honoured, and
`assessNoShowRisk` still scores that risk from what separated the honoured from
the unhonoured: no evidence they understood what the call was for, no goal of
their own, no acknowledged gap, a booking agreed in three messages, never having
asked us anything.

That score is **advisory**. It shapes how explicitly the purpose is framed, which
times are offered, how much commitment is asked for and how the follow-up is
handled. It is not a second gate. An earlier version let it forbid `offer_call`
outright, which meant a prospect who cleared all six dimensions, understood the
service and asked for the price could still be refused a call because their
replies were short. Qualification decides *whether*; risk decides *how*.

## One move per message

`src/core/message-plan.ts` picks the single move a DM makes, in a fixed order of
precedence: an explicit no outranks a wrong premise, a wrong premise outranks
discovery, discovery outranks a pitch, and nothing outranks the gate. Each plan
carries what reply it is trying to provoke and what happens if they engage, push
back or go quiet — a message with no forward path is a statement, which is what
the operator kept rejecting.

`src/core/audit.ts` then checks the draft against everything code can decide:
re-asking an answered topic, money framing at someone not motivated by money,
two questions, a question plus a call proposal, length and voice. The findings go
to the reviewer as facts to clear, and the same audit runs again on the rewrite,
so an approval cannot survive a violation it reintroduced.

## Service confusion vs commercial clarity

Two different problems that were previously one.

- **SERVICE_CONFUSION** is a wrong model of *what this is*: a podcast booking, a
  guest spot, a free collab. It closes the gate and the right move is to correct
  the premise.
- **"How much do you charge?"** is a buying question and strong evidence of
  understanding — you do not ask the price of something you think is free.
- **"Is there a cost?"** depends on context: a buying question once the service
  has been explained, and a sign *we* were unclear if it has not. That needs one
  plain sentence about the commercial model, not a premise correction, and it
  caps understanding rather than zeroing it.

## The coaching layer

`src/core/coaching.ts` carries the operator's own instructions, in a strict
precedence: an explicit rule beats an approved example, which beats a message
Cassey actually sent, which beats a historical one, which beats team strategy,
which beats the general prompt. The order is stated in the prompt so the model
knows which source wins when two disagree.

**Retrieval is contextual.** Dumping every approved rule and example into every
prompt buries whichever one mattered, and advice about building value before a
call is exactly wrong in the message that books one. Examples are ranked against
the situation — the move, the temperature, the booking state, the brush-off, the
motivation frame, whether the service is still misunderstood — with tags doing
most of the work and an explicit `applies_when` scope overriding them. At most
four reach the prompt, each carrying why it was selected. Explicit rules stay
global unless the operator scoped them to a stage.

**Live edits.** Every edit to a suggestion is read for what it appears to mean
and proposed as a rule: not only structural changes (shorter, question removed,
CTA added) but also praise cut, an intro dropped, money framing removed or added,
a CTA softened or hardened, credibility added, service clarity added, a statement
turned into a question. Proposals are inert. They sit in a review queue with the
before-and-after they were inferred from and can be reworded on approval, because
an inferred rule is a guess about what an edit meant.

**ChatGPT imports** (`src/core/chatgpt-import.ts`). An export is a tree, not a
list: regenerated answers and edited prompts create branches, and reading
`mapping` in file order can pair a criticism with a draft the operator never saw.
Paths are reconstructed from parent/child links, ordered by `create_time`, with
the `current_node` path marked active and every branch kept separate.

The unit worth importing is the whole correction chain — draft, criticism, next
draft, criticism, and eventually something approved. Assistant messages are not
approved examples: in a real coaching history most of them are the ones that were
rejected, so only an explicit approval sets an approved reply, and the API
refuses to approve a candidate that carries no wording to follow.

Criticism is read into tags — `too_long`, `already_answered`, `premature_cta`,
`money_frame_wrong`, `gave_up_too_early` and the rest — by deterministic patterns
for the phrasings the operator actually uses. Anything short and unexplained is
flagged as needing model judgement rather than guessed at, and a model may only
fill in a reading the patterns could not produce. Everything imported is
`pending_review`.

## Research facts

What we found out by looking someone up lives in `research_facts`, tagged with
its own provenance and source, and is never mixed with what they told us. Only
facts a person has verified may be referenced, and then only as something we
noticed publicly — never as something they said, never more than one, and never
in a way that sounds like research. No research fact counts as qualification
evidence.

## What the model cannot override

Deterministic code owns:

- the call gate;
- service understanding (evidence-derived) and the confusion / commercial-clarity split;
- per-dimension qualification evidence, and the cap on every score;
- verbatim verification of any quote the model offers as evidence;
- what has already been asked and answered;
- motivation frame, relationship temperature and brush-off classification;
- which single move the next message makes, and what is forbidden right now;
- booking state, the concrete times offered, and the fact that no-show risk
  cannot block a qualified call;
- the audit of the draft and of the rewrite;
- outcome tiers and example bucketing;
- credibility selection;
- which transcripts are eligible for retrieval;
- which coaching material is in force, and which of it is relevant here;
- that an imported draft nobody approved never becomes an approved example.

The model proposes; these decide.

## What remains model judgement

Deliberately, because no amount of pattern matching does these well:

- the strategic narrative — *why* this lead is where it is, and what would move it;
- the wording of the message, within the plan and the style rules;
- the reviewer's judgement on substance: whether the value is specific to this
  person, whether it sounds human, whether it is subtly pushy;
- rich memory extraction — what is worth remembering months from now (every item
  is still quote-checked before it is recorded as fact, and the narrative fields
  are always stored as inferences);
- reading an ambiguous piece of operator feedback that no deterministic pattern
  explains — and even then it can only fill a gap, never overturn a pattern, and
  every tag it offers must be one of the known tags;
- transcription of historical screenshots (a person verifies every transcript
  before it can influence a suggestion).

Where model judgement and deterministic code disagree, the code wins: the model
cannot open the gate, raise a dimension above its evidence, propose a call that
is forbidden, or approve a message that fails the audit.
