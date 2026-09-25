import {
  reconcileSmartAudioPronunciations,
  SmartAudioOutputValidationError,
  validateSmartAudioOutput,
} from '@/lib/shared/smart-audio-cleanup';
import { KOKORO_DEFAULT_VOICES } from '@/lib/shared/tts-provider-catalog';
import type {
  SmartAudioCharacterEntry,
  SmartAudioCharacterMap,
  DramaCharacterDirection,
} from '@/types/document-settings';
import {
  CLOUD_TTS_FEMALE_VOICE_SET,
  CLOUD_TTS_MALE_VOICE_SET,
} from '@/lib/shared/google-cloud-tts-voices';

export const MULTI_VOICE_WORKER_MODE = 'multi-voice' as const;
export const DRAMA_GEMINI_TTS_WORKER_MODE = 'drama-gemini-tts' as const;
export const WAITING_FOR_VOICES_STATUS = 'waiting_for_voices' as const;

export const KOKORO_CHARACTER_VOICES = KOKORO_DEFAULT_VOICES;

const KOKORO_CHARACTER_VOICE_SET = new Set<string>(KOKORO_CHARACTER_VOICES);
const PRIVATE_MULTI_VOICE_MARKER = /\[(?:CONTINUITY|TITLE|CHAPTER_TITLE|LAYOUT_ENGINE_TAG|SYSTEM HINT)\s*:/iu;
const VOICE_TAG = /<voice\s+name="([^"]+)"(\s+omitted="true")?>([\s\S]*?)<\/voice>/giu;

export type MultiVoiceSegment = {
  speaker: string;
  voiceId: string;
  text: string;
  omitted?: boolean;
};

export type MultiVoiceCastMember = {
  name: string;
  voiceId: string;
  aliases: string[];
};

export type DuplicateVoiceAssignment = {
  voiceId: string;
  characterNames: string[];
};

export type ResolvedMultiVoiceWorkerResult = {
  taggedText: string;
  segments: MultiVoiceSegment[];
  continuityState: string;
  chapterTitle: string | null;
  unknownSpeakers?: string[];
};

function normalizedName(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFC').replace(/\s+/gu, ' ').trim().slice(0, 120)
    : '';
}

function normalizedDescription(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 1_000) : '';
}

function normalizedSample(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 2_000) : '';
}

/**
 * Options for character map normalization.
 * All fields are optional and default to Kokoro behavior when absent.
 */
export interface NormalizeCharacterMapOptions {
  /**
   * The set of valid voice IDs for this provider.
   * voiceId values not in this set are nulled out during normalization.
   * Defaults to KOKORO_CHARACTER_VOICE_SET when not provided.
   */
  validVoiceSet?: ReadonlySet<string>;
}

/**
 * Safely normalize a raw `cloudDirection` value from stored JSON.
 * Returns null if the value is absent, malformed, or missing the required `audioProfile`.
 * The Kokoro Drama path never passes a value with this field, so this function
 * simply returns null for all existing Kokoro cast entries.
 */
