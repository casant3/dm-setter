# DM Setter Agent V1

A permanent-memory Instagram DM appointment-setting agent powered by OpenAI, with Supabase/Postgres as the source of truth.

## Core behaviour already encoded

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

## Architecture

User -> context loader -> strategy pass -> hard qualification gate -> reply writer -> reviewer -> exact DM
                         |                    |
                    Supabase memory      winner/loss retrieval

## Setup

1. Create/use a Supabase project.
2. Run `supabase/schema.sql` in a development database.
3. Copy `.env.example` to `.env` and add server-side credentials.
4. `npm install`
5. `npx tsx scripts/seed_playbook.ts`
6. Add VERIFIED rows to `credibility_assets` (clients/media outlets/case studies). The model is forbidden from inventing them.
7. Ingest leads/messages/transcripts.
8. Run `npm run dev`.

## Important security note

`SUPABASE_SERVICE_ROLE_KEY` is server-side only. Never expose it in browser/frontend code. The schema enables RLS but intentionally does not create permissive browser policies in V1.

## What still needs to be connected

- OpenAI API key/billing.
- Supabase project credentials.
- Verified list of approved big-name clients/media outlets and the exact claims allowed.
- Transcription/structuring of the 360 screenshot corpus.
- UI (the current V1 is a runnable CLI/backend agent core).

## Recommended next build

Add a three-column inbox UI: Leads | Conversation | AI Copilot. The agent core here can sit behind an API route without changing the memory/reasoning design.
