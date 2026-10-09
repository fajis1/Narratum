# PDF source recovery implementation plan

Started: 2026-10-09. Status: document-local recovery workflow implemented; live-provider verification remains unperformed. The current analysis runner is resumable and user-driven, not a continuously running server job.

## Intended behavior

Analyze a PDF's suspect spellings as document-local occurrence groups. Preserve extracted text, propose a corrected surface form (distinct from a dictionary lemma), and require explicit review before application. Accepted corrections are applied at their anchored PDF passages before audiobook cleanup. Pronunciation references and a pronunciation snapshot belong to this document; damaged aliases never enter personal/global pronunciation libraries.

## Stages and acceptance criteria

1. [x] Establish contracts and persistence. Versioned document analysis, all occurrences, group identity, evidence, proposal/approval/rejection, optimistic concurrency, and document ownership. Preserve existing user changes.
2. [x] Connect pre-scan. Retain all occurrence anchors, refresh old extraction caches, register suspect groups, and expose useful reasons rather than unexplained source-repair flags.
3. [x] Implement recovery proposals and review. Bounded Gemini page-image/context analysis, dictionary checks on corrected surface forms, explicit provider/validation diagnostics, and per-occurrence review UI. Never approve based solely on frequency or lexicon headword.
4. [x] Integrate audiobook generation. Apply only accepted, uniquely anchored readings before cleanup; preserve source/audit data; snapshot correction decisions and local pronunciations for deterministic resume. Do not create global aliases. Fail safely on conflicting/ambiguous anchors.
5. [x] Verify and document. Regression tests for repeats, inflections, page anchoring, stale revisions, ownership, proposal rejection and dictionary isolation; Python tests, focused/full units, TypeScript, affected lint, and relevant browser checks. Record live-provider limitations and local handoff.

## Design decisions

- Use a separate server-owned document-analysis store, scoped by authenticated user and content-addressed PDF ID. No pronunciation-library write capability in recovery services.
- Reuse existing Gemini transport/model selection and Greek/Hebrew dictionary adapters.
- Manual acceptance is the initial policy. Page images and dictionaries are evidence, not proof that a model inference is correct.
- Match PDF page plus exact surrounding characters, tolerating whitespace layout changes only. Never globally replace a malformed spelling or substitute a lemma for an inflected surface form.
- Keep UI summaries bounded while retaining the full occurrence index on the server.
- Finished code does not imply successful live dictionary/Gemini/audio verification; report these separately.

## Progress notes

### 2026-10-09 — Discovery

- Read GEMINI.md and local AI-HANDOFF.md; inspected git status. Existing private untracked reports will remain untouched.
- Confirmed scanner retains at most two contexts/occurrences; pronunciation pipeline deliberately blocks source-repair terms. Existing cleanup has mixed-script dictionary handling but no persistent per-occurrence correction layer.
- Audiobook PDF layout extraction differs from pypdf scan extraction. Integration must re-anchor using page/context rather than trusting raw scanner offsets.

### 2026-10-09 — Stages 1–3 implemented; generation integration underway

- Added isolated authenticated document-analysis persistence and optimistic revisions. Existing personal/global dictionaries are read-only inputs to recovery.
- Scanner retains every occurrence; candidate cache version increased to 13. Preview contexts remain bounded to two. Suspect groups include explicit scanner/source-repair reasons.
- Added bounded page renderer, Gemini page-image/context proposals, Greek/Hebrew dictionary enrichment, pronunciation reference + value snapshots, and redacted request/validation diagnostics.
- Added source-recovery panel to pre-scan with per-occurrence page inspection, editing, explicit verification acknowledgment, accept/reject/reset, and stale-request protection.
- Accepted readings participate in subsequent pre-scans, with their generated pronunciations/definitions excluded from automatic library promotion.
- Generation now re-anchors by page and exact nearby characters with whitespace tolerance, preserves an audit artifact, and rejects ambiguous/unmatched approved corrections. Correction/pronunciation snapshots are being connected to resume and re-record paths.

### 2026-10-09 — Stage 4 complete; verification in progress

