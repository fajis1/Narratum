import type { SmartAudioProfile } from '@/types/client';
import type { SourceRecoveryConfiguration } from '@/types/source-recovery';
import { resolvePronunciationAiModels, GEMINI_MODEL_FALLBACKS } from '@/lib/shared/smart-audio-models';

export function recoveryModelOverrides(input: { ocrModel?: unknown; ocrFallbackModels?: unknown }) {
  const validModel = (value: unknown): value is string => typeof value === 'string'
    && value.length <= 100 && /^gemini-[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(value);
  if (input.ocrModel !== undefined && !validModel(input.ocrModel)) throw new Error('Invalid OCR Gemini model.');
  if (input.ocrFallbackModels !== undefined && (!Array.isArray(input.ocrFallbackModels)
    || input.ocrFallbackModels.length > 2 || !input.ocrFallbackModels.every(validModel))) {
    throw new Error('Select at most two valid OCR Gemini fallback models.');
  }
  return { model: input.ocrModel as string | undefined, fallbacks: input.ocrFallbackModels as string[] | undefined };
}

export function recoveryConfiguration(profile: SmartAudioProfile): SourceRecoveryConfiguration {
  const [model, ...configured] = resolvePronunciationAiModels(profile);
  const fallbacks = configured.length ? configured : [...(GEMINI_MODEL_FALLBACKS[model] || [])];
  return { profileId: profile.id, profileName: profile.name, model, fallbackModels: fallbacks,
    primaryKeyConfigured: Boolean(profile.geminiApiKey?.trim()), backupKeyConfigured: Boolean(profile.backupGeminiApiKey?.trim()),
    automaticBackupFailover: Boolean(profile.backupGeminiApiKey?.trim())
      && profile.backupGeminiApiKey?.trim() !== profile.geminiApiKey?.trim() };
}
