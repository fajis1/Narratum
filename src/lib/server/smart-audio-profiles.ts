import fs from 'fs';
import path from 'path';
import { db } from '@/db';
import { userPreferences } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import type { SmartAudioProfile, ScanProvider } from '@/types/client';
import { DEFAULT_PROVIDER_ORDER } from '@/types/client';
import {
  DEFAULT_DRAMA_GEMINI_TTS_SETTINGS,
  normalizeDramaGeminiTtsProfileSettings,
} from '@/lib/shared/drama-profile-settings';
import { serverLogger } from '@/lib/server/logger';
import {
  DEFAULT_CLEANUP_AI_MODEL,
  resolveCleanupAiModels,
  resolvePronunciationAiModel,
  resolvePronunciationAiModels,
} from '@/lib/shared/smart-audio-models';
import defaultProfilesData from './default_smart_audio_profiles.json';

const configDir = path.join(process.cwd(), 'config');
const defaultProfileSourcePath = path.join(configDir, 'default_book_tts_settings.json');

export interface SmartAudioProfilesDocument {
  selectedProfileId: string;
  profiles: SmartAudioProfile[];
}

export interface RestoredSmartAudioProfile {
  id: string;
  name: string;
}

export interface RestoreMissingBuiltInProfilesResult {
  document: SmartAudioProfilesDocument;
  restoredProfiles: RestoredSmartAudioProfile[];
}

// A new decision ID offers 3.8 even to users who decided on the earlier rollout.
// Upgrade both primary task fields; preserve explicit fallback/custom choices.
export const PRONUNCIATION_MODEL_UPGRADE_ID = 'gemini-3.7-flash-to-gemini-3.8-flash-all-tasks-v1';
export const PRONUNCIATION_MODEL_UPGRADE_FROM = 'gemini-3.7-flash';
export const PRONUNCIATION_MODEL_UPGRADE_TO = 'gemini-3.8-flash';

export type PronunciationModelUpgradeDecision = 'upgrade' | 'stay';

export interface PronunciationModelUpgradeOffer {
  available: boolean;
  affectedProfileCount: number;
  fromModel: string;
  toModel: string;
}

export function mergeGeneratedPronunciations(
  profile: SmartAudioProfile,
  generatedPronunciations: Record<string, string>,
  pronunciationsAtScanStart: Record<string, string>,
): {
  profile: SmartAudioProfile;
  appliedWords: string[];
  preservedUserEdits: string[];
} {
  const pronunciations = { ...(profile.pronunciations || {}) };
  const appliedWords: string[] = [];
  const preservedUserEdits: string[] = [];
  for (const [word, pronunciation] of Object.entries(generatedPronunciations)) {
    if (pronunciations[word] !== pronunciationsAtScanStart[word]) {
      preservedUserEdits.push(word);
      continue;
    }
    pronunciations[word] = pronunciation;
    appliedWords.push(word);
  }
  return {
    profile: { ...profile, pronunciations },
    appliedWords,
    preservedUserEdits,
  };
}