function normalizeCloudDirection(value: unknown): DramaCharacterDirection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const src = value as Record<string, unknown>;
  const audioProfile = typeof src.audioProfile === 'string' ? src.audioProfile.trim() : '';
  if (!audioProfile) return null;

  let defaultPerformance: DramaCharacterDirection['defaultPerformance'] | undefined;
  if (src.defaultPerformance && typeof src.defaultPerformance === 'object' && !Array.isArray(src.defaultPerformance)) {
    const dp = src.defaultPerformance as Record<string, unknown>;
    const pace = typeof dp.pace === 'string' ? dp.pace.trim() : undefined;
    const energy = typeof dp.energy === 'string' ? dp.energy.trim() : undefined;
    const intensity = typeof dp.intensity === 'string' ? dp.intensity.trim() : undefined;
    const delivery = Array.isArray(dp.delivery)
      ? dp.delivery.filter((d): d is string => typeof d === 'string' && d.trim().length > 0).map((d) => d.trim())
      : undefined;
    const hasAny = pace || energy || intensity || (delivery && delivery.length > 0);
    if (hasAny) defaultPerformance = { pace, energy, intensity, delivery };
  }

  let technicalOverrides: DramaCharacterDirection['technicalOverrides'] | undefined;
  if (src.technicalOverrides && typeof src.technicalOverrides === 'object' && !Array.isArray(src.technicalOverrides)) {
    const to = src.technicalOverrides as Record<string, unknown>;
    const speakingRate = typeof to.speakingRate === 'number' && Number.isFinite(to.speakingRate)
      ? Math.min(Math.max(to.speakingRate, 0.25), 2.0)
      : undefined;
    const pitch = typeof to.pitch === 'number' && Number.isFinite(to.pitch)
      ? Math.min(Math.max(to.pitch, -20.0), 20.0)
      : undefined;
    if (speakingRate !== undefined || pitch !== undefined) technicalOverrides = { speakingRate, pitch };
  }

  return {
    audioProfile,
    ...(defaultPerformance !== undefined ? { defaultPerformance } : {}),
    ...(technicalOverrides !== undefined ? { technicalOverrides } : {}),
  };
}

function characterEntry(
  value: unknown,
  validVoiceSet: ReadonlySet<string>,
): SmartAudioCharacterEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const name = normalizedName(source.name);
  if (!name) return null;
  const voiceId = typeof source.voiceId === 'string' && validVoiceSet.has(source.voiceId)
    ? source.voiceId
    : null;
  const aliasFor = normalizedName(source.aliasFor) || null;
  const cloudDirection = normalizeCloudDirection(source.cloudDirection);
  const importance: 'main' | 'minor' = (source.importance === 'main' || source.importance === 'minor')
    ? source.importance
    : (name.toLocaleLowerCase() === 'narrator' ? 'main' : 'minor');
  return {
    name,
    description: normalizedDescription(source.description),
    sampleText: normalizedSample(source.sampleText),
    voiceId,
    aliasFor,
    importance,
    // Only include cloudDirection when present; keeps Kokoro entries clean
    ...(cloudDirection !== null ? { cloudDirection } : {}),
  };
}

export function normalizeSmartAudioCharacterMap(
  value: unknown,
  options: NormalizeCharacterMapOptions = {},
): SmartAudioCharacterMap | null {
  const voiceSet = options.validVoiceSet ?? KOKORO_CHARACTER_VOICE_SET;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.schemaVersion !== 1 || !source.entries || typeof source.entries !== 'object') return null;
  const entries: Record<string, SmartAudioCharacterEntry> = {};
  const canonicalNames = new Set<string>();
  for (const rawEntry of Object.values(source.entries as Record<string, unknown>)) {
    const entry = characterEntry(rawEntry, voiceSet);
    const canonicalName = entry?.name.toLocaleLowerCase() || '';
    if (!entry || canonicalNames.has(canonicalName)) continue;
    canonicalNames.add(canonicalName);
    entries[entry.name] = entry;
  }
  if (Object.keys(entries).length === 0) return null;

  const entriesByCanonicalName = new Map(
    Object.values(entries).map((entry) => [entry.name.toLocaleLowerCase(), entry]),
  );
  for (const entry of Object.values(entries)) {
    if (!entry.aliasFor) continue;
    const target = entriesByCanonicalName.get(entry.aliasFor.toLocaleLowerCase());
    if (!target || target.aliasFor || target.name === entry.name) entry.aliasFor = null;
    if (entry.aliasFor && target) {
      entry.aliasFor = target.name;
      entry.voiceId = null;
    }
  }

  return {
    schemaVersion: 1,
    status: source.status === 'complete' ? 'complete' : 'partial',
    scannedAt: typeof source.scannedAt === 'number' && Number.isFinite(source.scannedAt)
      ? source.scannedAt
      : Date.now(),
    ...(typeof source.profileId === 'string' && source.profileId.trim()
      ? { profileId: source.profileId.trim() }
      : {}),
    ...(typeof source.sourceFingerprint === 'string' && source.sourceFingerprint.trim()
      ? { sourceFingerprint: source.sourceFingerprint.trim() }
      : {}),
    ...(source.needsRescan === true ? { needsRescan: true } : {}),
    entries,
  };
}

