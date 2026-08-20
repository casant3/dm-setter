# DM Setter Agent

A permanent-memory Instagram DM appointment-setting agent powered by OpenAI, with Supabase/Postgres as the source of truth — now with a three-column web workspace on top of the original agent core.

## Core behaviour

- Qualifies before booking.
- Optimizes for qualified downstream conversion, not raw call count.
- Builds value around a real commercial/authority goal.
- Makes clear this is a professional paid media/authority service, not free podcast networking.
- Uses big-name client/media proof only from an approved credibility table.
- Detects and resolves SERVICE_CONFUSION before booking.
- Uses Avo as the director/closer only when the lead is call-ready.
- Retrieves both similar winners and similar failures.
- Gives each lead permanent memory plus a short recent-message working context.
- Stores every AI suggestion and later user edits/outcomes for a feedback loop.
- Tracks what has already been asked and answered *semantically*, so a question is never repeated in different words.
- Makes exactly one move per message, with a defined next step for a yes, a no and silence.
- Distinguishes a wrong premise about the service from a straightforward question about price.
- Reads brush-offs, timing objections and real rejections differently, and stops when it should.
- Carries the operator's own rules, which outrank everything the agent has learned.

## Architecture

```
Leads sidebar ─┐
Conversation  ─┼─► API routes ─► agent core ─► strategy pass ─► hard gate ─► reply writer ─► reviewer ─► exact DM
AI copilot    ─┘                     │              │
                                     │              └─ winner / failure retrieval (pgvector)
                                     └─ Supabase memory (leads, messages, lead_memories, events, credibility)
```

The three model passes are unchanged from V1 — strategist, writer, reviewer — but they are now surrounded by deterministic reading and enforcement: the conversation is analysed in code before the model sees it, and every draft is audited in code before and after the reviewer. What is new is that the persistence layer and the model layer are now interfaces, so the same core drives the CLI, the web app, and the tests.

- `src/core/` — the agent. `prompts.ts` and `schemas.ts` are byte-identical to V1.
- `src/lib/store/` — `Store` interface, Supabase implementation, local dev implementation.
- `src/app/` — Next.js App Router pages and API routes.
- `src/components/` — the three-column UI.

### The hard gate

The model proposes; a deterministic gate disposes. `evaluateGate()` blocks a call
unless **all six** qualification dimensions are above zero, the total is at least
9/12, and there is no unresolved SERVICE_CONFUSION. A high total never
compensates for a missing dimension. When the model wants to book and the gate
disagrees, the gate wins and the copilot says so.

See [`docs/AGENT_BRAIN.md`](docs/AGENT_BRAIN.md) for the full design.

## The workspace

**Leads sidebar** — search, filters for *needs reply*, *follow-up due* and *high priority*, and a sort that floats threads waiting on you to the top. Each row shows priority, follow-up state and conversation stage.

**Conversation** — the full thread with the lead's goal and media gap in the header, inline priority / follow-up status / due-date controls, and a composer for logging messages from either side.

**AI copilot** — one run of the pipeline produces:

- the exact DM to send, editable in place;
- a SERVICE_CONFUSION banner when the prospect thinks this is a guest invitation;
- call-ready or not, with the specific gate blockers;
- the six qualification scores and the total;
- the next objective and what is still missing;
- what the reviewer caught in the draft;
- similar winners and similar failures retrieved from past conversations;
- the suggestion history for this lead, with the feedback given.

**Feedback** — every suggestion is stored. *Use as-is*, *Send edited* and *Reject* record which happened; accepting appends the message that was actually sent to the thread, so the store learns the gap between what the agent proposed and what a human sent.

**Memory advances on send** — accepting a suggestion updates `lead_memories`: the questions the DM just asked are recorded so they are never asked twice, explaining the service is logged, the Avo CTA is logged once the gate opens, and `service_understanding` ratchets up as the model gets explained. Fresh SERVICE_CONFUSION resets that score to zero, which re-closes the call gate — so a prospect who reveals late that they thought this was a guest spot cannot stay call-ready.

**Adding leads and importing DMs** — new leads need only a handle. Existing threads can be pasted in: the parser handles `Me:` / `Them:` style, `@handle:` labels, leading timestamps, and Instagram's export format where the sender sits on its own line. Unrecognised speaker labels are surfaced in a preview so they can be mapped before anything is written.

## Setup

1. Create/use a Supabase project.
2. Run `supabase/schema.sql`, then `supabase/migrations/002_web_app.sql`, then
   `supabase/migrations/003_agent_brain.sql`, `supabase/migrations/004_coaching.sql`
   and `supabase/migrations/005_research.sql`, in a development database.
3. Copy `.env.example` to `.env` and add server-side credentials.
4. `npm install`
5. `npm run seed` — seeds the playbook rules.
5b. `npm run auth:setup` — generates the password hash and session secret. The app
   refuses every request in production until these are set.
6. Add VERIFIED rows to `credibility_assets` (clients/media outlets/case studies). The model is forbidden from inventing them.
7. Ingest leads/messages/transcripts.
8. `npm run dev` and open http://localhost:3000.

### Running without credentials