export function redactSmartAudioProfileSecrets(profile: SmartAudioProfile): SmartAudioProfile {
  // Extract safe metadata from Service Account JSON without exposing raw secrets.
  let googleCloudServiceAccountEmail: string | null = null;
  if (profile.googleCloudServiceAccountJson) {
    try {
      const sa = JSON.parse(profile.googleCloudServiceAccountJson) as Record<string, unknown>;
      googleCloudServiceAccountEmail = typeof sa.client_email === 'string' ? sa.client_email : null;
    } catch {
      // Malformed JSON stored; treat as configured but unparseable
    }
  }
  return {
    id: profile.id,
    name: profile.name,
    aiModel: profile.aiModel,
    pronunciationAiModel: profile.pronunciationAiModel,
    customTtsPrompt: profile.customTtsPrompt,
    abbreviations: profile.abbreviations,
    pronunciations: profile.pronunciations,
    books: profile.books,
    useGlobalPronunciations: profile.useGlobalPronunciations,
    pronunciationPromptMode: profile.pronunciationPromptMode,
    customPronunciationPrompt: profile.customPronunciationPrompt,
    workerMode: profile.workerMode,
    geminiApiKeyConfigured: Boolean(profile.geminiApiKey),
    geminiApiKeyLast4: profile.geminiApiKey ? profile.geminiApiKey.slice(-4) : undefined,
    backupGeminiApiKeyConfigured: Boolean(profile.backupGeminiApiKey),
    backupGeminiApiKeyLast4: profile.backupGeminiApiKey
      ? profile.backupGeminiApiKey.slice(-4)
      : undefined,
    geminiApiKeySourceProfileId: profile.geminiApiKeySourceProfileId || profile.id,
    backupGeminiApiKeySourceProfileId: profile.backupGeminiApiKeySourceProfileId || profile.id,
    groqApiKeyConfigured: Boolean(profile.groqApiKey),
    groqApiKeyLast4: profile.groqApiKey ? profile.groqApiKey.slice(-4) : undefined,
    aiModelFallbacks: profile.aiModelFallbacks ? [...profile.aiModelFallbacks] : undefined,
    pronunciationAiModelFallbacks: profile.pronunciationAiModelFallbacks
      ? [...profile.pronunciationAiModelFallbacks]
      : undefined,
    providerOrder: profile.providerOrder ? [...profile.providerOrder] : undefined,
    resolvedDictionaryHash: profile.resolvedDictionaryHash,
    // GCP Service Account: raw JSON is NEVER returned; expose configured flag and safe email only
    googleCloudServiceAccountConfigured: Boolean(profile.googleCloudServiceAccountJson),
    googleCloudServiceAccountEmail: profile.googleCloudServiceAccountJson
      ? googleCloudServiceAccountEmail
      : null,
    dramaGeminiTtsSettings: normalizeDramaGeminiTtsProfileSettings(profile.dramaGeminiTtsSettings),
  };
}

export function redactSmartAudioProfilesDocument(
  document: SmartAudioProfilesDocument,
): SmartAudioProfilesDocument {
  return {
    selectedProfileId: document.selectedProfileId,
    profiles: document.profiles.map(redactSmartAudioProfileSecrets),
  };
}

export function mergeStoredSmartAudioProfileSecrets(
  incomingProfiles: SmartAudioProfile[],
  storedProfiles: SmartAudioProfile[],
): SmartAudioProfile[] {
  const storedById = new Map(storedProfiles.map((profile) => [profile.id, profile]));

  return incomingProfiles.map((profile) => {
    const storedProfile = storedById.get(profile.id);
    const primarySourceProfile = profile.geminiApiKeySourceProfileId
      ? storedById.get(profile.geminiApiKeySourceProfileId) || storedProfile
      : storedProfile;
    const backupSourceProfile = profile.backupGeminiApiKeySourceProfileId
      ? storedById.get(profile.backupGeminiApiKeySourceProfileId) || storedProfile
      : storedProfile;
    const suppliedPrimaryKey = (profile.geminiApiKey || '').trim();
    const suppliedBackupKey = (profile.backupGeminiApiKey || '').trim();
    const suppliedGroqKey = (profile.groqApiKey || '').trim();
    // Preserve stored SA JSON when the incoming payload omits/empties it.
    // An empty string in the incoming payload means "keep what's stored."
    const suppliedSaJson = (profile.googleCloudServiceAccountJson || '').trim();

    const incomingFallbacks = profile.aiModelFallbacks !== undefined
      ? profile.aiModelFallbacks
      : storedProfile?.aiModelFallbacks;
    const incomingProviderOrder = profile.providerOrder !== undefined
      ? profile.providerOrder
      : storedProfile?.providerOrder;

    return {
      ...profile,
      aiModelFallbacks: incomingFallbacks,
      providerOrder: incomingProviderOrder,
      geminiApiKey: suppliedPrimaryKey || primarySourceProfile?.geminiApiKey,
      backupGeminiApiKey: suppliedBackupKey || backupSourceProfile?.backupGeminiApiKey,
      groqApiKey: suppliedGroqKey || storedProfile?.groqApiKey,
      googleCloudServiceAccountJson: suppliedSaJson || storedProfile?.googleCloudServiceAccountJson,
    };
  });
}

