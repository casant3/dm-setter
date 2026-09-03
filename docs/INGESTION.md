# Historical corpus ingestion

Turns the Trello screenshot archive into verified, retrievable training evidence
without fabricating anything and without private data touching the repository.

## Privacy

Screenshots, board exports and transcripts are **private prospect data**. They
live under `data/`, which is git-ignored, and in the database. They must never be
committed. Test fixtures in `test/` are synthetic.

## Input layout

```
data/trello/
  trello_dataset_part_01_of_12.zip   … part_12_of_12.zip
  trello_board_export.json
  UPLOAD_INDEX.json
```

Each ZIP contains `<Trello list>/<card name>__<shortLink>/` folders holding
`card_metadata.json` and the screenshots. Screenshot filenames keep their
original names with the Trello attachment id appended
(`IMG_4475__6a4fa82abcd464354d8b3baf.png`); the hex id is the identity, not the
filename.

Part numbers are a transport detail. They do not imply chronology, and a card may
span parts.

## Stages

```
npm run ingest:validate     # 1. reconcile the parts, refuse if incomplete
npm run ingest:extract      # 2. identity, outcome tier, provenance
npm run ingest:transcribe   # 3. screenshots -> draft transcripts (needs OPENAI_API_KEY)
# ---- human verification in the app's Corpus panel ----
npm run ingest:chunk        # 4. verified transcripts -> labelled, embedded chunks
```

All stages accept `--dry-run`. `transcribe` also accepts `--limit N` and
`--handle x` for cheap spot checks.

### 1. validate

Deduplicates on `(card shortLink, attachment id)`, reconciles counts against the
board export, and **exits non-zero unless the corpus is complete**, so a partial
archive can never silently become training data.

Verified result on the supplied dataset:

```
Parts present : 12/12
Cards         : 67/67
Screenshots   : 360/360
Duplicate attachment ids deduplicated: 0

🕒 Future follow-up      16 cards  86 screenshots
📞 Discovery Call        11 cards  63 screenshots
📞 Onboarding Call        8 cards  62 screenshots
❌ Not Interested         9 cards  43 screenshots
⚫ No show               10 cards  37 screenshots
Info Packet Sent          7 cards  36 screenshots
Nurturing Process         6 cards  33 screenshots
```

This reconciles exactly with the expected inventory.

### 2. extract

Joins the board export to derive each conversation's **outcome tier from real
card movement**, and writes one `source_conversations` row per card with status
`pending_ocr`. Keyed on the Trello card id, so re-running updates rather than
duplicating.

Result on the supplied dataset: Tier A 8, C 11, D 29, E 10, F 9, with **32
bookings not honoured downstream**.

### 3. transcribe

Reads each screenshot with a vision model. Rules the prompt enforces:

- transcribe exactly, including lowercase and typos;
- mark unreadable spans `[unreadable]` and never guess;
- attribute setter vs prospect, dropping confidence when unsure.

Consecutive screenshots of a scrolling thread overlap. That overlap is used twice:
to deduplicate repeated messages, and to **corroborate ordering** — screenshots
sharing a boundary raise `ordering_confidence`, ones sharing nothing lower it.

Every transcript lands as `needs_review` with `transcript_confidence`,
`ordering_confidence` and an uncertain-passage count. **There is no offline
fallback**: without `OPENAI_API_KEY` this stage refuses to run, because a
fabricated transcript is worse than a missing one.

### 4. Human verification

In the app: **Corpus** in the top bar. Each conversation shows its confidence
scores and screenshot count. The reviewer reads the transcript, corrects anything
misread, then approves or rejects.

Approval is the only path to `verified`, and **only `verified` conversations are
eligible for retrieval** — enforced in SQL, not just in application code:

```sql
join source_conversations sc on sc.id = cc.source_conversation_id
where sc.status = 'verified'
```

A human may re-edit a transcript they previously verified; re-running ingestion
cannot overwrite it.

### 5. chunk

Labels each verified conversation (opener type, value props used, objections,
buying signals, CTA timing, premature CTA, confusion handling, quality score),
cuts it at conversational stage boundaries, and writes embedded chunks.
Idempotent: a conversation's chunks are replaced wholesale, never appended.

Failure chunks are rendered with an explicit warning header so the writer reads
them as counter-examples rather than templates.

## Re-running

Every stage is idempotent. Cards are keyed on the Trello card id, screenshots on
the attachment id, chunks replaced per conversation. Re-running the whole
pipeline on the same input converges to the same state and cannot duplicate or
corrupt verified work.

## Not this pipeline: live screenshots

Screenshotting a conversation from the app (**Screenshot** on a conversation) is
a different thing and shares none of this machinery. It is one image, read once,
into one thread:

- No file ever lands on disk. The image is posted to the route, sent to the
  vision model, and dropped — nothing is stored under `data/`, in the database,
  or anywhere else.
- The read is a **proposal**. Every line comes back for review with its sender,
  whether the model was unsure, and whether the text was cut off; the operator
  corrects the wording, flips the sender, or removes a line before anything is
  written.
- Spans that could not be read are returned as descriptions of where they are,
  never as a guess at their content — the same rule stage 3 follows.
- Lines already present in the thread are dropped, so the trailing context a
  screenshot always includes is not appended twice.
- Without `OPENAI_API_KEY` the route refuses with a 503 rather than returning
  anything.

The messages it appends are ordinary thread messages and feed qualification,
memory and retrieval exactly as typed ones do. Nothing enters the *corpus* by
this route — corpus rows still require the four-stage pipeline above and human
verification.
