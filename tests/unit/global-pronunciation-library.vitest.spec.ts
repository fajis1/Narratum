import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  globalPronunciationDefaults,
  isMachineGeneratedGlobalPronunciationChoice,
  replaceGlobalPronunciationChoices,
  recordLearnedGlobalPronunciation,
  promoteHumanGlobalPronunciation,
  removeGlobalPronunciationChoice,
  previewGlobalPronunciationImport,
  setGlobalPronunciationDefault,
  type GlobalPronunciationLibrary,
} from '../../src/lib/server/tts/global-pronunciation-library';

describe('global pronunciation administration', () => {
  const library: GlobalPronunciationLibrary = {
    'στοιχεῖα': [
      { phonetic: 'stɔɪxɛːa', usageCount: 2 },
      { phonetic: '/stixia/', usageCount: 1 },
    ],
  };

  test('returns only each library word’s safe effective default', () => {
    expect(globalPronunciationDefaults({
      'τοὺς': [{ phonetic: '/tus/' }, { phonetic: '/tuːs/' }],
      unsafe: [{ phonetic: '' }, { phonetic: '/safe-but-not-default/' }],
    })).toEqual({ 'τοὺς': '/tus/' });
  });

  test('distinguishes scanner-generated choices from human and legacy choices', () => {
    expect(isMachineGeneratedGlobalPronunciationChoice({
      phonetic: '/ðə/',
      isUserCustom: false,
      timestamp: 123,
    })).toBe(true);
    expect(isMachineGeneratedGlobalPronunciationChoice({
      phonetic: '/ðə/',
      isUserCustom: true,
      timestamp: 123,
    })).toBe(false);
    expect(isMachineGeneratedGlobalPronunciationChoice({ phonetic: '/ðə/' })).toBe(false);
  });

  test('admin common-English cleanup is previewed, rechecked, and removes linked lexicons', () => {
    const route = fs.readFileSync(
      path.join(process.cwd(), 'src/app/api/tts/global-pronunciations/common-english/route.ts'),
      'utf8',
    );
    const settings = fs.readFileSync(
      path.join(process.cwd(), 'src/components/SmartAudioSettings.tsx'),
      'utf8',
    );
    expect(route).toContain('requireAdminContext(request)');
    expect(route).toContain("body.action === 'scan'");
    expect(route).toContain("body.action !== 'remove'");
    expect(route).toContain('classifyCommonEnglishWords(requested)');
    expect(route).toContain('isMachineGeneratedGlobalPronunciationChoice');
    expect(route).toContain('delete lexicon.entries[word]');
    expect(settings).toContain('Scan Regular English');
    expect(settings).toContain('Remove Selected');
    expect(settings).toContain('Human-created choices are protected');
  });

  test('moves an existing choice to the first/default position and repairs wrappers', () => {
    expect(setGlobalPronunciationDefault(library, 'στοιχεῖα', 'stixia')).toEqual([
      { phonetic: '/stixia/', usageCount: 1 },
      { phonetic: 'stɔɪxɛːa', usageCount: 2 },
    ]);
  });

  test('replaces all choices and puts the selected AI suggestion first', () => {
    expect(replaceGlobalPronunciationChoices(
      'στοιχεῖα',
      ['/stɔɪxeɪɑ/', '/stixia/', '/stɔɪxeːa/'],
      1,
    )?.map(({ phonetic }) => phonetic)).toEqual([
      '/stixia/',
      '/stɔɪxeɪɑ/',
      '/stɔɪxeːa/',
    ]);
  });

  test('rejects malformed or suspect replacement sets', () => {
    expect(replaceGlobalPronunciationChoices('στοιχεῖα', [''], 0)).toBeNull();
    expect(replaceGlobalPronunciationChoices('στοιχεῖα', ['/styyia/'], 0)).toBeNull();
  });

  test('previews global imports without admitting unsafe pronunciations', () => {
    const preview = previewGlobalPronunciationImport({
      format: 'openreader-global-pronunciations',
      pronunciations: {
        'καλός': [{ phonetic: '/kalos/' }, { phonetic: '/styyia/' }],
        'κτλ': ['/K, T, L/', '/KTL/'],
        '': ['/valid/'],
      },
    });
    expect(preview.library).toEqual({
      'καλός': [expect.objectContaining({ phonetic: '/kalos/' })],
      'κτλ': [expect.objectContaining({ phonetic: '/K, T, L/' })],
    });
    expect(preview.validWords).toBe(2);
    expect(preview.validChoices).toBe(2);
    expect(preview.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ word: 'καλός', reason: expect.stringContaining('adjacent') }),
      expect.objectContaining({ word: 'κτλ', reason: expect.stringContaining('grouped capital') }),
      expect.objectContaining({ reason: 'Word is blank.' }),
    ]));
  });

  test('keeps the global default first while learning and evicting alternatives', () => {
    const full = [
      { phonetic: '/default/', usageCount: 0 },
      { phonetic: '/one/', usageCount: 5 },
      { phonetic: '/two/', usageCount: 0 },
      { phonetic: '/three/', usageCount: 3 },
      { phonetic: '/four/', usageCount: 4 },
    ];
    expect(recordLearnedGlobalPronunciation(full, '/new/')).toEqual([
      { phonetic: '/default/', usageCount: 0 },
      { phonetic: '/one/', usageCount: 5 },
      expect.objectContaining({ phonetic: '/new/', usageCount: 1 }),
      { phonetic: '/three/', usageCount: 3 },
      { phonetic: '/four/', usageCount: 4 },
    ]);
    expect(recordLearnedGlobalPronunciation(full, '/one/')[0].phonetic).toBe('/default/');
    expect(recordLearnedGlobalPronunciation(full, '/one/')[1].usageCount).toBe(6);
  });

  test('promotes the latest human pronunciation while retaining alternatives', () => {
    expect(promoteHumanGlobalPronunciation([
      { phonetic: '/gemini/', usageCount: 0, isUserCustom: false },
      { phonetic: '/human/', usageCount: 2, isUserCustom: true, timestamp: 10 },
    ], '/human/', 20)).toEqual([
      { phonetic: '/human/', usageCount: 3, isUserCustom: true, timestamp: 20 },
      { phonetic: '/gemini/', usageCount: 0, isUserCustom: false },
    ]);
    expect(promoteHumanGlobalPronunciation([], '[OMIT]', 20)).toBeNull();
  });

  test('removes one global choice and promotes the next choice when needed', () => {
    expect(removeGlobalPronunciationChoice(library, 'στοιχεῖα', 'stɔɪxɛːa')).toEqual({
      removed: true,
      choices: [{ phonetic: '/stixia/', usageCount: 1 }],
    });
    expect(removeGlobalPronunciationChoice(library, 'στοιχεῖα', '/missing/').removed).toBe(false);
    expect(removeGlobalPronunciationChoice(
      { λόγος: [{ phonetic: '/loˈgos/' }] },
      'λόγος',
      '/loˈgos/',
    ).removed).toBe(true);
  });

  test('exposes admin-only default and guided AI replacement controls', () => {
    const component = fs.readFileSync(
      path.join(process.cwd(), 'src/components/SmartAudioSettings.tsx'),
      'utf8',
    );
    const route = fs.readFileSync(
      path.join(process.cwd(), 'src/app/api/tts/global-pronunciations/route.ts'),
      'utf8',
    );
    expect(component).toContain('Global default');
    expect(component).toContain('Make Global Default');
    expect(component).toContain('Ask AI for 5 Replacement Choices');
    expect(component).toContain('Apply Reviewed Choices Globally');
    expect(component).toContain('Delete Word from Global Library');
    expect(component).toContain('Remove Choice');
    expect(component).toContain("action: 'delete-word'");
    expect(component).toContain("action: 'delete-choice'");
    expect(component).toContain("trimmed.startsWith('/') && trimmed.endsWith('/')");
    expect(component).toContain('{isAdmin &&');
    expect(component).toContain('Import Global JSON');
    expect(component).toContain("action: 'preview-import'");
    expect(component).toContain("action: 'import'");
    expect(component).toContain('Replace existing choices for imported words');
    expect(component).toContain('Use Global');
    expect(component).toContain('Personal pronunciation for ${item.key}');
    expect(component).toContain('savePersonalSuspectPronunciation');
    expect(component).toContain('validDefinitions');
    expect(component).toContain('Import ${globalImportPreview.validWords} Safe Words and ${globalImportPreview.validDefinitions} Definitions');
    expect(route).toContain("body.action === 'set-default'");
    expect(route).toContain("body.action === 'replace-choices'");
    expect(route).toContain("body.action === 'delete-choice'");
    expect(route).toContain("body.action === 'delete-word'");
    expect(route).toContain('delete latestLibrary[word]');
    expect(route).toContain('requireAdminContext(req)');
    expect(route).toContain('pg_advisory_xact_lock');
    expect(route).toContain('const latestLibrary = normalizeGlobalPronunciationLibrary');
    expect(route).toContain('mutateGlobalPronunciationLibrary');
    expect(route).toContain("body.action === 'preview-import'");
    expect(route).toContain("body.action === 'import'");
    expect(route).toContain('previewGlobalPronunciationImport');
    expect(route).toContain('previewGlobalDefinitionImport');
    expect(route).toContain('mergeGlobalDefinitions');
    expect(route).toContain('.limit(1)\n        .all();');
    expect(route).toContain('}).run();');
    expect(route).not.toContain('Object.keys(parsed).length === 0');
  });

  test('requires a verified personal value before promoting a shared default', () => {
    const route = fs.readFileSync(
      path.join(process.cwd(), 'src/app/api/tts/global-pronunciations/route.ts'),
      'utf8',
    );
    expect(route).toContain("body.action === 'promote-personal-default'");
    expect(route).toContain('requireAuthContext(req)');
    expect(route).toContain('activeProfile?.pronunciations?.[word]');
    expect(route).toContain('promoteHumanGlobalPronunciation');
  });

  test('keeps new-word-only generation as the scan default', () => {
    const component = fs.readFileSync(
      path.join(process.cwd(), 'src/components/doclist/ScanForeignWordsModal.tsx'),
      'utf8',
    );
    const route = fs.readFileSync(
      path.join(process.cwd(), 'src/app/api/documents/scan-foreign-words/route.ts'),
      'utf8',
    );
    expect(component).toContain('useState(true)');
    expect(component).toContain('Show one stored option for known words');
    expect(route).toContain('body.generateOnlyForNewWords !== false');
    expect(route).toContain('compatibleGlobalChoices.length === 0');
    expect(route).toContain('!compatibleOverrides[w.word]');
  });
});