function slugifyProfileName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `profile-${Date.now()}`;
}

function sanitizeProfile(profile: Partial<SmartAudioProfile> & { id?: string; name?: string }): SmartAudioProfile {
  const id = (profile.id || slugifyProfileName(profile.name || 'profile')).trim();
  const name = (profile.name || 'Smart Audio Profile').trim();
  const validWorkerModes = ['standard', 'scholar', 'bibliography-catcher', 'multi-voice', 'drama-gemini-tts'] as const;
  const workerMode = validWorkerModes.includes(profile.workerMode as typeof validWorkerModes[number])
    ? (profile.workerMode as SmartAudioProfile['workerMode'])
    : 'standard';
  return {
    id,
    name,
    aiModel: (profile.aiModel || DEFAULT_CLEANUP_AI_MODEL).trim(),
    aiModelFallbacks: resolveCleanupAiModels(profile).slice(1),
    pronunciationAiModel: resolvePronunciationAiModel(profile),
    pronunciationAiModelFallbacks: resolvePronunciationAiModels(profile).slice(1),
    customTtsPrompt: profile.customTtsPrompt || '',
    abbreviations: profile.abbreviations || {},
    pronunciations: profile.pronunciations || {},
    books: profile.books || {},
    // Global pronunciations are always the baseline; local profile entries
    // override individual words. Keep this field for legacy clients.
    useGlobalPronunciations: true,
    pronunciationPromptMode: profile.pronunciationPromptMode === 'custom' ? 'custom' : 'default',
    customPronunciationPrompt: profile.customPronunciationPrompt || '',
    workerMode,
    // Keep the key if already stored; never default to a non-empty string
    geminiApiKey: (profile.geminiApiKey || '').trim() || undefined,
    backupGeminiApiKey: (profile.backupGeminiApiKey || '').trim() || undefined,
    // Keep the key if already stored; never default to a non-empty string
    groqApiKey: (profile.groqApiKey || '').trim() || undefined,
    // Google Cloud Service Account JSON — stored server-side only
    googleCloudServiceAccountJson: (profile.googleCloudServiceAccountJson || '').trim() || undefined,
    dramaGeminiTtsSettings: normalizeDramaGeminiTtsProfileSettings(
      profile.dramaGeminiTtsSettings || DEFAULT_DRAMA_GEMINI_TTS_SETTINGS,
    ),
    // Validate and persist provider order; fall back to default if invalid
    providerOrder: (() => {
      const valid: ScanProvider[] = ['gemini_primary', 'gemini_backup', 'groq'];
      const order = Array.isArray(profile.providerOrder) ? profile.providerOrder : null;
      if (!order) return undefined;
      const sanitized = order.filter((p): p is ScanProvider => valid.includes(p as ScanProvider));
      // Must have at least one entry and no duplicates
      const deduped = [...new Set(sanitized)];
      return deduped.length > 0 ? deduped : undefined;
    })(),
  };
}

export function getDefaultSmartAudioProfile(): SmartAudioProfile {
  try {
    if (fs.existsSync(defaultProfileSourcePath)) {
      const raw = JSON.parse(fs.readFileSync(defaultProfileSourcePath, 'utf8')) as Partial<SmartAudioProfile>;
      return sanitizeProfile({
        id: 'default',
        name: 'Default',
        ...raw,
      });
    }
  } catch {
    // Fall back to a hard-coded default if the template file is unavailable.
  }

  return sanitizeProfile({
    id: 'default',
    name: 'Default',
    customTtsPrompt: 'You are an expert audiobook preparation assistant.',
  });
}