export function getDuplicateVoiceAssignments(value: unknown, options: NormalizeCharacterMapOptions = {}): DuplicateVoiceAssignment[] {
  const map = normalizeSmartAudioCharacterMap(value, options);
  if (!map) return [];
  const namesByVoice = new Map<string, string[]>();
  for (const entry of Object.values(map.entries)) {
    if (entry.aliasFor || !entry.voiceId) continue;
    const names = namesByVoice.get(entry.voiceId) || [];
    names.push(entry.name);
    namesByVoice.set(entry.voiceId, names);
  }
  return [...namesByVoice.entries()]
    .filter(([, characterNames]) => characterNames.length > 1)
    .map(([voiceId, characterNames]) => ({ voiceId, characterNames }));
}

export function getNarratorVoiceId(value: unknown, options: NormalizeCharacterMapOptions = {}): string | null {
  const map = normalizeSmartAudioCharacterMap(value, options);
  const narrator = Object.values(map?.entries || {}).find(
    (entry) => !entry.aliasFor && entry.name.toLocaleLowerCase() === 'narrator',
  );
  return narrator?.voiceId || null;
}

export function requiresDramaAudiobookReplacement(input: {
  hasExistingChapters: boolean;
  requestedWorkerMode: string | null | undefined;
  previousUseSmartAudio: boolean;
  previousWorkerMode: string | null | undefined;
}): boolean {
  return input.hasExistingChapters
    && input.requestedWorkerMode === MULTI_VOICE_WORKER_MODE
    && !(input.previousUseSmartAudio && input.previousWorkerMode === MULTI_VOICE_WORKER_MODE);
}

