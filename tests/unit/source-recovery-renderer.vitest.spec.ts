import { beforeEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({ blob: vi.fn(), exec: vi.fn() }));
vi.mock('@/lib/server/documents/blobstore', () => ({ getDocumentBlob: mocks.blob }));
vi.mock('node:child_process', () => ({ execFile: mocks.exec }));
import { renderRecoveryPages } from '@/lib/server/smart-audio/source-recovery-proposals';
beforeEach(() => { vi.clearAllMocks(); mocks.blob.mockResolvedValue(Buffer.from('fixture-pdf')); });

test('PDF storage failure is reported before renderer startup or Gemini contact', async () => {
  mocks.blob.mockRejectedValueOnce(new Error('private storage location'));
  await expect(renderRecoveryPages('pdf', [1])).rejects.toMatchObject({ stage: 'pdf_loading', message: 'Could not load the PDF. Gemini was not contacted.' });
  expect(mocks.exec).not.toHaveBeenCalled();
});

test.each([{ code: 'ENOENT' }, { stderr: "python3: can't open file '/private/renderer.py'" }, { stderr: "ModuleNotFoundError: No module named 'fitz'" }])('missing Python/script/dependencies are renderer startup errors', async details => {
  mocks.exec.mockImplementationOnce((_executable, _args, _options, callback) => callback(Object.assign(new Error('private raw details'), details)));
  await expect(renderRecoveryPages('pdf', [1])).rejects.toMatchObject({ stage: 'renderer_startup', message: expect.stringContaining('Gemini was not contacted') });
});

test('failed page rendering remains distinct from missing renderer prerequisites', async () => {
  mocks.exec.mockImplementationOnce((_executable, _args, _options, callback) => callback(Object.assign(new Error('private raw details'), { stderr: 'ValueError: PDF page is out of range' })));
  await expect(renderRecoveryPages('pdf', [1])).rejects.toMatchObject({ stage: 'pdf_rendering', message: 'Could not render the PDF page. Gemini was not contacted.' });
});

test('every web runtime stage inherits a copied renderer and an import-checked PyMuPDF prerequisite', () => {
  const dockerfile = readFileSync('Dockerfile', 'utf8');
  expect(dockerfile).toContain('COPY --from=app-builder /app/render_source_recovery_pages.py ./render_source_recovery_pages.py');
  expect(dockerfile).toContain('PyMuPDF==1.26.5');
  expect(dockerfile).toContain('.venv/bin/python3 scripts/check-source-recovery-runtime.py');
  expect(dockerfile).toContain('FROM runner AS runner-cuda');
});
