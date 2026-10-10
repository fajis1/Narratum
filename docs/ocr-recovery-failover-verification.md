# OCR recovery failover and workspace verification

Base: main `3639a05111a1d50a49d0d1dcc02db41a08355e0c`.

## Findings

The web Dockerfile neither copied `render_source_recovery_pages.py` nor installed
PyMuPDF (`fitz`). The OCR renderer invokes `.venv/bin/python3` and the missing
script before contacting Gemini. The broad exception handler classified those
failures as provider outages. The published main web image (`latest`, manifest digest
`sha256:d18a7db32a7c18dca8943fc1c7cc98822cfc1beab5337dbf205d9d173a5c39c0`)
was inspected in a disposable container with networking disabled: both the renderer
script and `fitz` were absent. The reported production batch has no accessible
retained attempt history, so its exact attempted model/key cannot be recovered
from the report alone. Local source-recovery records are absent.

OCR used the saved selected Smart Audio profile, independently of pre-scan's
temporary pronunciation settings. Empty configured fallback arrays suppressed
the shared helper's defaults. Request TimeoutError aborted model/key failover;
successful backup usage was discarded from diagnostics.

## Implementation

- [x] Copy renderer and install pinned PyMuPDF in the shared web runtime, inherited
  by CPU/ARM/CUDA targets. Build-time offline smoke check renders a temporary PDF
  using the image's actual Python interpreter and renderer script.
- [x] Add safe OCR-specific profile/model/key-presence summary and temporary
  model/fallback controls. Validate overrides on the server; resolve keys only
  from the selected saved profile. Backup selection applies to the next batch.
- [x] Opt OCR into bounded shared failover: at most six requests, one request per
  model/key pair, 20-second request deadlines covering headers and response bodies, primary model sequence before the
  backup sequence. Local backoff starts at one second and caps at eight seconds.
  Provider Retry-After is respected; delays exceeding ten seconds yield to a
  persisted cooldown. The browser requires an explicit continuation after failure.
- [x] Keep cancellation separate from request timeout; stop permanent 401/402/
  permission-denied 403. Temporary 403 requires RESOURCE_EXHAUSTED plus Retry-After.
- [x] Persist allowlisted attempt history and fixed public stage errors. Distinguish
  PDF load/render/startup, configuration, HTTP/transport/timeout, JSON parsing,
  output validation and dictionary warnings. Dictionary outages preserve visual
  proposals as dictionary-unverified; strict occurrence/surface validation remains.
- [x] Provide Pre-Scan and OCR Recovery tabs with one main scroll area per active
  tab. Keep both mounted; switching does not restart requests or discard progress.

## Verification progress

- Initial full suite: 1,905 unit tests passed; 27 Python scanner/renderer tests
  passed. Existing 75-occurrence lifecycle and audiobook recovery tests passed.
- Six mocked Chromium tests passed: OCR desktop/mobile analysis, bulk review,
  tab switching during requests, preserved selection, reachable controls, stage
  diagnostics and cancellation; existing provider-recovery interface tests passed.
- TypeScript passed. New/changed supporting modules are lint-clean. The existing
  pre-scan modal retains its baseline 141 errors and two warnings; no broad lint
  refactor is included in this focused fix.
- Final full suite: 218 files / 1,906 tests passed. TypeScript, production
  application build, bundle guard and the real offline renderer smoke check passed.
  Docker matrix, GitHub checks and delivery: pending branch verification.

No paid provider calls or production source decisions are made by these tests.
The original production PDF and live recognition accuracy remain unverified.

Response-body timeout hardening adds an integrated HTTP-200/body-timeout regression:
known HTTP status is retained, model/key failover continues, and raw transport
details are excluded. The final full suite (1,906 tests), six focused browser tests, TypeScript and
unchanged lint baseline passed locally; GitHub checks rerun for this follow-up.