const fallbackProfilesDocument: SmartAudioProfilesDocument = {
  selectedProfileId: defaultProfilesData.selectedProfileId,
  profiles: defaultProfilesData.profiles.map(p => sanitizeProfile(p as unknown as Partial<SmartAudioProfile>)),
};

function cloneSmartAudioProfile(profile: SmartAudioProfile): SmartAudioProfile {
  return {
    ...profile,
    abbreviations: { ...(profile.abbreviations || {}) },
    pronunciations: { ...(profile.pronunciations || {}) },
    books: { ...(profile.books || {}) },
    aiModelFallbacks: profile.aiModelFallbacks ? [...profile.aiModelFallbacks] : undefined,
    providerOrder: profile.providerOrder ? [...profile.providerOrder] : undefined,
  };
}

export function restoreMissingBuiltInSmartAudioProfiles(
  document: SmartAudioProfilesDocument,
): RestoreMissingBuiltInProfilesResult {
  const existingIds = new Set(document.profiles.map((profile) => profile.id));
  const missingProfiles = fallbackProfilesDocument.profiles
    .filter((profile) => !existingIds.has(profile.id))
    .map(cloneSmartAudioProfile);
  const profiles = [...document.profiles, ...missingProfiles];
  const selectedProfileId = profiles.some((profile) => profile.id === document.selectedProfileId)
    ? document.selectedProfileId
    : profiles[0]?.id || fallbackProfilesDocument.selectedProfileId;

  return {
    document: {
      selectedProfileId,
      profiles,
    },
    restoredProfiles: missingProfiles.map(({ id, name }) => ({ id, name })),
  };
}

function parseDataJson(val: unknown): Record<string, unknown> {
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch {
      return {};
    }
  } else if (typeof val === 'object' && val !== null) {
    return val as Record<string, unknown>;
  }
  return {};
}

function serializeDataJson(val: Record<string, unknown>): string | Record<string, unknown> {
  return process.env.POSTGRES_URL ? val : JSON.stringify(val);
}

function getModelUpgradeDecision(data: Record<string, unknown>): string | null {
  const decisions = data.smartAudioModelUpgradeDecisions;
  if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) return null;
  const decision = (decisions as Record<string, unknown>)[PRONUNCIATION_MODEL_UPGRADE_ID];
  return typeof decision === 'string' ? decision : null;
}

function profileDocumentFromData(data: Record<string, unknown>): SmartAudioProfilesDocument {
  const raw = data.smartAudioProfiles as Partial<SmartAudioProfilesDocument> | undefined;
  const profiles = Array.isArray(raw?.profiles) && raw.profiles.length > 0
    ? raw.profiles.map((profile) => sanitizeProfile(profile as SmartAudioProfile))
    : fallbackProfilesDocument.profiles.map(cloneSmartAudioProfile);
  const selectedProfileId = typeof raw?.selectedProfileId === 'string'
    && profiles.some((profile) => profile.id === raw.selectedProfileId)
    ? raw.selectedProfileId
    : profiles[0]?.id || fallbackProfilesDocument.selectedProfileId;
  return { selectedProfileId, profiles };
}

export function buildPronunciationModelUpgradeOffer(
  data: Record<string, unknown>,
): PronunciationModelUpgradeOffer {
  const document = profileDocumentFromData(data);
  const affectedProfileCount = document.profiles.filter(
    (profile) => profile.pronunciationAiModel === PRONUNCIATION_MODEL_UPGRADE_FROM
      || profile.aiModel === PRONUNCIATION_MODEL_UPGRADE_FROM,
  ).length;
  return {
    available: affectedProfileCount > 0 && getModelUpgradeDecision(data) === null,
    affectedProfileCount,
    fromModel: PRONUNCIATION_MODEL_UPGRADE_FROM,
    toModel: PRONUNCIATION_MODEL_UPGRADE_TO,
  };
}

