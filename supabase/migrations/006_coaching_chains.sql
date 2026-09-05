-- Correction chains, contextual coaching, and a timezone we were actually told.
-- Additive: nothing here drops a column or rewrites existing data.

-- ---------------------------------------------------------------------------
-- Coaching examples become correction chains
--
-- An imported ChatGPT history is mostly rejected drafts. The unit worth keeping
-- is the whole chain — the draft, what the operator objected to, the next
-- draft — so `approved_reply` can no longer be required: a candidate has one
-- only once a person has said which wording they stand behind.
-- ---------------------------------------------------------------------------

alter table coaching_examples add column if not exists kind text not null default 'good_example';
alter table coaching_examples add column if not exists rejected_reply text;
alter table coaching_examples add column if not exists operator_feedback text;
alter table coaching_examples add column if not exists revisions jsonb not null default '[]'::jsonb;
-- When this coaching applies: moves, stages, temperatures, booking states.
alter table coaching_examples add column if not exists applies_when jsonb;

alter table coaching_examples alter column approved_reply drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'coaching_examples_kind_check'
  ) then
    alter table coaching_examples
      add constraint coaching_examples_kind_check
      check (kind in ('good_example', 'bad_example', 'correction_pair', 'correction_chain'));
  end if;
end $$;

-- An approved example must actually carry the reply it is telling the setter to
-- follow. Rejections and pending candidates may have none.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'coaching_examples_approved_has_reply'
  ) then
    alter table coaching_examples
      add constraint coaching_examples_approved_has_reply
      check (status <> 'approved' or approved_reply is not null);
  end if;
end $$;

create index if not exists coaching_examples_tags_idx on coaching_examples using gin (tags);
create index if not exists coaching_examples_kind_idx on coaching_examples(kind);

-- `coaching_in_force` selected approved_reply directly; it now has to skip rows
-- that carry no approved wording.
create or replace view coaching_in_force as
select 'explicit_rule' as tier, 1 as tier_rank, id, setter_name, rule as content, applies_to, source, approved_at
from setter_preferences
where status = 'active'
union all
select 'approved_example' as tier, 2 as tier_rank, id, setter_name, approved_reply as content, situation as applies_to, source, approved_at
from coaching_examples
where status = 'approved' and approved_reply is not null;

-- ---------------------------------------------------------------------------
-- A timezone we were told
--
-- Never inferred from a location: a guessed timezone produces an invite an hour
-- out, which is the same thing as not turning up. Filled in by a human, or read
-- from the prospect's own words at suggestion time.
-- ---------------------------------------------------------------------------

alter table leads add column if not exists timezone text;

-- `lead_inbox` selects `l.*`, so adding a column to `leads` changes the view's
-- column order. `create or replace view` refuses that, which would break a
-- replay of 002 after this migration — so the view is rebuilt here, with the
-- same definition, against the new column list.
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
