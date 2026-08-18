-- Additive migration for the web app. Safe to run on a database already
-- created from schema.sql: nothing here drops or rewrites existing columns.

-- ---------------------------------------------------------------------------
-- Follow-up status and priority
-- ---------------------------------------------------------------------------

alter table leads add column if not exists followup_status text;
alter table leads add column if not exists followup_note text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_followup_status_check') then
    alter table leads add constraint leads_followup_status_check
      check (followup_status is null or followup_status in
        ('none','waiting_on_them','owed_reply','scheduled','overdue','closed'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leads_priority_check') then
    alter table leads add constraint leads_priority_check
      check (priority is null or priority in ('low','medium','high','urgent'));
  end if;
end $$;

update leads set followup_status = 'none' where followup_status is null;
update leads set priority = 'medium' where priority is null;

create index if not exists leads_followup_idx on leads(followup_status, next_followup_at);
create index if not exists leads_priority_idx on leads(priority);

-- ---------------------------------------------------------------------------
-- AI suggestion feedback: Used / Edited / Rejected
-- The legacy accepted/edited/rejected booleans are retained and kept in sync.
-- ---------------------------------------------------------------------------

alter table ai_suggestions add column if not exists feedback text;
alter table ai_suggestions add column if not exists feedback_at timestamptz;
alter table ai_suggestions add column if not exists feedback_note text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_suggestions_feedback_check') then
    alter table ai_suggestions add constraint ai_suggestions_feedback_check
      check (feedback is null or feedback in ('used','edited','rejected'));
  end if;
end $$;

-- Backfill the new column from whatever the boolean columns already recorded.
update ai_suggestions
   set feedback = case
     when rejected is true then 'rejected'
     when edited is true then 'edited'
     when accepted is true then 'used'
     else null
   end
 where feedback is null;

create index if not exists ai_suggestions_lead_created_idx on ai_suggestions(lead_id, created_at desc);
create index if not exists ai_suggestions_feedback_idx on ai_suggestions(feedback);

-- ---------------------------------------------------------------------------
-- Import provenance for pasted DM transcripts
-- ---------------------------------------------------------------------------

alter table messages add column if not exists import_batch_id uuid;
alter table messages add column if not exists source text default 'app';

create index if not exists messages_import_batch_idx on messages(import_batch_id);

-- ---------------------------------------------------------------------------
-- Inbox view backing the leads sidebar
-- ---------------------------------------------------------------------------

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
-- Suggestion feedback rollup, for tuning the setter over time
-- ---------------------------------------------------------------------------

create or replace view suggestion_feedback_stats as
select
  feedback,
  count(*) as suggestions,
  count(*) filter (where eventual_booking is true) as led_to_booking,
  avg((strategy->>'total_score')::numeric) as avg_qualification_score
from ai_suggestions
where feedback is not null
group by feedback;
