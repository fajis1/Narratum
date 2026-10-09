import { assertAudiobookComplete } from './completeness';
import { spawn } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { audiobooks, audiobookChapters } from '@/db/schema';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { getAudiobookObjectBuffer, putAudiobookObject, listAudiobookObjects, } from './blobstore';
import { escapeFFMetadata, ffprobeAudio, resolveChapterRecordings } from './chapters';
import { getFFmpegPath } from './ffmpeg-bin';
import type { TTSAudiobookFormat } from '@/types/tts';
export async function runFFmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn(getFFmpegPath(), args);
    let finished = false;
    const onAbort = () => {
      if (finished) return;
      finished = true;
      try { ffmpeg.kill('SIGKILL'); } catch {}
      reject(new Error('ABORTED'));
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    ffmpeg.stderr.on('data', (data) => {
      serverLogger.warn({
        event: 'audiobook.ffmpeg.stderr',
        degraded: true,
        step: 'ffmpeg',
        stderr: String(data),
      }, 'ffmpeg stderr');
    });
    ffmpeg.on('close', (code) => {
      if (finished) return;
      finished = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
    ffmpeg.on('error', (err) => {
      if (finished) return;
      finished = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

export async function validateOutputDuration(outputPath: string, expectedDurationSec: number, signal?: AbortSignal): Promise<void> {
  let probe;
  try {
    probe = await ffprobeAudio(outputPath, signal);
  } catch (error) {
    throw new Error(`Failed to probe output file: ${(error as Error)?.message}`);
  }
  if (!probe.durationSec || probe.durationSec <= 0) {
    throw new Error(`FFmpeg completed but output duration is ${probe.durationSec}s`);
  }
  if (Math.abs(probe.durationSec - expectedDurationSec) > Math.max(60, expectedDurationSec * 0.1)) {
    throw new Error(`Corrupted output duration: ${probe.durationSec}s (expected ~${expectedDurationSec}s)`);
  }
}

export async function executeAudiobookCombine(
  bookId: string,
  storageUserId: string,
  format: TTSAudiobookFormat,
  testNamespace: string | null,
  onProgress?: (progress: number) => Promise<void>
): Promise<void> {
  let workDir: string | null = null;
  try {
    const objects = await listAudiobookObjects(bookId, storageUserId, testNamespace);
    const objectNames = objects.map((item) => item.fileName);
    const completeness = await assertAudiobookComplete(bookId, storageUserId, testNamespace, objectNames);

    const chapterRows = await db
      .select({
        chapterIndex: audiobookChapters.chapterIndex,
        duration: audiobookChapters.duration,
        title: audiobookChapters.title,
        filePath: audiobookChapters.filePath,
        format: audiobookChapters.format,
      })
      .from(audiobookChapters)
      .where(and(eq(audiobookChapters.bookId, bookId), eq(audiobookChapters.userId, storageUserId)));
    const resolution = resolveChapterRecordings(objectNames, chapterRows, completeness.expectedChapterIndexes, completeness.omittedChapterIndexes);
    if (resolution.issues.length || resolution.missingChapterIndexes.length) {
      throw new Error(`Cannot compile audiobook: authoritative chapter recordings are missing or invalid for chapter${resolution.missingChapterIndexes.length === 1 ? '' : 's'} ${resolution.missingChapterIndexes.map(index => index + 1).join(', ')}.`);
    }
    const durationByIndex = new Map<number, number>();
    const titleByIndex = new Map<number, string>();
    for (const row of chapterRows) {
      durationByIndex.set(row.chapterIndex, Number(row.duration ?? 0));
      if (row.title.trim()) titleByIndex.set(row.chapterIndex, row.title.trim());
    }
    const chapters = resolution.chapters.map((chapter) => ({
      ...chapter,
      title: titleByIndex.get(chapter.index) ?? chapter.title,
    }));
    if (chapters.length === 0) throw new Error('No chapters found');

    const completeName = `complete.${format}`;
    const manifestName = `${completeName}.manifest.json`;
    const signature = chapters.map((chapter) => ({
      index: chapter.index,
      fileName: chapter.fileName,
      title: chapter.title,
    }));

    workDir = await mkdtemp(join(tmpdir(), 'openreader-audiobook-combine-'));
    const metadataPath = join(workDir, 'metadata.txt');
    const listPath = join(workDir, 'list.txt');
    const outputPath = join(workDir, completeName);

    const localChapters: Array<{ index: number; title: string; localPath: string; duration: number }> = [];
    if (onProgress) await onProgress(10);
    for (const chapter of chapters) {
      const localPath = join(workDir, chapter.fileName);
      const bytes = await getAudiobookObjectBuffer(bookId, storageUserId, chapter.fileName, testNamespace);
      await writeFile(localPath, bytes);

      let duration = 0;
      try {
        const probe = await ffprobeAudio(localPath);
        if (probe.durationSec && probe.durationSec > 0) duration = probe.durationSec;
      } catch {
        duration = 0;
      }
      if (!duration || duration <= 0) duration = durationByIndex.get(chapter.index) ?? 0;

      localChapters.push({
        index: chapter.index,
        title: chapter.title,
        localPath,
        duration,
      });
    }

    if (onProgress) await onProgress(30);

    const metadata: string[] = [];
    let currentTime = 0;
    let currentChapterTitle: string | null = null;
    let currentChapterStartMs = 0;

    for (let i = 0; i < localChapters.length; i++) {
      const chapter = localChapters[i];
      const startMs = Math.floor(currentTime * 1000);

      if (currentChapterTitle !== chapter.title) {
        if (currentChapterTitle !== null) {
          metadata.push(
            '[CHAPTER]',
            'TIMEBASE=1/1000',
            `START=${currentChapterStartMs}`,
            `END=${startMs}`,
            `title=${escapeFFMetadata(currentChapterTitle)}`
          );
        }
        currentChapterTitle = chapter.title;
        currentChapterStartMs = startMs;
      }
      currentTime += chapter.duration;
    }

    if (currentChapterTitle !== null) {
      const endMs = Math.floor(currentTime * 1000);
      metadata.push(
        '[CHAPTER]',
        'TIMEBASE=1/1000',
        `START=${currentChapterStartMs}`,
        `END=${endMs}`,
        `title=${escapeFFMetadata(currentChapterTitle)}`
      );
    }

    await writeFile(metadataPath, ';FFMETADATA1\n' + metadata.join('\n'));
    await writeFile(
      listPath,
      localChapters.map((chapter) => `file '${chapter.localPath.replace(/'/g, "'\\''")}'`).join('\n')
    );

    if (onProgress) await onProgress(40);

    if (format === 'mp3') {
      try {
        await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-map_metadata', '-1', '-c:a', 'copy', outputPath]);
        await validateOutputDuration(outputPath, currentTime);
      } catch (copyError) {
        if ((copyError as Error)?.message === 'ABORTED') throw copyError;
        serverLogger.warn({ event: 'audiobook.concat_copy.mp3.failed', degraded: true, fallbackPath: 'reencode', error: errorToLog(copyError) }, 'MP3 concat copy failed; falling back to re-encode');
        for (const chap of localChapters) {
          const normalizedPath = `${chap.localPath}.normalized.mp3`;
          await runFFmpeg(['-y', '-i', chap.localPath, '-c:a', 'libmp3lame', '-b:a', '64k', normalizedPath]);
          chap.localPath = normalizedPath;
        }
        await writeFile(
          listPath,
          localChapters.map((chapter) => `file '${chapter.localPath.replace(/'/g, "'\\''")}'`).join('\n')
        );
        await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-map_metadata', '-1', '-c:a', 'copy', outputPath]);
        await validateOutputDuration(outputPath, currentTime);
      }
    } else {
      try {
        await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-i', metadataPath, '-map', '0:a', '-map_metadata', '1', '-map_chapters', '1', '-c:a', 'copy', '-movflags', 'use_metadata_tags', '-f', 'mp4', outputPath]);
        await validateOutputDuration(outputPath, currentTime);
      } catch (copyError) {
        if ((copyError as Error)?.message === 'ABORTED') throw copyError;
        serverLogger.warn({ event: 'audiobook.concat_copy.m4b.failed', degraded: true, fallbackPath: 'reencode', error: errorToLog(copyError) }, 'M4B concat copy failed; falling back to re-encode');
        for (const chap of localChapters) {
          const normalizedPath = `${chap.localPath}.normalized.mp3`;
          await runFFmpeg(['-y', '-i', chap.localPath, '-c:a', 'libmp3lame', '-b:a', '64k', normalizedPath]);
          chap.localPath = normalizedPath;
        }
        await writeFile(
          listPath,
          localChapters.map((chapter) => `file '${chapter.localPath.replace(/'/g, "'\\''")}'`).join('\n')
        );
        await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-i', metadataPath, '-map', '0:a', '-map_metadata', '1', '-map_chapters', '1', '-c:a', 'copy', '-movflags', 'use_metadata_tags', '-f', 'mp4', outputPath]);
        await validateOutputDuration(outputPath, currentTime);
      }
    }

    if (onProgress) await onProgress(90);

    serverLogger.info({ event: 'audiobook.combine.debug' }, 'Checking duration...');
    await validateOutputDuration(outputPath, currentTime);

    serverLogger.info({ event: 'audiobook.combine.debug' }, 'Uploading audio file to S3...');
    const { createReadStream } = await import('fs');
    const outputStreamForPut = createReadStream(outputPath);
    await putAudiobookObject(bookId, storageUserId, completeName, outputStreamForPut, (format), testNamespace);
    
    serverLogger.info({ event: 'audiobook.combine.debug' }, 'Uploading manifest file to S3...');
    await putAudiobookObject(
      bookId,
      storageUserId,
      manifestName,
      Buffer.from(JSON.stringify(signature, null, 2), 'utf8'),
      'application/json; charset=utf-8',
      testNamespace,
    );
    serverLogger.info({ event: 'audiobook.combine.debug' }, 'Finished uploading to S3!');
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}




function chapterFileMimeType(format: TTSAudiobookFormat): string {
  return format === 'mp3' ? 'audio/mpeg' : 'audio/mp4';
}
