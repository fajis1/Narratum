import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { audiobooks, audiobookChapters, documents } from '@/db/schema';
import { getRuntimeConfig } from '@/lib/server/admin/settings';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import {
  getAudiobookObjectBuffer,
  listAudiobookObjects,
} from './blobstore';
import { getDocumentBlob } from '@/lib/server/documents/blobstore';
import { executeAudiobookCombine } from './combine';
import { listChapterObjects } from './chapters';
import type { TTSAudiobookFormat } from '@/types/tts';
import { fetchGeminiWithRateLimitFallback, GEMINI_MODEL_FALLBACKS } from '@/lib/server/smart-audio/gemini-failover';
import { readSmartAudioProfilesDocument } from '@/lib/server/smart-audio-profiles';

export interface AudiobookshelfFolder {
  id: string;
  fullPath: string;
}

export interface AudiobookshelfLibrary {
  id: string;
  name: string;
  mediaType: string;
  folders: AudiobookshelfFolder[];
}

export interface AudiobookshelfConfig {
  url: string;
  token: string;
  libraryId: string;
  folderId: string;
  autoDetectMetadata: boolean;
  isConfigured: boolean;
}

export interface AudiobookshelfSearchCandidate {
  id: string;
  title: string;
  author: string;
  folderName: string;
  hasAudio: boolean;
  hasEbook: boolean;
}

export interface MatchCandidateResult {
  isMatch: boolean;
  matchedItemId: string | null;
  matchedFolderName: string | null;
  confidence: number; // 0.0 to 1.0
  reasoning: string;
}

export interface MatchCandidateOptions {
  userId?: string;
  model?: string;
  primaryApiKey?: string;
  backupApiKey?: string;
}

export interface AudiobookshelfUploadOptions {
  bookId: string;
  userId: string;
  title: string;
  author?: string;
  series?: string;
  includeCompanionDocument?: boolean;
  libraryId?: string;
  folderId?: string;
  namespace?: string | null;
  smartMatchExistingBook?: boolean; // defaults to true
  targetItemId?: string;            // optional manual override from UI
  targetFolderName?: string;        // optional manual override from UI
  model?: string;                   // optional AI model override (defaults to gemini-3.1-flash-lite)
}

export interface AudiobookshelfUploadResult {
  success: boolean;
  title: string;
  author: string;
  libraryId: string;
  folderId: string;
  files: string[];
  scanTriggered: boolean;
  matchedItemId?: string | null;
  matchedFolderName?: string | null;
  unified?: boolean;
}

/**
 * Sanitize strings for Audiobookshelf folder / file naming.
 * Removes illegal filesystem characters, collapses spaces, trims.
 */
export function sanitizeFilenameForAudiobookshelf(name: string): string {
  const sanitized = name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, ''); // strip leading/trailing periods
  return sanitized || 'Untitled';
}

/**
 * Resolves current Audiobookshelf settings from runtime config and environment variables.
 */
export async function resolveAudiobookshelfConfig(): Promise<AudiobookshelfConfig> {
  const runtime = await getRuntimeConfig();

  const url = (runtime.audiobookshelfUrl || process.env.AUDIOBOOKSHELF_URL || 'http://192.168.90.244:13378').trim().replace(/\/+$/, '');
  const token = (runtime.audiobookshelfToken || process.env.AUDIOBOOKSHELF_TOKEN || '').trim();
  const libraryId = (runtime.audiobookshelfLibraryId || process.env.AUDIOBOOKSHELF_LIBRARY_ID || '').trim();
  const folderId = (runtime.audiobookshelfFolderId || process.env.AUDIOBOOKSHELF_FOLDER_ID || '').trim();
  const autoDetectMetadata = runtime.audiobookshelfAutoDetectMetadata ?? true;

  return {
    url,
    token,
    libraryId,
    folderId,
    autoDetectMetadata,
    isConfigured: Boolean(url && token),
  };
}

