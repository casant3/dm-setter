-- Narrative memory gets the same provenance discipline as everything else.
-- Additive in effect: existing text is converted in place, never discarded.

-- ---------------------------------------------------------------------------
-- relationship_summary and communication_style are interpretations
--
-- Both were plain text, which meant a model's reading of a conversation
-- ("prospect trusts Cassey") sat in context indistinguishable from something
-- the prospect actually said. They now hold a MemoryItem, exactly like the list
-- fields upgraded in 003: value, provenance, confidence, quote, verified.
--
-- Idempotent: the conversion only runs while the column is still text.
-- ---------------------------------------------------------------------------

do $$
declare
  col text;
begin
  foreach col in array array['relationship_summary', 'communication_style'] loop
    if exists (
      select 1 from information_schema.columns
      where table_name = 'lead_memories' and column_name = col and data_type = 'text'
    ) then
      execute format($f$
        alter table lead_memories
        alter column %I type jsonb
        using case
          when %I is null or btrim(%I) = '' then null
          else jsonb_build_object(
            'value', %I,
            'provenance', 'inference',
            'confidence', 0.4,
            'source_message_id', null,
            'quote', null,
            'source_ref', null,
            'recorded_at', coalesce(updated_at, now()),
            'verified', false
          )
        end
      $f$, col, col, col, col);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Where incremental extraction got to
--
-- Without this, every exchange re-sent the whole transcript to the model to
-- re-derive memory it had already produced.
-- ---------------------------------------------------------------------------

alter table lead_memories add column if not exists extraction_state jsonb;

-- A human correction is still the end of the argument: `verified_fields` (003)
-- continues to protect both narrative fields from automatic updates.