export function applyPronunciationModelUpgradeToData(
  data: Record<string, unknown>,
  decision: PronunciationModelUpgradeDecision,
): PronunciationModelUpgradeOffer {
  const document = profileDocumentFromData(data);
  const affectedProfileCount = document.profiles.filter(
    (profile) => profile.pronunciationAiModel === PRONUNCIATION_MODEL_UPGRADE_FROM
      || profile.aiModel === PRONUNCIATION_MODEL_UPGRADE_FROM,
  ).length;
  if (decision === 'upgrade') {
    data.smartAudioProfiles = {
      ...document,
      profiles: document.profiles.map((profile) => ({
        ...profile,
        aiModel: profile.aiModel === PRONUNCIATION_MODEL_UPGRADE_FROM
          ? PRONUNCIATION_MODEL_UPGRADE_TO
          : profile.aiModel,
        pronunciationAiModel: profile.pronunciationAiModel === PRONUNCIATION_MODEL_UPGRADE_FROM
          ? PRONUNCIATION_MODEL_UPGRADE_TO
          : profile.pronunciationAiModel,
      })),
    } satisfies SmartAudioProfilesDocument;
  }
  const currentDecisions = data.smartAudioModelUpgradeDecisions;
  data.smartAudioModelUpgradeDecisions = {
    ...(currentDecisions && typeof currentDecisions === 'object' && !Array.isArray(currentDecisions)
      ? currentDecisions as Record<string, unknown>
      : {}),
    [PRONUNCIATION_MODEL_UPGRADE_ID]: decision,
  };
  return {
    available: false,
    affectedProfileCount,
    fromModel: PRONUNCIATION_MODEL_UPGRADE_FROM,
    toModel: PRONUNCIATION_MODEL_UPGRADE_TO,
  };
}

export async function readPronunciationModelUpgradeOffer(
  userId: string | null,
): Promise<PronunciationModelUpgradeOffer> {
  if (!userId) return buildPronunciationModelUpgradeOffer({});
  const rows = await db.select({ dataJson: userPreferences.dataJson })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  return buildPronunciationModelUpgradeOffer(
    rows.length > 0 ? parseDataJson(rows[0].dataJson) : {},
  );
}

export async function savePronunciationModelUpgradeDecision(
  userId: string | null,
  decision: PronunciationModelUpgradeDecision,
): Promise<PronunciationModelUpgradeOffer> {
  if (!userId) throw new Error('A signed-in user is required to save a model upgrade decision.');
  const mutate = (rows: Array<{ dataJson: unknown }>) => {
    const data = rows.length > 0 ? parseDataJson(rows[0].dataJson) : {};
    const offer = applyPronunciationModelUpgradeToData(data, decision);
    return { data, offer };
  };

  if (process.env.POSTGRES_URL) {
    return db.transaction(async (tx: typeof db) => {
      await lockSmartAudioProfilesRow(tx, userId);
      const rows = await tx.select({ dataJson: userPreferences.dataJson })
        .from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1);
      const { data, offer } = mutate(rows);
      await tx.insert(userPreferences).values({ userId, dataJson: serializeDataJson(data) })
        .onConflictDoUpdate({ target: [userPreferences.userId], set: { dataJson: serializeDataJson(data) } });
      return offer;
    });
  }

  return db.transaction((tx: typeof db) => {
    const rows = tx.select({ dataJson: userPreferences.dataJson })
      .from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1).all();
    const { data, offer } = mutate(rows);
    tx.insert(userPreferences).values({ userId, dataJson: serializeDataJson(data) })
      .onConflictDoUpdate({ target: [userPreferences.userId], set: { dataJson: serializeDataJson(data) } }).run();
    return offer;
  });
}

