import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { splitAudiobookTextForTts } from '@/lib/shared/audiobook-batching';
import { getFFmpegPath } from '@/lib/server/audiobooks/ffmpeg-bin';
import {
  generateTTSBuffer,
  type ServerTTSRequest,
  type TtsUpstreamRuntimeSettings,
} from '@/lib/server/tts/generate';
import {
  runWithGpuQueueStatus,
  type GpuArbiterStatus,
  type GpuQueueRequestIdentity,
} from '@/lib/server/tts/gpu-arbiter';
import { parseVoiceTaggedText } from '@/lib/shared/multi-voice';

export interface AudiobookGpuQueueObserver {
  onStatus: (status: GpuArbiterStatus | null) => void | Promise<void>;
  requestIdentity?: GpuQueueRequestIdentity;
}

export async function concatenateMp3Segments(
  segments: readonly Buffer[],
  signal?: AbortSignal,
): Promise<Buffer> {
  if (segments.length === 1) return segments[0];

  const workDir = await mkdtemp(join(tmpdir(), 'openreader-tts-segments-'));
  try {
    const segmentPaths: string[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segmentPath = join(workDir, `${String(index).padStart(4, '0')}.mp3`);
      await writeFile(segmentPath, segments[index]);
      segmentPaths.push(segmentPath);
    }
    const concatListPath = join(workDir, 'segments.txt');
    const outputPath = join(workDir, 'combined.mp3');
    await writeFile(
      concatListPath,
      segmentPaths.map((segmentPath) => `file '${segmentPath}'`).join('\n'),
      'utf8',
    );

    await new Promise<void>((resolve, reject) => {
      const ffmpeg = spawn(getFFmpegPath(), [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatListPath,
        '-c:a',
        'libmp3lame',
        '-b:a',
        '64k',
        outputPath,
      ]);
      let stderr = '';
      let finished = false;
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const onAbort = () => {
        if (finished) return;
        finished = true;
        ffmpeg.kill('SIGKILL');
        cleanup();
        reject(new Error('ABORTED'));
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      ffmpeg.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      ffmpeg.on('error', (error) => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(error);
      });
      ffmpeg.on('close', (code) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg failed to concatenate TTS segments (code ${code}): ${stderr.slice(-500)}`));
        }
      });
    });

    return await readFile(outputPath);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Short, valid MP3 used to retain the place of a failed Cloud Drama line. */
export async function generateSilentMp3Segment(signal?: AbortSignal): Promise<Buffer> {
  const workDir = await mkdtemp(join(tmpdir(), 'openreader-tts-silence-'));
  const outputPath = join(workDir, 'silence.mp3');
  try {
    await new Promise<void>((resolve, reject) => {
      const ffmpeg = spawn(getFFmpegPath(), [
        '-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono',
        '-t', '0.4', '-c:a', 'libmp3lame', '-b:a', '64k', outputPath,
      ]);
      const onAbort = () => ffmpeg.kill('SIGKILL');
      signal?.addEventListener('abort', onAbort, { once: true });
      ffmpeg.on('error', (error) => { signal?.removeEventListener('abort', onAbort); reject(error); });
      ffmpeg.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg failed to create silence (code ${code}).`));
      });
      if (signal?.aborted) onAbort();
    });
    return await readFile(outputPath);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function generateSegmentedAudiobookTtsBuffer(
  request: ServerTTSRequest,
  signal?: AbortSignal,
  runtimeSettings?: TtsUpstreamRuntimeSettings,
  gpuQueueObserver?: AudiobookGpuQueueObserver,
): Promise<Buffer> {
  const audioSegments: Buffer[] = [];
  
  // Tagged chapters are fail-closed: every character must use a known Kokoro
  // voice and no text may sit outside a voice segment. Ordinary single-voice
  // chapters continue to use the request's configured default voice.
  const parsedChunks: { text: string; voice: string }[] = /<\/?voice\b/iu.test(request.text)
    ? parseVoiceTaggedText(request.text).map((segment) => ({
      text: segment.text,
      voice: segment.voiceId,
    }))
    : [{ text: request.text, voice: request.voice }];

  // Now, for each chunk, we still need to run it through splitAudiobookTextForTts
  // to ensure no chunk exceeds the TTS engine's character limits (e.g. 4000 chars)
  for (const chunk of parsedChunks) {
    const subSegments = splitAudiobookTextForTts(chunk.text, request.language);
    for (const text of subSegments) {
      const segmentRequest = { ...request, text, voice: chunk.voice, format: 'mp3' };
      audioSegments.push(await runWithGpuQueueStatus({
        request: gpuQueueObserver?.requestIdentity || segmentRequest,
        signal,
        onStatus: gpuQueueObserver?.onStatus,
        operation: (operationSignal) => generateTTSBuffer(
          segmentRequest,
          operationSignal,
          runtimeSettings,
        ),
      }));
    }
  }

  if (audioSegments.length === 0) {
    throw new Error('No speakable text remained after TTS segmentation.');
  }

  return concatenateMp3Segments(audioSegments, signal);
}