/**
 * Fetches available libraries and their folders from Audiobookshelf.
 */
export async function fetchAudiobookshelfLibraries(
  urlOverride?: string,
  tokenOverride?: string,
): Promise<AudiobookshelfLibrary[]> {
  const config = await resolveAudiobookshelfConfig();
  const rawUrl = urlOverride || config.url;
  const token = tokenOverride || config.token;

  if (!rawUrl) {
    throw new Error('Audiobookshelf server URL is not configured.');
  }
  if (!token) {
    throw new Error('Audiobookshelf API token is not configured.');
  }

  const normalizedUrl = rawUrl.trim().replace(/\/+$/, '');
  const endpoint = `${normalizedUrl}/api/libraries`;

  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Audiobookshelf API returned ${response.status}: ${errorText || response.statusText}`);
  }

  const data = (await response.json()) as { libraries?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  const rawLibraries = Array.isArray(data) ? data : data.libraries || [];

  return rawLibraries.map((lib): AudiobookshelfLibrary => {
    const rawFolders = (Array.isArray(lib.folders) ? lib.folders : Array.isArray(lib.libraryFolders) ? lib.libraryFolders : []) as Array<Record<string, unknown>>;
    return {
      id: String(lib.id || ''),
      name: String(lib.name || 'Unnamed Library'),
      mediaType: String(lib.mediaType || 'book'),
      folders: rawFolders.map((f) => ({
        id: String(f.id || ''),
        fullPath: String(f.fullPath || f.path || ''),
      })),
    };
  });
}

/**
 * Triggers an immediate library scan in Audiobookshelf so the uploaded files are indexed.
 */
export async function triggerAudiobookshelfScan(
  url: string,
  token: string,
  libraryId: string,
): Promise<boolean> {
  try {
    const normalizedUrl = url.trim().replace(/\/+$/, '');
    const res = await fetch(`${normalizedUrl}/api/libraries/${encodeURIComponent(libraryId)}/scan`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    return res.ok;
  } catch (err) {
    serverLogger.warn({
      event: 'audiobookshelf.scan.trigger_failed',
      error: errorToLog(err),
      libraryId,
    }, 'Failed to trigger Audiobookshelf library scan');
    return false;
  }
}

/**
 * Strips scanner noise, release notes, file extensions, and extra punctuation from titles
 * to generate high-yield search queries for Audiobookshelf.
 */
export function sanitizeSearchTitle(rawTitle: string): string {
  return rawTitle
    .replace(/\.(pdf|epub|m4b|mp3|m4a|docx|txt)$/i, '') // strip file extensions
    .replace(/\[(?:B[0-9A-Z]{8,10}|[^\]]+)\]/gi, '') // strip ASINs or bracketed tags
    .replace(/\((?:copy|ocr|scan|clean|retail|unabridged)[^)]*\)/gi, '') // strip (Copy), (OCR), etc.
    .replace(/\b(?:copy of|ocr|scan)\b/gi, '')
    .replace(/[_\-]+/g, ' ')
    .replace(/[^\w\s:–—'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Builds candidate search queries for Audiobookshelf API.
 */
export function buildAudiobookshelfSearchQueries(title: string, author?: string): string[] {
  const cleanedTitle = sanitizeSearchTitle(title);
  const queries = new Set<string>();

  if (cleanedTitle) {
    queries.add(cleanedTitle);

    // Primary title before colon or dash
    const primaryTitle = cleanedTitle.split(/[:–—]/)[0]?.trim();
    if (primaryTitle && primaryTitle.length >= 3 && primaryTitle !== cleanedTitle) {
      queries.add(primaryTitle);
    }
  }

  // Author query if provided and not generic
  if (author) {
    const cleanedAuthor = author
      .replace(/[_\-]+/g, ' ')
      .replace(/[^\w\s\.'-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (
      cleanedAuthor.length >= 3 &&
      !/^unknown(?: author)?$/i.test(cleanedAuthor)
    ) {
      queries.add(cleanedAuthor);
    }
  }

  return Array.from(queries);
}

/**
 * Searches Audiobookshelf library for existing candidate books.
 */
export async function searchAudiobookshelfCandidates(
  url: string,
  token: string,
  libraryId: string,
  title: string,
  author?: string,
): Promise<AudiobookshelfSearchCandidate[]> {
  const normalizedUrl = url.trim().replace(/\/+$/, '');
  const queries = buildAudiobookshelfSearchQueries(title, author);

  const candidateMap = new Map<string, AudiobookshelfSearchCandidate>();

  for (const query of queries) {
    try {
      const endpoint = `${normalizedUrl}/api/libraries/${encodeURIComponent(libraryId)}/search?q=${encodeURIComponent(query)}`;
      const res = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        serverLogger.warn(
          { event: 'audiobookshelf.search.query_failed', status: res.status, query },
          'Audiobookshelf search query returned non-200',
        );
        continue;
      }

      const data = (await res.json()) as Record<string, unknown>;
      const rawList = Array.isArray(data)
        ? data
        : Array.isArray(data.book)
          ? data.book
          : Array.isArray(data.books)
            ? data.books
            : Array.isArray(data.results)
              ? data.results
              : [];

      for (const entry of rawList) {
        const item = (entry && typeof entry === 'object' && 'libraryItem' in entry && entry.libraryItem)
          ? (entry.libraryItem as Record<string, unknown>)
          : (entry as Record<string, unknown>);
        if (!item || !item.id) continue;

        const itemId = String(item.id);
        if (candidateMap.has(itemId)) continue;

        const media = (item.media as Record<string, unknown>) || {};
        const metadata = (media.metadata as Record<string, unknown>) || {};

        const rawRelPath = String(item.relPath || item.path || '');
        const folderName = rawRelPath
          ? rawRelPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || rawRelPath
          : String(metadata.title || item.title || 'Untitled');

        const itemTitle = String(metadata.title || item.title || folderName || 'Untitled');
        const itemAuthor = String(
          metadata.authorName ||
          metadata.author ||
          (Array.isArray(metadata.authors)
            ? metadata.authors.map((a: unknown) => (a && typeof a === 'object' && 'name' in a ? String(a.name) : String(a))).join(', ')
            : '') ||
          ''
        );

        const hasAudio = Boolean(
          (Array.isArray(media.audioFiles) && media.audioFiles.length > 0) ||
          (Array.isArray(media.tracks) && media.tracks.length > 0) ||
          (typeof media.numTracks === 'number' && media.numTracks > 0) ||
          (typeof media.duration === 'number' && media.duration > 0)
        );

        const hasEbook = Boolean(
          media.ebookFile ||
          (Array.isArray(media.ebookFiles) && media.ebookFiles.length > 0) ||
          media.hasEbook
        );

        candidateMap.set(itemId, {
          id: itemId,
          title: itemTitle,
          author: itemAuthor,
          folderName,
          hasAudio,
          hasEbook,
        });

        if (candidateMap.size >= 6) break;
      }
    } catch (err) {
      serverLogger.warn(
        { event: 'audiobookshelf.search.error', error: errorToLog(err), query },
        'Failed to query Audiobookshelf candidates',
      );
    }

    if (candidateMap.size >= 6) break;
  }

  return Array.from(candidateMap.values()).slice(0, 6);
}

/**
 * Deterministic / fuzzy fallback matcher when Gemini API is unconfigured or unavailable.
 */
export function matchCandidatesDeterministically(
  candidates: AudiobookshelfSearchCandidate[],
  targetTitle: string,
  targetAuthor?: string,
): MatchCandidateResult {
  if (candidates.length === 0) {
    return {
      isMatch: false,
      matchedItemId: null,
      matchedFolderName: null,
      confidence: 0,
      reasoning: 'No candidate items found in Audiobookshelf.',
    };
  }

  const stopWords = new Set(['the', 'a', 'an', 'and', 'of', 'in', 'to', 'for', 'with', 'on', 'at', 'by', 'from']);
  const tokenize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !stopWords.has(w));

  const targetTokens = tokenize(targetTitle);
  const targetAuthorTokens = targetAuthor ? tokenize(targetAuthor) : [];

  let bestCandidate: AudiobookshelfSearchCandidate | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const candTokens = tokenize(candidate.title);
    if (candTokens.length === 0 || targetTokens.length === 0) continue;

    const overlap = targetTokens.filter((t) => candTokens.includes(t)).length;
    const targetCoverage = overlap / targetTokens.length;
    const candCoverage = overlap / candTokens.length;
    const titleScore = Math.max(targetCoverage, (targetCoverage + candCoverage) / 2);

    let score = titleScore * 0.85;

    // Check author match if available
    if (targetAuthorTokens.length > 0 && candidate.author) {
      const candAuthorTokens = tokenize(candidate.author);
      const authorOverlap = targetAuthorTokens.filter((t) => candAuthorTokens.includes(t)).length;
      if (authorOverlap > 0) {
        score += 0.1;
      }
    }

    // Boost preference for items already having an eBook/PDF for unification
    if (candidate.hasEbook) {
      score += 0.05;
    }

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  const confidence = Math.min(1.0, Math.round(bestScore * 100) / 100);
  const isMatch = Boolean(bestCandidate && confidence >= 0.75);

  return {
    isMatch,
    matchedItemId: isMatch && bestCandidate ? bestCandidate.id : null,
    matchedFolderName: isMatch && bestCandidate ? bestCandidate.folderName : null,
    confidence,
    reasoning: isMatch && bestCandidate
      ? `Deterministic title and author token overlap (${Math.round(confidence * 100)}% match).`
      : 'No candidate item met the 0.75 confidence threshold in deterministic matching.',
  };
}

/**
 * Matches an audiobook being exported against existing Audiobookshelf items using Gemini AI.
 */
export async function matchAudiobookshelfCandidateWithGemini(
  candidates: AudiobookshelfSearchCandidate[],
  targetTitle: string,
  targetAuthor?: string,
  options?: MatchCandidateOptions,
): Promise<MatchCandidateResult> {
  if (candidates.length === 0) {
    return {
      isMatch: false,
      matchedItemId: null,
      matchedFolderName: null,
      confidence: 0,
      reasoning: 'No candidate items to evaluate.',
    };
  }

  // 1. Resolve Gemini API Key
  const runtime = await getRuntimeConfig();
  let primaryKey = (options?.primaryApiKey || runtime.geminiApiKey || process.env.GEMINI_API_KEY || '').trim();
  let backupKey = (options?.backupApiKey || process.env.BACKUP_GEMINI_API_KEY || '').trim();

  if (!primaryKey && options?.userId) {
    try {
      const profilesDoc = await readSmartAudioProfilesDocument(options.userId);
      for (const p of profilesDoc.profiles) {
        if (p.geminiApiKey?.trim()) {
          primaryKey = p.geminiApiKey.trim();
          if (p.backupGeminiApiKey?.trim()) {
            backupKey = p.backupGeminiApiKey.trim();
          }
          break;
        }
      }
    } catch {
      // ignore
    }
  }

  // If no Gemini key is available, use deterministic matching
  if (!primaryKey) {
    serverLogger.info(
      { event: 'audiobookshelf.match.fallback_deterministic', reason: 'No Gemini key available' },
      'Evaluating Audiobookshelf candidates using deterministic matcher',
    );
    return matchCandidatesDeterministically(candidates, targetTitle, targetAuthor);
  }

  // 2. Prepare Librarian Prompt
  const requestedModel = options?.model?.trim() || 'gemini-3.1-flash-lite';
  const fallbackModels = GEMINI_MODEL_FALLBACKS[requestedModel] || ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];

  const userPrompt = [
    'You are an expert digital librarian and catalog unification system.',
    'Your task is to determine whether an audiobook being exported from OpenReader corresponds to an EXISTING book already cataloged in the user\'s Audiobookshelf library.',
    '',
    `Exporting Target Audiobook Title: "${targetTitle}"`,
    `Exporting Target Audiobook Author: "${targetAuthor || 'Unknown'}"`,
    '',
    'Candidate Items Found in Audiobookshelf Library:',
    JSON.stringify(candidates, null, 2),
    '',
    'Librarian Matching Rules:',
    '1. Determine if the target audiobook corresponds to the same underlying book as any existing candidate item, accounting for subtitles, edition notes, translation notes, and author spelling variations.',
    '2. Priority rule: If multiple items match, explicitly prefer attaching to an existing item that already has an eBook/PDF ("hasEbook": true) so Audiobookshelf unifies both the audio and text into a single card with both "Listen" and "Read" capabilities.',
    '3. If no candidate matches the target book with high certainty, set "is_match": false, "matched_item_id": null, "matched_folder_name": null, and "confidence": 0.0.',
    '4. Confidence score must be a number from 0.0 to 1.0. A match is only considered authoritative if confidence is >= 0.75.',
    '',
    'Respond ONLY with a valid JSON object matching this schema:',
    '{',
    '  "is_match": boolean,',
    '  "matched_item_id": string | null,',
    '  "matched_folder_name": string | null,',
    '  "confidence": number,',
    '  "reasoning": string',
    '}',
  ].join('\n');

  try {
    const { response } = await fetchGeminiWithRateLimitFallback({
      primaryApiKey: primaryKey,
      backupApiKey: backupKey || undefined,
      requestedModel,
      fallbackModels,
      request: (apiKey, model) =>
        fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || requestedModel)}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
              systemInstruction: {
                parts: [
                  {
                    text: 'You are an expert digital librarian. Return only valid JSON evaluating candidate Audiobookshelf matches.',
                  },
                ],
              },
              generationConfig: {
                responseMimeType: 'application/json',
                temperature: 0.1,
              },
            }),
          },
        ),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      serverLogger.warn(
        { event: 'audiobookshelf.match.gemini_failed', status: response.status, error: errText },
        'Gemini matching call failed; falling back to deterministic matching',
      );
      return matchCandidatesDeterministically(candidates, targetTitle, targetAuthor);
    }

    const responseJson = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const rawText = responseJson.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '{}';
    const cleanedJson = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    const parsed = JSON.parse(cleanedJson) as Record<string, unknown>;
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
    const isMatch = Boolean(parsed.is_match && confidence >= 0.75 && parsed.matched_item_id);

    const matchedCandidate = isMatch
      ? candidates.find((c) => c.id === String(parsed.matched_item_id)) || null
      : null;

    const matchedFolderName = isMatch
      ? String(parsed.matched_folder_name || matchedCandidate?.folderName || '')
      : null;

    return {
      isMatch,
      matchedItemId: isMatch && parsed.matched_item_id ? String(parsed.matched_item_id) : null,
      matchedFolderName: matchedFolderName || (matchedCandidate ? matchedCandidate.folderName : null),
      confidence,
      reasoning: typeof parsed.reasoning === 'string'
        ? parsed.reasoning
        : (isMatch ? 'Gemini identified a confident match.' : 'No candidate met confidence threshold.'),
    };
  } catch (error) {
    serverLogger.warn(
      { event: 'audiobookshelf.match.gemini_error', error: errorToLog(error) },
      'Error during Gemini candidate matching; falling back to deterministic matching',
    );
    return matchCandidatesDeterministically(candidates, targetTitle, targetAuthor);
  }
}

/**
 * Updates an existing item in Audiobookshelf with unification tags.
 */
export async function tagAudiobookshelfItem(
  url: string,
  token: string,
  itemId: string,
  newTags: string[] = ['Audiobook', 'Companion Audiobook', 'OpenReader'],
): Promise<boolean> {
  try {
    const normalizedUrl = url.trim().replace(/\/+$/, '');
    let existingTags: string[] = [];
    try {
      const getRes = await fetch(`${normalizedUrl}/api/items/${encodeURIComponent(itemId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (getRes.ok) {
        const itemData = (await getRes.json()) as Record<string, unknown>;
        const media = (itemData?.media as Record<string, unknown>) || {};
        const metadata = (media?.metadata as Record<string, unknown>) || {};
        const tags = media?.tags || itemData?.tags || metadata?.tags;
        if (Array.isArray(tags)) {
          existingTags = tags.map((t: unknown) => String(t));
        }
      }
    } catch {
      // non-fatal
    }

    const mergedTags = Array.from(new Set([...existingTags, ...newTags]));

    const patchRes = await fetch(`${normalizedUrl}/api/items/${encodeURIComponent(itemId)}/media`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tags: mergedTags,
        metadata: { tags: mergedTags },
      }),
    });
    return patchRes.ok;
  } catch (err) {
    serverLogger.warn(
      { event: 'audiobookshelf.tag.failed', error: errorToLog(err), itemId },
      'Failed to tag unified Audiobookshelf item',
    );
    return false;
  }
}