export function estimateSpeakerSegmentAtTime(
  texts: readonly string[],
  currentTimeSeconds: number,
  durationSeconds: number,
): number | null {
  if (texts.length === 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  const weights = texts.map((text) => Math.max(
    1,
    text.trim().length
      + (text.match(/[.!?…]/gu)?.length || 0) * 12
      + (text.match(/\n/gu)?.length || 0) * 20,
  ));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const boundedTime = Math.min(Math.max(currentTimeSeconds, 0), durationSeconds);
  const targetWeight = (boundedTime / durationSeconds) * totalWeight;
  let elapsedWeight = 0;
  for (let index = 0; index < weights.length; index += 1) {
    elapsedWeight += weights[index];
    if (targetWeight < elapsedWeight || index === weights.length - 1) return index;
  }
  return texts.length - 1;
}

export interface CharacterMapReadinessOptions {
  /** Voice set to validate assigned voiceIds against. Defaults to the Kokoro character voice set. */
  validVoiceSet?: ReadonlySet<string>;
}

export function getCharacterMapReadiness(value: unknown, options: CharacterMapReadinessOptions = {}): {
  ready: boolean;
  map: SmartAudioCharacterMap | null;
  unassigned: string[];
  unassignedMain: string[];
  unassignedMinor: string[];
  errors: string[];
} {
  const voiceSet = options.validVoiceSet ?? KOKORO_CHARACTER_VOICE_SET;
  const map = normalizeSmartAudioCharacterMap(value, { validVoiceSet: voiceSet });
  if (!map) return { ready: false, map: null, unassigned: [], unassignedMain: [], unassignedMinor: [], errors: ['No character scan is available.'] };
  const primary = Object.values(map.entries).filter((entry) => !entry.aliasFor);
  const unassigned = primary
    .filter((entry) => !entry.voiceId || !voiceSet.has(entry.voiceId))
    .map((entry) => entry.name);
  const unassignedMain = primary
    .filter((entry) => (entry.name.toLocaleLowerCase() === 'narrator' || entry.importance === 'main') && (!entry.voiceId || !voiceSet.has(entry.voiceId)))
    .map((entry) => entry.name);
  const unassignedMinor = primary
    .filter((entry) => entry.name.toLocaleLowerCase() !== 'narrator' && entry.importance !== 'main' && (!entry.voiceId || !voiceSet.has(entry.voiceId)))
    .map((entry) => entry.name);
  const errors: string[] = [];
  if (!primary.some((entry) => entry.name.toLocaleLowerCase() === 'narrator')) {
    errors.push('The cast must include a Narrator.');
  }
  if (primary.length === 0) errors.push('The cast has no primary characters.');
  if (unassignedMain.length > 0) errors.push(`Main characters need assigned voices: ${unassignedMain.join(', ')}.`);
  if (unassignedMinor.length > 0 && unassignedMain.length === 0) errors.push('Every primary character needs a voice.');
  if (map.needsRescan) errors.push('The document narration filters changed; rescan the cast.');
  return {
    ready: map.status === 'complete' && errors.length === 0,
    map,
    unassigned,
    unassignedMain,
    unassignedMinor,
    errors,
  };
}

export function finalizeSmartAudioCharacterMap(value: unknown): SmartAudioCharacterMap {
  const readiness = getCharacterMapReadiness(value);
  if (!readiness.map) throw new Error(readiness.errors[0] || 'Invalid character map.');
  if (readiness.unassigned.length > 0 || readiness.errors.length > 0) {
    throw new Error([...readiness.errors, ...readiness.unassigned.map((name) => `${name} is unassigned.`)].join(' '));
  }
  const finalized = { ...readiness.map, status: 'complete' as const };
  delete finalized.needsRescan;
  return finalized;
}

export function buildMultiVoiceCast(value: unknown): MultiVoiceCastMember[] {
  const map = finalizeSmartAudioCharacterMap(value);
  return Object.values(map.entries)
    .filter((entry): entry is SmartAudioCharacterEntry & { voiceId: string } => (
      !entry.aliasFor && typeof entry.voiceId === 'string'
    ))
    .map((entry) => ({
      name: entry.name,
      voiceId: entry.voiceId,
      aliases: Object.values(map.entries)
        .filter((candidate) => candidate.aliasFor === entry.name)
        .map((candidate) => candidate.name),
    }));
}

export function mergeExtractedCharacters(input: {
  previous: unknown;
  characters: unknown;
  profileId: string;
  sourceFingerprint: string;
  scannedAt?: number;
  validVoiceSet?: ReadonlySet<string>;
}): SmartAudioCharacterMap {
  const previous = normalizeSmartAudioCharacterMap(input.previous, { validVoiceSet: input.validVoiceSet });
  const previousByName = new Map(
    Object.values(previous?.entries || {}).map((entry) => [entry.name.toLocaleLowerCase(), entry]),
  );
  const rawCharacters = Array.isArray(input.characters) ? input.characters : [];
  const entries: Record<string, SmartAudioCharacterEntry> = {};
  const extractedNames = new Set<string>();

  for (const raw of rawCharacters) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const source = raw as Record<string, unknown>;
    const name = normalizedName(source.name);
    const canonicalName = name.toLocaleLowerCase();
    if (!name || extractedNames.has(canonicalName)) continue;
    extractedNames.add(canonicalName);
    const existing = previousByName.get(canonicalName);
    const rawImportance = typeof source.importance === 'string' ? source.importance.toLowerCase() : '';
    const importance: 'main' | 'minor' = (rawImportance === 'main' || rawImportance === 'minor')
      ? rawImportance
      : (existing?.importance || (canonicalName === 'narrator' ? 'main' : 'minor'));
    entries[name] = {
      name,
      description: normalizedDescription(source.description) || existing?.description || '',
      sampleText: normalizedSample(source.sample_text ?? source.sampleText) || existing?.sampleText || '',
      voiceId: existing?.voiceId || null,
      importance,
      ...(existing?.cloudDirection ? { cloudDirection: existing.cloudDirection } : {}),
      aliasFor: existing?.aliasFor && previous?.entries[existing.aliasFor]
        ? existing.aliasFor
        : null,
    };
  }

  const narratorKey = Object.keys(entries).find((name) => name.toLocaleLowerCase() === 'narrator');
  if (!narratorKey) {
    const existingNarrator = previousByName.get('narrator');
    entries.Narrator = {
      name: 'Narrator',
      description: existingNarrator?.description || 'Primary audiobook narrator.',
      sampleText: existingNarrator?.sampleText || '',
      voiceId: existingNarrator?.voiceId || null,
      importance: 'main',
      ...(existingNarrator?.cloudDirection ? { cloudDirection: existingNarrator.cloudDirection } : {}),
      aliasFor: null,
    };
  } else {
    entries[narratorKey].importance = 'main';
  }

  if (Object.keys(entries).length === 0) {
    throw new Error('The character scan returned no usable cast members.');
  }
  return {
    schemaVersion: 1,
    status: 'partial',
    scannedAt: input.scannedAt ?? Date.now(),
    profileId: input.profileId,
    sourceFingerprint: input.sourceFingerprint,
    entries,
  };
}

