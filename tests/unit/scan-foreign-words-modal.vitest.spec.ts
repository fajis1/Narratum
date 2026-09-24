import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, test } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'src/components/doclist/ScanForeignWordsModal.tsx'),
  'utf8',
);
const scanRoute = readFileSync(
  resolve(process.cwd(), 'src/app/api/documents/scan-foreign-words/route.ts'),
  'utf8',
);

describe('foreign-word scan modal', () => {
  test('offers a complete JSON export and a document-scoped edited JSON import', () => {
    expect(source).toContain('Export all words JSON');
    expect(source).toContain('Export Batches (100 / ZIP)');
    expect(source).toContain('Import edited JSON');
    expect(source).toContain('exportForeignWordScan(activeDocId, words)');
    expect(source).toContain('downloadScanBatchesZip');
    expect(source).toContain("fetch('/api/documents/scan-foreign-words/import'");
    expect(source).toContain('documentId: activeDocId, jobId: scanJobId, scan');
  });

  test('starts a scan only from the explicit scan button', () => {
    expect(source.match(/loadWords\(/g)).toHaveLength(1);
    expect(source).toContain("hasScanned ? 'Scan Again' : 'Start Scan'");
    expect(source).toContain('Choose the scan settings, then click Start Scan.');
  });

  test('guards against duplicate in-flight scan requests', () => {
    expect(source).toContain('if (scanInFlight.current || scanActive) return;');
    expect(source).toContain('scanInFlight.current = true;');
    expect(source).toContain('scanInFlight.current = false;');
  });

  test('always requests a full scan that can certify a Scholar audiobook', () => {
    expect(source).toContain('target: 100');
    expect(source).toContain('Coverage: Full 100%');
    expect(source).not.toContain('Top 80% (Recommended)');
    expect(source).not.toContain('setScanCoverage');
    expect(scanRoute).toContain('const target = 100;');
  });

  test('warns before closing an active scan and reconnects when reopened', () => {
    expect(source).toContain('onClose={handleClose}');
    expect(source).toContain("scanJobStatus === 'queued' || scanJobStatus === 'running'");
    expect(source).toContain('This scan will continue safely in the background.');
    expect(source).toContain('/api/documents/scan-foreign-words/status?documentId=');
    expect(source).toContain('void reconnectScanJob(documentId, session);');
    expect(source).toContain('watchScanJob(job.id);');
    expect(source).toContain('loading || (scanActive && words.length === 0)');
  });

  test('offers cancellation and preserves completed batch results', () => {
    expect(source).toContain("fetch('/api/documents/scan-foreign-words/status'");
    expect(source).toContain('method: \'POST\'');
    expect(source).toContain('Cancel scan');
    expect(source).toContain('Completed results were kept');
    expect(source).toContain("'cancelled'");
  });

  test('opens wider, supports desktop resizing, and constrains long word cells', () => {
    expect(source).toContain('size="xl"');
    expect(source).toContain('handleResizePointerDown');
    expect(source).toContain('setPanelWidth(nextWidth)');
    expect(source).toContain('Drag the lower-right corner to resize this window.');
    expect(source).toContain('table-fixed');
    expect(source).toContain('<col className="w-[16%]" />');
    expect(source).toContain('[overflow-wrap:anywhere]');
    expect(source).toContain('generateOnlyForNewWords');
    expect(source).toContain('Show one stored option for known words');
    expect(source).toContain('/api/documents/scan-foreign-words/status?jobId=');
    expect(source).toContain('setInterval(() => void pollScanJob');
    expect(source).not.toContain('warmGeminiDefaults');
    expect(source).not.toContain('warmRemainingAudio');
    expect(source).toContain('Gemini processed {scanJobProgress.completed}/{scanJobProgress.total} terms and generated');
    expect(source).toContain('Library matches skipped by Gemini: {scanJobLibrarySkipped}');
    expect(source).toContain("action: 'promote-personal-default'");
    expect(source).toContain('No Gemini pronunciation was generated for this word');
    expect(source).toContain('English Definition');
    expect(source).toContain('definitionNeedsReview');
    expect(source).toContain('fuzzyGroupCount');
    expect(source).toContain('Fuzzy priority · {w.fuzzyGroupCount} combined · {w.fuzzyGroupVariants.length} direct variants');
    expect(source).toContain('prepareForeignWordScanRows(words)');
    expect(source).toContain('sortForeignWordScanRows');
    expect(source).toContain('Automatically hidden: {ignoredWordCount}');
    expect(source).toContain('Biblical Scholarship (Greek, Hebrew & Latin Transliteration)');
    expect(source).toContain('Gemini confirms the biblical language before anything is saved.');
    expect(source).toContain('Non-biblical Latin candidates ignored: {scanJobTransliterationRejected}');
    expect(source).toContain('setScanJobResolved(Number(job.resolved ?? job.generated) || 0)');
    expect(source).toContain('terms need manual review because Gemini omitted them or returned no usable pronunciation.');
    expect(source).toContain('extracting PDF candidates on the CPU; term progress begins when extraction finishes');
    expect(source).toContain('useState(false)');
    expect(source).toContain('Override fuzzy order: missing first');
  });

  test('labels library pronunciations and new Gemini recommendations distinctly', () => {
    expect(source).toContain('isLibraryPronunciation');
    expect(source).toContain('isGeminiRecommendation');
    expect(source).toContain('Library</span>');
    expect(source).toContain('Gemini pick</span>');
    expect(source).toContain('text-green-700');
    expect(source).toContain('text-red-700');
    expect(source).toContain('onlyNewPronunciations');
    expect(source).toContain('isInGlobalLibrary');
    expect(source).toContain('Try paid API key');
    expect(source).toContain('[30, 60, 120, 240]');
  });

  test('shows pending pronunciation previews and prevents stale requests from playing later', () => {
    expect(source).toContain('generatingPreviewKey');
    expect(source).toContain('new AbortController()');
    expect(source).toContain('requestId !== previewRequestId.current');
    expect(source).toContain("'Generating…'");
    expect(source).toContain('aria-busy={isGeneratingPreview}');
    expect(source).toContain('Preview voice: {previewSettings.voice}');
  });

  test('offers a saved-pronunciation health scan across global and personal libraries', () => {
    expect(source).toContain('Saved pronunciation health check');
    expect(source).toContain('Scan Saved Pronunciations');
    expect(source).toContain("fetch('/api/tts/global-pronunciations/rescan')");
    expect(source).toContain('globalWords: libraryScan.globalWords');
    expect(source).toContain('personalWords: libraryScan.personalWords');
    expect(source).toContain('Repair All Suspects with Gemini');
    expect(source).toContain('first safe replacement is automatically selected as the default');
    expect(source).toContain('Global library');
    expect(source).toContain('Personal library —');
  });
});