/**
 * Uploads an audiobook file and companion original document into Audiobookshelf.
 */
export async function uploadBookToAudiobookshelf(
  options: AudiobookshelfUploadOptions,
): Promise<AudiobookshelfUploadResult> {
  const config = await resolveAudiobookshelfConfig();
  if (!config.url || !config.token) {
    throw new Error('Audiobookshelf connection is not configured. Please set the server URL and API token in Admin Settings.');
  }

  const targetLibraryId = options.libraryId || config.libraryId;
  if (!targetLibraryId) {
    throw new Error('No target Audiobookshelf library specified. Please select a library in Admin Settings or in the export dialog.');
  }

  // Resolve target folder ID:
  let targetFolderId = options.folderId || config.folderId;
  if (!targetFolderId) {
    // Look up libraries to select the default folder for this library
    const libraries = await fetchAudiobookshelfLibraries(config.url, config.token);
    const targetLib = libraries.find((l) => l.id === targetLibraryId);
    if (targetLib && targetLib.folders.length > 0) {
      targetFolderId = targetLib.folders[0].id;
    }
  }

  if (!targetFolderId) {
    throw new Error('No folder ID could be resolved for the selected Audiobookshelf library.');
  }

  const { bookId, userId, namespace = null } = options;

  // 1. Verify book and document exist and belong to user
  const bookRows = await db
    .select()
    .from(audiobooks)
    .where(and(eq(audiobooks.id, bookId), eq(audiobooks.userId, userId)));
  if (bookRows.length === 0) {
    throw new Error('Audiobook record not found.');
  }

  const docRows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, bookId), eq(documents.userId, userId)));
  const doc = docRows[0] || null;

  // 2. Check for held/rejected chapters
  const objects = await listAudiobookObjects(bookId, userId, namespace);
  const objectNames = objects.map((item) => item.fileName);
  const failedChapters = objectNames.filter((name) => /^\d{1,6}__rejected\.txt$/u.test(name));
  if (failedChapters.length > 0) {
    throw new Error(
      `${failedChapters.length} chapter(s) require review and successful replacement recording before uploading to Audiobookshelf.`,
    );
  }

  const chapters = listChapterObjects(objectNames);
  if (chapters.length === 0) {
    throw new Error('No chapters found for this audiobook.');
  }

  const format: TTSAudiobookFormat = chapters[0].format || 'm4b';
  const completeAudioName = `complete.${format}`;
  const manifestName = `${completeAudioName}.manifest.json`;

  const chapterRows = await db
    .select({
      chapterIndex: audiobookChapters.chapterIndex,
      title: audiobookChapters.title,
    })
    .from(audiobookChapters)
    .where(and(eq(audiobookChapters.bookId, bookId), eq(audiobookChapters.userId, userId)));
  const titleByIndex = new Map<number, string>();
  for (const row of chapterRows) {
    if (row.title.trim()) titleByIndex.set(row.chapterIndex, row.title.trim());
  }

  const signature = chapters.map((chapter) => ({
    index: chapter.index,
    fileName: chapter.fileName,
    title: titleByIndex.get(chapter.index) ?? chapter.title,
  }));

  // 3. Ensure combined audio exists
  let audioBuffer: Buffer | null = null;
  if (objectNames.includes(completeAudioName) && objectNames.includes(manifestName)) {
    try {
      const manifestRaw = await getAudiobookObjectBuffer(bookId, userId, manifestName, namespace);
      const manifest = JSON.parse(manifestRaw.toString('utf8'));
      if (JSON.stringify(manifest) === JSON.stringify(signature)) {
        audioBuffer = await getAudiobookObjectBuffer(bookId, userId, completeAudioName, namespace);
      }
    } catch {
      audioBuffer = null;
    }
  }

  if (!audioBuffer) {
    serverLogger.info(
      { event: 'audiobookshelf.combining_before_upload', bookId },
      'Assembling complete audiobook before Audiobookshelf upload',
    );
    await executeAudiobookCombine(bookId, userId, format, namespace);
    audioBuffer = await getAudiobookObjectBuffer(bookId, userId, completeAudioName, namespace);
  }

  const cleanTitle = sanitizeFilenameForAudiobookshelf(options.title || bookRows[0].title || 'Audiobook');
  const cleanAuthor = sanitizeFilenameForAudiobookshelf(options.author || bookRows[0].author || 'Unknown');
  const cleanSeries = options.series ? sanitizeFilenameForAudiobookshelf(options.series) : undefined;

  const audioFileName = `${cleanTitle}.${format}`;
  const audioMime = format === 'mp3' ? 'audio/mpeg' : 'audio/mp4';

  const filesUploaded: string[] = [audioFileName];

  // 4. Retrieve companion document if requested and available
  let companionBuffer: Buffer | null = null;
  let companionFileName: string | null = null;
  let companionMime = 'application/octet-stream';

  const shouldIncludeCompanion = options.includeCompanionDocument !== false && doc;
  if (shouldIncludeCompanion) {
    try {
      companionBuffer = await getDocumentBlob(doc.id, namespace);
      const rawExt = doc.name.includes('.') ? doc.name.split('.').pop()?.toLowerCase() : doc.type;
      const cleanExt = rawExt && /^[a-z0-9]+$/.test(rawExt) ? rawExt : 'pdf';
      companionFileName = `${cleanTitle}.${cleanExt}`;

      if (cleanExt === 'pdf') companionMime = 'application/pdf';
      else if (cleanExt === 'epub') companionMime = 'application/epub+zip';
      else if (cleanExt === 'docx') companionMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      else if (cleanExt === 'txt') companionMime = 'text/plain';

      filesUploaded.push(companionFileName);
    } catch (err) {
      serverLogger.warn(
        { event: 'audiobookshelf.companion_fetch_failed', error: errorToLog(err), bookId },
        'Failed to fetch companion original document; proceeding with audio only',
      );
      companionBuffer = null;
      companionFileName = null;
    }
  }

  // 5. Check for smart match unification with existing Audiobookshelf book
  let destinationFolderTitle = cleanTitle;
  let matchedItemId: string | null = null;
  let isUnified = false;

  if (options.targetFolderName) {
    destinationFolderTitle = sanitizeFilenameForAudiobookshelf(options.targetFolderName);
    matchedItemId = options.targetItemId || null;
    isUnified = Boolean(matchedItemId);
  } else if (options.smartMatchExistingBook !== false) {
    try {
      const candidates = await searchAudiobookshelfCandidates(
        config.url,
        config.token,
        targetLibraryId,
        cleanTitle,
        cleanAuthor,
      );
      if (candidates.length > 0) {
        const matchResult = await matchAudiobookshelfCandidateWithGemini(
          candidates,
          cleanTitle,
          cleanAuthor,
          { userId, model: options.model },
        );
        if (matchResult.isMatch && matchResult.matchedFolderName) {
          destinationFolderTitle = sanitizeFilenameForAudiobookshelf(matchResult.matchedFolderName);
          matchedItemId = matchResult.matchedItemId;
          isUnified = true;
          serverLogger.info(
            {
              event: 'audiobookshelf.smart_match_unified',
              matchedItemId,
              matchedFolderName: destinationFolderTitle,
              confidence: matchResult.confidence,
              reasoning: matchResult.reasoning,
            },
            'Matched existing Audiobookshelf book; unifying into existing directory',
          );
        }
      }
    } catch (err) {
      serverLogger.warn(
        { event: 'audiobookshelf.smart_match_failed', error: errorToLog(err) },
        'Smart candidate matching encountered an error; proceeding with standard upload',
      );
    }
  }

  // 6. Construct multipart/form-data payload for Audiobookshelf
  const formData = new FormData();
  formData.append('library', targetLibraryId);
  formData.append('folder', targetFolderId);
  formData.append('title', destinationFolderTitle);
  formData.append('author', cleanAuthor);
  if (cleanSeries) {
    formData.append('series', cleanSeries);
  }

  const audioBlob = new Blob([new Uint8Array(audioBuffer)], { type: audioMime });
  formData.append('file', audioBlob, audioFileName);

  if (companionBuffer && companionFileName) {
    const companionBlob = new Blob([new Uint8Array(companionBuffer)], { type: companionMime });
    formData.append('file_companion', companionBlob, companionFileName);
  }

  serverLogger.info(
    {
      event: 'audiobookshelf.uploading',
      url: config.url,
      targetLibraryId,
      targetFolderId,
      title: cleanTitle,
      destinationFolderTitle,
      author: cleanAuthor,
      files: filesUploaded,
      isUnified,
    },
    'Uploading audiobook to Audiobookshelf',
  );

  const uploadEndpoint = `${config.url}/api/upload`;
  const uploadResponse = await fetch(uploadEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
    },
    body: formData,
  });

  if (!uploadResponse.ok) {
    const errText = await uploadResponse.text().catch(() => '');
    serverLogger.error(
      {
        event: 'audiobookshelf.upload_failed',
        status: uploadResponse.status,
        error: errText,
      },
      'Audiobookshelf upload failed',
    );
    throw new Error(`Audiobookshelf upload failed (${uploadResponse.status}): ${errText || uploadResponse.statusText}`);
  }

  // 7. Trigger library scan in background
  const scanTriggered = await triggerAudiobookshelfScan(config.url, config.token, targetLibraryId);

  // 8. Tag unified book item if match was unified
  if (matchedItemId) {
    await tagAudiobookshelfItem(config.url, config.token, matchedItemId);
  }

  serverLogger.info(
    {
      event: 'audiobookshelf.upload_success',
      bookId,
      title: cleanTitle,
      destinationFolderTitle,
      filesUploaded,
      scanTriggered,
      isUnified,
      matchedItemId,
    },
    'Successfully uploaded audiobook to Audiobookshelf',
  );

  return {
    success: true,
    title: cleanTitle,
    author: cleanAuthor,
    libraryId: targetLibraryId,
    folderId: targetFolderId,
    files: filesUploaded,
    scanTriggered,
    matchedItemId,
    matchedFolderName: isUnified ? destinationFolderTitle : null,
    unified: isUnified,
  };
}
