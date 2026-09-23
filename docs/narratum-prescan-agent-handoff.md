# Narratum prescan work: handoff for the next agent

Updated 2026-09-23. Worktree branch: `fix/prescan-source-quality`.

## What is implemented

- Complete Unicode tokenization prevents accented fragments such as `šš` and `ššā` from being extracted out of `Aššurbanipal` and `haššāmayim`.
- Occurrence records retain PDF page and source offsets, centered context, extraction provenance, and quality evidence. The candidate cache version is 12.
- Hebrew extraction disagreement is surfaced as source-review evidence. The pipeline does not reverse text or invent source corrections.
- Gemini can return `needs_source_repair` or `insufficient_context`; the scan asks for one safe pronunciation rather than five alternatives. Unresolved source rows are withheld from reusable generated pronunciation/definition entries.
- Scan export is version 2 and includes occurrence/source evidence. Imports remain compatible with version 1; source-sensitive import decisions use the stored scan job, not client-edited status fields.
- A read-only old/new scan comparison is available as `scripts/prescan_cleanup_dry_run.py`. It does not delete or rewrite dictionary records.
- Page-179 visual/manual check and the maqqef context fix are documented in `docs/narratum-prescan-source-quality-report.md` and `/tmp/narratum-prescan-inputs/page-179-review.md`.

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

Commits on this branch:

- `6bd5dfc` complete-word tokenization and target-centered context.
- `4f6816d` source-quality evidence and cache version 12.
- `572c727` explicit Gemini source outcomes and one-pronunciation policy.
- `e005b78` evidence-rich v2 transfer and trusted import guards.
- `b3ab563` read-only cleanup comparison and report.
- `99591d5` source-aware scan choice typing.
- `a215b16` context punctuation preservation around Hebrew maqqef.

Last verified: full unit suite 177 files / 1,321 tests; scanner Python tests 19; TypeScript; focused Gemini/Groq and transfer/import tests. Full route ESLint still reports numerous violations in the large pre-existing scan route; record the exact current result if lint is rerun. No live Gemini/Groq request, Kokoro synthesis, dictionary cleanup, deployment, or push was performed.