function safeSegmentText(value: unknown, authoritativePronunciations?: Record<string, string>): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  if (/<[^>]+>/u.test(text) || PRIVATE_MULTI_VOICE_MARKER.test(text)) {
    throw new SmartAudioOutputValidationError('Multi-voice output contained markup or private control markers.');
  }
  return validateSmartAudioOutput(
    authoritativePronunciations
      ? reconcileSmartAudioPronunciations(text, authoritativePronunciations)
      : text,
    { requirePronunciationTagsForForeignScripts: false }
  );
}

export function renderVoiceSegments(segments: readonly MultiVoiceSegment[]): string {
  return segments
    .map((segment) => `<voice name="${segment.voiceId}"${segment.omitted ? ' omitted="true"' : ''}>${segment.text}</voice>`)
    .join('\n\n');
}

export function resolveMultiVoiceWorkerResult(
  value: unknown,
  cast: readonly MultiVoiceCastMember[],
  options: { authoritativePronunciations?: Record<string, string>; allowUnknownSpeakers?: boolean } = {},
): ResolvedMultiVoiceWorkerResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SmartAudioOutputValidationError('Multi-voice worker returned an invalid response.');
  }
  const result = value as Record<string, unknown>;
  if (result.status !== 'success') {
    const message = typeof result.message === 'string' && result.message.trim()
      ? result.message.trim()
      : 'unknown worker error';
    throw new SmartAudioOutputValidationError(`Multi-voice worker failed: ${message}`);
  }
  if (!Array.isArray(result.segments) || result.segments.length === 0 || result.segments.length > 5_000) {
    throw new SmartAudioOutputValidationError('Multi-voice worker returned no valid speaker segments.');
  }

  const unknownSpeakers: string[] = [];
  const speakerMap = new Map<string, MultiVoiceCastMember>();
  for (const member of cast) {
    speakerMap.set(member.name.toLocaleLowerCase(), member);
    for (const alias of member.aliases) speakerMap.set(alias.toLocaleLowerCase(), member);
  }
  const segments: MultiVoiceSegment[] = [];
  for (const raw of result.segments) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new SmartAudioOutputValidationError('Multi-voice worker returned a malformed segment.');
    }
    const segment = raw as Record<string, unknown>;
    const speaker = normalizedName(segment.speaker);
    const member = speakerMap.get(speaker.toLocaleLowerCase());
    if (!speaker || !member) {
      if (options.allowUnknownSpeakers) {
         unknownSpeakers.push(speaker || 'blank');
         const narrator = cast.find(c => c.name.toLocaleLowerCase() === 'narrator') || cast[0];
         segments.push({ speaker: speaker || 'blank', voiceId: narrator ? narrator.voiceId : KOKORO_CHARACTER_VOICES[0], text: safeSegmentText(segment.text, options.authoritativePronunciations) });
         continue;
      }
      throw new SmartAudioOutputValidationError(`Multi-voice worker used an unknown speaker: ${speaker || 'blank'}.`);
    }
    const suppliedVoice = typeof segment.voice_id === 'string'
      ? segment.voice_id
      : typeof segment.voiceId === 'string'
        ? segment.voiceId
        : '';
    if (suppliedVoice && suppliedVoice !== member.voiceId) {
      throw new SmartAudioOutputValidationError(`Multi-voice worker changed the assigned voice for ${speaker}.`);
    }
    const text = safeSegmentText(segment.text, options.authoritativePronunciations);
    if (!text) continue;
    const omitted = segment.omit_from_audio === true;
    if (omitted && member.name.toLocaleLowerCase() !== 'narrator') {
      throw new SmartAudioOutputValidationError('Only Narrator attribution segments may be omitted from Audio Drama TTS.');
    }
    const previous = segments.at(-1);
    if (!omitted && !previous?.omitted && previous?.speaker === member.name) {
      previous.text = `${previous.text}\n\n${text}`;
    } else {
      segments.push({ speaker: member.name, voiceId: member.voiceId, text, ...(omitted ? { omitted: true } : {}) });
    }
  }
  if (segments.length === 0) {
    throw new SmartAudioOutputValidationError('Multi-voice worker returned only empty segments.');
  }

  const continuityState = typeof result.continuity_state === 'string'
    ? result.continuity_state.trim().slice(0, 2_000)
    : '';
  const rawTitle = typeof result.chapter_title === 'string' ? result.chapter_title.trim() : '';
  const chapterTitle = rawTitle && !PRIVATE_MULTI_VOICE_MARKER.test(rawTitle) && !/<[^>]+>/u.test(rawTitle)
    ? rawTitle.slice(0, 160)
    : null;
  return {
    taggedText: renderVoiceSegments(segments),
    segments,
    continuityState,
    chapterTitle,
    unknownSpeakers,
  };
}

