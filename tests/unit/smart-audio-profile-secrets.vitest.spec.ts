import { describe, expect, it } from 'vitest';

import {
  mergeGeneratedPronunciations,
  mergeStoredSmartAudioProfileSecrets,
  redactSmartAudioProfileSecrets,
  restoreMissingBuiltInSmartAudioProfiles,
  restoreMissingBuiltInSmartAudioProfilesForUser,
} from '../../src/lib/server/smart-audio-profiles';
import type { SmartAudioProfile } from '../../src/types/client';

const makeProfile = (overrides: Partial<SmartAudioProfile> = {}): SmartAudioProfile => ({
  id: 'profile-one',
  name: 'Profile One',
  aiModel: 'gemini-test-model',
  customTtsPrompt: '',
  abbreviations: {},
  pronunciations: {},
  books: {},
  ...overrides,
});

describe('Smart Audio profile secret boundary', () => {
  it('restores only missing built-in profiles without changing saved profiles', () => {
    const litrpg = makeProfile({
      id: 'profile-1781109047563',
      name: 'My customized LitRPG',
      customTtsPrompt: 'Keep this custom prompt.',
      geminiApiKey: 'saved-primary-key',
      pronunciations: { Asterion: '/custom/' },
    });
    const biblical = makeProfile({
      id: 'default',
      name: 'Biblical Scholarship',
      backupGeminiApiKey: 'saved-backup-key',
    });

    const restored = restoreMissingBuiltInSmartAudioProfiles({
      selectedProfileId: litrpg.id,
      profiles: [litrpg, biblical],
    });

    expect(restored.document.selectedProfileId).toBe(litrpg.id);
    expect(restored.document.profiles.slice(0, 2)).toEqual([litrpg, biblical]);
    expect(restored.restoredProfiles).toEqual([
      { id: 'profile-biblical-scholar-defs', name: 'Biblical Scholarship with English Definitions' },
      { id: 'profile-litrpg-audio-drama', name: 'LitRPG Audio Drama' },
      { id: 'profile-bibliography-catcher', name: 'Bibliography Catcher (Test)' },
    ]);
    expect(restored.document.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'profile-biblical-scholar-defs', workerMode: 'scholar' }),
      expect.objectContaining({ id: 'profile-litrpg-audio-drama', workerMode: 'multi-voice' }),
    ]));
    expect(restored.document.profiles[0]).toMatchObject({
      geminiApiKey: 'saved-primary-key',
      customTtsPrompt: 'Keep this custom prompt.',
      pronunciations: { Asterion: '/custom/' },
    });
    expect(restored.document.profiles[1].backupGeminiApiKey).toBe('saved-backup-key');
  });

  it('does not duplicate or overwrite a restored built-in profile', () => {
    const customizedDrama = makeProfile({
      id: 'profile-litrpg-audio-drama',
      name: 'My Drama Profile',
      workerMode: 'multi-voice',
      customTtsPrompt: 'My reviewed drama prompt.',
    });
    const first = restoreMissingBuiltInSmartAudioProfiles({
      selectedProfileId: customizedDrama.id,
      profiles: [customizedDrama],
    });
    const second = restoreMissingBuiltInSmartAudioProfiles(first.document);

    expect(first.document.profiles.filter((profile) => profile.id === customizedDrama.id)).toEqual([
      customizedDrama,
    ]);
    expect(second.restoredProfiles).toEqual([]);
    expect(second.document).toEqual(first.document);
  });

  it('uses the complete fallback catalog without writing for a shared local account', async () => {
    const result = await restoreMissingBuiltInSmartAudioProfilesForUser(null);

    expect(result.restoredProfiles).toEqual([]);
    expect(result.document.profiles.map((profile) => profile.id)).toEqual(expect.arrayContaining([
      'profile-biblical-scholar-defs',
      'profile-litrpg-audio-drama',
    ]));
  });

  it('merges scan results without overwriting pronunciations edited during the scan', () => {
    const profile = makeProfile({
      customTtsPrompt: 'new prompt saved while scanning',
      pronunciations: {
        λόγος: '/user-edited/',
        θεός: '/unchanged-at-start/',
      },
    });
    const merged = mergeGeneratedPronunciations(
      profile,
      {
        λόγος: '/generated-logos/',
        θεός: '/generated-theos/',
        πνεῦμα: '/generated-pneuma/',
      },
      {
        λόγος: '/old-logos/',
        θεός: '/unchanged-at-start/',
      },
    );

    expect(merged.profile.customTtsPrompt).toBe('new prompt saved while scanning');
    expect(merged.profile.pronunciations).toEqual({
      λόγος: '/user-edited/',
      θεός: '/generated-theos/',
      πνεῦμα: '/generated-pneuma/',
    });
    expect(merged.appliedWords).toEqual(['θεός', 'πνεῦμα']);
    expect(merged.preservedUserEdits).toEqual(['λόγος']);
  });

  it('redacts both stored keys and returns only configured/suffix metadata', () => {
    const safeProfile = redactSmartAudioProfileSecrets(makeProfile({
      geminiApiKey: 'test-primary-1234',
      backupGeminiApiKey: 'test-backup-9876',
    }));

    expect(safeProfile).not.toHaveProperty('geminiApiKey');
    expect(safeProfile).not.toHaveProperty('backupGeminiApiKey');
    expect(safeProfile).toMatchObject({
      geminiApiKeyConfigured: true,
      geminiApiKeyLast4: '1234',
      backupGeminiApiKeyConfigured: true,
      backupGeminiApiKeyLast4: '9876',
    });
    expect(JSON.stringify(safeProfile)).not.toContain('test-primary');
    expect(JSON.stringify(safeProfile)).not.toContain('test-backup');
  });

  it('does not trust stale client key metadata', () => {
    const safeProfile = redactSmartAudioProfileSecrets(makeProfile({
      geminiApiKeyConfigured: true,
      geminiApiKeyLast4: 'fake',
      backupGeminiApiKeyConfigured: true,
      backupGeminiApiKeyLast4: 'fake',
    }));

    expect(safeProfile).toMatchObject({
      geminiApiKeyConfigured: false,
      backupGeminiApiKeyConfigured: false,
    });
    expect(safeProfile.geminiApiKeyLast4).toBeUndefined();
    expect(safeProfile.backupGeminiApiKeyLast4).toBeUndefined();
  });

  it('preserves both stored keys when a client saves redacted profiles', () => {
    const stored = makeProfile({
      geminiApiKey: 'stored-primary',
      backupGeminiApiKey: 'stored-backup',
    });
    const incoming = redactSmartAudioProfileSecrets(stored);

    const [merged] = mergeStoredSmartAudioProfileSecrets([incoming], [stored]);

    expect(merged.geminiApiKey).toBe('stored-primary');
    expect(merged.backupGeminiApiKey).toBe('stored-backup');
  });

  it('replaces only a newly supplied key and preserves its blank counterpart', () => {
    const stored = makeProfile({
      geminiApiKey: 'stored-primary',
      backupGeminiApiKey: 'stored-backup',
    });
    const incoming = makeProfile({
      geminiApiKey: '  replacement-primary  ',
      backupGeminiApiKey: '   ',
    });

    const [merged] = mergeStoredSmartAudioProfileSecrets([incoming], [stored]);

    expect(merged.geminiApiKey).toBe('replacement-primary');
    expect(merged.backupGeminiApiKey).toBe('stored-backup');
  });

  it('does not copy secrets into a new profile id', () => {
    const stored = makeProfile({ geminiApiKey: 'stored-primary' });
    const incoming = makeProfile({
      id: 'new-profile',
      geminiApiKeyConfigured: true,
      geminiApiKeyLast4: 'mary',
    });

    const [merged] = mergeStoredSmartAudioProfileSecrets([incoming], [stored]);

    expect(merged.geminiApiKey).toBeUndefined();
    expect(merged.backupGeminiApiKey).toBeUndefined();
  });

  it('copies stored keys using source-profile metadata without returning secrets', () => {
    const stored = makeProfile({
      geminiApiKey: 'stored-primary',
      backupGeminiApiKey: 'stored-backup',
    });
    const duplicate = makeProfile({
      id: 'profile-copy',
      geminiApiKeySourceProfileId: stored.id,
      backupGeminiApiKeySourceProfileId: stored.id,
    });

    const [merged] = mergeStoredSmartAudioProfileSecrets([duplicate], [stored]);
    const safeDuplicate = redactSmartAudioProfileSecrets(merged);

    expect(merged.geminiApiKey).toBe('stored-primary');
    expect(merged.backupGeminiApiKey).toBe('stored-backup');
    expect(safeDuplicate.geminiApiKeySourceProfileId).toBe(stored.id);
    expect(safeDuplicate.backupGeminiApiKeySourceProfileId).toBe(stored.id);
    expect(safeDuplicate).not.toHaveProperty('geminiApiKey');
    expect(safeDuplicate).not.toHaveProperty('backupGeminiApiKey');
  });

  it('can cascade one stored key to multiple profiles without returning it', () => {
    const source = makeProfile({ geminiApiKey: 'stored-primary' });
    const target = makeProfile({ id: 'target-profile' });
    const incoming = [source, target].map((profile) => ({
      ...redactSmartAudioProfileSecrets(profile),
      geminiApiKeySourceProfileId: source.id,
    }));

    const merged = mergeStoredSmartAudioProfileSecrets(incoming, [source, target]);
    const safeProfiles = merged.map(redactSmartAudioProfileSecrets);

    expect(merged.every((profile) => profile.geminiApiKey === 'stored-primary')).toBe(true);
    expect(JSON.stringify(safeProfiles)).not.toContain('stored-primary');
  });

  it('preserves aiModelFallbacks and providerOrder in redacted profiles', () => {
    const safeProfile = redactSmartAudioProfileSecrets(makeProfile({
      aiModelFallbacks: ['gemini-3.1-flash-lite', 'gemini-3.7-flash'],
      providerOrder: ['gemini_primary', 'groq', 'gemini_backup'],
      geminiApiKey: 'test-key-1234',
    }));

    expect(safeProfile.aiModelFallbacks).toEqual(['gemini-3.1-flash-lite', 'gemini-3.7-flash']);
    expect(safeProfile.providerOrder).toEqual(['gemini_primary', 'groq', 'gemini_backup']);
    expect(safeProfile).not.toHaveProperty('geminiApiKey');
    expect(safeProfile.geminiApiKeyConfigured).toBe(true);
  });

  it('preserves stored fallbacks and providerOrder when incoming profile omits them', () => {
    const stored = makeProfile({
      aiModelFallbacks: ['gemini-3.1-flash-lite'],
      providerOrder: ['groq', 'gemini_primary', 'gemini_backup'],
      geminiApiKey: 'stored-primary',
    });
    const incoming = makeProfile({
      id: stored.id,
      name: 'Updated Name',
      aiModelFallbacks: undefined,
      providerOrder: undefined,
    });

    const [merged] = mergeStoredSmartAudioProfileSecrets([incoming], [stored]);

    expect(merged.aiModelFallbacks).toEqual(['gemini-3.1-flash-lite']);
    expect(merged.providerOrder).toEqual(['groq', 'gemini_primary', 'gemini_backup']);
  });

  it('falls back to each stored key when a requested source id is unresolved', () => {
    const first = makeProfile({ geminiApiKey: 'first-primary' });
    const second = makeProfile({
      id: 'second-profile',
      geminiApiKey: 'second-primary',
      backupGeminiApiKey: 'second-backup',
    });
    const incoming = [first, second].map((profile) => ({
      ...redactSmartAudioProfileSecrets(profile),
      geminiApiKeySourceProfileId: 'unsaved-profile',
      backupGeminiApiKeySourceProfileId: 'unsaved-profile',
    }));

    const merged = mergeStoredSmartAudioProfileSecrets(incoming, [first, second]);

    expect(merged[0].geminiApiKey).toBe('first-primary');
    expect(merged[1].geminiApiKey).toBe('second-primary');
    expect(merged[1].backupGeminiApiKey).toBe('second-backup');
  });
});
