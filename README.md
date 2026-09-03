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
- Books in one move: once the gate opens it proposes the call *and* two concrete times, rather than spending a turn asking whether a call would be welcome.
- Treats no-show risk as advice on how to book, never as a second gate.
- Learns from whole correction chains — the draft, what the operator objected to, and what they approved instead — with nothing applied until a person approves it.

## Architecture

```
Leads sidebar ─┐
Conversation  ─┼─► API routes ─► agent core ─► strategy pass ─► hard gate ─► reply writer ─► reviewer ─► exact DM
AI copilot    ─┘                     │              │
                                     │              └─ winner / failure retrieval (pgvector)
                                     └─ Supabase memory (leads, messages, lead_memories, events, credibility)
```

The three model passes are unchanged from V1 — strategist, writer, reviewer — but they are now surrounded by deterministic reading and enforcement: the conversation is analysed in code before the model sees it, and every draft is audited in code before and after the reviewer. What is new is that the persistence layer and the model layer are now interfaces, so the same core drives the CLI, the web app, and the tests.

- `src/core/` — the agent. The three passes are V1's, but `prompts.ts` and `schemas.ts` have both grown since: the prompt carries the gate, the explained/understood split, one-move planning and the booking rules, and `schemas.ts` adds the memory-extraction schema.
- `src/lib/store/` — `Store` interface, Supabase implementation, local dev implementation.
- `src/app/` — Next.js App Router pages and API routes.
- `src/components/` — the three-column UI.

### The hard gate

The model proposes; a deterministic gate disposes. `evaluateGate()` blocks a call
unless **all six** qualification dimensions are above zero, the total is at least
9/12, and there is no unresolved SERVICE_CONFUSION. A high total never
compensates for a missing dimension. When the model wants to book and the gate
disagrees, the gate wins and the copilot says so.

No-show risk sits alongside the gate but is **advisory**: it changes how firmly
the purpose is framed, which times are offered and how much commitment is asked
for. It never withholds a call from a prospect the gate has passed.

See [`docs/AGENT_BRAIN.md`](docs/AGENT_BRAIN.md) for the full design.

## Outbound accounts

Outreach runs from more than one Instagram page, so every conversation belongs to
exactly one **outbound account**. Attribution only: no credentials are stored,
nothing logs in to Instagram, and nothing is sent by this system.

- A lead carries its account; messages inherit it through the lead.
- The same prospect may exist under two accounts — those are two conversations,
  with separate memory, and are never merged. The same account cannot open two
  threads with the same person.
- Adding a prospect already being contacted from another active page raises a
  warning the operator must acknowledge. It is never silently blocked, because
  there are legitimate reasons, and never silent, because two pages messaging
  someone the same week reads as spam.
- Historical Trello conversations are attributed to an explicit
  **unknown/legacy** account rather than a guess. It is inactive, so it can never
  be chosen for new outreach.
- Analytics segment the whole funnel by account: DMs sent, conversations,
  replies, positive replies, qualified, calls offered, calls booked, shows,
  no-shows, onboardings, not interested, and the conversion rate between stages.
- Coaching stays operator-level. The voice is Cassey's, not the page's.

## On a phone

The app is mobile-first, because the accounts are logged in on a phone and the
real workflow is Instagram ↔ DM Setter:

> copy their reply → paste it here → generate → **Copy reply** → send it in
> Instagram → Sent as-is / Sent edited → next prospect

Below 900px the three columns become three screens — inbox, conversation,
details — rather than a narrower desktop:

- The conversation screen is built around the exact DM, in a box that grows to
  fit, under a full-width **Copy reply** button that copies the message and
  nothing else.
- **Add reply** opens a sheet focused and ready, with a Paste button where the
  browser allows it, and saves-and-generates in one action. The clipboard is
  never read except from that button.
- Feedback is one tap, and an edit made before sending is preserved separately
  from the suggestion so the coaching layer sees what changed.
- *Sending from @account* appears on every conversation and inbox row, with
  account tabs across the top of the inbox.
- Triage filters — needs reply, follow-up due, warm, call ready — carry counts
  for the selected account, and search matches a handle prefix first.
- **Screenshot** reads a photo of the Instagram thread into the conversation
  (see below) — the fastest way to get an exchange in from a phone.
- Qualification, memory, retrieval and the audit live under **Details**.

Installable as a PWA (standalone display, maskable icons, safe-area viewport).
Installing is optional and the ordinary HTTPS site behaves identically. The
service worker caches build assets only — never an API response, never HTML —
so no prospect data is stored offline. `scripts/mobile_check.mjs` drives the app
in Chromium at 360/390/412/430px and checks overflow, tap targets and console
errors; Playwright is deliberately not a project dependency.

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

**Memory advances on send** — accepting a suggestion updates `lead_memories` in two passes. The deterministic pass records the questions the DM just asked so they are never asked twice, logs that the service was explained, logs the Avo CTA once the gate opens, and re-derives `service_understanding` from the prospect's own words. Fresh SERVICE_CONFUSION resets that score to zero, which re-closes the call gate — so a prospect who reveals late that they thought this was a guest spot cannot stay call-ready.

The model pass then extracts what patterns cannot: what they are building, who they named, what is in their way. It runs **incrementally** — only the messages since the last run, plus a short window of context and a list of what is already remembered — and does not run at all when nothing new has been said. Every item must carry the words it came from; a quote found verbatim in the thread is a fact, a quote that cannot be found is kept as a low-confidence inference. `relationship_summary` and `communication_style` are always inferences, never facts, because they are readings of a conversation rather than anything the prospect said — they reach the model labelled as such, and a human correction replaces them permanently.

