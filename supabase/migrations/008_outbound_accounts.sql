-- Multiple outbound Instagram accounts.
--
-- Attribution, conversation ownership and analytics only. No credentials are
-- stored, nothing logs in to Instagram, and nothing is sent by this system.

-- ---------------------------------------------------------------------------
-- The pages we send from
-- ---------------------------------------------------------------------------

create table if not exists outbound_accounts (
  id uuid primary key default gen_random_uuid(),
  platform text not null default 'instagram',
  -- Stored without the @, lower case, so attribution cannot fork on casing.
  handle text not null,
  display_name text,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);

create unique index if not exists outbound_accounts_platform_handle_idx
  on outbound_accounts(platform, lower(handle));
create index if not exists outbound_accounts_active_idx on outbound_accounts(active);

-- ---------------------------------------------------------------------------
-- The account historical conversations belong to
--
-- The Trello corpus does not record which page sent each thread. Guessing would
-- put false attribution into the analytics decisions are made from, so those
-- conversations get an explicit unknown account. It is inactive: nothing new is
-- ever sent from "we do not know".
-- ---------------------------------------------------------------------------

insert into outbound_accounts (platform, handle, display_name, active, notes)
select 'unknown', 'unknown_legacy', 'Unknown / legacy (before account tracking)', false,
       'Conversations from before outbound accounts were tracked. Never guess which page sent them.'
where not exists (select 1 from outbound_accounts where handle = 'unknown_legacy');

-- ---------------------------------------------------------------------------
-- Conversation ownership
--
-- A lead belongs to exactly one outbound account. Messages inherit it through
-- the lead, which is what keeps two threads with the same prospect from ever
-- being read as one conversation.
-- ---------------------------------------------------------------------------

alter table leads add column if not exists outbound_account_id uuid references outbound_accounts(id);

create index if not exists leads_outbound_account_idx on leads(outbound_account_id);

-- Existing leads predate account tracking, so they are attributed to the
-- explicit unknown account rather than to a guess.
update leads
set outbound_account_id = (select id from outbound_accounts where handle = 'unknown_legacy')
where outbound_account_id is null;

-- Historical corpus conversations, same reasoning.
alter table source_conversations add column if not exists outbound_account_id uuid references outbound_accounts(id);

update source_conversations
set outbound_account_id = (select id from outbound_accounts where handle = 'unknown_legacy')
where outbound_account_id is null;

-- ---------------------------------------------------------------------------
-- A handle is no longer unique on its own
--
-- The same prospect can legitimately be in two threads from two different
-- pages. What must stay impossible is the same page opening two threads with
-- the same person, so the uniqueness moves to (account, handle).
--
-- The old constraint is dropped by whichever name Postgres gave it.
-- ---------------------------------------------------------------------------

do $$
declare
  constraint_name text;
begin
  select con.conname into constraint_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_attribute att on att.attrelid = rel.oid and att.attnum = any (con.conkey)
  where rel.relname = 'leads'
    and con.contype = 'u'
    and array_length(con.conkey, 1) = 1
    and att.attname = 'instagram_handle'
  limit 1;

  if constraint_name is not null then
    execute format('alter table leads drop constraint %I', constraint_name);
  end if;
end $$;

create unique index if not exists leads_account_handle_idx
  on leads(coalesce(outbound_account_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(instagram_handle));

-- ---------------------------------------------------------------------------
-- The inbox carries its account
--
-- `lead_inbox` selects `l.*`, so adding a column to `leads` changes the view's
-- column order and `create or replace view` refuses that. It is rebuilt here
-- with exactly the definition 002 gives it, so replaying 002 after this
-- migration still matches column for column. The account's handle is joined in
-- the application rather than added here for the same reason: a view whose
-- column list has drifted from the migration that defines it cannot be replayed.
-- ---------------------------------------------------------------------------

drop view if exists lead_inbox;

create or replace view lead_inbox as
select
  l.*,
  coalesce(m.message_count, 0) as message_count,
  m.last_message_at,
  m.last_message_preview,
  m.last_message_sender,
  greatest(
    coalesce(m.last_message_at, l.created_at),
    coalesce(l.created_at, m.last_message_at)
  ) as last_activity_at
from leads l
left join lateral (
  select
    count(*) as message_count,
    max(sent_at) as last_message_at,
    (array_agg(left(message_text, 140) order by sent_at desc))[1] as last_message_preview,
    (array_agg(sender order by sent_at desc))[1] as last_message_sender
  from messages
  where messages.lead_id = l.id
) m on true;

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Same posture as the rest of the app: server-side only, through an
-- authenticated API route using the service credential.
-- ---------------------------------------------------------------------------

alter table outbound_accounts enable row level security;
