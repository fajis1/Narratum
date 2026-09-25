# Pronunciation repair review

## Review and override workflow

Pronunciation repair proposals are intentionally validated against the saved
source text. A proposal can be structurally valid but still be rejected when
it changes a Greek/Hebrew spelling or reconstructs an OCR word without source
evidence. The review page displays the validator reason and the affected
finding text.

When a reviewer has confirmed that the difference is a genuine OCR or
cross-script artifact, select the checkbox for that specific finding and use
**Approve with override**. The selected finding IDs are recorded with the
approval. Recording applies the same per-finding exception; unchecked findings
remain protected by source-evidence validation.

Simply adding a pronunciation tag to an existing Greek/Hebrew word does not
need an override. For example, raw `θεῷ`, `τῷ`, and `ὀνόματι` can be safely
tagged because their source spelling is unchanged. A mixed-script token such as
`[φρονեω]` may require an override if the reviewer confirms the OCR character
should be replaced with Greek.

The override does not bypass other safety checks. English text, voice markup,
malformed or unsafe IPA, unresolved pronunciation findings, stale chapter
text, active generation jobs, and recording-time source checks can still block
approval or recording.

The scanner classifies findings as formatting, missing pronunciation,
contextual notation, unsafe pronunciation, structural damage, or OCR/source
change. Only OCR/source changes and source-changing structural repairs are
eligible for the override checklist. The report retains this classification
alongside Gemini's returned candidate and the validator reasons.

Predictable delimiter errors are repaired locally. For example,
`[ποικίλων](/pɔɪkɪloʊn/]` becomes `[ποικίλων](/pɔɪkɪloʊn/)` without an AI
request. A malformed closing delimiter is bounded at that tag, so it cannot
swallow later valid tags and become a misleading nested-region finding.

Elided forms such as `δ᾽` and `γ᾽` are contextual. The printed elision mark is
preserved, and the fixer may reuse an approved pronunciation for the complete
word (for example `δέ`) without saving the elided label as a reusable
dictionary entry. A bare consonant is not treated as a word.

Examples that may require a reviewer decision include an Arabic character in a
Greek word, or a Greek phrase where Gemini correctly identified an OCR spelling
but cannot prove it from the retained source artifact. Broad manuscript edits
and deletion of long foreign passages belong to the text-cleaning/OCR stage,
not the pronunciation-only repair stage.

## Failed chapter isolation and download gating

Background generation isolates unrecoverable chapter failures instead of aborting
the entire audiobook:

- If a chapter fails targeted pronunciation repair (`SmartAudioTargetedRepairError`)
  or final validation recovery (`SmartAudioOutputValidationError`), or encounters TTS
  synthesis failures, the failure artifacts (`*__rejected.txt` and
  `*__pronunciation_failure.json`) are retained, the chapter is marked for review,
  and the worker advances to subsequent chapters without aborting the job.
- When the targeted pronunciation fixer repairs a malformed dictionary pronunciation
  (such as compacting spaced phonemes `/siːk lənd/` $\to$ `/siːklənd/`), the corrected
  IPA is immediately updated in memory, synchronized to the user's active Smart Audio
  profile (`updateSmartAudioProfilePronunciations`), and written to the book's
  `bookLexicon` so subsequent chapters and reconciliation passes do not re-apply the
  malformed pronunciation.
- Single-word dictionary lookups (`buildPronunciationLookup`) automatically compact
  whitespace between syllables or phonemes for single words, ensuring dictionary entries
  comply with Kokoro single-word token alignment.
- When remembering approved pronunciations (`rememberApprovedPronunciations`), existing
  dictionary entries with broken or spaced IPA are overwritten with the approved
  repair and propagated to the active profile, while valid conflicting pronunciations
  remain untouched.
- The audiobook job completes with a review-required status message indicating how
  many chapters require manual attention.
- **Download Gating**: Full-book combined assembly (`GET` / `POST /api/audiobook`)
  is blocked with HTTP 409 `AUDIOBOOK_CHAPTER_REVIEW_REQUIRED` while any
  `*__rejected.txt` artifacts exist for the document.