**Adding leads and importing DMs** — new leads need only a handle. Existing threads can be pasted in: the parser handles `Me:` / `Them:` style, `@handle:` labels, leading timestamps, and Instagram's export format where the sender sits on its own line. Unrecognised speaker labels are surfaced in a preview so they can be mapped before anything is written.

**Importing the daily lead list** — *Import leads* reads the lead-vault sheet:
either a Google Sheets link, or the tab pasted or uploaded as CSV/TSV. The grid
is date rows (`26/8`, `22nd of July`, `03/09/2026`) with handles beside them, and
a cell may carry a note after the handle (`someone - runs an agency`). A cell
that reads as prose rather than a handle is skipped and shown rather than turned
into a prospect.

Nothing is written on the first pass. The preview reports how many days and
handles were found, how many days are still empty, how many handles are new,
how many are already in the pipeline, how many are repeated in the sheet, how
many are already being contacted from another page, and which cells could not be
read — and only then is a page chosen and the import committed. Re-running the
same sheet imports nothing, so the daily list can be pulled repeatedly as it
fills. Imported leads start at `NEW_LEAD` with no messages; nothing is sent.

A link works when the sheet is link-shared, or with a Google service account
(`GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY`) that the sheet is shared
with — view access is enough. The service-account JWT is signed with `node:crypto`,
so there is no Google client library in the dependency tree. Pasting always works
and needs no credentials.

**Screenshots of a conversation** — on a conversation, **Screenshot** sends a
photo of the Instagram thread to a vision model and returns what it read. Every
line comes back for review with its sender, whether the model was unsure of it,
and whether it was cut off; each can be reworded, flipped between *Them* and
*You*, or removed before anything reaches the thread. Lines already in the thread
are dropped, so the context messages a screenshot always includes are not
appended twice, and spans the model could not read are listed as unread rather
than guessed at. **The image is never stored** — it is read and the bytes are
dropped. Without `OPENAI_API_KEY` the read refuses outright rather than
inventing a transcript.

## Running it online

The app is meant to be used from a phone, which means it needs to be deployed.
[`docs/DEPLOY.md`](docs/DEPLOY.md) is the whole procedure — it takes four
environment variables and no terminal.

## Setup

1. Create/use a Supabase project.
2. Run `supabase/schema.sql`, then `supabase/migrations/002_web_app.sql`, then
   `supabase/migrations/003_agent_brain.sql`, `supabase/migrations/004_coaching.sql`,
   `supabase/migrations/005_research.sql`, `supabase/migrations/006_coaching_chains.sql`,
   `supabase/migrations/007_memory_narrative.sql` and
   `supabase/migrations/008_outbound_accounts.sql`, in a development database.
3. Copy `.env.example` to `.env` and add server-side credentials.
4. `npm install`
5. `npm run seed` — seeds the playbook rules.
5b. Set a password: either `APP_PASSWORD=...` in `.env`, or `npm run auth:setup`
   for the hashed form. The app refuses every request in production until one of
   the two is set.
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
| `GET/POST /api/leads/import-sheet` | whether a sheet link can be used / import the lead-vault sheet (preview by default, `commit: true` to write) |
| `POST /api/leads/:id/screenshot` | read a conversation screenshot (preview by default, `commit: true` to append the reviewed lines) |
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
single-operator password auth with an HMAC-signed, httpOnly session cookie. The
session lasts 30 days and renews once past halfway, so a phone in daily use
stays signed in while an abandoned device still expires. With
auth unconfigured the app runs open **only** in local development; in production
it returns 503 rather than exposing prospect data.

Private prospect data — screenshots, board exports, transcripts — lives under the
git-ignored `data/` directory and in the database. It is never committed. Test
fixtures are synthetic.

## Deeper documentation

- [`docs/AGENT_BRAIN.md`](docs/AGENT_BRAIN.md) — the gate, the
  explained/understood split, the dialogue ledger, motivation, brush-offs, the
  one-move planner, the deterministic audit, booking state, advisory no-show
  risk, memory provenance and incremental extraction, outcome tiers, retrieval,
  voice separation and the coaching layer.
- [`docs/INGESTION.md`](docs/INGESTION.md) — the four-stage screenshot pipeline
  and the transcript verification workflow.

## What still needs to be connected

- OpenAI API key/billing. Without it the app runs on a deterministic offline
  engine, and neither corpus transcription nor reading a conversation screenshot
  can run at all — both refuse rather than guess.
- A Google service account, if lead sheets are to be pulled by link without
  link-sharing them. Pasting the tab needs nothing.
- Supabase project credentials.
- Verified rows in `credibility_assets`. The ranker returns nothing when no asset
  is relevant, and the writer is told to cite nothing — but with an empty table it
  can never cite anything.
- Transcription and human verification of the 360-screenshot corpus. Stages 1 and
  2 have been run against the real dataset (67/67 cards, 360/360 screenshots);
  stages 3 and 4 need an API key and a human reviewer.
- Live GPT-5.6 behaviour. Every deterministic path is tested and the offline
  engine exercises the whole pipeline, but no live model call has been made.
- Coaching material. The layer is built and the importer works, but it starts
  empty: rules, examples and imported correction chains all need a human to
  approve them before they influence anything.
