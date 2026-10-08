# Audiobookshelf author suggestions

## Original-source evidence (2026-10-08)

Gemini catalog inference now reads available original source evidence before cleaned narration:

- PDF: first six pages of the existing parsed PDF artifact, including title/copyright/byline blocks omitted from audiobook narration. No new PDF extraction job is started.
- EPUB: actual container/OPF title and creator metadata plus the first four spine files. Explicit editor/translator roles are excluded from author metadata (EPUB 2 attributes and EPUB 3 role refinements). Embedded author metadata is retained even if Gemini omits or guesses an author.
- Text/HTML: original document beginning, with HTML script/style content excluded.
- Audiobook chunks: first four chapter keys in numeric order, preferring original text and falling back to cleaned counterparts if missing/empty/unreadable.

The combined excerpt is capped at 12,000 characters. Filename, existing catalog title and existing author remain in the prompt. PDF/EPUB binary bytes are never treated as readable book text. Prompts distinguish authors from quoted scholars, subjects, editors, translators and bibliography names. Unknown author placeholders do not overwrite known catalog/local authors. Missing authors are explicitly reported in the dialog instead of claiming successful author detection.

No web search or external catalog lookup is performed. Missing PDF extraction or absent bylines can still prevent identification; users can enter/verify the author manually. Model suggestions are reviewable catalog metadata, not verified bibliographic assertions. No book text, pronunciation or recording pipeline is modified. Metadata-start logs include excerpt size, evidence-source labels and embedded-author count for troubleshooting.

Verification: focused 57 tests, full unit suite 206 files / 1,744 tests, three real-modal Chromium tests and TypeScript passed. New/affected server helpers and tests pass ESLint with zero warnings. AudiobookshelfModal has an unchanged pre-existing lint baseline (26 errors, 2 warnings), verified by rule/message comparison; no suppressions or unrelated UI migration. Browser APIs and Gemini are mocked, no production upload/provider calls/deployment verification.
