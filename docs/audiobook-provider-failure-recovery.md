# Audiobook provider failure recovery

Branch: `fix/audiobook-provider-failure-recovery`
Baseline: `fe2683c1a7ecb0df5dbb71d69d565f2fa28120ca`

## Plan and progress — 2026-10-09

- [x] Trace repair, validation, TTS, queue and completion paths.
- [x] Implement typed classification and preserve sanitized provider diagnostics.
- [x] Persist bounded provider-independent retries and release workers.
- [x] Pin chapter mappings; preserve recordings and validated intermediate text.
- [x] Reconcile durable completeness and guard full-book compilation.
- [x] Separate diagnostic history from active failures.
- [x] Verify explicit same-job recovery, cancellation and concurrent-job guards.
- [x] Run TypeScript, unit, Python, focused browser and affected lint checks.
- [x] Prepare scoped feature-branch delivery; commit and push for review without merging main.

## Diagnosis and evidence limits

Broad targeted-repair catches obscured provider errors. Validation recovery could save a manual-review artifact before classification, and the worker grouped repair outages with invalid content and skipped chapters. Message-based TTS heuristics conflated availability failures with Gemini quota. Completion could mark partial books completed and attempt compilation.

The seven historical Gemini failures cannot be assigned an exact HTTP/transport cause from retained evidence. Chapter 19's 503 without a body establishes upstream unavailability, not a particular cause/provider. Chapter 20 establishes Kokoro failed readiness before the startup deadline; the reason initialization failed is unknown. No historical job is automatically requeued.

## Classification and retry implementation

Typed failures distinguish transient provider, permanent configuration, content validation, explicit cancellation and unknown technical exceptions. Wrapping preserves causes; exports allowlist provider, stage, HTTP status, safe code, model, attempts, retry delay and chapter. Messages redact configured secrets and common credential forms; raw authorization headers are not exported.

429, temporary 5xx and appropriate transport/timeouts defer. Permanent 401/403 and configuration errors stop with actionable errors. A 403 is transient only with explicit resource-exhaustion and retry evidence. Successful-but-invalid output retains strict source, Unicode, IPA, dictionary and speaker validation. Provider failures do not create manual pronunciation artifacts.

Kokoro readiness and structured SDK 503 failures retain actual TTS provider/model identity and observed GPU state. Existing arbitration and cancellation remain; requests defer rather than restarting healthy services or extending startup waits indefinitely.

Atomic settings patches merge into the current stored JSON. Queued jobs persist nextAttemptAt and retry metadata; every valid future retry time gates claiming independently of the error message. Six automatic deferred attempts use five-minute exponential backoff capped at one hour, honoring longer provider Retry-After. A subsequent failure stops with an accurate provider error. Counts survive restart and reset only after the corresponding provider/stage/chapter recovers. Explicit resume and manual Retry/Resolve clear obsolete schedules. Cancellation never schedules another attempt.

## Preservation, completeness and history

Original chapter maps are pinned and reused before parsing or rebatching. Legacy resume verifies retained source evidence and indices; changed/unverifiable boundaries stop safely. Existing audio and records survive. Shared idempotent chapter writes reuse legacy IDs and prevent duplicate new records.

Standard/Scholar validated text is saved before TTS. Reuse requires matching immutable source/profile/source-recovery/dictionary/cast/batching/validation identity, content hashes and renewed validation. Conflicting saved Review Workspace edits stop with instructions rather than being overwritten. Multi-voice/Drama cleanup is not cached.

Expected pinned chapter indices reconcile against persisted records and audio blobs, respecting intentional omissions. Missing recordings produce incomplete/error state, never successful completion. Full-book export and compiler both reject missing chapters or active review findings; partial playback remains available.

Timestamped diagnostic history remains available. Recording receipts distinguish recovered history from active failures, scheduled retries and real manual review. Newer content findings remain active even when old audio exists. Legacy failure filenames stay readable.

## Safe recovery of old jobs

Use **Retry Missing Chapters** on an incomplete terminal job. The existing job is requeued with its settings/source decisions and completed chapters preserved; there is no new job creation/billing charge. Incompatible active jobs, fully complete books and completed maintenance jobs are refused. The production example is not automatically requeued.

