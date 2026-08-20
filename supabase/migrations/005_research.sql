-- Research facts: what we found out about a lead ourselves.
-- Additive. Kept in its own column rather than mixed into facts_known, because
-- "we found this out" and "they told us this" must never be confused in a
-- message — the second is rapport, the first is only usable with care.

alter table lead_memories add column if not exists research_facts jsonb default '[]'::jsonb;

comment on column lead_memories.research_facts is
  'MemoryItem[] with provenance = research. Publicly-found facts the prospect has never stated to us.';
