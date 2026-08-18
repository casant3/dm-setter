-- Additive migration for the agent-brain upgrade.
-- Safe to run on a database created from schema.sql + 002_web_app.sql.
-- Nothing here drops or rewrites an existing column.

-- ---------------------------------------------------------------------------
-- Long-term lead memory
--
-- Existing jsonb list columns previously held bare strings. They now hold
-- MemoryItem objects ({value, provenance, confidence, source_message_id, quote,
-- recorded_at, verified}). Old rows are migrated in place below; the column
-- types are unchanged, so this is backwards-compatible.
-- ---------------------------------------------------------------------------

alter table lead_memories add column if not exists personal_goals jsonb default '[]'::jsonb;
alter table lead_memories add column if not exists buying_signals jsonb default '[]'::jsonb;
alter table lead_memories add column if not exists timing_constraints jsonb default '[]'::jsonb;
alter table lead_memories add column if not exists followup_commitments jsonb default '[]'::jsonb;
alter table lead_memories add column if not exists key_entities jsonb default '[]'::jsonb;

-- The action we took, kept distinct from the prospect's understanding.
alter table lead_memories add column if not exists service_explained boolean default false;
alter table lead_memories add column if not exists service_explained_at timestamptz;
alter table lead_memories add column if not exists service_explained_count integer default 0;

-- Evidence behind the understanding score, so it can be audited.
alter table lead_memories add column if not exists service_understanding_evidence jsonb default '[]'::jsonb;

-- Fields a human has verified. Automatic updates must skip these.
alter table lead_memories add column if not exists verified_fields text[] default '{}';

-- Upgrade any legacy bare-string entries to MemoryItem objects. Idempotent:
-- entries that are already objects are left untouched.
do $$
declare
  col text;
  cols text[] := array[
    'facts_known','businesses','goals','pain_points','interests','objections',
    'media_history','opportunities_identified','questions_already_asked',
    'offers_explained','ctas_already_used'
  ];
begin
  foreach col in array cols loop
    execute format($f$
      update lead_memories
         set %I = (
           select coalesce(jsonb_agg(
             case
               when jsonb_typeof(elem) = 'string'
                 then jsonb_build_object(
                   'value', elem #>> '{}',
                   'provenance', 'fact',
                   'confidence', 0.8,
                   'source_message_id', null,
                   'quote', null,
                   'recorded_at', coalesce(updated_at, now()),
                   'verified', false)
               else elem
             end
           ), '[]'::jsonb)
           from jsonb_array_elements(%I) as elem
         )
       where %I is not null
         and exists (
           select 1 from jsonb_array_elements(%I) e where jsonb_typeof(e) = 'string'
         )
    $f$, col, col, col, col);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Historical outcome quality
-- ---------------------------------------------------------------------------

alter table source_conversations add column if not exists outcome_tier text;
alter table source_conversations add column if not exists status text default 'pending_ocr';
alter table source_conversations add column if not exists outcome_history jsonb default '[]'::jsonb;
alter table source_conversations add column if not exists labels jsonb;
alter table source_conversations add column if not exists verified_by text;
alter table source_conversations add column if not exists verified_at timestamptz;
alter table source_conversations add column if not exists transcript_confidence numeric;
alter table source_conversations add column if not exists ordering_confidence numeric;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'source_conversations_tier_check') then
    alter table source_conversations add constraint source_conversations_tier_check
      check (outcome_tier is null or outcome_tier in ('A','B','C','D','E','F'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'source_conversations_status_check') then
    alter table source_conversations add constraint source_conversations_status_check
      check (status in ('pending_ocr','needs_review','verified','rejected'));
  end if;

  -- Ingestion is keyed on the Trello card so re-running is idempotent.
  if not exists (select 1 from pg_constraint where conname = 'source_conversations_card_key') then
    alter table source_conversations add constraint source_conversations_card_key
      unique (external_card_id);
  end if;
end $$;

create index if not exists source_conversations_status_idx on source_conversations(status);
create index if not exists source_conversations_tier_idx on source_conversations(outcome_tier);

-- ---------------------------------------------------------------------------
-- Retrieval metadata on chunks
-- ---------------------------------------------------------------------------

alter table conversation_chunks add column if not exists outcome_tier text;
alter table conversation_chunks add column if not exists industry text;
alter table conversation_chunks add column if not exists setter_name text;
alter table conversation_chunks add column if not exists quality_score numeric;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'conversation_chunks_tier_check') then
    alter table conversation_chunks add constraint conversation_chunks_tier_check
      check (outcome_tier is null or outcome_tier in ('A','B','C','D','E','F'));
  end if;
