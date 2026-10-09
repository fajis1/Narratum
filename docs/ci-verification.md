# CI prerequisites and recovery

The OCR lifecycle regression runs the actual scanner with deterministic extracted
PDF text and mocked PDF/Gemini/dictionary evidence. Its Python fixture requires
Python 3.10 or later and **no third-party Python packages**. Vitest CI provisions
Python 3.12 and supplies `NARRATUM_TEST_PYTHON` from `actions/setup-python`.
Locally, interpreter discovery uses an explicit `NARRATUM_TEST_PYTHON`, then a
supported project `.venv`, then `python3` or `python` on PATH. An unavailable
explicit override or missing suitable interpreter fails with setup guidance;
the lifecycle regression is never skipped.

To verify without relying on a local virtual environment:

```sh
NARRATUM_TEST_PYTHON=/usr/bin/python3 pnpm test:unit
python3 -I -S tests/fixtures/ocr_source_recovery.py
```

Playwright retains SeaweedFS 4.18, caches the binary extracted from its official
container, and checks its version on every run. Cache misses use three bounded
pull attempts for transient registry failures with 30/60-second waits. Invalid
image names and permanent authorization errors fail immediately. Browser tests
use local mocked provider endpoints, never a paid production API key.

Ephemeral CI Docker daemons and BuildKit use Google's documented public Docker
Hub cache (`mirror.gcr.io`), with Docker Hub fallback. Existing daemon settings,
base-image versions, pinned CUDA digest, TLS/content verification, image layer
caches and publication safeguards are preserved. BuildKit bootstrap is pulled
with bounded retries and selected by its verified digest. Image builds get at
most three attempts with 30/60-second waits; an application failure still fails
the workflow after that bound. Only complete architecture families publish
manifests. A sustained registry outage still requires operator attention and
must not be reported as green CI.

The export browser regressions follow the merged completeness contract: status
retains pinned missing chapter placeholders, so readiness requires `hasAudio`
and a complete expected chapter set. Incomplete MP3/M4B full-book GET and
compilation POST requests must return 409 while individual recorded chapters
remain downloadable. Resume must restore the missing recording without changing
the other chapter metadata or creating duplicate indexes. These assertions
replace the older assumption that a partial book could be exported as complete.
