/**
 * Stage 4 — Gemini Cloud Voice Catalog and Cast Assignment
 *
 * Tests for:
 *  1. Voice catalog completeness and gender correctness
 *  2. Provider-aware normalizeSmartAudioCharacterMap (Cloud voice IDs preserved)
 *  3. getCloudTtsCharacterMapReadiness
 *  4. autoAssignCloudTtsMinorVoices
 *  5. buildCloudTtsVoicePool
 *  6. Kokoro backward-compatibility (normalizer defaults unchanged)
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CLOUD_TTS_FEMALE_VOICES,
  CLOUD_TTS_MALE_VOICES,
  CLOUD_TTS_ALL_VOICES,
  CLOUD_TTS_CHARACTER_VOICE_SET,
  CLOUD_TTS_RECYCLABLE_VOICES,
  CLOUD_TTS_FEMALE_VOICE_SET,
  CLOUD_TTS_MALE_VOICE_SET,
  isValidCloudTtsVoice,
  isCloudTtsFemaleVoice,
  isCloudTtsMaleVoice,
} from '../../src/lib/shared/google-cloud-tts-voices';

import {
  normalizeCloudTtsCharacterMap,
  getCloudTtsCharacterMapReadiness,
  autoAssignCloudTtsMinorVoices,
  buildCloudTtsVoicePool,
} from '../../src/lib/server/smart-audio/google-cloud-cast-helpers';

import {
  getDuplicateVoiceAssignments,
  getNarratorVoiceId,
  mergeExtractedCharacters,
  normalizeSmartAudioCharacterMap,
} from '../../src/lib/shared/multi-voice';

describe('Stage 12 — Cloud cast review persistence', () => {
  it('keeps Cloud voices and character direction during a rescan', () => {
    const base = makeMap({ Narrator: { voiceId: 'Kore' }, Hero: { voiceId: 'Orus' } });
    const previous = { ...base, entries: {
      ...base.entries,
      Hero: { ...base.entries.Hero, cloudDirection: { audioProfile: 'Warm and measured.' } },
    } };
    const rescanned = mergeExtractedCharacters({
      previous, characters: [{ name: 'Hero', description: 'New scan description' }],
      profileId: 'cloud', sourceFingerprint: 'new', validVoiceSet: CLOUD_TTS_CHARACTER_VOICE_SET,
    });
    expect(rescanned.entries.Hero.voiceId).toBe('Orus');
    expect(rescanned.entries.Hero.cloudDirection?.audioProfile).toBe('Warm and measured.');
    expect(rescanned.entries.Narrator.voiceId).toBe('Kore');
  });

  it('resolves Cloud narrator and duplicate voice warnings', () => {
    const map = makeMap({ Narrator: { voiceId: 'Kore' }, Hero: { voiceId: 'Kore' } });
    expect(getNarratorVoiceId(map, { validVoiceSet: CLOUD_TTS_CHARACTER_VOICE_SET })).toBe('Kore');
    expect(getDuplicateVoiceAssignments(map, { validVoiceSet: CLOUD_TTS_CHARACTER_VOICE_SET })).toEqual([
      { voiceId: 'Kore', characterNames: ['Narrator', 'Hero'] },
    ]);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMap(entries: Record<string, { voiceId?: string | null; aliasFor?: string | null; description?: string; importance?: 'main' | 'minor' }>) {
  return {
    schemaVersion: 1,
    status: 'complete',
    scannedAt: Date.now(),
    entries: Object.fromEntries(
      Object.entries(entries).map(([name, e]) => [
        name,
        { name, voiceId: e.voiceId ?? null, aliasFor: e.aliasFor ?? null, description: e.description ?? '', importance: e.importance },
      ]),
    ),
  };
}

// ── 1. Voice catalog ──────────────────────────────────────────────────────────

describe('Stage 4 — Cloud TTS voice catalog', () => {
  it('CLOUD_TTS_ALL_VOICES contains 30 voices', () => {
    expect(CLOUD_TTS_ALL_VOICES).toHaveLength(30);
  });

  it('CLOUD_TTS_FEMALE_VOICES contains 14 voices', () => {
    expect(CLOUD_TTS_FEMALE_VOICES).toHaveLength(14);
  });

  it('CLOUD_TTS_MALE_VOICES contains 16 voices', () => {
    expect(CLOUD_TTS_MALE_VOICES).toHaveLength(16);
  });

  it('female and male sets are disjoint', () => {
    for (const v of CLOUD_TTS_FEMALE_VOICES) {
      expect(CLOUD_TTS_MALE_VOICE_SET.has(v)).toBe(false);
    }
    for (const v of CLOUD_TTS_MALE_VOICES) {
      expect(CLOUD_TTS_FEMALE_VOICE_SET.has(v)).toBe(false);
    }
  });

  it('CLOUD_TTS_CHARACTER_VOICE_SET contains all 30 voices', () => {
    expect(CLOUD_TTS_CHARACTER_VOICE_SET.size).toBe(30);
    for (const v of CLOUD_TTS_ALL_VOICES) {
      expect(CLOUD_TTS_CHARACTER_VOICE_SET.has(v)).toBe(true);
    }
  });

  it('CLOUD_TTS_RECYCLABLE_VOICES contains all 30 voices', () => {
    expect(CLOUD_TTS_RECYCLABLE_VOICES).toHaveLength(30);
  });

  it('no duplicate voices in the catalog', () => {
    const names = [...CLOUD_TTS_ALL_VOICES];
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('contains expected female voices', () => {
    const female = new Set<string>(CLOUD_TTS_FEMALE_VOICES);
    for (const name of ['Kore', 'Zephyr', 'Aoede', 'Leda', 'Achernar']) {
      expect(female.has(name)).toBe(true);
    }
  });

  it('contains expected male voices', () => {
    const male = new Set<string>(CLOUD_TTS_MALE_VOICES);
    for (const name of ['Orus', 'Puck', 'Charon', 'Fenrir', 'Enceladus']) {
      expect(male.has(name)).toBe(true);
    }
  });

  it('isValidCloudTtsVoice returns true for catalog voices', () => {
    expect(isValidCloudTtsVoice('Kore')).toBe(true);
    expect(isValidCloudTtsVoice('Orus')).toBe(true);
  });

  it('isValidCloudTtsVoice returns false for non-catalog voices', () => {
    expect(isValidCloudTtsVoice('af_bella')).toBe(false);  // Kokoro voice
    expect(isValidCloudTtsVoice('')).toBe(false);
    expect(isValidCloudTtsVoice('kore')).toBe(false);  // case-sensitive
  });

  it('isCloudTtsFemaleVoice / isCloudTtsMaleVoice work correctly', () => {
    expect(isCloudTtsFemaleVoice('Kore')).toBe(true);
    expect(isCloudTtsFemaleVoice('Orus')).toBe(false);
    expect(isCloudTtsMaleVoice('Orus')).toBe(true);
    expect(isCloudTtsMaleVoice('Kore')).toBe(false);
  });
});

// ── 2. Provider-aware normalizer ──────────────────────────────────────────────

describe('Stage 4 — normalizeCloudTtsCharacterMap (Cloud voice IDs preserved)', () => {
  it('preserves Cloud TTS voice IDs during normalization', () => {
    const raw = makeMap({
      Narrator: { voiceId: 'Kore' },
      Hero: { voiceId: 'Orus' },
    });
    const map = normalizeCloudTtsCharacterMap(raw);
    expect(map).not.toBeNull();
    expect(map!.entries['Narrator'].voiceId).toBe('Kore');
    expect(map!.entries['Hero'].voiceId).toBe('Orus');
  });

  it('nulls out Kokoro voice IDs (not in Cloud catalog)', () => {
    const raw = makeMap({
      Narrator: { voiceId: 'af_bella' },  // Kokoro voice
    });
    const map = normalizeCloudTtsCharacterMap(raw);
    expect(map!.entries['Narrator'].voiceId).toBeNull();
  });

  it('nulls out completely unknown voice IDs', () => {
    const raw = makeMap({
      Hero: { voiceId: 'not_a_real_voice' },
    });
    const map = normalizeCloudTtsCharacterMap(raw);
    expect(map!.entries['Hero'].voiceId).toBeNull();
  });

  it('preserves all 30 Cloud TTS voices correctly', () => {
    // Build a map with 10 voices to test validation of various catalog members
    const voices = [...CLOUD_TTS_ALL_VOICES].slice(0, 10);
    const entries: Record<string, { voiceId: string }> = {};
    voices.forEach((v, i) => { entries[`Char${i}`] = { voiceId: v }; });
    const raw = makeMap(entries);
    const map = normalizeCloudTtsCharacterMap(raw);
    voices.forEach((v, i) => {
      expect(map!.entries[`Char${i}`].voiceId).toBe(v);
    });
  });
});

// ── 3. Kokoro backward-compatibility ─────────────────────────────────────────

describe('Stage 4 — normalizeSmartAudioCharacterMap Kokoro backward-compat', () => {
  it('still accepts Kokoro voice IDs with no options (default behavior)', () => {
    const raw = makeMap({ Narrator: { voiceId: 'af_bella' } });
    const map = normalizeSmartAudioCharacterMap(raw);
    expect(map!.entries['Narrator'].voiceId).toBe('af_bella');
  });

  it('still rejects Cloud TTS voice IDs with no options (Kokoro default)', () => {
    const raw = makeMap({ Narrator: { voiceId: 'Kore' } });
    const map = normalizeSmartAudioCharacterMap(raw);
    expect(map!.entries['Narrator'].voiceId).toBeNull();
  });

  it('accepts Cloud TTS voices when validVoiceSet is provided', () => {
    const raw = makeMap({ Narrator: { voiceId: 'Kore' } });
    const map = normalizeSmartAudioCharacterMap(raw, { validVoiceSet: CLOUD_TTS_CHARACTER_VOICE_SET });
    expect(map!.entries['Narrator'].voiceId).toBe('Kore');
  });
});

// ── 4. getCloudTtsCharacterMapReadiness ───────────────────────────────────────

describe('Stage 4 — getCloudTtsCharacterMapReadiness', () => {
  it('returns ready=true when narrator + all characters have Cloud voices', () => {
    const raw = makeMap({
      Narrator: { voiceId: 'Kore' },
      Hero: { voiceId: 'Orus' },
    });
    const result = getCloudTtsCharacterMapReadiness(raw);
    expect(result.ready).toBe(true);
  });

  it('returns ready=false when a character has no voiceId', () => {
    const raw = makeMap({
      Narrator: { voiceId: 'Kore' },
      Hero: { voiceId: null },
    });
    const result = getCloudTtsCharacterMapReadiness(raw);
    expect(result.ready).toBe(false);
  });

  it('returns ready=false when a character has a Kokoro (invalid Cloud) voice', () => {
    const raw = makeMap({
      Narrator: { voiceId: 'af_bella' },
      Hero: { voiceId: 'Orus' },
    });
    const result = getCloudTtsCharacterMapReadiness(raw);
    expect(result.ready).toBe(false);
  });

  it('returns ready=false for null/undefined input', () => {
    expect(getCloudTtsCharacterMapReadiness(null).ready).toBe(false);
    expect(getCloudTtsCharacterMapReadiness(undefined).ready).toBe(false);
  });

  it('separates unassignedMain and unassignedMinor', () => {
    const raw = makeMap({
      Narrator: { voiceId: null, importance: 'main' },
      Hero: { voiceId: null, importance: 'main' },
      Guard: { voiceId: null, importance: 'minor' },
    });
    const readiness = getCloudTtsCharacterMapReadiness(raw);
    expect(readiness.ready).toBe(false);
    expect(readiness.unassignedMain).toEqual(['Narrator', 'Hero']);
    expect(readiness.unassignedMinor).toEqual(['Guard']);
    expect(readiness.errors).toContain('Main characters need assigned voices: Narrator, Hero.');
  });
});

// ── 5. autoAssignCloudTtsMinorVoices ──────────────────────────────────────────

describe('Stage 4 — autoAssignCloudTtsMinorVoices', () => {
  it('assigns Cloud TTS voices to unassigned minor characters', () => {
    const raw = makeMap({
      Narrator: { voiceId: 'Kore' },
      Hero: { voiceId: 'Orus' },
      MinorA: { voiceId: null },
      MinorB: { voiceId: null },
    });
    const map = normalizeCloudTtsCharacterMap(raw)!;
    const result = autoAssignCloudTtsMinorVoices({ characterMap: map });
    expect(result.updatedMap.entries['MinorA'].voiceId).not.toBeNull();
    expect(result.updatedMap.entries['MinorB'].voiceId).not.toBeNull();
    expect(isValidCloudTtsVoice(result.updatedMap.entries['MinorA'].voiceId!)).toBe(true);
    expect(isValidCloudTtsVoice(result.updatedMap.entries['MinorB'].voiceId!)).toBe(true);
  });

  it('does not reassign narrator voice to minor characters', () => {
    const raw = makeMap({
      Narrator: { voiceId: 'Kore' },
      Minor: { voiceId: null },
    });
    const map = normalizeCloudTtsCharacterMap(raw)!;
    const result = autoAssignCloudTtsMinorVoices({ characterMap: map });
    expect(result.updatedMap.entries['Minor'].voiceId).not.toBe('Kore');
  });

  it('does not reassign already-assigned character voices', () => {
    const raw = makeMap({
      Narrator: { voiceId: 'Kore' },
      Hero: { voiceId: 'Orus', description: 'Sample text to trigger main-char protection.' },
      Minor: { voiceId: null },
    });
    const map = normalizeCloudTtsCharacterMap(raw)!;
    // Provide sampleText on Hero so the auto-assigner treats it as protected
    map.entries['Hero'].sampleText = 'He stepped forward.';
    const result = autoAssignCloudTtsMinorVoices({ characterMap: map });
    // Hero's voice is preserved
    expect(result.updatedMap.entries['Hero'].voiceId).toBe('Orus');
    // Minor gets something valid but not Kore or Orus
    const minorVoice = result.updatedMap.entries['Minor'].voiceId;
    expect(minorVoice).not.toBeNull();
    expect(minorVoice).not.toBe('Kore');
    expect(minorVoice).not.toBe('Orus');
  });

  it('assigned voices are all valid Cloud TTS voices', () => {
    const raw = makeMap({
      Narrator: { voiceId: 'Kore' },
      A: { voiceId: null },
      B: { voiceId: null },
      C: { voiceId: null },
    });
    const map = normalizeCloudTtsCharacterMap(raw)!;
    const result = autoAssignCloudTtsMinorVoices({ characterMap: map });
    for (const name of ['A', 'B', 'C']) {
      const v = result.updatedMap.entries[name].voiceId;
      if (v) expect(isValidCloudTtsVoice(v)).toBe(true);
    }
  });

  it('does not auto-assign voices to main characters', () => {
    const raw = makeMap({
      Narrator: { voiceId: 'Kore', importance: 'main' },
      Hero: { voiceId: null, importance: 'main', description: 'The main hero of the adventure.' },
      MinorA: { voiceId: null, importance: 'minor', description: 'A minor tavern patron.' },
    });
    const map = normalizeCloudTtsCharacterMap(raw)!;
    const result = autoAssignCloudTtsMinorVoices({ characterMap: map });
    expect(result.updatedMap.entries['Hero'].voiceId).toBeNull();
    expect(result.updatedMap.entries['MinorA'].voiceId).not.toBeNull();
  });

  it('assigns gender-appropriate Cloud TTS voices based on description', () => {
    const raw = makeMap({
      Narrator: { voiceId: 'Kore', importance: 'main' },
      Priestess: { voiceId: null, importance: 'minor', description: 'A wise woman and high priestess.' },
      Knight: { voiceId: null, importance: 'minor', description: 'A brave man and loyal brother in arms.' },
    });
    const map = normalizeCloudTtsCharacterMap(raw)!;
    const result = autoAssignCloudTtsMinorVoices({ characterMap: map });
    const priestessVoice = result.updatedMap.entries['Priestess'].voiceId!;
    const knightVoice = result.updatedMap.entries['Knight'].voiceId!;
    expect(isCloudTtsFemaleVoice(priestessVoice)).toBe(true);
    expect(isCloudTtsMaleVoice(knightVoice)).toBe(true);
  });
});

// ── 6. buildCloudTtsVoicePool ─────────────────────────────────────────────────

describe('Stage 4 — buildCloudTtsVoicePool', () => {
  it("'female' pool contains only female voices", () => {
    const pool = buildCloudTtsVoicePool('female');
    expect(pool.length).toBe(14);
    for (const v of pool) {
      expect(isCloudTtsFemaleVoice(v)).toBe(true);
    }
  });

  it("'male' pool contains only male voices", () => {
    const pool = buildCloudTtsVoicePool('male');
    expect(pool.length).toBe(16);
    for (const v of pool) {
      expect(isCloudTtsMaleVoice(v)).toBe(true);
    }
  });

  it("'any' pool contains all 30 voices", () => {
    const pool = buildCloudTtsVoicePool('any');
    expect(pool.length).toBe(30);
  });

  it('excludeVoices filters out specified voices', () => {
    const exclude = new Set(['Kore', 'Aoede']);
    const pool = buildCloudTtsVoicePool('female', exclude);
    expect(pool).not.toContain('Kore');
    expect(pool).not.toContain('Aoede');
    expect(pool.length).toBe(12); // 14 female - 2 excluded
  });

  it('empty excludeVoices does not filter anything', () => {
    const pool = buildCloudTtsVoicePool('any', new Set());
    expect(pool.length).toBe(30);
  });

  it('excludeVoices from wrong gender have no effect on female pool', () => {
    const exclude = new Set(['Orus']); // male voice
    const pool = buildCloudTtsVoicePool('female', exclude);
    expect(pool.length).toBe(14); // No female voice excluded
  });
});

// ── 7. Google Cloud Drama Generation Pipeline in Generation UI ────────────────

describe('Google Cloud Drama Generation Pipeline in Generation UI', () => {
  it('wires Google Cloud Drama pipeline into BatchAudiobookSidebar', () => {
    const batchContent = fs.readFileSync(path.join(process.cwd(), 'src/components/doclist/BatchAudiobookSidebar.tsx'), 'utf8');
    expect(batchContent).toContain('DRAMA_GEMINI_TTS_WORKER_MODE');
    expect(batchContent).toContain('Generate Google Cloud Drama Audiobook');
    expect(batchContent).toContain("workerMode={isCloudDrama ? 'drama-gemini-tts' : 'multi-voice'}");
    expect(batchContent).toContain("CLOUD_TTS_CHARACTER_VOICE_SET");
    expect(batchContent).toContain("CLOUD_TTS_MODEL");
    expect(batchContent).toContain("disabled={isQueueing || selectedDocs.length === 0 || (!isCloudDrama && availableVoices.length === 0)}");
  });

  it('wires Google Cloud Drama pipeline into AudiobookExportModal', () => {
    const exportContent = fs.readFileSync(path.join(process.cwd(), 'src/components/AudiobookExportModal.tsx'), 'utf8');
    expect(exportContent).toContain('Generate Google Cloud Drama Audiobook');
    expect(exportContent).toContain("providerRef: isCloudDrama ? 'google-cloud' : providerRef");
    expect(exportContent).toContain("ttsModel: isCloudDrama ? CLOUD_TTS_MODEL : ttsModel");
    expect(exportContent).toContain("selectedSmartAudioProfile?.workerMode === DRAMA_GEMINI_TTS_WORKER_MODE ? 'drama-gemini-tts' : 'multi-voice'");
  });

  it('wires Save & Generate Google Drama into MultiVoiceCharacterModal', () => {
    const modalContent = fs.readFileSync(path.join(process.cwd(), 'src/components/doclist/MultiVoiceCharacterModal.tsx'), 'utf8');
    expect(modalContent).toContain('✨ Save & Generate Google Drama');
    expect(modalContent).toContain('handleSave(true)');
    expect(modalContent).toContain('handleSave(false)');
    expect(modalContent).toContain('onComplete: (characterMap: SmartAudioCharacterMap, startGeneration?: boolean) => void | Promise<void>');
  });

  it('wires direct drama generation and replacement dialog into DocumentList', () => {
    const docListContent = fs.readFileSync(path.join(process.cwd(), 'src/components/doclist/DocumentList.tsx'), 'utf8');
    expect(docListContent).toContain('handleStartDramaGeneration');
    expect(docListContent).toContain("providerRef: isCloud ? 'google-cloud' : ''");
    expect(docListContent).toContain("ttsModel: isCloud ? CLOUD_TTS_MODEL : undefined");
    expect(docListContent).toContain('pendingDramaReplacementDoc');
  });
});