async function lockSmartAudioProfilesRow(tx: typeof db, userId: string): Promise<void> {
  if (!process.env.POSTGRES_URL) return;
  // The row may not exist yet, so SELECT FOR UPDATE cannot cover first-write
  // races. Every Smart Audio profile writer takes this transaction-scoped lock.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`openreader-smart-audio:${userId}`}, 0))`,
  );
}

export async function readSmartAudioProfilesDocument(userId?: string | null): Promise<SmartAudioProfilesDocument> {
  if (!userId) return fallbackProfilesDocument;
  
  try {
    const rows = await db.select({ dataJson: userPreferences.dataJson }).from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1);
    if (!rows || rows.length === 0) return fallbackProfilesDocument;
    
    const data = parseDataJson(rows[0].dataJson);
    const raw = data.smartAudioProfiles as Partial<SmartAudioProfilesDocument> | undefined;
    
    if (!raw || !Array.isArray(raw.profiles)) return fallbackProfilesDocument;
    
    const profiles = raw.profiles.map((profile) => sanitizeProfile(profile as SmartAudioProfile));
    const selectedProfileId = typeof raw.selectedProfileId === 'string' && raw.selectedProfileId.trim()
      ? raw.selectedProfileId.trim()
      : profiles[0]?.id || defaultProfilesData.selectedProfileId;

    return {
      selectedProfileId,
      profiles: profiles.length > 0 ? profiles : fallbackProfilesDocument.profiles,
    };
  } catch {
    return fallbackProfilesDocument;
  }
}

export async function writeSmartAudioProfilesDocument(userId: string | null | undefined, document: SmartAudioProfilesDocument): Promise<SmartAudioProfilesDocument> {
  if (!userId) return document;

  const profiles = document.profiles.length > 0
    ? document.profiles.map((profile) => sanitizeProfile(profile))
    : fallbackProfilesDocument.profiles;
  const selectedProfileId = profiles.some((profile) => profile.id === document.selectedProfileId)
    ? document.selectedProfileId
    : profiles[0].id;

  const sanitizedDocument: SmartAudioProfilesDocument = {
    selectedProfileId,
    profiles,
  };

  try {
    if (process.env.POSTGRES_URL) {
      await db.transaction(async (tx: typeof db) => {
        await lockSmartAudioProfilesRow(tx, userId);
        const rows = await tx.select({ dataJson: userPreferences.dataJson }).from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1);
        const currentDataJson = rows && rows.length > 0 ? parseDataJson(rows[0].dataJson) : {};

        currentDataJson.smartAudioProfiles = sanitizedDocument;

        await tx.insert(userPreferences)
          .values({
            userId,
            dataJson: serializeDataJson(currentDataJson),
          })
          .onConflictDoUpdate({
            target: [userPreferences.userId],
            set: {
              dataJson: serializeDataJson(currentDataJson),
            }
          });
      });
    } else {
      db.transaction((tx: typeof db) => {
        const rows = tx.select({ dataJson: userPreferences.dataJson }).from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1).all();
        const currentDataJson = rows && rows.length > 0 ? parseDataJson(rows[0].dataJson) : {};

        currentDataJson.smartAudioProfiles = sanitizedDocument;

        tx.insert(userPreferences)
          .values({
            userId,
            dataJson: serializeDataJson(currentDataJson),
          })
          .onConflictDoUpdate({
            target: [userPreferences.userId],
            set: {
              dataJson: serializeDataJson(currentDataJson),
            }
          }).run();
      });
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to write smart audio profiles', error);
  }
  return sanitizedDocument;
}