- Attempting to download an audiobook with unreviewed chapters redirects the user
  to `/listen/[bookId]?reviewPronunciation=true`, automatically opening the
  pronunciation review modal.
- For chapters that failed due to TTS or processing errors rather than dictionary
  IPA issues, the review tool synthesizes an editable whole-chapter finding
  (`failed-chapter`). This allows the reviewer to inspect or edit the text and
  re-record.
- Once a rejected chapter is successfully approved and re-recorded via Batch Refine,
  its `*__rejected.txt` and `*__pronunciation_failure.json` artifacts are deleted,
  clearing the download gate once all chapters pass.

## Foreign-word pre-scan review area and candidate normalization

In addition to chapter-level review during audiobook generation, the pre-scan stage
identifies, flags, and repairs lexical pronunciation and definition issues prior to
synthesis.

### Pre-scan Review Area and filter tabs

When a foreign-word scan completes or an edited scan JSON is imported:
- An **amber Review Area banner** appears at the top of the table if any terms require review
  (due to invalid contextual definitions, invalid pronunciations, missing pronunciations,
  or profile override conflicts).
- The banner provides a one-click toggle to filter the table directly to flagged words, as well as an
  **Export Flagged Words JSON** button that exports only the items requiring resolution.
- Filter tabs above the table allow immediate switching between:
  - **All Words**: The full vocabulary list.
  - **⚠️ Flagged for Review**: Terms requiring manual correction or omission.
  - **Missing Pronunciation**: Terms currently lacking any valid Kokoro IPA.
  - **Has Definition**: Terms with assigned English glosses.
- Inline row action **🚫 Omit definition**: Allows reviewers to instantly clear definition review
  issues on grammatical stop-words (e.g. Hebrew/Greek pronouns or prepositions) with a single click.

### Companion AI instructions (`AI-INSTRUCTIONS.md`)

When exporting scan data for external review or AI agent processing:
- A companion `AI-INSTRUCTIONS.md` guide is automatically downloaded alongside the JSON file
  (or bundled inside the root of batch ZIP archives).
- The guide instructs agents on strict field boundaries (immutable `word` keys and extraction
  evidence), Kokoro IPA formatting rules, 1–4 word definition limits, and mandatory omission
  of grammatical stop-words (`omitDefinition: true`, `proposedDefinition: null`).

### Deterministic pronunciation candidate normalization

The pronunciation normalization rules originally implemented in the Smart Audio worker
(`scanPronunciationIssues` and `buildPronunciationLookup`) have been centralized in
`normalizeKokoroPronunciationCandidate` (`src/lib/shared/kokoro-pronunciation-policy.ts`)
and backported across all pre-scan, import, and repair pipelines:
- **Delimiter wrapping and typo repair**: Bare phonemes are wrapped with `/.../` forward slashes,
  and typos like `/]` or `/)` are corrected to `/`.
- **Markdown tag unwrapping**: Formats like `[word](/ipa/)` or `[/ipa/]` are unwrapped to bare `/ipa/`.
- **Ghost syllable prevention**: Unsupported primary and secondary stress markers (`[ˈˌ']`) are
  stripped to prevent Kokoro model hallucination and stuttering.
- **Single-word whitespace compaction**: Spaces between syllables or phonemes (e.g., `/hɑː dɑːm/` $\to$
  `/hɑːdɑːm/`, `/siːk lənd/` $\to$ `/siːklənd/`) are compacted for single words while preserving
  comma-delimited initialisms like `/K, T, L/`.
- **OCR artifact stripping**: Leading and trailing OCR digit fragments (e.g. `118Lamaštu` $\to$
  `lɑːmɑʃtuː`) are safely stripped.
- **Stop-word gloss auto-omission**: On JSON import, dictionary definitions for function words
  and stop-words are automatically converted to `definition: null` with `omitDefinition: true`
  instead of failing with an `Invalid contextual definition` warning.

## Operational notes

- Wait for background generation and repair jobs to finish or pause before
  approving or retrying recordings.
- **Retry all failed recordings** requeues only already-approved recordings
  whose audio status is failed; it does not approve pending proposals again.
- After deployment, rescan or retry old proposals so they use the current
  patch-scoped repair and per-finding override behavior. Existing rejected
  proposals are not silently rewritten.