export function parseVoiceTaggedText(
  text: string,
  options: { includeOmitted?: boolean } = {},
): MultiVoiceSegment[] {
  const segments: MultiVoiceSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  VOICE_TAG.lastIndex = 0;
  while ((match = VOICE_TAG.exec(text)) !== null) {
    if (text.slice(lastIndex, match.index).trim()) {
      throw new SmartAudioOutputValidationError('Multi-voice text contained narration outside a voice segment.');
    }
    const voiceId = match[1].trim();
    if (!KOKORO_CHARACTER_VOICE_SET.has(voiceId)) {
      throw new SmartAudioOutputValidationError(`Multi-voice text used an unsupported voice: ${voiceId}.`);
    }
    const omitted = Boolean(match[2]);
    const segmentText = safeSegmentText(match[3]);
    if (segmentText && (!omitted || options.includeOmitted)) {
      segments.push({ speaker: voiceId, voiceId, text: segmentText, ...(omitted ? { omitted: true } : {}) });
    }
    lastIndex = VOICE_TAG.lastIndex;
  }
  if (text.slice(lastIndex).trim()) {
    throw new SmartAudioOutputValidationError('Multi-voice text contained trailing narration outside a voice segment.');
  }
  if (segments.length === 0 && /<\/?voice\b/iu.test(text)) {
    throw new SmartAudioOutputValidationError('Multi-voice text contained malformed voice markup.');
  }
  return segments;
}

export const KOKORO_AMERICAN_FEMALE_VOICES = [
  'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica',
  'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
] as const;

export const KOKORO_AMERICAN_MALE_VOICES = [
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam',
  'am_michael', 'am_onyx', 'am_puck', 'am_santa',
] as const;