- Accepted readings now re-anchor into PDF layout blocks before chapter batching and Gemini cleanup. Unmatched/ambiguous anchors stop generation with actionable guidance; already-correct layout text is recognized.
- Saved `source-recovery.audit.json` retains changed original/corrected passages and application IDs. The PDF and shared extraction artifacts remain unchanged.
- Job snapshots and saved audiobook metadata pin approved decisions and pronunciation values. Queue settings reject client-supplied decisions; continuing/legacy books retain prior decisions instead of acquiring new corrections midway.
- Missing pronunciation values resolve only for corrected document terms before cleanup, with no personal/global library promotion. Re-recording reads saved values; output validation protects reviewed grammatical surface forms.
- Focused source-recovery tests, real SQLite revision/ownership tests, all-occurrence Python regression and PDF rendering checks passed. Initial full suite passed 210 files / 1,781 tests. Actual recovery component passed Chromium with mocked APIs; no live provider calls.
- Final hardening adds snapshot-copy and legacy-continuation coverage, local missing-pronunciation generation, and explicit provider/JSON/count/ID/spelling/dictionary failure explanations. Final verification is pending these last changes.

### 2026-10-09 — Stage 5 complete

- Final full unit suite: **211 files / 1,791 tests passed**. Source-recovery regressions cover occurrence identity, exact Unicode, repeats, whitespace wrapping, inflections, already-correct layout text, ambiguity/overlap, ownership, real SQLite optimistic saves, extraction-version invalidation, deletion isolation, malformed provider replies, redaction, reviewed acceptance, missing local pronunciations, client snapshot rejection and legacy continuation.
- TypeScript (`pnpm exec tsc --noEmit`) passed. New modules and associated tests passed ESLint with no warnings. Existing integration files have no added lint findings; the worker's previously unused `sql` import is now used.
- Python: **21 scanner tests + 2 page-renderer tests passed**. Renderer limits requests to six pages and caps raster dimensions.
- Chromium checked the actual recovery component with mocked endpoints: proposals, original-page link, explicit acceptance acknowledgment, reset, edited inflection/IPA clearing, stale-save draft retention, mobile width and absence of browser errors. Evidence screenshot: `/tmp/source-recovery-browser/panel.png` (local only).
- Local handoff updated. Existing private reports preserved, no staging/commit/push/deployment or live provider/audio calls.

### 2026-10-09 — Integrated OCR analysis and reconciliation hardening

- Pre-scan now displays the OCR recovery status and the visible **Analyze OCR Problems** action. Analysis remains opt-in, persists each bounded request, and can be continued after closing/restarting the application. A single click submits at most twelve sequential six-occurrence batches (72 occurrences); stop takes effect after the active batch.
- The scanner conservatively flags rare ASCII words matching a narrow `x…w` OCR shape for review. It does not convert them, and common English words and transliterations remain governed by separate filters. This heuristic is intentionally incomplete.
- Page analysis sends a full-page image plus text-block context crops when PyMuPDF bounding boxes exist. Without coordinates, Gemini receives an explicitly unlocalized page image. The crop is contextual and not word-tight; the owner still checks the original page.
- Proposal requests use bounded transient retries and shared Gemini cooldown/model fallback. Provider failures and invalid responses stop the current action with separate diagnostics; saved earlier proposals remain.
- Review prioritizes larger unresolved groups and supports selected multi-occurrence approval with optimistic revision checks. Each approved record retains its occurrence identity, proposal, page/context evidence, and explicit user verification acknowledgment.
- Effective scan reconciliation now applies individually anchored approvals even when a row also has omitted/legacy occurrence details; unknown occurrences remain unresolved. Exported examples explicitly state when occurrence details were truncated. Repeated same-surface occurrences carry a page-local ordinal that is used only if independently extracted text has the same total and matching context.
- Verification after hardening: 71 focused unit tests; 26 Python scanner/page-renderer tests; TypeScript passed; source-recovery ESLint passed; the desktop/mobile recovery browser tests passed (2/2). Full unit suite passed with 211 files / 1,800 tests on the final run. An earlier full run had one scheduled-task timeout under concurrent load; the test passed in isolation and the later full run.

## How to use the implemented workflow

