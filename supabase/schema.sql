create extension if not exists vector with schema extensions;

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  instagram_handle text unique not null,
  name text,
  company text,
  job_title text,
  industry text,
  niche text,
  followers integer,
  location text,
  lead_status text,
  interest_level text,
  conversation_stage text,
  priority text,
  media_experience text,
  authority_level text,
  media_gap text,
  commercial_goal text,
  first_contact_at timestamptz,
  last_contact_at timestamptz,
  next_followup_at timestamptz,
  booked_call boolean default false,
  booked_call_at timestamptz,
  outcome text,
  openai_conversation_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  sender text not null check (sender in ('setter','prospect','system')),
  message_text text not null,
  message_type text default 'text',
  sent_at timestamptz default now(),
  channel text default 'instagram',
  is_question boolean default false,
  is_cta boolean default false,
  is_objection boolean default false,
  is_buying_signal boolean default false,
  sent_by_ai boolean default false,
  ai_suggestion_id uuid
);
create index if not exists messages_lead_sent_idx on messages(lead_id, sent_at desc);

create table if not exists lead_memories (
  lead_id uuid primary key references leads(id) on delete cascade,
  relationship_summary text,
  facts_known jsonb default '[]'::jsonb,
  businesses jsonb default '[]'::jsonb,
  goals jsonb default '[]'::jsonb,
  pain_points jsonb default '[]'::jsonb,
  interests jsonb default '[]'::jsonb,
  objections jsonb default '[]'::jsonb,
  media_history jsonb default '[]'::jsonb,
  opportunities_identified jsonb default '[]'::jsonb,
  questions_already_asked jsonb default '[]'::jsonb,
  offers_explained jsonb default '[]'::jsonb,
  ctas_already_used jsonb default '[]'::jsonb,
  communication_style text,
  current_strategy text,
  service_understanding integer default 0 check (service_understanding between 0 and 2),
  updated_at timestamptz default now()
);

create table if not exists conversation_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  event_type text not null,
  description text not null,
  importance integer default 1,
  happened_at timestamptz default now()
);

create table if not exists credibility_assets (
  id uuid primary key default gen_random_uuid(),
  asset_type text not null check (asset_type in ('client','media_outlet','case_study')),
  name text not null,
  approved_claim text not null,
  niches text[] default '{}',
  active boolean default true,
  source_note text
);

create table if not exists setter_playbook (
  id uuid primary key default gen_random_uuid(),
  rule_key text unique not null,
  rule_text text not null,
  priority integer default 1,
  active boolean default true,
  updated_at timestamptz default now()
);

create table if not exists source_conversations (
  id uuid primary key default gen_random_uuid(),
  source text default 'trello',
  external_card_id text,
  instagram_handle text,
  setter_name text,
  outcome text,
  stage text,
  transcript text,
  notes text,
  screenshot_paths jsonb default '[]'::jsonb,
  quality_score numeric,
  created_at timestamptz default now()
);

create table if not exists conversation_chunks (
  id uuid primary key default gen_random_uuid(),
  source_conversation_id uuid references source_conversations(id) on delete cascade,
  lead_id uuid references leads(id) on delete cascade,
  outcome text,
  stage text,
  niche text,
  content text not null,
  metadata jsonb default '{}'::jsonb,
  embedding extensions.vector(1536),
  created_at timestamptz default now()
);
create index if not exists conversation_chunks_embedding_hnsw on conversation_chunks using hnsw (embedding extensions.vector_cosine_ops);

create table if not exists conversation_outcomes (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id) on delete cascade,
  outcome text not null,
  booked boolean default false,
  qualified boolean,
  showed boolean,
  closed boolean,
  booking_date timestamptz,
  days_to_booking integer,
  messages_to_booking integer,
  lost_reason text,
  successful_angle text,
  successful_cta text,
  successful_opener text,
  created_at timestamptz default now()
);

create table if not exists ai_suggestions (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  suggested_message text not null,
  strategy jsonb not null,
  context_used jsonb default '{}'::jsonb,
  examples_used jsonb default '[]'::jsonb,
  accepted boolean,
  edited boolean,
  rejected boolean,
  final_message_sent text,
  prospect_replied boolean,
  reply_sentiment text,
  eventual_booking boolean,
  created_at timestamptz default now()
);

create or replace function match_conversation_chunks(
  query_embedding extensions.vector(1536),
  match_count int default 8,
  filter_outcomes text[] default null
)
returns table (
  id uuid,
  source_conversation_id uuid,
  outcome text,
  stage text,
  niche text,
  content text,
  metadata jsonb,
  similarity float
)
language sql stable
as $$
  select cc.id, cc.source_conversation_id, cc.outcome, cc.stage, cc.niche, cc.content, cc.metadata,
         1 - (cc.embedding <=> query_embedding) as similarity
  from conversation_chunks cc
  where filter_outcomes is null or cc.outcome = any(filter_outcomes)
  order by cc.embedding <=> query_embedding
  limit match_count;
$$;

alter table leads enable row level security;
alter table messages enable row level security;
alter table lead_memories enable row level security;
alter table conversation_events enable row level security;
alter table credibility_assets enable row level security;
alter table setter_playbook enable row level security;
alter table source_conversations enable row level security;
alter table conversation_chunks enable row level security;
alter table conversation_outcomes enable row level security;
alter table ai_suggestions enable row level security;

-- V1 is intended to be called server-side with a secret/service credential.
-- Do not expose that credential in browser code. Add explicit authenticated-user RLS policies before direct client access.
