import { expect, test } from 'vitest';
import { buildPronunciationRepairInstructions, inspectRepairPatches, selectRepairCandidates, sanitizeRepairDiagnostics, type RepairDiagnostics } from '@/lib/server/audiobooks/pronunciation-repair-diagnostics';
import { scanPronunciationIssues } from '@/lib/shared/pronunciation-issues';

test('selects the first valid ranked candidate and retains rejected-choice reasons', () => {
  const text = 'τυγχάνω';
  const diagnostics: RepairDiagnostics = { version: 1, promptVersion: 2, stage: 'patch-coverage' };
  const patches = [{ id: '0', replacement: '[τυγχάνω](/t juŋ k ɑ n oʊ/)', alternatives: ['[τυγχάνω](/tjuŋkɑnoʊ/)', '[τυγχάνω](/tuŋkɑnoʊ/)'] }];
  expect(selectRepairCandidates(text, scanPronunciationIssues(text), patches, diagnostics)).toEqual([{ id: '0', replacement: patches[0].alternatives[0] }]);
  expect(diagnostics.candidateChecks).toHaveLength(2);
  expect(diagnostics.candidateChecks?.[0].reasons.length).toBeGreaterThan(0);
  expect(diagnostics.candidateChecks?.[1]).toMatchObject({ rank: 2, selected: true });
  // Simulate a legacy finding whose offsets excluded the surrounding brackets.
  const bracketed = '[τυγχάνω]';
  const legacyIssue = { ...scanPronunciationIssues(text)[0], start: 1, end: 1 + text.length };
  selectRepairCandidates(bracketed, [legacyIssue], [{ id: '0', replacement: patches[0].alternatives[0] }], diagnostics);
  expect(diagnostics.candidateChecks?.[0].selected).toBe(false);
});

test('ranked candidates cannot change English and stop after five choices', () => {
  const text = '[Aetherian](/bad split/)';
  const diagnostics: RepairDiagnostics = { version: 1, promptVersion: 2, stage: 'patch-coverage' };
  const patch = { id: '0', replacement: 'Changed', alternatives: ['Changed', 'Changed', 'Changed', 'Changed', '[Aetherian](/eɪθɪriən/)'] };
  expect(selectRepairCandidates(text, scanPronunciationIssues(text), [patch], diagnostics)[0].replacement).toBe('Changed');
  expect(diagnostics.candidateChecks).toHaveLength(5);
  expect(diagnostics.candidateChecks?.every(check => !check.selected)).toBe(true);
});

test('keeps the exact repair task with profile pronunciation guidance and mandatory editorial/policy instructions', () => {
  const prompt = buildPronunciationRepairInstructions({ pronunciationPromptMode: 'custom', customPronunciationPrompt: 'CUSTOM PRONUNCIATION GUIDE' });
  expect(prompt).toContain('CUSTOM PRONUNCIATION GUIDE');
  expect(prompt).toContain('KOKORO PRONUNCIATION COMPATIBILITY POLICY');
  expect(prompt).toContain('θε(οῦ) is one complete word');
  expect(prompt).toContain('Preserve all original words.');
  expect(prompt).toContain('If a reading cannot be resolved, omit its patch');
});
test('identifies specific bad replacements and missing findings without modifying source', () => {
  const text = 'The [Aetherian](/bad split/) saw θεοῦ.';
  const issues = scanPronunciationIssues(text);
  const result = inspectRepairPatches(text, issues, [{ id: '0', replacement: 'Someone else' }], new Set(['0', '1']));
  expect(result[0]).toMatchObject({ original: '[Aetherian](/bad split/)', replacement: 'Someone else', reasons: ['Repair changed unrelated English text.'] });
  expect(result[1].reasons).toContain('No replacement returned for this finding.');
});
test('captures remaining pronunciation problems and duplicate patch IDs', () => {
  const text = 'θεοῦ';
  const result = inspectRepairPatches(text, scanPronunciationIssues(text), [{ id: '0', replacement: 'θεοῦ' }, { id: '0', replacement: 'θεοῦ' }], new Set(['0']));
  expect(result[0].reasons).toContain('Duplicate patch ID.');
  expect(result[0].reasons.some(reason => reason.includes('outside a pronunciation tag'))).toBe(true);
});
test('redacts credentials and marks bounded captures as truncated', () => {
  const report = sanitizeRepairDiagnostics({ version: 1, promptVersion: 1, stage: 'validation', systemInstruction: 'fixture-secret https://example.invalid/?key=hidden',
    validatorReason: 'x'.repeat(70000) }, ['fixture-secret']);
  expect(report.truncated).toBe(true);
  expect(JSON.stringify(report)).not.toContain('fixture-secret');
  expect(JSON.stringify(report)).not.toContain('hidden');
  expect(report.validatorReason!.length).toBeLessThan(17000);
});
