-- Coaching layer: how the operator wants messages written.
-- Additive. Nothing here drops or rewrites an existing column.

-- ---------------------------------------------------------------------------
-- Explicit rules from the operator
--
-- Only rows with status = 'active' ever reach the prompt. Everything learned
-- from a live edit or imported from elsewhere is inserted as 'pending_review'
-- and stays inert until a person approves it.
-- ---------------------------------------------------------------------------

create table if not exists setter_preferences (
  id uuid primary key default gen_random_uuid(),
  setter_name text not null default 'Cassey',
  rule text not null,
  -- A stage name to scope the rule to, or null for always.
  applies_to text,
  source text not null default 'human' check (source in ('human', 'live_edit', 'chatgpt_import')),
  status text not null default 'pending_review' check (status in ('pending_review', 'active', 'rejected')),
  priority integer not null default 0,
  -- The edit or import this was proposed from, when it was not typed by hand.
  evidence jsonb,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists setter_preferences_status_idx on setter_preferences(status);
create index if not exists setter_preferences_setter_idx on setter_preferences(setter_name);

-- ---------------------------------------------------------------------------
-- Situation-and-reply pairs the operator has stood behind
-- ---------------------------------------------------------------------------

create table if not exists coaching_examples (
  id uuid primary key default gen_random_uuid(),
  setter_name text not null default 'Cassey',
  situation text not null,
  prospect_message text,
  approved_reply text not null,
  why text,
  source text not null default 'human' check (source in ('human', 'live_edit', 'chatgpt_import')),
  status text not null default 'pending_review' check (status in ('pending_review', 'approved', 'rejected')),
  tags text[] not null default '{}',
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists coaching_examples_status_idx on coaching_examples(status);
create index if not exists coaching_examples_setter_idx on coaching_examples(setter_name);

-- ---------------------------------------------------------------------------
-- What is actually in force
--
-- A convenience view over the two tables, in the precedence order the prompt
-- applies: an explicit rule outranks an approved example.
-- ---------------------------------------------------------------------------

create or replace view coaching_in_force as
select 'explicit_rule' as tier, 1 as tier_rank, id, setter_name, rule as content, applies_to, source, approved_at
from setter_preferences
where status = 'active'
union all
select 'approved_example' as tier, 2 as tier_rank, id, setter_name, approved_reply as content, situation as applies_to, source, approved_at
from coaching_examples
where status = 'approved';

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Same posture as the rest of V2: server-side only, through an authenticated
-- API route using the service credential. No permissive browser policy.
-- ---------------------------------------------------------------------------

alter table setter_preferences enable row level security;
alter table coaching_examples enable row level security;
