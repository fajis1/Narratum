import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLEANUP_AI_MODEL,
  DEFAULT_PRONUNCIATION_AI_MODEL,
  resolveCleanupAiModel,
  resolveCleanupAiModels,
  resolvePronunciationAiModel,
  resolvePronunciationAiModels,
  resolveSmartAudioValidationRepairModel,
} from '@/lib/shared/smart-audio-models';

const readSource = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf8');

describe('Smart Audio model selection', () => {
  it('uses separate economical cleanup and pronunciation defaults', () => {
    expect(DEFAULT_CLEANUP_AI_MODEL).toBe('gemini-3.1-flash-lite');
    expect(DEFAULT_PRONUNCIATION_AI_MODEL).toBe('gemini-3.8-flash');
    expect(resolveCleanupAiModel(undefined)).toBe(DEFAULT_CLEANUP_AI_MODEL);
    expect(resolvePronunciationAiModel(undefined)).toBe(DEFAULT_PRONUNCIATION_AI_MODEL);
    expect(DEFAULT_CLEANUP_AI_MODEL).not.toBe(DEFAULT_PRONUNCIATION_AI_MODEL);
  });

  it('preserves the single-model behavior of legacy profiles', () => {
    const legacyProfile = { aiModel: 'gemini-legacy-model' };

    expect(resolveCleanupAiModel(legacyProfile)).toBe('gemini-legacy-model');
    expect(resolvePronunciationAiModel(legacyProfile)).toBe('gemini-legacy-model');
  });

  it('honors an explicitly separated pronunciation model', () => {
    const splitProfile = {
      aiModel: 'cleanup-model',
      pronunciationAiModel: 'pronunciation-model',
    };

    expect(resolveCleanupAiModel(splitProfile)).toBe('cleanup-model');
    expect(resolvePronunciationAiModel(splitProfile)).toBe('pronunciation-model');
  });

  it('uses at most two unique cleanup fallbacks in profile order', () => {
    expect(resolveCleanupAiModels({
      aiModel: 'gemini-3.8-flash',
      aiModelFallbacks: ['gemini-3.7-flash', 'gemini-3.7-flash', 'gemini-3.5-flash'],
    })).toEqual(['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash']);
    expect(resolveCleanupAiModels({ aiModel: 'only-model', aiModelFallbacks: [] }))
      .toEqual(['only-model']);
  });

  it('uses at most two unique pronunciation fallbacks in profile order', () => {
    expect(resolvePronunciationAiModels({
      pronunciationAiModel: 'gemini-3.8-flash',
      pronunciationAiModelFallbacks: ['gemini-3.7-flash', 'gemini-3.7-flash', 'gemini-3.6-flash'],
    })).toEqual(['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash']);
    expect(resolvePronunciationAiModels({ pronunciationAiModel: 'only-model', pronunciationAiModelFallbacks: [] }))
      .toEqual(['only-model']);
  });

  it('fails validation retries upward to 3.8 Flash without overriding custom models', () => {
    expect(resolveSmartAudioValidationRepairModel('gemini-3.5-flash-lite'))
      .toBe('gemini-3.8-flash');
    expect(resolveSmartAudioValidationRepairModel('gemini-3.7-flash'))
      .toBe('gemini-3.8-flash');
    expect(resolveSmartAudioValidationRepairModel('gemini-3.8-flash'))
      .toBe('gemini-3.8-flash');
    expect(resolveSmartAudioValidationRepairModel('private-cleanup-model'))
      .toBe('private-cleanup-model');
  });

  it('routes pronunciation and cleanup call sites through the correct resolver', () => {
    expect(readSource('src/app/api/documents/scan-foreign-words/route.ts'))
      .toContain('resolvePronunciationAiModel(activeProfile)');
    expect(readSource('src/app/api/tts/refine-pronunciations/route.ts'))
      .toContain('resolvePronunciationAiModel(activeProfile)');
    expect(readSource('src/lib/server/audiobooks/worker.ts'))
      .toContain('resolveCleanupAiModel(currentSelectedProfile)');
    expect(readSource('src/lib/server/audiobooks/worker.ts'))
      .toContain('ai_model_fallbacks: resolveCleanupAiModels(currentSelectedProfile).slice(1)');
    expect(readSource('src/app/api/audiobook/chapter/route.ts'))
      .toContain('resolveCleanupAiModel(selectedProfile)');
    expect(readSource('src/app/api/audiobook/characters/scan/route.ts'))
      .toContain('ai_model_fallbacks: resolveCleanupAiModels(scope.profile).slice(1)');
  });

  it('shows both selectors and the active pronunciation model to users', () => {
    const settings = readSource('src/components/SmartAudioSettings.tsx');
    const scanner = readSource('src/components/doclist/ScanForeignWordsModal.tsx');

    expect(settings).toContain('PDF & Audiobook Cleanup Model');
    expect(settings).toContain('Pronunciation Model');
    expect(settings).toContain('Optional cleanup fallbacks');
    expect(settings).toContain('Optional pronunciation fallbacks');
    expect(settings).toContain('If every selected model fails, the book pauses for 24 hours.');
    expect(scanner).toContain('Pronunciation model:');
    expect(scanner).toContain('Fallback chain:');
  });

  it('offers existing 3.7 users a durable upgrade-or-stay decision after login', () => {
    const route = readSource('src/app/api/tts-settings/route.ts');
    const modal = readSource('src/components/GeminiPronunciationModelUpgradeModal.tsx');
    const onboarding = readSource('src/contexts/OnboardingFlowContext.tsx');

    expect(route).toContain("body.pronunciationModelUpgradeDecision === 'upgrade'");
    expect(route).toContain("body.pronunciationModelUpgradeDecision === 'stay'");
    expect(modal).toContain('Upgrade to 3.8');
    expect(modal).toContain('Stay on 3.7');
    expect(onboarding).toContain('<GeminiPronunciationModelUpgradeModal');
  });

  it('renders the document scanner and pronunciation inspector opened by settings buttons', () => {
    const settings = readSource('src/components/SmartAudioSettings.tsx');

    expect(settings).toContain('<ScanForeignWordsModal');
    expect(settings).toContain('isOpen={isScannerOpen}');
    expect(settings).toContain('<BookPronunciationInspectorModal');
    expect(settings).toContain('isOpen={isInspectorOpen}');
  });
});