1. Run a new Foreign Word Pronunciation & Definition Pre-Scan for the PDF. Older cached scans must be refreshed to retain all occurrences.
2. In the visible **OCR source recovery** panel, click **Analyze OCR Problems**. The runner prioritizes frequent unresolved groups and analyzes up to 72 occurrences per click in sequential six-occurrence requests. Use **Continue OCR analysis** to resume saved work.
3. Review proposals by group. Open each original PDF page and check the printed surface spelling before selecting occurrences for bulk approval. AI proposals never become accepted automatically.
4. Open the original page, check the surface spelling and grammatical form, optionally supply Kokoro IPA, and confirm **I checked this occurrence against the printed PDF word** before accepting.
5. Rerun pre-scan to refresh foreign-term detection and definitions. Accepted occurrences are reinterpreted locally; unresolved instances keep their original extracted spelling. Generated values for recovered terms are excluded from automatic personal/global library promotion.
6. Start a new audiobook generation. Approved passages are corrected before chapter batching and cleanup, missing document pronunciations resolve locally, and metadata retains the values used. Continuing books retain their prior correction snapshot; to adopt newer corrections throughout an existing book, regenerate it as a new run after removing its existing generated chapters.

## Operational boundaries and follow-up

- Original PDFs and shared PDF extraction artifacts are unchanged. This is a document-local correction layer, not a global spelling alias or wholesale PDF rewrite.
- No new database migration is required: versioned analysis uses the existing server-owned runtime store with user/PDF keys and ownership checks. Deleting document ownership also cleans that owner's analysis, with existing best-effort cleanup behavior.
- Source recovery adds an authenticated API and a PyMuPDF rendering helper. Deploy the application/worker and helper together using the normal release process; PyMuPDF must be available in `.venv` (it is available in this checkout).
- A missing/ambiguous page-context anchor stops generation rather than applying a speculative substitution. Omitted PDF sections are not globally searched for replacement. The audit artifact records unmatched IDs for diagnosis.
- Gemini analyzes page images and bounded group context, not the entire PDF on every request. Dictionary matches may be absent or identify only a lemma. The document owner remains responsible for confirming the printed surface form.
- The browser coordinates analysis batches; no durable server-side queue, timed retry scheduler, or automatic restart runner exists yet. A provider failure is persisted as a diagnostic and the user can resume with **Continue OCR analysis** after cooldown.
- Full-document spelling grouping reuses the scanner's existing fuzzy groups; it does not claim to recognize every possible font-encoding family. Manual reviewed readings remain available when a group cannot be recovered automatically.
- Generation and pre-scan perform the relevant lexical resolution after source correction; approval does not launch a full paid PDF rescan after each individual click.
- Real Gemini/dictionary calls, production-sized unusual PDFs, Kokoro output and deployment have **not** been verified. The quoted example has not been verified against its actual PDF.


## 2026-10-09 — Final cache, source-integrity and lifecycle hardening

Completed on `feat/automated-pdf-source-recovery`; no merge into main.

- Candidate caches previously used v13 both before and after ASCII detection changed. A matching cache skipped Python entirely. Candidate keys and payload validation now use v14; independent source-anchor compatibility is v1. Legacy analyses with extractionVersion 13 and matching anchors remain compatible; extractionVersion is retained as historical provenance, not a candidate-cache gate.
- Complete all-foreign rescans re-index prior investigated spellings even when cached raw detection lacks Gemini's later source findings. Stable page/offset/surface/context anchors preserve approvals, proposals and individual analysis timestamps. Partial/custom scans retain other indexed decisions. Changed context resets a decision; vanished/shifted anchors remain as invalidated audit evidence, cannot be approved or automatically analyzed, and do not distort current occurrence ordinals. Existing audiobook snapshots remain pinned and unchanged.
- The shared source gate now includes latinizedOcrCandidate independently of English source-review recommendations. The scan blocks these terms before library reuse, dictionary prefetch, ordinary Gemini pronunciation requests, result acceptance, book enrichment and every batch/final global pronunciation/definition merge. Stored source outcomes survive enrichment. Exports cannot advertise stale pronunciations/definitions for blocked aliases; import consults server-held evidence, so client status spoofing cannot release them.
- Scan Refine/Adopt requests carry their scan identity. Refinement, personal profile changes and global promotion check persisted ownership and term evidence. Reviewed corrections use the existing document-local import path, not personal/global adoption. Standalone explicit dictionary-management actions remain supported and do not infer PDF corruption from arbitrary Latin strings. Pre-existing library entries are preserved but cannot establish trust for an OCR candidate.
- Reconciliation clears OCR flags and old source outcomes only for applied occurrences. A mixed effective row with unresolved damaged occurrences remains source-blocked regardless of aggregation order. Accepted exact-surface IPA is reused locally. Lemmas remain separate from grammatical surfaces; a different inflection at an already-corrected ordinal cannot masquerade as the accepted surface.
- The panel separately reports invalidated anchors and approved readings not represented in the latest effective scan. Successful application counters still derive from actual reconciliation, not the number of model suggestions.

