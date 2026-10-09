import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const readRepositoryFile = (relativePath: string) => readFileSync(
  path.resolve(process.cwd(), relativePath),
  'utf8',
);

describe('CI workflow resilience', () => {
  const dockerWorkflow = readRepositoryFile('.github/workflows/docker-publish.yml');
  const playwrightWorkflow = readRepositoryFile('.github/workflows/playwright.yml');
  const vitestWorkflow = readRepositoryFile('.github/workflows/vitest.yml');
  const installRetryScript = readRepositoryFile('scripts/ci-install-with-retry.sh');

  test('retries root dependency installation after transient binary download failures', () => {
    const retryCommand = 'bash scripts/ci-install-with-retry.sh --frozen-lockfile';

    expect(vitestWorkflow).toContain(retryCommand);
    expect(playwrightWorkflow).toContain(retryCommand);
    expect(installRetryScript).toContain('max_attempts=3');
    expect(installRetryScript).toContain('if pnpm install "$@"; then');
    expect(installRetryScript).toContain('retry_delay=$((attempt * 10))');
  });

  test('retries registry login in both Docker build and merge jobs', () => {
    expect(dockerWorkflow.match(/uses: docker\/login-action@v4/g)).toHaveLength(6);
    expect(dockerWorkflow.match(/id: ghcr_login_1/g)).toHaveLength(2);
    expect(dockerWorkflow.match(/id: ghcr_login_2/g)).toHaveLength(2);
    expect(dockerWorkflow.match(/id: ghcr_login_[12]\n[\s\S]*?continue-on-error: true\n        uses: docker\/login-action/g)).toHaveLength(4);
  });

  test('provisions Python and executes rather than skips the integrated OCR fixture', () => {
    expect(vitestWorkflow).toContain('uses: actions/setup-python@v6');
    expect(vitestWorkflow).toContain("python-version: '3.12'");
    expect(vitestWorkflow).toContain('python -I -S tests/fixtures/ocr_source_recovery.py');
    expect(vitestWorkflow).toContain('NARRATUM_TEST_PYTHON: ${{ steps.python.outputs.python-path }}');
  });

  test('reuses a pinned version-checked SeaweedFS binary without repeat pulls', () => {
    expect(playwrightWorkflow).toContain('key: seaweedfs-4.18-');
    expect(playwrightWorkflow).toContain('bash scripts/ci-docker-pull-with-retry.sh chrislusf/seaweedfs:4.18');
    expect(playwrightWorkflow).toContain('docker create --pull=never');
    expect(playwrightWorkflow).toContain("grep -Eq '(^|[^0-9])4\\.18([^0-9]|$)'");
    expect(playwrightWorkflow).not.toContain('secrets.DEEPINFRA_API_KEY');
  });

  test('bounds Docker retries and preserves digest publishing and architecture checks', () => {
    expect(dockerWorkflow.match(/uses: docker\/build-push-action@v7/g)).toHaveLength(3);
    expect(dockerWorkflow).toContain('run: sleep 30');
    expect(dockerWorkflow).toContain('run: sleep 60');
    expect(dockerWorkflow).toContain("if: steps.build_1.outcome == 'failure' && steps.build_2.outcome == 'failure'");
    expect(dockerWorkflow).toContain("steps.build_1.outcome == 'success' && steps.build_1.outputs.digest");
    expect(dockerWorkflow).toContain("steps.build_2.outcome == 'success' && steps.build_2.outputs.digest");
    expect(dockerWorkflow).toContain('mirrors = ["mirror.gcr.io"]');
    expect(dockerWorkflow).toContain('driver-opts: image=${{ env.CI_BUILDKIT_IMAGE }}');
    expect(dockerWorkflow.match(/push-by-digest=true,name-canonical=true,push=true/g)).toHaveLength(3);
  });

  test('publishes complete image families independently after a matrix failure', () => {
    expect(dockerWorkflow).toContain(
      "if: ${{ always() && !cancelled() && needs.prepare.result == 'success' }}",
    );
    expect(dockerWorkflow).toContain('- name: Validate architecture digests');
    expect(dockerWorkflow).toContain('web|compute-worker) expected=2');
    expect(dockerWorkflow).toContain('*) expected=1');
    expect(dockerWorkflow).toContain('refusing to publish an incomplete image');
    expect(dockerWorkflow.indexOf('Validate architecture digests')).toBeLessThan(
      dockerWorkflow.indexOf('Create manifest list and push'),
    );
  });
});