end $$;

create index if not exists conversation_chunks_tier_idx on conversation_chunks(outcome_tier);
create index if not exists conversation_chunks_setter_idx on conversation_chunks(setter_name);
create index if not exists conversation_chunks_source_idx on conversation_chunks(source_conversation_id);

-- ---------------------------------------------------------------------------
-- Credibility targeting
-- ---------------------------------------------------------------------------

alter table credibility_assets add column if not exists industries text[] default '{}';

-- ---------------------------------------------------------------------------
-- Retrieval RPC
--
-- Outcome filtering moves out of SQL: reranking needs winners and failures in
-- one candidate pool so it can bucket and label them. `filter_outcomes` is kept
-- for backwards compatibility and may be null.
-- ---------------------------------------------------------------------------

create or replace function match_conversation_chunks(
  query_embedding extensions.vector(1536),
  match_count int default 8,
  filter_outcomes text[] default null
)
returns table (
  id uuid,
  source_conversation_id uuid,
  outcome text,
  outcome_tier text,
  stage text,
  niche text,
  industry text,
  setter_name text,
  content text,
  metadata jsonb,
  quality_score numeric,
  similarity float
)
language sql stable
as $$
  select cc.id, cc.source_conversation_id, cc.outcome, cc.outcome_tier, cc.stage,
         cc.niche, cc.industry, cc.setter_name, cc.content, cc.metadata, cc.quality_score,
         1 - (cc.embedding <=> query_embedding) as similarity
  from conversation_chunks cc
  join source_conversations sc on sc.id = cc.source_conversation_id
  where (filter_outcomes is null or cc.outcome = any(filter_outcomes))
    -- Only human-verified transcripts may influence live suggestions.
    and sc.status = 'verified'
  order by cc.embedding <=> query_embedding
  limit match_count;
$$;

-- ---------------------------------------------------------------------------
-- Feedback learning views
-- ---------------------------------------------------------------------------

create or replace view strategy_performance as
select
  strategy->>'stage' as stage,
  count(*) filter (where feedback = 'used') as used,
  count(*) filter (where feedback = 'edited') as edited,
  count(*) filter (where feedback = 'rejected') as rejected,
  count(*) filter (where prospect_replied is true) as replies,
  count(*) filter (where eventual_booking is true) as bookings,
  avg((strategy->>'total_score')::numeric) as avg_qualification_score
from ai_suggestions
where strategy is not null
group by strategy->>'stage';

create or replace view suggestion_outcome_link as
select
  s.id as suggestion_id,
  s.lead_id,
  s.feedback,
  s.created_at,
  (s.strategy->>'stage') as stage,
  (s.strategy->>'total_score')::numeric as total_score,
  (s.strategy->>'call_ready')::boolean as call_ready,
  l.outcome as lead_outcome,
  l.booked_call
from ai_suggestions s
join leads l on l.id = s.lead_id;

-- ---------------------------------------------------------------------------
-- Row level security for the new table surface
-- ---------------------------------------------------------------------------

alter table source_conversations enable row level security;
alter table conversation_chunks enable row level security;

-- V2 remains server-side only: every read goes through an authenticated API
-- route using the service credential. No permissive browser policy is created.