export async function restoreMissingBuiltInSmartAudioProfilesForUser(
  userId: string | null | undefined,
): Promise<RestoreMissingBuiltInProfilesResult> {
  if (!userId) {
    return {
      document: {
        selectedProfileId: fallbackProfilesDocument.selectedProfileId,
        profiles: fallbackProfilesDocument.profiles.map(cloneSmartAudioProfile),
      },
      restoredProfiles: [],
    };
  }

  const restoreFromRows = (
    rows: Array<{ dataJson: unknown }>,
  ): RestoreMissingBuiltInProfilesResult & { dataJson: Record<string, unknown> } => {
    const dataJson = rows.length > 0 ? parseDataJson(rows[0].dataJson) : {};
    const raw = dataJson.smartAudioProfiles as Partial<SmartAudioProfilesDocument> | undefined;
    const profiles = Array.isArray(raw?.profiles) && raw.profiles.length > 0
      ? raw.profiles.map((profile) => sanitizeProfile(profile as SmartAudioProfile))
      : fallbackProfilesDocument.profiles.map(cloneSmartAudioProfile);
    const selectedProfileId = typeof raw?.selectedProfileId === 'string'
      && profiles.some((profile) => profile.id === raw.selectedProfileId)
      ? raw.selectedProfileId
      : profiles[0]?.id || fallbackProfilesDocument.selectedProfileId;
    const result = restoreMissingBuiltInSmartAudioProfiles({ selectedProfileId, profiles });

    if (result.restoredProfiles.length > 0) {
      dataJson.smartAudioProfiles = result.document;
    }

    return { ...result, dataJson };
  };

  if (process.env.POSTGRES_URL) {
    return db.transaction(async (tx: typeof db) => {
      await lockSmartAudioProfilesRow(tx, userId);
      const rows = await tx
        .select({ dataJson: userPreferences.dataJson })
        .from(userPreferences)
        .where(eq(userPreferences.userId, userId))
        .limit(1);
      const { dataJson, ...result } = restoreFromRows(rows);
      if (result.restoredProfiles.length === 0) return result;

      await tx.insert(userPreferences)
        .values({ userId, dataJson: serializeDataJson(dataJson) })
        .onConflictDoUpdate({
          target: [userPreferences.userId],
          set: { dataJson: serializeDataJson(dataJson) },
        });
      return result;
    });
  }

  return db.transaction((tx: typeof db) => {
    const rows = tx
      .select({ dataJson: userPreferences.dataJson })
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1)
      .all();
    const { dataJson, ...result } = restoreFromRows(rows);
    if (result.restoredProfiles.length === 0) return result;

    tx.insert(userPreferences)
      .values({ userId, dataJson: serializeDataJson(dataJson) })
      .onConflictDoUpdate({
        target: [userPreferences.userId],
        set: { dataJson: serializeDataJson(dataJson) },
      })
      .run();
    return result;
  });
}

