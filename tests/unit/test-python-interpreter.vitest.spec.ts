import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { resolveTestPython } from '../helpers/python';

const cwd = path.resolve('/tmp/python-fixture');
const venv = path.join(cwd, '.venv/bin/python');
test('an explicit CI interpreter wins over the local environment', () => {
  const probe = vi.fn(() => true);
  expect(resolveTestPython({ override: '/ci/python', cwd, probe })).toBe('/ci/python');
  expect(probe).toHaveBeenCalledExactlyOnceWith('/ci/python');
});
test('an invalid explicit interpreter fails with setup guidance instead of silently falling back', () => {
  const probe = vi.fn(() => false);
  expect(() => resolveTestPython({ override: '/missing/python', probe })).toThrow('NARRATUM_TEST_PYTHON is unavailable or unsupported');
  expect(probe).toHaveBeenCalledOnce();
});
test('an existing supported local virtual environment continues working', () => {
  const probe = vi.fn(() => true);
  expect(resolveTestPython({ override: '', cwd, exists: (candidate) => candidate === venv, probe })).toBe(venv);
});
test('a clean checkout without a venv uses standard python3', () => {
  expect(resolveTestPython({ override: '', cwd, exists: () => false, probe: (command) => command === 'python3' })).toBe('python3');
});
test('an unusable local environment and python3 can fall back to supported python on PATH', () => {
  expect(resolveTestPython({ override: '', cwd, exists: () => true, probe: (command) => command === 'python' })).toBe('python');
});
test('missing or unsupported Python is a test failure with an actionable prerequisite message', () => {
  expect(() => resolveTestPython({ override: '', cwd, exists: () => false, probe: () => false })).toThrow('OCR lifecycle fixtures require Python 3.10+');
});