The app boots with no credentials at all, which is how the tests run:

- **No `SUPABASE_URL`** → a JSON store under `.data/`, seeded with three demo leads covering a confused prospect, a call-ready prospect, and an untouched opener. Delete `.data/` to reseed.
- **No `OPENAI_API_KEY`** → a deterministic offline engine that applies the same qualification model, gate and SERVICE_CONFUSION rules as the prompt. It writes plain, correct replies rather than good ones.

Both are development conveniences. Supabase is the source of truth and GPT-5.6 is the setter; the banners in the UI say which mode is live.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server |
| `npm run build` / `npm start` | production build and serve |
| `npm run cli` | the original interactive CLI |
| `npm run seed` | seed playbook rules into Supabase |
| `npm test` | the full suite (gate, understanding, memory, retrieval, ingestion, credibility) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run auth:setup` | generate the auth environment values |
| `npm run ingest:validate` | verify the Trello corpus is complete |
| `npm run ingest:extract` | derive identity and outcome tiers |
| `npm run ingest:transcribe` | screenshots → draft transcripts (needs an API key) |
| `npm run ingest:chunk` | verified transcripts → embedded chunks |

## API

| Route | Purpose |
| --- | --- |
| `GET /api/status` | which store and model are live |
| `GET/POST /api/leads` | list the inbox / add a lead |
| `GET/PATCH /api/leads/:id` | lead detail (messages, memory, events, suggestions) / update follow-up, priority, profile |
| `GET/POST /api/leads/:id/messages` | read or append messages |
| `POST /api/leads/:id/generate` | run the pipeline; returns strategy, gate, draft, reviewer, retrieved examples |
| `POST /api/leads/:id/import` | parse a pasted thread (preview by default, `commit: true` to write) |
| `POST /api/suggestions/:id/feedback` | record `used` / `edited` / `rejected` |
| `GET/PATCH /api/leads/:id/memory` | inspect or correct long-term memory |
| `POST /api/leads/:id/research` | record researched facts about a lead, with source and verified status |
| `GET/POST /api/coaching` | the coaching layer: rules and examples, including proposals awaiting review |
| `PATCH /api/coaching/:id` | approve or reject a proposed rule or example |
| `POST /api/coaching/import` | queue coaching candidates from a ChatGPT export for review |
| `GET /api/corpus`, `GET/PATCH /api/corpus/:id` | transcript verification workflow |
| `GET /api/analytics` | feedback-learning statistics |
| `GET/POST/DELETE /api/auth` | session status, sign in, sign out |

Every route except `/api/auth` requires an authenticated session.

## Dataset inventory

The supplied Trello screenshot corpus contains 360 screenshots across 67 prospect cards:

- Discovery Call: 11 / 63 screenshots
- Onboarding Call: 8 / 62
- Not Interested: 9 / 43
- No Show: 10 / 37
- Nurturing: 6 / 33
- Future follow-up: 16 / 86
- Info Packet Sent: 7 / 36

This has been validated against the real archive: **12/12 parts, 67/67 cards,
360/360 screenshots**, reconciling exactly with the breakdown above.

The code does NOT pretend screenshots have been transcribed. Transcription
requires an API key, produces drafts marked `needs_review`, and only a human
approval makes a conversation eligible for retrieval. See
[`docs/INGESTION.md`](docs/INGESTION.md).

Analysis of the real corpus found **32 of 67 bookings (48%) were not honoured
downstream** — the evidence behind the tiered outcome model.

## Security

`SUPABASE_SERVICE_ROLE_KEY` is server-side only. It is read exclusively in API
routes and never reaches the browser. The schema enables RLS and intentionally
creates no permissive browser policies.

Every data API route requires an authenticated session (`src/lib/auth.ts`):
single-operator password auth with an HMAC-signed, httpOnly session cookie. With
auth unconfigured the app runs open **only** in local development; in production
it returns 503 rather than exposing prospect data.

Private prospect data — screenshots, board exports, transcripts — lives under the
git-ignored `data/` directory and in the database. It is never committed. Test
fixtures are synthetic.

## Deeper documentation

- [`docs/AGENT_BRAIN.md`](docs/AGENT_BRAIN.md) — the gate, the
  explained/understood split, memory provenance, outcome tiers, retrieval and
  voice separation.
- [`docs/INGESTION.md`](docs/INGESTION.md) — the four-stage screenshot pipeline
  and the transcript verification workflow.

## What still needs to be connected

- OpenAI API key/billing. Without it the app runs on a deterministic offline
  engine and screenshot transcription cannot run at all.
- Supabase project credentials.
- Verified rows in `credibility_assets`. The ranker returns nothing when no asset
  is relevant, and the writer is told to cite nothing — but with an empty table it
  can never cite anything.
- Transcription and human verification of the 360-screenshot corpus. Stages 1 and
  2 have been run against the real dataset (67/67 cards, 360/360 screenshots);
  stages 3 and 4 need an API key and a human reviewer.
- Richer narrative memory. Structured memory advances automatically after each
  accepted exchange; `relationship_summary` and free-text fields are still
  maintained by hand or corrected in the Memory panel.
