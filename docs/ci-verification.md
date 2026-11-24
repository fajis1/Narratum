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

Playwright uses SeaweedFS 4.53, matching the Docker runtime. It caches the binary
extracted from its official container and checks its version on every run. Cache
misses use three bounded pull attempts for transient registry failures with
30/60-second waits. Invalid image names and permanent authorization errors fail
immediately. Browser tests
use local mocked provider endpoints, never a paid production API key.

CPU tests and dependency installation skip ONNX Runtime's optional CUDA
GitHub download, whose historical archive now returns 404. The CUDA images
reuse only the complete ONNX Runtime 1.18.0 native bundle from the last successful
`openreader-cuda` image, pinned by immutable digest in both Dockerfiles. The
application and worker code are built from the current checkout. This preserves
CUDA 11.8/cuDNN 8 and P100 support without mixing native libraries from different
builds. `scripts/install-onnx-cuda.mjs` checks package versions and the complete
native file set before linking it into the deployed worker. Keep the pinned
source image available until this bootstrap dependency is replaced.

## Verification record: 2026-11-24

- `e560ad0` upgraded SeaweedFS to 4.53 and aligned the browser CI binary pin.
- `14ef7d3` restored CUDA publication using the pinned native bundle above.
  The [Docker workflow](https://github.com/fajis1/Narratum/actions/runs/45346344775)
  successfully built and published all image families, including the all-in-one
  `ghcr.io/fajis1/openreader-cuda:latest` image.
- The published CUDA amd64 manifest for that revision was
  `sha256:06b6d513fdef0118d48fb7312d8cedf1720ac6c75b18fb795c9ca18453cf2218`.
  Later publications can move `latest`; this digest records the verified build.
- Local verification passed 224 unit-test files / 2,043 tests, TypeScript,
  scoped ESLint, native-library checksum comparisons, and real CPU Identity
  inference after installing the pinned bundle. The
  [GitHub unit workflow](https://github.com/fajis1/Narratum/actions/runs/45346344725)
  also passed. No live GPU inference or deployed-host idle CPU was verified.
- Browser CI [stopped before tests](https://github.com/fajis1/Narratum/actions/runs/45346344837):
  `ubuntu-latest` selected Ubuntu 26.04, unsupported by Playwright 1.60.0.
  Follow-up: pin the browser job to supported Ubuntu 24.04 and rerun it. This
  remains separate from the successful image publication and unit checks.

## Registry and browser recovery

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
