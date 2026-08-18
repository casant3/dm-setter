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

## Architecture

```
Leads sidebar ─┐
Conversation  ─┼─► API routes ─► agent core ─► strategy pass ─► hard gate ─► reply writer ─► reviewer ─► exact DM
AI copilot    ─┘                     │              │
                                     │              └─ winner / failure retrieval (pgvector)
                                     └─ Supabase memory (leads, messages, lead_memories, events, credibility)
```

The pipeline is unchanged from V1: the same prompt, the same JSON schemas, the same three passes. What is new is that the persistence layer and the model layer are now interfaces, so the same core drives the CLI, the web app, and the tests.

- `src/core/` — the agent. `prompts.ts` and `schemas.ts` are byte-identical to V1.
- `src/lib/store/` — `Store` interface, Supabase implementation, local dev implementation.
- `src/app/` — Next.js App Router pages and API routes.
- `src/components/` — the three-column UI.

### The hard gate

The model proposes; a deterministic gate disposes. `evaluateGate()` blocks a call unless fit, commercial goal and service understanding are all above zero, the qualification total is at least 9/12, and there is no unresolved SERVICE_CONFUSION. When the model wants to book and the gate disagrees, the gate wins and the copilot says so.

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

**Adding leads and importing DMs** — new leads need only a handle. Existing threads can be pasted in: the parser handles `Me:` / `Them:` style, `@handle:` labels, leading timestamps, and Instagram's export format where the sender sits on its own line. Unrecognised speaker labels are surfaced in a preview so they can be mapped before anything is written.

## Setup

1. Create/use a Supabase project.
2. Run `supabase/schema.sql`, then `supabase/migrations/002_web_app.sql`, in a development database.
3. Copy `.env.example` to `.env` and add server-side credentials.
4. `npm install`
5. `npm run seed` — seeds the playbook rules.
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
| `npm test` | parser, gate, SERVICE_CONFUSION and feedback-loop tests |
| `npm run typecheck` | `tsc --noEmit` |

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

## Dataset inventory

The supplied Trello screenshot corpus contains 360 screenshots across 67 prospect cards:

- Discovery Call: 11 / 63 screenshots
- Onboarding Call: 8 / 62
- Not Interested: 9 / 43
- No Show: 10 / 37
- Nurturing: 6 / 33
- Future follow-up: 16 / 86
- Info Packet Sent: 7 / 36

The code does NOT pretend screenshots have already been perfectly transcribed. The next data step is to create verified transcripts/labels for `source_conversations` and chunk them for retrieval.

## Important security note

`SUPABASE_SERVICE_ROLE_KEY` is server-side only. It is read exclusively in API routes and never reaches the browser. The schema enables RLS but intentionally does not create permissive browser policies. **The app currently has no authentication** — put it behind auth before exposing it beyond localhost.

## What still needs to be connected

- OpenAI API key/billing.
- Supabase project credentials.
- Verified list of approved big-name clients/media outlets and the exact claims allowed.
- Transcription/structuring of the 360 screenshot corpus into `conversation_chunks` with embeddings — until that exists, winner/failure retrieval has nothing real to draw on.
- Authentication for the web app.
- Writing back to `lead_memories` after each exchange; memory is currently read by the pipeline and maintained by hand.
