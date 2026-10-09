import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

function runPull(scenario: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ci-pull-'));
  try {
    writeFileSync(path.join(dir, 'docker'), `#!/bin/bash
echo pull >> "$TEST_CALLS"
count=$(wc -l < "$TEST_CALLS")
case "$TEST_SCENARIO" in
  success) exit 0 ;;
  recover) if (( count == 3 )); then exit 0; fi; echo '429 Too Many Requests' ;;
  timeout) echo 'Client.Timeout exceeded while awaiting headers' ;;
  unavailable) echo '504 Gateway Timeout' ;;
  permanent) echo 'unauthorized: authentication required' ;;
  missing) echo 'manifest unknown' ;;
esac
exit 1
`, { mode: 0o755 });
    writeFileSync(path.join(dir, 'sleep'), '#!/bin/bash\necho "$1" >> "$TEST_DELAYS"\n', { mode: 0o755 });
    const result = spawnSync('bash', ['scripts/ci-docker-pull-with-retry.sh', 'fixture/image:1'], {
      encoding: 'utf8', timeout: 10000,
      env: {
        NODE_ENV: 'test', PATH: `${dir}:/usr/bin:/bin`, TEST_SCENARIO: scenario,
        TEST_CALLS: path.join(dir, 'calls'), TEST_DELAYS: path.join(dir, 'delays'),
      },
    });
    expect(result.error).toBeUndefined();
    return {
      status: result.status, output: result.stdout + result.stderr,
      attempts: readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').length,
      delays: ['recover', 'timeout', 'unavailable'].includes(scenario)
        ? readFileSync(path.join(dir, 'delays'), 'utf8').trim().split('\n') : [],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a healthy registry requires one pull without a wait', () => {
  expect(runPull('success')).toMatchObject({ status: 0, attempts: 1, delays: [] });
});
test('a temporary 429 recovers on the third bounded attempt', () => {
  expect(runPull('recover')).toMatchObject({ status: 0, attempts: 3, delays: ['30', '60'] });
});
test.each(['timeout', 'unavailable'])('persistent %s stops after three attempts and reports the outage', (scenario) => {
  expect(runPull(scenario)).toMatchObject({ status: 1, attempts: 3, delays: ['30', '60'], output: expect.stringContaining('Registry unavailable after 3 attempts') });
});
test.each(['permanent', 'missing'])('%s fails immediately rather than retrying a bad configuration', (scenario) => {
  expect(runPull(scenario)).toMatchObject({ status: 1, attempts: 1, delays: [] });
});