export async function mergeGeneratedPronunciationsIntoLatestProfile(
  userId: string,
  profileId: string,
  generatedPronunciations: Record<string, string>,
  pronunciationsAtScanStart: Record<string, string>,
): Promise<{
  document: SmartAudioProfilesDocument;
  profile: SmartAudioProfile;
  appliedWords: string[];
  preservedUserEdits: string[];
} | null> {
  const mergeDocument = (
    rows: Array<{ dataJson: unknown }>,
  ): {
    document: SmartAudioProfilesDocument;
    profile: SmartAudioProfile;
    appliedWords: string[];
    preservedUserEdits: string[];
  } | null => {
    const currentDataJson = rows.length > 0 ? parseDataJson(rows[0].dataJson) : {};
    const raw = currentDataJson.smartAudioProfiles as Partial<SmartAudioProfilesDocument> | undefined;
    const currentProfiles = Array.isArray(raw?.profiles)
      ? raw.profiles.map((profile) => sanitizeProfile(profile as SmartAudioProfile))
      : fallbackProfilesDocument.profiles.map((profile) => ({ ...profile }));
    const profileIndex = currentProfiles.findIndex((profile) => profile.id === profileId);
    if (profileIndex < 0) return null;

    const merged = mergeGeneratedPronunciations(
      currentProfiles[profileIndex],
      generatedPronunciations,
      pronunciationsAtScanStart,
    );
    currentProfiles[profileIndex] = merged.profile;
    const selectedProfileId = typeof raw?.selectedProfileId === 'string'
      && currentProfiles.some((profile) => profile.id === raw.selectedProfileId)
      ? raw.selectedProfileId
      : currentProfiles[0].id;
    const document: SmartAudioProfilesDocument = {
      selectedProfileId,
      profiles: currentProfiles,
    };
    currentDataJson.smartAudioProfiles = document;

    return {
      document,
      profile: merged.profile,
      appliedWords: merged.appliedWords,
      preservedUserEdits: merged.preservedUserEdits,
    };
  };

  if (process.env.POSTGRES_URL) {
    return db.transaction(async (tx: typeof db) => {
      await lockSmartAudioProfilesRow(tx, userId);
      const rows = await tx
        .select({ dataJson: userPreferences.dataJson })
        .from(userPreferences)
        .where(eq(userPreferences.userId, userId))
        .limit(1);
      const result = mergeDocument(rows);
      if (!result) return null;
      const dataJson = rows.length > 0 ? parseDataJson(rows[0].dataJson) : {};
      dataJson.smartAudioProfiles = result.document;
      await tx.insert(userPreferences)
        .values({ userId, dataJson: serializeDataJson(dataJson) })
        .onConflictDoUpdate({ target: [userPreferences.userId], set: { dataJson: serializeDataJson(dataJson) } });
      return result;
    });
  }

  return db.transaction((tx: typeof db) => {
    const rows = tx
      .select({ dataJson: userPreferences.dataJson })
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1)
      .all();
    const result = mergeDocument(rows);
    if (!result) return null;
    const dataJson = rows.length > 0 ? parseDataJson(rows[0].dataJson) : {};
    dataJson.smartAudioProfiles = result.document;
    tx.insert(userPreferences)
      .values({ userId, dataJson: serializeDataJson(dataJson) })
      .onConflictDoUpdate({ target: [userPreferences.userId], set: { dataJson: serializeDataJson(dataJson) } })
      .run();
    return result;
  });
}

export function findSmartAudioProfileById(
  profilesDocument: SmartAudioProfilesDocument,
  profileId?: string | null,
): SmartAudioProfile | null {
  const normalizedId = (profileId || '').trim();
  if (!normalizedId) return profilesDocument.profiles[0] ?? null;
  return profilesDocument.profiles.find((profile) => profile.id === normalizedId) ?? profilesDocument.profiles[0] ?? null;
}

export async function updateSmartAudioProfilePronunciations(
  userId: string | null | undefined,
  profileId: string,
  corrections: Record<string, string>,
): Promise<boolean> {
  if (!userId || !profileId || Object.keys(corrections).length === 0) return false;
  try {
    const doc = await readSmartAudioProfilesDocument(userId);
    const profileIndex = doc.profiles.findIndex((p) => p.id === profileId);
    if (profileIndex < 0) return false;

    let modified = false;
    const profile = doc.profiles[profileIndex];
    const pronunciations = { ...(profile.pronunciations || {}) };

    for (const [term, fixedIpa] of Object.entries(corrections)) {
      if (pronunciations[term] && pronunciations[term] !== fixedIpa) {
        pronunciations[term] = fixedIpa;
        modified = true;
      }
    }

    if (!modified) return false;

    doc.profiles[profileIndex] = {
      ...profile,
      pronunciations,
    };

    await writeSmartAudioProfilesDocument(userId, doc);
    return true;
  } catch (error) {
    serverLogger.warn({
      event: 'smart_audio.profile.update_pronunciations_error',
      userId,
      profileId,
      error: error instanceof Error ? error.message : String(error),
    }, 'Failed to persist corrected pronunciations into smart audio profile.');
    return false;
  }
}
