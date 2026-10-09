import { beforeEach, expect, test, vi } from 'vitest';
import type { SmartAudioProfile } from '@/types/client';
const mocks = vi.hoisted(() => ({ gemini: vi.fn() }));
vi.mock('@/lib/server/smart-audio/gemini-failover', () => ({ fetchGeminiWithRateLimitFallback: (...args: unknown[]) => mocks.gemini(...args) }));
import { repairSmartAudioWorkerPronunciations } from '@/lib/server/audiobooks/smart-audio-targeted-repair';
import { resolveSmartAudioWithValidationRecovery } from '@/lib/server/audiobooks/smart-audio-validation-recovery';
const input = { profile: { id: 'profile', geminiApiKey: 'fixture', aiModel: 'gemini-3.8-flash', pronunciations: {} } as SmartAudioProfile,
  sourceText: 'The λόγος remains.', dictionary: { 'λόγος': '/lɒɡɒs/' }, signal: new AbortController().signal };
beforeEach(() => vi.clearAllMocks());
test('repairs ordinary Smart AI output locally without Gemini or metadata changes', async () => {
  const result = await repairSmartAudioWorkerPronunciations({ status: 'success', cleaned_text: input.sourceText, chapter_title: 'Title' }, input);
  expect(result).toEqual({ status: 'success', cleaned_text: 'The [λόγος](/lɒɡɒs/) remains.', chapter_title: 'Title' });
  expect(mocks.gemini).not.toHaveBeenCalled();
});
test('chapter 167 phrase is repaired automatically before normal validation', async () => {
  const initialResult = { status: 'success', cleaned_text: 'Seek not [μὴ ζητεῖτε] your own advantages.' };
  const dictionary = { 'μὴ': '/meɪ/', 'ζητεῖτε': '/zeɪ teɪ tɛ/' };
  const resolve = vi.fn(value => value);
  const requestRepair = vi.fn();
  const result = await resolveSmartAudioWithValidationRecovery({ initialResult, resolve, requestRepair,
    authoritativePronunciations: dictionary,
    targetedRepair: value => repairSmartAudioWorkerPronunciations(value, { ...input, dictionary, sourceText: initialResult.cleaned_text }),
  });
  expect(result.workerResult.cleaned_text).toBe('Seek not [μὴ](/meɪ/) [ζητεῖτε](/zeɪteɪtɛ/) your own advantages.');
  expect(mocks.gemini).not.toHaveBeenCalled(); expect(requestRepair).not.toHaveBeenCalled();
});
test('valid output is unchanged and multi-voice speaker/order metadata is preserved', async () => {
  const clean = { status: 'success', cleaned_text: 'Plain text.' };
  expect(await repairSmartAudioWorkerPronunciations(clean, input)).toEqual(clean);
  const segments = [{ speaker_id: 'one', text: input.sourceText }, { speaker_id: 'two', text: 'Plain text.' }];
  const result = await repairSmartAudioWorkerPronunciations({ status: 'success', segments, continuity_state: { scene: 1 } }, input);
  expect(result).toEqual({ status: 'success', segments: [{ ...segments[0], text: 'The [λόγος](/lɒɡɒs/) remains.' }, segments[1]], continuity_state: { scene: 1 } });
  expect(segments[0].text).toBe(input.sourceText);
});
test('unresolved findings use the shared Gemini engine and rate-limit fallback policy', async () => {
  mocks.gemini.mockResolvedValue({ response: new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ patches: [{ id: '0', replacement: '[λόγος](/lɒɡɒs/)' }] }) }] } }] })), usedModel: 'gemini-3.7-flash' });
  const result = await repairSmartAudioWorkerPronunciations({ status: 'success', cleaned_text: input.sourceText }, { ...input, dictionary: {} });
  expect(result).toMatchObject({ cleaned_text: 'The [λόγος](/lɒɡɒs/) remains.' });
  expect(mocks.gemini).toHaveBeenCalledWith(expect.objectContaining({ deferTransientFailures: true, retryRateLimitedModels: false, maxAttempts: 1 }));
});
test('provider-blocked repair preserves cause and never creates a manual-review artifact', async () => {
  mocks.gemini.mockImplementation(async () => ({ response: new Response(null, { status: 429 }) }));
  const resolve = vi.fn(), requestRepair = vi.fn(), onUnrecoverable = vi.fn();
  const initialResult = { status: 'success', cleaned_text: input.sourceText };
  await expect(resolveSmartAudioWithValidationRecovery({ initialResult, resolve, requestRepair, onUnrecoverable,
    authoritativePronunciations: {}, targetedRepair: value => repairSmartAudioWorkerPronunciations(value, { ...input, dictionary: {} }),
  })).rejects.toMatchObject({ failure: { failureCategory: 'provider_transient', provider: 'gemini', httpStatus: 429 } });
  expect(onUnrecoverable).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled(); expect(requestRepair).not.toHaveBeenCalled();
});
test('cancellation aborts without an AI request', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(repairSmartAudioWorkerPronunciations({ status: 'success', cleaned_text: input.sourceText }, { ...input, signal: controller.signal })).rejects.toThrow();
  expect(mocks.gemini).not.toHaveBeenCalled();
});

test('source-supported OCR reconstruction remains for manual review in automatic runs', async () => {
  mocks.gemini.mockImplementation(async () => ({ response: new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ patches: [{ id: '0', replacement: '[οἷς](/hɔɪs/)' }] }) }] } }] })) }));
  await expect(repairSmartAudioWorkerPronunciations({ status: 'success', cleaned_text: 'Among o[ἷς](/hɔɪs/).' },
    { ...input, sourceText: 'Among οἷς.', dictionary: {} })).rejects.toThrow('Targeted pronunciation repair');
});

test('a partial dictionary repair cannot reach recording while other findings remain', async () => {
  mocks.gemini.mockImplementation(async () => ({ response: new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"patches":[]}' }] } }] })) }));
  await expect(repairSmartAudioWorkerPronunciations({ status: 'success', cleaned_text: 'The λόγος and θεῷ remain.' }, input)).rejects.toThrow('Targeted pronunciation repair');
});

test('aborted targeted recovery does not save a failed chapter or request further correction', async () => {
  const onUnrecoverable = vi.fn(), requestRepair = vi.fn();
  await expect(resolveSmartAudioWithValidationRecovery({ initialResult: {}, resolve: value => value,
    requestRepair, onUnrecoverable, authoritativePronunciations: {},
    targetedRepair: async () => { throw new DOMException('Aborted', 'AbortError'); },
  })).rejects.toThrow('Aborted');
  expect(onUnrecoverable).not.toHaveBeenCalled(); expect(requestRepair).not.toHaveBeenCalled();
});

test('updates dictionary in memory and invokes onPronunciationCorrections callback', async () => {
  const dictionary: Record<string, string> = { 'Seekland': '/siːk lənd/' };
  const onCorrections = vi.fn();
  const result = await repairSmartAudioWorkerPronunciations(
    { status: 'success', cleaned_text: 'Welcome to [Seekland](/siːk lənd/).' },
    {
      ...input,
      sourceText: 'Welcome to Seekland.',
      dictionary,
      onPronunciationCorrections: onCorrections,
    },
  );
  expect(result).toEqual({ status: 'success', cleaned_text: 'Welcome to [Seekland](/siːklənd/).' });
  expect(dictionary['Seekland']).toBe('/siːklənd/');
  expect(onCorrections).toHaveBeenCalledWith({ Seekland: '/siːklənd/' });
});
