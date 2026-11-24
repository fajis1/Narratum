#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const NATIVE_FILES = [
  'libonnxruntime.so.1.18.0',
  'libonnxruntime_providers_cuda.so',
  'libonnxruntime_providers_shared.so',
  'libonnxruntime_providers_tensorrt.so',
  'onnxruntime_binding.node',
];

// The Docker source is pinned to the last successful CUDA image's digest.
// Keep its complete native bundle together: providers use an internal C++ ABI,
// while the Node addon also requires the core's VERS_1.18.0 ELF symbol version.
export async function installCudaRuntime(runtimeRoot, sourceRoot) {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('The pinned CUDA 11 runtime requires Linux x64');
  }
  const runtimeRequire = createRequire(path.resolve(runtimeRoot, 'package.json'));
  const coreRequire = createRequire(runtimeRequire.resolve('@openreader/compute-core'));
  const packagePath = coreRequire.resolve('onnxruntime-node/package.json');
  const installed = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  const source = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  if (installed.version !== '1.18.0' || source.version !== installed.version) {
    throw new Error(`Expected matching ONNX Runtime 1.18.0 packages; found ${installed.version} and ${source.version}`);
  }
  const nativeSource = path.resolve(sourceRoot, 'native');
  // Validate the entire source before replacing any part of the installed set.
  for (const name of NATIVE_FILES) {
    const handle = await fs.open(path.join(nativeSource, name), 'r');
    try {
      const header = Buffer.alloc(4);
      await handle.read(header, 0, header.length, 0);
      if (!header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
        throw new Error(`Invalid ONNX Runtime native library: ${name}`);
      }
    } finally {
      await handle.close();
    }
  }
  const nativeTarget = path.join(path.dirname(packagePath), 'bin/napi-v3/linux/x64');
  await fs.rm(nativeTarget, { recursive: true, force: true });
  await fs.symlink(nativeSource, nativeTarget, 'dir');
  console.log('Installed pinned ONNX Runtime 1.18.0 CUDA 11 native bundle');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  installCudaRuntime(process.argv[2], process.argv[3]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