Legacy source-map verification failures require resolving retained boundary evidence. Conflicting saved review text requires Review Workspace resolution/re-recording; it is not silently discarded.

## Verification

- TypeScript: `pnpm exec tsc --noEmit` passed.
- Unit: `pnpm test:unit` passed, 212 files / 1,816 tests.
- New worker/API/SQLite regressions: 23 tests, covering provider classes, durable cooldown/restart/budget, nine missing chapters, cancellation, cache integrity, legacy mapping and idempotent writes.
- Python: 23 rate-limiter tests passed; modified Python files compile.
- Focused mocked Playwright recovery/history UI: 2 tests passed.
- Recovery core and changed UI ESLint: zero errors, one existing hook warning.
- Additional affected legacy routes: eight preexisting errors and 21 warnings remain. Baseline comparison confirmed one chapter-route and seven full-export-route errors unchanged; these checks are not claimed as passing lint.
- Diff whitespace check passed.
- No live Gemini, Kokoro or production calls.

Existing regression updates cover failover, strict targeted repair, review, queue eligibility and source fidelity. Validation is not weakened.

## Remaining limitations

Historical upstream causes require logs that were not retained. PostgreSQL atomic updates are not exercised against a live PostgreSQL server; integration tests use SQLite. Live GPU/provider health is mocked and still needs operational observation. Multi-voice/Drama has no reusable cleanup cache. Legacy recovery requires enough retained source evidence. Main remains unchanged; final SHA and pushed branch are reported in the delivery message.

## Files changed

- `audiobook_worker.py`
- `biblical_scholar_worker.py`
- `docs/audiobook-provider-failure-recovery.md`
- `gemini_rate_limiter.py`
- `src/app/api/audiobook/chapter/route.ts`
- `src/app/api/audiobook/failure-log/route.ts`
- `src/app/api/audiobook/route.ts`
- `src/app/api/audiobook/status/route.ts`
- `src/app/api/audiobooks/queue/route.ts`
- `src/components/audiobooks/ChapterErrorLogModal.tsx`
- `src/components/doclist/views/JobsInlineView.tsx`
- `src/lib/server/audiobooks/chapter-record.ts`
- `src/lib/server/audiobooks/cloud-drama.ts`
- `src/lib/server/audiobooks/combine.ts`
- `src/lib/server/audiobooks/completeness.ts`
- `src/lib/server/audiobooks/pronunciation-failures.ts`
- `src/lib/server/audiobooks/pronunciation-repair-diagnostics.ts`
- `src/lib/server/audiobooks/pronunciation-repair-engine.ts`
- `src/lib/server/audiobooks/pronunciation-repairs.ts`
- `src/lib/server/audiobooks/provider-diagnostics.ts`
- `src/lib/server/audiobooks/queue-eligibility.ts`
- `src/lib/server/audiobooks/retry-settings.ts`
- `src/lib/server/audiobooks/smart-audio-targeted-repair.ts`
- `src/lib/server/audiobooks/smart-audio-validation-recovery.ts`
- `src/lib/server/audiobooks/troubleshooting.ts`
- `src/lib/server/audiobooks/worker.ts`
- `src/lib/server/smart-audio/drama-cloud-synthesis.ts`
- `src/lib/server/smart-audio/gemini-failover.ts`
- `src/lib/server/tts/generate.ts`
- `src/lib/server/tts/upstream-response.ts`
- `src/lib/shared/audiobook-error-category.ts`
- `src/lib/shared/audiobook-job-status.ts`
- `src/lib/shared/audiobook-processing-failure.ts`
- `tests/audiobook-provider-recovery.spec.ts`
- `tests/python/test_gemini_rate_limiter.py`
- `tests/unit/audiobook-chapter-review.vitest.spec.ts`
- `tests/unit/audiobook-provider-recovery.vitest.spec.ts`
- `tests/unit/audiobook-queue-eligibility.vitest.spec.ts`
- `tests/unit/gemini-failover.vitest.spec.ts`
- `tests/unit/smart-audio-data-integrity.vitest.spec.ts`
- `tests/unit/smart-audio-targeted-repair.vitest.spec.ts`
