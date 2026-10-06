import { DRAMA_INLINE_VOCAL_EVENTS } from '../../src/lib/shared/drama-director-schema';
import { describe, expect, it, vi } from 'vitest';
import examples from '../../src/lib/server/smart-audio/drama-director-examples.json';
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
    expect(prompt).toContain('Start a new segment whenever the speaker or utterance type changes.');
    for (const example of DRAMA_DIRECTOR_PROMPT_EXAMPLES) expect(prompt).toContain(example.text);
    for (const example of DRAMA_DIRECTOR_EVALUATION_EXAMPLES) expect(prompt).not.toContain(example.text);
  });

  it('validates all author directions, including held-out evaluation fixtures', () => {
    for (const example of examples) {
      const output = { segments: [{
        ...example.direction,
        performance: { ...example.direction.performance, tags: example.direction.performance.tags.filter((tag) => DRAMA_INLINE_VOCAL_EVENTS.includes(tag as never)) },
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

  it('rejects unknown tags', () => {
    const output = structuredClone(valid);
    (output.segments[0].performance.tags as string[]).push('sigh', 'scared');
    expect(() => validateDramaDirectorOutput({ ...input, output })).toThrow(/tags/);
  });

  it('rejects unauthorized omissions, voice choices, and oversized performance arrays', () => {
    for (const changes of [
      { omit_from_audio: true },
      { voiceId: 'Kore' },
      { performance: { ...valid.segments[0].performance, delivery: [] } },
      { performance: { ...valid.segments[0].performance, delivery: ['natural', 'soft', 'urgent'] } },
      { performance: { ...valid.segments[0].performance, tags: ['sigh', 'laugh', 'long pause'] } },
    ]) {
      expect(() => validateDramaDirectorOutput({
        ...input, output: { segments: [{ ...valid.segments[0], ...changes }] },
      })).toThrow(DramaDirectorValidationError);
    }
  });

  it('rejects invalid and oversized secondary emotions', () => {
    const output = structuredClone(valid);
    (output.segments[0].performance as { secondaryEmotions: string[] }).secondaryEmotions = ['uncertain', 'uncertain', 'not-allowed'];
    expect(() => validateDramaDirectorOutput({ ...input, output })).toThrow(/secondaryEmotions/);
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

  it('rejects paragraph-break multiplicity differences in legacy validation', () => {
    const sourceText = 'Chapter 1\n\n[Bethany](/bɛθəni/) spoke.\n\nThe room went quiet.';
    const output = structuredClone(valid);
    output.segments = [
      { ...output.segments[0], text: 'Chapter 1\n[Bethany](/bɛθəni/) spoke.\n' },
      { ...output.segments[0], text: 'The room went quiet.' },
    ];
    expect(() => validateDramaDirectorOutput({ sourceText, castNames: ['Narrator'], output })).toThrow(/exactly match/);

    output.segments[0].text = 'Chapter 1 [Bethany](/bɛθəni/) spoke.\n';
    expect(() => validateDramaDirectorOutput({ sourceText, castNames: ['Narrator'], output })).toThrow(/exactly match/);

    output.segments[0].text = 'Chapter 1\n[Bethany](/bɛθəni/)spoke.\n';
    expect(() => validateDramaDirectorOutput({ sourceText, castNames: ['Narrator'], output })).toThrow(/exactly match/);
  });

  it('makes up to two repairs and rejects a still-invalid correction', async () => {
    const generate = vi.fn().mockResolvedValueOnce({ segments: [] }).mockResolvedValueOnce({ segments: [{ speaker: 'Narrator', utteranceType: 'narration', sceneContext: 'Greeting.', omit_from_audio: false, performance: valid.segments[0].performance, spanIds: ['s000001'] }] });
    expect(await directDramaWithRepair({ ...input, generate })).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0]).toContain('Validation issues');
    const broken = vi.fn().mockResolvedValue({ segments: [] });
    await expect(directDramaWithRepair({ ...input, generate: broken })).rejects.toThrow(DramaDirectorValidationError);
    expect(broken).toHaveBeenCalledTimes(3);
    expect(broken.mock.calls[2][0]).toContain('Final repair');
  });
});
