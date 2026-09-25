# Narratum prescan work: handoff for the next agent

Updated 2026-09-25. Worktree branch: `main`.

## What is implemented

- Complete Unicode tokenization prevents accented fragments such as `šš` and `ššā` from being extracted out of `Aššurbanipal` and `haššāmayim`.
- Occurrence records retain PDF page and source offsets, centered context, extraction provenance, and quality evidence. The candidate cache version is 12.
- Hebrew extraction disagreement is surfaced as source-review evidence. The pipeline does not reverse text or invent source corrections.
- Gemini can return `needs_source_repair` or `insufficient_context`; the scan asks for one safe pronunciation rather than five alternatives. Unresolved source rows are withheld from reusable generated pronunciation/definition entries.
- Scan export is version 2 and includes occurrence/source evidence. Imports remain compatible with version 1; source-sensitive import decisions use the stored scan job, not client-edited status fields.
- A read-only old/new scan comparison is available as `scripts/prescan_cleanup_dry_run.py`. It does not delete or rewrite dictionary records.
- Page-179 visual/manual check and the maqqef context fix are documented in `docs/narratum-prescan-source-quality-report.md` and `/tmp/narratum-prescan-inputs/page-179-review.md`.
- **Pre-Scan Review Area & Filter Controls**:
  - Embedded amber **Review Area Banner** in `src/components/doclist/ScanForeignWordsModal.tsx` showing the number of flagged words, a breakdown of stop-word/definition vs pronunciation issues, a toggle between `Filter to Flagged Words` and `Show All Words`, and a one-click `Export Flagged Words JSON` button.
  - Filter tabs above the table (`All Words`, `⚠️ Flagged for Review`, `Missing Pronunciation`, `Has Definition`).
  - Auto-switches `reviewFilter` to `'flagged'` upon importing scan files that have skipped/flagged words so users are immediately brought to the review view without hunting through thousands of rows.
  - Dedicated `downloadFlaggedScanJson` that exports only the flagged terms, automatically pre-populating `omitDefinition: true` and `proposedDefinition: null` on Hebrew/Greek stop-words with invalid contextual definitions so they can be re-imported without manual JSON editing.
  - Added inline `🚫 Omit definition` button on table rows for words flagged with definition review issues.
- **Companion AI Agent Instructions Guide (`AI-INSTRUCTIONS.md`)**:
  - Automatically generated companion Markdown guide (`generateForeignWordAiInstructions` in `src/lib/shared/foreign-word-scan-transfer.ts`) bundled with all JSON exports (full export, flagged export, and batch ZIP archives).
  - Dedicated `📄 AI Agent Guide (.md)` button in the scan modal header for on-demand downloading of the guide.
  - Defines strict editing rules: immutability of `word` key and read-only evidence, Kokoro TTS IPA formatting rules, 1–4 word single-meaning definition constraints, stop-word omission mandates, and before/after JSON examples.
- **Deterministic Pronunciation Normalization**:
  - Added centralized `normalizeKokoroPronunciationCandidate(word, raw)` to `src/lib/shared/kokoro-pronunciation-policy.ts`:
    - Wraps bare phonemes with `/.../` forward slashes.
    - Fixes malformed delimiter endings (e.g. `/]` or `/)` -> `/`).
    - Strips markdown link wrappers (e.g. `[word](/ipa/)` or `[/ipa/]`).
    - Strips unsupported primary and secondary stress markers (`[ˈˌ']`) to prevent Kokoro ghost syllable artifacts.
    - Compacts inner whitespace between phonemes or syllables for single words (e.g. `/hɑː dɑːm/` -> `/hɑːdɑːm/`) while preserving comma-separated initialisms (e.g. `/K, T, L/`).
    - Strips leading and trailing OCR digits (e.g. `118Lamaštu` -> `lɑːmɑʃtuː`).
    - Enforces safety policy when a word term is provided (`isKokoroSafePronunciation`).
  - Integrated across pre-scan route, JSON import route, global pronunciation rescan route, and Gemini repair requests.
- **Stop-Word Auto-Omission on JSON Import**:
  - `parseForeignWordScanImportDetailed` in `src/lib/shared/foreign-word-scan-transfer.ts` automatically converts stop-word/function-word glosses (`shouldOmitDictionaryDefinition(row.proposedDefinition)`) to `definition: null` with `omitDefinition: true` rather than rejecting them with `Invalid contextual definition`.

## Page 179 check already performed

Constructing the Human PDF page 179 (printed page 165) has materially conflicting text extraction. pypdf omits a Hebrew word-study sentence; PyMuPDF returns Hebrew in reversed/damaged order. The page image itself is readable. A short note-3 phrase was transcribed at consonant level as `מאדם עד־בהמה עד־רמש ועד־עוף השמים`; vowel points remain unverified. Rescanning that explicit corrected-text fixture yields six complete candidates with the full phrase as context and page 179 attached.

This confirms only the image-to-token/context step. Gemini did not read the image or generate pronunciation in this run, and no audio was produced.

## Remaining task: complete the live demonstration

Run this sequence on the limited page-179 excerpt:

1. Ask Gemini vision to transcribe the selected image crop and return the raw reading, normalized reading, confidence/uncertainty, and any ambiguous glyphs. Keep the pypdf and PyMuPDF outputs beside the proposed transcription.
2. Compare Gemini's result with the rendered page and the author's transliteration/context. Preserve an unresolved status if the pointing or any consonant cannot be read. Do not silently substitute a canonical Bible text.
3. Feed the verified corrected excerpt through the production scanner path, retaining original PDF page, block/region, offsets, corrected source text, and target-centered context.
4. Send the resulting terms and contexts to the configured Gemini pronunciation path. Request one recommended Kokoro-safe IPA per verified lexical term; keep unresolved results out of reusable dictionaries.
5. Synthesize a short sample with the configured Kokoro-compatible endpoint using those exact IPA values. Save the audio and transcript as local demonstration artifacts, listen to it, and record whether each Hebrew word was pronounced acceptably.

## Workspace dependency status

At the last check, this checkout has no Gemini API key in `.env` or process environment, no local Tesseract executable, and no service listening at `127.0.0.1:8880`. No plugin connection for Gemini was available. Never ask the maintainer to paste a secret into chat or commit it. Use the server/profile secret store or a secure local environment configuration; report only whether it is configured. Recheck before assuming the state is unchanged.

The PDFs and original 2,055-entry v1 JSON are in `/tmp/narratum-prescan-inputs/` on the current machine and are not tracked by git. The v1 export belongs to Constructing the Human only. Do not commit either PDF or claim the old JSON is repaired by changing word keys. Avoid production cleanup until an actual database provenance inventory is backed up and reviewed.

## Current commits and checks

Recent commits on `main`:

- `745d234` feat(prescan): backport pronunciation normalization and stop-word handling across prescan and import
- `d7a01eb` feat(prescan): companion markdown instructions for AI agent scan processing
- `52cde3f` feat(prescan): add dedicated Review Area view, filter tabs, and flagged JSON export
- `cbce1c8` feat(drama): wire Google Cloud Audio Drama pipeline into generation buttons
- `d01a89f` feat(drama): support character importance, auto-assign minor voices, and voice previews
- `a215b16` context punctuation preservation around Hebrew maqqef.

Last verified: full unit suite 178 files / 1,345 tests passing; TypeScript: `tsc --noEmit` clean; `git diff --check` clean.
