# Pronunciation repair reliability — next release

Verified 2026-10-07.

- Bare Greek/Hebrew scanning now requires a Unicode letter. Combining marks
  remain attached to lexical words; script-associated punctuation and detached
  marks do not become missing-pronunciation findings. Hebrew maqaf, sof pasuq,
  paseq and nun hafukha remain exactly where printed, outside lexical tags.
- A bounded contextual classifier distinguishes scholarly letter references
  from lexical words and unsupported/mixed source writing systems. Immediate
  edition/manuscript/translation/text/symbol/letter wording and recognized
  citation forms provide positive evidence. Capitalization alone never does.
- Proven Greek references use local broad English Greek letter names for the
  standard 24-letter alphabet. Repeated references are resolved independently
  from their own context, before key resolution or Gemini requests. This does
  not reuse decisions across unrelated contexts or English heteronyms.
- Inline policy explicitly receives chapter context. Contextual Greek names
  still require Kokoro-compatible IPA and the selected letter-name convention.
  Global dictionary validation retains its stray-consonant and source-integrity
  rules. Approved single-letter annotations are never learned as lexical keys.
  Latin/Hebrew labels can be classified contextually, but are not assigned Greek
  names or speculative deterministic pronunciations.
- Candidate checks validate assembled chapter context, rather than rejecting
  proven references when scanned alone. Optional diagnostics retain token
  classification, evidence, validation scope and local letter-name provenance.
  Existing reports/proposals remain readable; no database migration is needed.
- Repair source comparison now retains all scripts, punctuation and whitespace,
  rather than comparing only Greek/Hebrew runs. Existing narrowly validated
  malformed-markup and source-supported reconstruction paths remain available.
  Nested tag deduplication additionally requires matching outer/inner labels.
  Cyrillic labels cannot silently become Greek. Greek partial-word/vowel-nucleus
  validation is unchanged for lexical words.
- Gemini repair instructions distinguish contextual letter names, immutable
  Hebrew punctuation, and source-supported OCR reconstruction. Provider blocking
  continues to retain model/key-role/status/retry diagnostics and remains
  distinct from rejected candidates or linguistic uncertainty.

## Job finalization

The worker already writes a chapter checkpoint before its final status update.
A `running`, 100%, null-completion snapshot can therefore occur during that
short database-update window. All accounted-for nonblocked results subsequently
become `error` when any chapter failed, otherwise `completed`, with `completedAt`
and no active retry deadline. Saved results are skipped on recovery, allowing an
all-accounted-for checkpoint to finalize without new AI work. The outer worker
handles escaped errors and resets orphaned running jobs on startup or after a
stale heartbeat; no permanent terminal-state defect was reproduced.

API-blocked work retains the existing bounded queued/future-deadline policy.
Queue transitions now explicitly clear `completedAt`, including a stale inherited
completion timestamp. Retry exhaustion becomes terminal `error` and removes the
active deadline. Historical per-attempt suggestions remain separate from the
report's active queued retry schedule.

## Verification

- Focused scanner, policy, engine/service, approval/recording, jobs, reporting,
  diagnostics, editorial-word and dictionary-learning tests passed.
- `pnpm test:unit`: 200 files, 1,672 tests passed, including existing API failover,
  foreign-word scanning and Smart Audio protections.
- `pnpm exec tsc --noEmit`: passed.
- `pnpm exec eslint` for all affected TypeScript files: passed. The legacy
  `pnpm lint` script uses `next lint`; direct ESLint is used for this release check.

Regressions include 24 repeated Θ references with no Gemini calls, isolated
consonant rejection, wrong letter-name rejection, Hebrew punctuation-only input,
maqaf before two different lexical words, combining marks, source punctuation
mutation, Cyrillic-to-Greek rejection, incomplete περι, 503 and quota/Retry-After
outcomes, report compatibility, and both terminal and active-retry job states.

## Limits

Context recognition is intentionally conservative and uses bounded English
scholarly cues/recognized citation forms. Unrecognized roles, historical Greek
letter variants, non-Greek letter-name pronunciation, and uncertain OCR remain
review work; they are not guessed. Standard Greek names use one broad English
narration convention. Existing normalization conventions and explicit reviewer
source overrides remain in place. No live provider or audio-listening test was
performed. Existing occurrence counts are unchanged; classification diagnostics
supply the distinction without a new persisted grouping schema.
