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

## Pre-merge hardening — 2026-10-07

The existing contextual-token architecture is unchanged. Ethiopic/Geʽez now
participates in lexical scanning, bracketed-word repair, token script diagnostics
and final Smart Audio bare-foreign validation. Punctuation and detached combining
marks remain nonlexical. Ethiopic never enters the Greek letter-name convention.
Source labels may be Ethiopic; pronunciation still requires Kokoro-compatible
phonetic output. Approved dictionary repairs for ኵሎ, ኅቡኣተ and ጥበቦሙ preserve
Ethiopic separators without a Gemini call.

Private ordinary and malformed-markup source-equivalence comparisons no longer
NFC-normalize labels. Adding IPA must retain the stored code-point sequence;
canonical equivalence does not authorize silently composing Greek characters or
reordering Hebrew combining marks. Linguistic inspection, dictionary/phonetic
normalization and verified source-reconstruction conventions remain unchanged.
Approval/recording regressions enforce the same exact-label boundary.

The real outer worker is now exercised against isolated in-memory SQLite in
`tests/unit/audiobook-worker-pronunciation-recovery.vitest.spec.ts`. Both process
restart and stale-heartbeat cases begin at running/100%, with all selected
chapters accounted for, one failed result, null completedAt and no retry
deadline. The worker recovers, reclaims and dispatches the saved job to real
repair finalization, reaching error/100% with completedAt and unchanged results,
without proposing repairs again. A fresh running job is not reset by the stale
heartbeat sweep. No production worker lifecycle change was necessary.

Hardening verification: 13 focused files / 226 tests; full unit suite 201 files /
1,698 tests; TypeScript, affected-file ESLint and whitespace checks passed. No
live provider or audio test was performed. Earlier Greek siglum, strict lexical
dictionary, Hebrew punctuation, mixed-script, partial-word, API-blocking and
bounded-retry protections remain covered and passing.

## Supported-script consistency — 2026-10-07

Smart Audio pronunciation-label mixed-script validation now derives its count
from getSupportedSourceScripts(), eliminating the obsolete Latin/Greek/Hebrew
list. The shared Latin/Greek/Hebrew/Ethiopic registry is authoritative. Nine
regressions accept pure Ethiopic/Greek/Hebrew labels and reject all six supported
script pairs at normalization and final validation. Other script-specific
transliteration, inflection, Scholar omission and reconstruction policies remain
unchanged. Verified seven focused files / 195 tests, full unit suite 201 files /
1,707 tests, TypeScript, affected-file ESLint and whitespace checks.

## Explicit reviewer Override (2026-10-08)

Scan Pronunciation Issues includes a prominent, unchecked-by-default **Override** checkbox. Checking it makes **Accept all proposals with Override** include every pending saved proposal, including partial proposals with unresolved pronunciation findings. A confirmation precedes bulk approval. Individual Review & Approve also carries the checked choice. Failed/omitted provider responses without a saved proposal are not invented or accepted.

Override accepts pronunciation-quality/completeness warnings, including scholarly letter-name proposals with remaining bare sigla. It does not promote contextual tokens into a dictionary, change the default scanner or weaken ordinary approval. Exact source and flagged-region validation, Unicode character fidelity, speaker assignments, malformed-markup checks, ownership, chapter hashes and job-conflict checks remain enforced. Source-reconstruction/manual-edit overrides remain separate controls.

Approval records the reviewer decision in the existing review note; the recording worker reads that decision and applies the same scoped validation. The Scholar completeness gate honors it at both stages. A subsequent strict approval clears the pronunciation-review marker. Checkbox state resets on closing/reopening or changing books. No database migration is required.

Verified: focused validator/approval/scanner suites (90 tests), recording-worker regressions (3 tests), full unit suite (203 files / 1,726 tests), TypeScript and affected-file ESLint with zero warnings. Chromium exercised all seven scan-to-approval workflows, including override confirmation cancellation, accepting partial proposals, individual override approval and reset after reload. Provider/audio calls were mocked.
