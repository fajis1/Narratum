import { spawn } from 'node:child_process';
import { getFFmpegPath } from './ffmpeg-bin';
import type { DramaSpeechSetting } from '@/lib/shared/drama-speech-settings';

/** Walk RIFF chunks rather than assuming a 44-byte WAV header. */
export function inspectDramaWav(audio: Buffer): { durationMs: number; dataOffset: number; dataBytes: number; sampleRate: number; channels: number } | null {
  if (audio.length < 12 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') return null;
  let byteRate = 0, sampleRate = 0, channels = 0;
  for (let offset = 12; offset + 8 <= audio.length;) {
    const id = audio.toString('ascii', offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ' && size >= 16 && start + 16 <= audio.length) {
      if (audio.readUInt16LE(start) !== 1 || audio.readUInt16LE(start + 14) !== 16) return null;
      channels = audio.readUInt16LE(start + 2); sampleRate = audio.readUInt32LE(start + 4); byteRate = audio.readUInt32LE(start + 8);
    }
    if (id === 'data' && byteRate > 0 && channels > 0 && sampleRate > 0) {
      const dataBytes = Math.min(size, audio.length - start);
      return { durationMs: dataBytes / byteRate * 1000, dataOffset: start, dataBytes, sampleRate, channels };
    }
    if (size > audio.length - start) return null;
    offset = start + size + (size % 2);
  }
  return null;
}

/** Fixed presets only: user values never become arbitrary FFmpeg arguments. */
export function dramaEffectFilter(setting: DramaSpeechSetting): string | null {
  if (setting.effect === 'clean' || setting.strength <= 0) return null;
  const amount = Math.min(1, Math.max(0, setting.strength / 100));
  const wet = setting.effect === 'cb-radio'
    ? 'highpass=f=300,lowpass=f=3200,acompressor=threshold=0.12:ratio=4:attack=5:release=60:makeup=1.5,volume=1.6,asoftclip=type=tanh:output=0.8'
    : setting.effect === 'mental-link'
      ? 'aecho=0.85:0.9:25|50:0.18|0.09'
      : 'lowpass=f=6500,aecho=0.9:0.9:35:0.12';
  return `[0:a]asplit=2[dry][wet];[wet]${wet}[treated];[dry][treated]amix=inputs=2:weights='${1 - amount} ${amount}':normalize=0:duration=longest[out]`;
}

function radioTexture(audio: Buffer, setting: DramaSpeechSetting): void {
  if (setting.effect !== 'cb-radio' || setting.radioTexture === 'none') return;
  const wav = inspectDramaWav(audio);
  if (!wav) throw new Error('Radio processing produced an invalid WAV.');
  const samples = Math.floor(wav.dataBytes / 2);
  const clickSamples = Math.round(wav.sampleRate * wav.channels * 0.012);
  let seed = 17;
  for (let i = 0; i < samples; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = (seed / 0xffffffff * 2 - 1);
    const envelope = Math.min(1, i / Math.max(1, clickSamples), (samples - 1 - i) / Math.max(1, clickSamples));
    let extra = setting.radioTexture === 'static' || setting.radioTexture === 'both' ? noise * 100 * envelope : 0;
    if ((setting.radioTexture === 'clicks' || setting.radioTexture === 'both') && (i < clickSamples || samples - i <= clickSamples)) extra += noise * 1800 * (1 - envelope);
    const offset = wav.dataOffset + i * 2;
    audio.writeInt16LE(Math.round(Math.min(32767, Math.max(-32768, audio.readInt16LE(offset) + extra * setting.strength / 100))), offset);
  }
}

/** Effects are local and lossless until chapter encoding; echoes retain their full tail. */
export async function applyDramaAudioEffect(audio: Buffer, setting: DramaSpeechSetting, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const filter = dramaEffectFilter(setting);
  if (!filter) return audio;
  const output = await new Promise<Buffer>((resolve, reject) => {
    const ffmpeg = spawn(getFFmpegPath(), ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-filter_complex', filter,
      '-map', '[out]', '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1']);
    const chunks: Buffer[] = [];
    let size = 0, stderr = '', settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', abort);
      if (error) { ffmpeg.kill('SIGKILL'); reject(error); } else resolve(Buffer.concat(chunks));
    };
    const abort = () => finish(new Error('ABORTED'));
    signal?.addEventListener('abort', abort, { once: true });
    ffmpeg.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 128 * 1024 * 1024) finish(new Error('Processed speech segment is too large.'));
      else chunks.push(chunk);
    });
    ffmpeg.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-1000); });
    ffmpeg.on('error', finish);
    ffmpeg.stdin.on('error', error => finish(error));
    ffmpeg.on('close', code => finish(code === 0 ? undefined : new Error(`Speech sound processing failed (${code}): ${stderr}`)));
    ffmpeg.stdin.end(audio);
    if (signal?.aborted) abort();
  });
  const wav = inspectDramaWav(output);
  if (!wav || !wav.dataBytes) throw new Error('Speech sound processing produced no valid PCM audio.');
  // A streamed WAV has unknown RIFF/data lengths. Finalize them before concatenation.
  output.writeUInt32LE(output.length - 8, 4);
  output.writeUInt32LE(wav.dataBytes, wav.dataOffset - 4);
  radioTexture(output, setting);
  return output;
}