### Regression evidence

The shared Python extracted-PDF fixture spans five pages and contains 75 xatagyéw, 8 xataoyéw, 19 téAoc, ASCII xatagew, repeated contexts, ambiguous év and ordinary Latin text. It exercises the real Python detector, scan API background callback, SQLite analysis persistence, actual proposal parser with mocked page/model/dictionary evidence, explicit approval API, cache reuse and effective rescan. Both the old cache namespace and an old-version payload at the current key force detection refresh.

One approved xatagyéw occurrence produces exactly 74 unresolved raw spellings plus one verified καταργέω occurrence. Repeating the scan preserves those counts and the approval without another model call. The original extracted source still has 75 instances. The audiobook source application produces one Greek reading and 74 unchanged raw spellings; source-fidelity validation rejects changing that accepted reading to another inflection. No global pronunciation/definition merge occurs. Additional API coverage rejects scan-driven refinement, personal/global adoption and spoofed imports, including when an old library already contains the malformed alias.

Final verification:

- `pnpm exec tsc --noEmit`: passed.
- `pnpm test:unit`: 212 files, 1,812 tests passed (including all requested source-recovery/transfer suites).
- `.venv/bin/python -m unittest tests.python.test_scan_pdf_foreign_words tests.python.test_source_recovery_pages`: 27 passed.
- `pnpm exec playwright test tests/source-recovery.spec.ts --config /tmp/ocr-playwright.config.ts --project chromium`: 2 passed, desktop and mobile. The isolated config runs the actual bundled component with mocked endpoints and avoids starting production services.
- ESLint checked every changed TypeScript/test file against reviewed HEAD. No new findings. Existing baseline remains: scan route 23 errors/1 warning; refinement route 10 errors/4 warnings; scan modal 141 errors/2 warnings. All other changed files lint clean. These legacy findings were not suppressed or broadened into this patch.
- `git diff --check`: passed. No live Gemini, dictionaries or TTS calls; production PDF not available as an identifiable local fixture. Mocked visual proposals prove integration and safeguards, not real OCR accuracy. Browser-controlled bounded six-occurrence analysis remains as before.

### Files in this hardening patch

- `docs/document-source-recovery-plan.md`
- `src/app/api/documents/scan-foreign-words/import/route.ts`
- `src/app/api/documents/scan-foreign-words/route.ts`
- `src/app/api/documents/source-recovery/route.ts`
- `src/app/api/tts-settings/route.ts`
- `src/app/api/tts/global-pronunciations/route.ts`
- `src/app/api/tts/refine-pronunciations/route.ts`
- `src/components/doclist/ScanForeignWordsModal.tsx`
- `src/components/doclist/SourceRecoveryPanel.tsx`
- `src/lib/server/smart-audio/gemini-foreign-word-scan.ts`
- `src/lib/server/smart-audio/scan-pronunciation-guard.ts`
- `src/lib/server/smart-audio/source-recovery-proposals.ts`
- `src/lib/server/smart-audio/source-recovery-store.ts`
- `src/lib/shared/foreign-word-scan-transfer.ts`
- `src/lib/shared/foreign-word-source-integrity.ts`
- `src/lib/shared/source-recovery.ts`
- `src/types/source-recovery.ts`
- `tests/fixtures/ocr_source_recovery.py`
- `tests/python/test_scan_pdf_foreign_words.py`
- `tests/source-recovery.spec.ts`
- `tests/unit/foreign-word-scan-import-route.vitest.spec.ts`
- `tests/unit/foreign-word-source-integrity.vitest.spec.ts`
- `tests/unit/gemini-foreign-word-scan.vitest.spec.ts`
- `tests/unit/source-recovery-lifecycle.vitest.spec.ts`
- `tests/unit/source-recovery-proposals.vitest.spec.ts`
- `tests/unit/source-recovery-route.vitest.spec.ts`
- `tests/unit/source-recovery-store.vitest.spec.ts`
- `tests/unit/source-recovery.vitest.spec.ts`