export const KOKORO_BRITISH_FEMALE_VOICES = [
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
] as const;

export const KOKORO_BRITISH_MALE_VOICES = [
  'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
] as const;

export const KOKORO_RECYCLABLE_ENGLISH_VOICES = [
  ...KOKORO_AMERICAN_FEMALE_VOICES,
  ...KOKORO_AMERICAN_MALE_VOICES,
  ...KOKORO_BRITISH_FEMALE_VOICES,
  ...KOKORO_BRITISH_MALE_VOICES,
] as const;

export interface CharacterUsageMetrics {
  spokenLength?: number;
  chapterCount?: number;
}

export interface AutoAssignMinorVoicesOptions {
  characterMap: SmartAudioCharacterMap;
  characterUsageMetrics?: Record<string, CharacterUsageMetrics>;
  mainCharacterThreshold?: number;
  targetCharacters?: string[];
  /**
   * Pool of recyclable voices to draw from when assigning minor characters.
   * Defaults to KOKORO_RECYCLABLE_ENGLISH_VOICES when not provided.
   */
  voicePool?: readonly string[];
  /**
   * Valid voice set for the "already assigned" skip check.
   * Defaults to KOKORO_CHARACTER_VOICE_SET when not provided.
   */
  validVoiceSet?: ReadonlySet<string>;
}

export interface AutoAssignMinorVoicesResult {
  updatedMap: SmartAudioCharacterMap;
  assigned: Array<{ characterName: string; voiceId: string; reason: string }>;
  protectedVoices: string[];
}

