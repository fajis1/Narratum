# Pre-scan JSON imports and rescans

Successful JSON imports save pronunciation and definition edits in the selected
book's lexicon. The import response includes the updated scan job, so the table,
manual-review count and manual-review export update together. Successfully saved
terms are removed from the persisted manual-review list; skipped and untouched
terms remain. Reopening the pre-scan shows the same updated list. Historical
Gemini generation counters are retained.

An import with saved edits shows All Words, making the accepted edits visible
even when other rows were skipped. Skipped rows retain their individual reasons.
A corrected re-import clears the import-validation flag and restores the source
status recorded before that import failure. Independent source-quality warnings
remain; older warnings without stored source-status provenance are preserved.

Rescans reuse compatible book pronunciations for the same Smart Audio profile,
display them as document choices, and keep imported definitions and explicit
definition omissions. Personal overrides retain precedence for ordinary terms;
verified OCR readings retain their existing document-local precedence. Imported
definitions are not automatically promoted to the global dictionary. A Scholar
scan can still request missing definitions, and invalid stored pronunciations
still need repair.

An imported pronunciation does not verify damaged PDF source text. Source-repair
rows remain blocked until the OCR recovery workflow resolves the printed reading.
Setting `omitDefinition: true` only omits the spoken gloss: it does not bypass the
requirement for a valid pronunciation or the source-repair checks.

Regression coverage includes the real scan/import API lifecycle with SQLite and
mocked providers, repeated rescans, personal/global precedence, explicit
omissions, import-only flag cleanup, and a mounted browser import/reopen flow.
These fixtures do not verify a particular production book's database or PDF.

## Reviewed defaults and formatting experiment

The pre-scan now offers **Use reviewed pronunciation defaults**, enabled by
default. Version 1 contains 12 exact Greek spellings (including explicit acute
and grave variants) and three fully pointed Hebrew function terms. The table
follows Narratum's default Erasmian/academic guidance. These are code-reviewed
English-compatible approximations; production audio quality has not been
certified. Custom pronunciation guidance disables the table. NFC-equivalent
spellings can match, but lookup never removes accents or Hebrew pointing,
changes case, infers an abbreviation, or repairs source text.

Personal, book and global pronunciations take priority. A table entry can fill
an absent pronunciation and omit its function-word gloss, or supply only an
omission when a compatible saved pronunciation lacks a gloss. Existing
definitions, explicit user approvals and review findings remain authoritative.
Source-quality warnings, suspected/confirmed OCR and recovered document readings
prevent table lookup. Built-in choices stay document-local and retain versioned
provenance. Disabling the checkbox retracts unapproved automatic choices and
omissions on subsequent scans; manually imported/approved choices are retained.
If Gemini has subsequently supplied a value, it is an ordinary saved value and
will be reused by later scans, so production comparisons require accounting for
that warmed library.

Completed scans report **Reviewed defaults used** and **Gemini terms with
formatting normalized**. The first counts unique terms using a fallback or a
missing-gloss omission; it is a subset of library matches skipped by Gemini.
The second counts unique Gemini terms with an accepted pronunciation whose
formatting was normalized. It includes existing stress/delimiter/whitespace
normalization, so it is not a count of newly avoided API calls.

Internal syllable periods are removed only from lowercase phoneme segments with
a vowel nucleus in each segment and phonetic evidence. Empty/leading/trailing
segments, dotted initials and plain dotted prose are rejected. The result still
faces word-dependent pronunciation/source checks. No vowel, consonant or glide
substitution is introduced. Imports and Gemini repair decisions use the same
normalizer. Locally resolved terms also skip Sefaria/Perseus enrichment requests.

The isolated API fixture compares the same four known terms with defaults on
and off, including after persistence, and checks a dotted Gemini result accepted
with one provider call and no repair call. Real production savings depend on
candidate coverage and existing libraries; real listening remains a follow-up.

## Smart Generate readiness is separate

Scholar and bibliography-catcher queue checks require a book lexicon marked
`status: "complete"`, `definitionScanComplete: true`, matching the selected
profile, with compatible saved pronunciations. Importing JSON preserves the
existing completion state. A cancelled scan plus successful imports can therefore
still trigger the Smart Generate warning. A blank definition with
`definitionOmitted: true` is intentional and does not require an AI gloss.

A complete, unfiltered All Foreign or Greek/Hebrew scan under the Scholar
profile records completion when all batches finish without errors. Alternatively,
the explicit **Continue & Auto-Scan** action lets generation resolve outstanding
terms from chapter text using saved choices. It does not promise a request per
blank definition: omitted definitions and compatible saved choices are reused.
Do not equate a null-definition count with the unresolved-term count, or force
completion flags without verifying scan coverage and the selected profile.

## Contextual language recognition

All Foreign now includes uncommon Latin spellings without diacritics when
`wordfreq` is available, plus Japanese kana and Ethiopic ranges. This broadens
candidates, not confirmed languages: ordinary English and unrelated names should
receive `not_applicable`. Greek/Hebrew mode retains its biblical-only scope.
The candidate cache version is bumped so old extraction results are recomputed.

Gemini identifies a separate `detectedLanguage` from spelling and nearby text,
with `languageConfidence` and optional language/abbreviation ambiguity. The
legacy Greek/Hebrew/other field remains compatible. Script is evidence, never
proof of a particular language: Cyrillic need not be Russian; Hebrew script
need not be Biblical Hebrew. These optional fields persist in the book lexicon
and exports; old saved entries remain readable without fabricated metadata.
New structured generation responses require language identification/confidence;
repair requests retain that guidance. Resolved non-biblical entries survive a
later biblical auto-scan, and audiobook insertion uses whole-word boundaries
across scripts so a pronunciation cannot replace only part of another word.

Source validation now accepts Cyrillic, Arabic, Han and Japanese kana in
addition to Latin, Greek, Hebrew and Ethiopic. Han/kana combinations are valid;
unrelated mixed alphabets still require source review. Pronunciation characters
remain English-compatible IPA, independent of the source alphabet. Contextually
identified German/French/Latin and other languages receive their own guidance,
and the Koine silent-p/syllable checks are not applied to identified non-Koine
readings. Imports use server-owned scan language metadata, not upload assertions,
for these language-dependent checks.

Identified foreign languages may receive useful Scholar definitions. Explicit
omissions are respected. New non-biblical pronunciations and definitions stay
document-local to avoid cross-book homograph conflicts. Classification happens
in the existing generation request; it adds no separate language-identification
call. Broad Latin candidate selection may increase the initial work queue.

The table shows the model's language/confidence and current review reasons:
unsupported script, source repair/review, ambiguous language or abbreviation,
insufficient context, failed import, missing/invalid pronunciation, or unresolved
definition. An intentional omission is labelled separately. Confidence below
0.7 or an unknown language remains flagged; this is a review threshold, not a
calibrated probability. Unsupported scripts avoid futile generation calls.
Exports recompute reasons from current evidence and include script/language
metadata. Neither language recognition nor parser acceptance certifies native
pronunciation or acoustic quality; real listening on future books remains needed.
