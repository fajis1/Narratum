import { describe, expect, it, vi } from 'vitest';
import {
  buildDramaDirectorPrompt, directDramaWithRepair,
  DRAMA_DIRECTOR_EVALUATION_EXAMPLES, DRAMA_DIRECTOR_PROMPT_EXAMPLES,
  DramaDirectorValidationError, validateDramaDirectorOutput,
} from '../../src/lib/server/smart-audio/drama-director';

const valid = {
  segments: [{
    speaker: 'Narrator', utteranceType: 'narration', text: 'Hello, world.',
    sceneContext: 'A greeting opens the scene.', omit_from_audio: false,
    performance: {
      primaryEmotion: 'calm', secondaryEmotions: [], socialIntent: 'informing',
      delivery: ['natural'], pace: 'normal', energy: 'low', intensity: 'low', tags: [],
    },
  }],
};
const input = { sourceText: 'Hello, world.', castNames: ['Narrator'] };

describe('Drama Director prompt and validation', () => {
  it('uses exactly 11 prompt examples and keeps four held out', () => {
    expect(DRAMA_DIRECTOR_PROMPT_EXAMPLES.map((e) => e.number)).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 11, 12, 15]);
    expect(DRAMA_DIRECTOR_EVALUATION_EXAMPLES.map((e) => e.number)).toEqual([6, 10, 13, 14]);
    const prompt = buildDramaDirectorPrompt(input);
    for (const example of DRAMA_DIRECTOR_PROMPT_EXAMPLES) expect(prompt).toContain(example.text);
    for (const example of DRAMA_DIRECTOR_EVALUATION_EXAMPLES) expect(prompt).not.toContain(example.text);
  });

  it('validates the four held-out author directions as evaluation fixtures', () => {
    for (const example of DRAMA_DIRECTOR_EVALUATION_EXAMPLES) {
      const output = { segments: [{
        ...example.direction,
        text: example.text,
        omit_from_audio: false,
      }] };
      expect(validateDramaDirectorOutput({
        sourceText: example.text,
        castNames: [example.direction.speaker],
        output,
      })).toHaveLength(1);
    }
  });

  it('accepts exact text and strips unknown tags', () => {
    const output = structuredClone(valid);
    (output.segments[0].performance.tags as string[]).push('sigh', 'scared');
    expect(validateDramaDirectorOutput({ ...input, output })[0].performance.tags).toEqual(['sigh']);
  });

  it.each([
    ['cast', { ...valid, segments: [{ ...valid.segments[0], speaker: 'Unknown' }] }],
    ['utterance', { ...valid, segments: [{ ...valid.segments[0], utteranceType: 'telepathy' }] }],
    ['vocabulary', { ...valid, segments: [{ ...valid.segments[0], performance: { ...valid.segments[0].performance, pace: 'warp' } }] }],
    ['omission', { ...valid, segments: [{ ...valid.segments[0], text: 'Hello.' }] }],
  ])('rejects invalid %s', (_label, output) => {
    expect(() => validateDramaDirectorOutput({ ...input, output })).toThrow(DramaDirectorValidationError);
  });

  it('preserves exact whitespace across segments', () => {
    const output = structuredClone(valid);
    output.segments = [
      { ...output.segments[0], text: 'Hello, ' },
      { ...output.segments[0], text: 'world.' },
    ];
    expect(validateDramaDirectorOutput({ ...input, output })).toHaveLength(2);
    output.segments[0].text = 'Hello,';
    expect(() => validateDramaDirectorOutput({ ...input, output })).toThrow(/exactly match/);
  });

  it('repairs once and rejects a still-invalid correction', async () => {
    const generate = vi.fn().mockResolvedValueOnce({ segments: [] }).mockResolvedValueOnce(valid);
    expect(await directDramaWithRepair({ ...input, generate })).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0]).toContain('Validation issues');
    const broken = vi.fn().mockResolvedValue({ segments: [] });
    await expect(directDramaWithRepair({ ...input, generate: broken })).rejects.toThrow(DramaDirectorValidationError);
    expect(broken).toHaveBeenCalledTimes(2);
  });
});