export function autoAssignMinorCharacterVoices(
  options: AutoAssignMinorVoicesOptions,
): AutoAssignMinorVoicesResult {
  const {
    characterMap,
    characterUsageMetrics = {},
    mainCharacterThreshold = 0.05,
    targetCharacters,
    voicePool = KOKORO_RECYCLABLE_ENGLISH_VOICES,
    validVoiceSet = KOKORO_CHARACTER_VOICE_SET,
  } = options;

  const entriesCopy: Record<string, SmartAudioCharacterEntry> = Object.fromEntries(
    Object.entries(characterMap.entries).map(([k, v]) => [k, { ...v }]),
  );

  const targetSet = targetCharacters
    ? new Set(targetCharacters.map((c) => c.toLowerCase()))
    : null;

  const protectedVoices = new Set<string>();

  const narratorVoice = getNarratorVoiceId(characterMap);
  if (narratorVoice) {
    protectedVoices.add(narratorVoice);
  }

  let totalSpokenLength = 0;
  for (const [name, metrics] of Object.entries(characterUsageMetrics)) {
    if (name.toLowerCase() === 'narrator') continue;
    totalSpokenLength += metrics.spokenLength || 0;
  }

  const hasMetrics = totalSpokenLength > 0;

  for (const entry of Object.values(entriesCopy)) {
    if (entry.aliasFor || !entry.voiceId) continue;
    if (entry.name.toLowerCase() === 'narrator') continue;

    if (entry.importance === 'main') {
      protectedVoices.add(entry.voiceId);
      continue;
    }

    if (entry.sampleText && entry.voiceId) {
      protectedVoices.add(entry.voiceId);
      continue;
    }

    if (hasMetrics) {
      const charMetrics = characterUsageMetrics[entry.name]
        || characterUsageMetrics[entry.name.toLowerCase()]
        || characterUsageMetrics[entry.voiceId];
      const spoken = charMetrics?.spokenLength || 0;
      const chapters = charMetrics?.chapterCount || 0;
      const share = totalSpokenLength > 0 ? spoken / totalSpokenLength : 0;

      if (share >= mainCharacterThreshold || chapters >= 3) {
        protectedVoices.add(entry.voiceId);
      }
    }
  }

  let recyclableVoices = voicePool.filter(
    (v) => !protectedVoices.has(v),
  );

  if (recyclableVoices.length === 0) {
    recyclableVoices = voicePool.filter((v) => v !== narratorVoice);
  }

  const femaleVoices = recyclableVoices.filter((v) => (
    (KOKORO_AMERICAN_FEMALE_VOICES as readonly string[]).includes(v)
    || (KOKORO_BRITISH_FEMALE_VOICES as readonly string[]).includes(v)
    || CLOUD_TTS_FEMALE_VOICE_SET.has(v)
  ));
  const maleVoices = recyclableVoices.filter((v) => (
    (KOKORO_AMERICAN_MALE_VOICES as readonly string[]).includes(v)
    || (KOKORO_BRITISH_MALE_VOICES as readonly string[]).includes(v)
    || CLOUD_TTS_MALE_VOICE_SET.has(v)
  ));

  const voiceUsageCount = new Map<string, number>();
  for (const v of recyclableVoices) {
    voiceUsageCount.set(v, 0);
  }
  for (const entry of Object.values(entriesCopy)) {
    if (entry.voiceId && voiceUsageCount.has(entry.voiceId)) {
      voiceUsageCount.set(entry.voiceId, (voiceUsageCount.get(entry.voiceId) || 0) + 1);
    }
  }

  const assigned: Array<{ characterName: string; voiceId: string; reason: string }> = [];

  for (const entry of Object.values(entriesCopy)) {
    if (entry.aliasFor) continue;
    if (entry.name.toLowerCase() === 'narrator') continue;
    if (entry.importance === 'main') continue;
    // Skip if already assigned to a valid voice in the current provider's voice set
    if (entry.voiceId && validVoiceSet.has(entry.voiceId)) continue;

    if (targetSet && !targetSet.has(entry.name.toLowerCase())) {
      continue;
    }

    const desc = `${entry.name} ${entry.description || ''} ${entry.sampleText || ''}`.toLowerCase();
    const isFemale = /\b(she|her|female|woman|girl|lady|queen|princess|mother|sister|daughter|witch|priestess|goddess|mrs|ms|miss)\b/iu.test(desc);
    const isMale = /\b(he|him|his|male|man|boy|lord|king|prince|father|brother|son|wizard|priest|god|mr|sir)\b/iu.test(desc);

    let candidates: readonly string[] = recyclableVoices;
    let genderReason = 'neutral';
    if (isFemale && !isMale && femaleVoices.length > 0) {
      candidates = femaleVoices;
      genderReason = 'female';
    } else if (isMale && !isFemale && maleVoices.length > 0) {
      candidates = maleVoices;
      genderReason = 'male';
    }

    let bestVoice = candidates[0];
    let minCount = voiceUsageCount.get(bestVoice) ?? 0;
    for (const v of candidates) {
      const count = voiceUsageCount.get(v) ?? 0;
      if (count < minCount) {
        minCount = count;
        bestVoice = v;
      }
    }

    entry.voiceId = bestVoice;
    if (!entry.description) {
      entry.description = `Auto-assigned minor character (${bestVoice}).`;
    }
    voiceUsageCount.set(bestVoice, (voiceUsageCount.get(bestVoice) || 0) + 1);

    assigned.push({
      characterName: entry.name,
      voiceId: bestVoice,
      reason: `Assigned least-used ${genderReason} recyclable English voice (avoiding main characters).`,
    });
  }

  const tempMap = {
    ...characterMap,
    status: 'complete' as const,
    entries: entriesCopy,
  };
  delete tempMap.needsRescan;
  const readiness = getCharacterMapReadiness(tempMap, { validVoiceSet });
  const isComplete = readiness.ready && readiness.unassigned.length === 0;

  const updatedMap: SmartAudioCharacterMap = {
    ...characterMap,
    status: isComplete ? 'complete' : characterMap.status,
    entries: entriesCopy,
  };

  if (isComplete) {
    delete updatedMap.needsRescan;
  }

  return {
    updatedMap,
    assigned,
    protectedVoices: Array.from(protectedVoices),
  };
}
