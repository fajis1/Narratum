import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Fixtures require Python 3.10+ syntax, not a particular local environment. */
function isSupportedPython(command: string): boolean {
  const result = spawnSync(command, ['-I', '-c',
    'import sys; sys.exit(0 if sys.version_info.major == 3 and sys.version_info.minor >= 10 else 1)'],
  { encoding: 'utf8', timeout: 10000 });
  return !result.error && result.status === 0;
}

/** Explicit CI override → local venv → standard Python on PATH. Never skip. */
export function resolveTestPython(options: {
  override?: string; cwd?: string; exists?: typeof existsSync; probe?: (command: string) => boolean;
} = {}): string {
  const override = (options.override ?? process.env.NARRATUM_TEST_PYTHON)?.trim();
  const cwd = options.cwd ?? process.cwd();
  const exists = options.exists ?? existsSync;
  const probe = options.probe ?? isSupportedPython;
  const setupMessage = 'OCR lifecycle fixtures require Python 3.10+. Install Python (CI uses actions/setup-python 3.12), or set NARRATUM_TEST_PYTHON to its executable path.';
  if (override) {
    if (probe(override)) return override;
    throw new Error(`NARRATUM_TEST_PYTHON is unavailable or unsupported. ${setupMessage}`);
  }
  for (const candidate of [path.join(cwd, '.venv/bin/python'), path.join(cwd, '.venv/bin/python3'),
    path.join(cwd, '.venv/Scripts/python.exe')]) {
    if (exists(candidate) && probe(candidate)) return candidate;
  }
  for (const candidate of ['python3', 'python']) if (probe(candidate)) return candidate;
  throw new Error(setupMessage);
}
