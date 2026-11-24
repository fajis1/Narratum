import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { installCudaRuntime, NATIVE_FILES } from '../../scripts/install-onnx-cuda.mjs';

async function fixture(run: (root: string, source: string, target: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'onnx-cuda-install-'));
  const source = path.join(root, 'pinned-source');
  const core = path.join(root, 'node_modules/@openreader/compute-core');
  const ort = path.join(root, 'node_modules/onnxruntime-node');
  const target = path.join(ort, 'bin/napi-v3/linux/x64');
  try {
    for (const dir of [core, target, path.join(source, 'native')]) await mkdir(dir, { recursive: true });
    await writeFile(path.join(core, 'package.json'), JSON.stringify({ main: 'index.js' }));
    await writeFile(path.join(core, 'index.js'), '');
    for (const pkg of [ort, source]) await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ version: '1.18.0' }));
    await writeFile(path.join(target, 'original'), 'CPU runtime');
    for (const name of NATIVE_FILES) await writeFile(path.join(source, 'native', name), Buffer.from('\x7fELFfixture'));
    await run(root, source, target);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('pinned ONNX CUDA native bundle', () => {
  test('links the complete matched bundle at the Node package native path', async () => {
    await fixture(async (root, source, target) => {
      await installCudaRuntime(root, source);
      expect(await realpath(target)).toBe(path.join(source, 'native'));
      for (const name of NATIVE_FILES) expect((await readFile(path.join(target, name))).subarray(0, 4).toString()).toBe('\x7fELF');
    });
  });

  test('refuses a different source version before changing the installed runtime', async () => {
    await fixture(async (root, source, target) => {
      await writeFile(path.join(source, 'package.json'), JSON.stringify({ version: '1.18.1' }));
      await expect(installCudaRuntime(root, source)).rejects.toThrow('matching ONNX Runtime');
      expect(await readFile(path.join(target, 'original'), 'utf8')).toBe('CPU runtime');
    });
  });

  test.each(['libonnxruntime_providers_cuda.so', 'onnxruntime_binding.node'])(
    'rejects missing %s without replacing the installed runtime', async (name) => {
      await fixture(async (root, source, target) => {
        await rm(path.join(source, 'native', name));
        await expect(installCudaRuntime(root, source)).rejects.toThrow('ENOENT');
        expect(await readFile(path.join(target, 'original'), 'utf8')).toBe('CPU runtime');
      });
    },
  );

  test('rejects a non-native payload before changing the installed runtime', async () => {
    await fixture(async (root, source, target) => {
      await writeFile(path.join(source, 'native/onnxruntime_binding.node'), 'wrong file');
      await expect(installCudaRuntime(root, source)).rejects.toThrow('Invalid ONNX Runtime');
      expect(await readFile(path.join(target, 'original'), 'utf8')).toBe('CPU runtime');
    });
  });
});
