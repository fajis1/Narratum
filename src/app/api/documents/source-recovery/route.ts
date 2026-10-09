import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { db } from '@/db';
import { adminSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { readSourceRecovery, requireOwnedPdf, saveSourceRecovery, SourceRecoveryConflict } from '@/lib/server/smart-audio/source-recovery-store';
import { proposeSourceRecovery, renderRecoveryPages, validateRecoveredSurface, recoveryDictionary } from '@/lib/server/smart-audio/source-recovery-proposals';
import { readSmartAudioProfilesDocument, findSmartAudioProfileById } from '@/lib/server/smart-audio-profiles';
import { normalizeKokoroPronunciationCandidate } from '@/lib/shared/kokoro-pronunciation-policy';
import { sourceRecoveryPronunciations, sourceRecoverySnapshot } from '@/lib/shared/source-recovery';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const auth = await requireAuthContext(req);
  if (auth instanceof Response) return auth;
  if (!auth.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const documentId = req.nextUrl.searchParams.get('documentId') || '';
  try {
    await requireOwnedPdf(auth.userId, documentId);
    const page = req.nextUrl.searchParams.get('page');
    if (page) {
      if (!/^\d+$/.test(page) || Number(page) < 1) return NextResponse.json({ error: 'Invalid page' }, { status: 400 });
      const images = await renderRecoveryPages(documentId, [Number(page)], getOpenReaderTestNamespace(req.headers));
      return new Response(Buffer.from(images[0].data, 'base64'), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store' } });
    }
    return NextResponse.json({ analysis: await readSourceRecovery(auth.userId, documentId) });
  } catch {
    return NextResponse.json({ error: 'PDF analysis or page could not be loaded.' }, { status: 404 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuthContext(req);
  if (auth instanceof Response) return auth;
  if (!auth.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.documentId !== 'string') return NextResponse.json({ error: 'Missing documentId' }, { status: 400 });
  try {
    await requireOwnedPdf(auth.userId, body.documentId);
  } catch {
    return NextResponse.json({ error: 'PDF not found' }, { status: 404 });
  }
  try {
    const current = await readSourceRecovery(auth.userId, body.documentId);
    if (!current) return NextResponse.json({ error: 'Run a new PDF pre-scan first.' }, { status: 409 });
    if (body.revision !== current.revision) throw new SourceRecoveryConflict('PDF analysis changed. Refresh before reviewing again.');
    let next = structuredClone(current);
    if (body.action === 'propose') {
      const profiles = await readSmartAudioProfilesDocument(auth.userId);
      const profile = findSmartAudioProfileById(profiles, profiles.selectedProfileId);
      if (!profile?.geminiApiKey) return NextResponse.json({ error: 'Configure a Gemini key in the selected Smart Audio profile.' }, { status: 400 });
      const [row] = await db.select({ value: adminSettings.valueJson }).from(adminSettings).where(eq(adminSettings.key, 'global_pronunciations')).limit(1);
      const library = typeof row?.value === 'string' ? JSON.parse(row.value) : row?.value || {};
      const globalPronunciations: Record<string, string> = {};
      for (const [term, choices] of Object.entries(library)) {
        const first = Array.isArray(choices) ? choices[0] : choices;
        const value = typeof first === 'string' ? first : first && typeof first === 'object' && 'phonetic' in first ? String(first.phonetic) : '';
        if (value) globalPronunciations[term] = value;
      }
      next = await proposeSourceRecovery({ analysis: current, groupId: body.groupId, profile, globalPronunciations, namespace: getOpenReaderTestNamespace(req.headers) });
    } else if (body.action === 'approve' || body.action === 'reject' || body.action === 'reset') {
      const item = next.occurrences.find((entry) => entry.id === body.occurrenceId);
      if (!item) return NextResponse.json({ error: 'Occurrence not found' }, { status: 404 });
      if (body.action === 'approve') {
        if (body.sourceVerified !== true) return NextResponse.json({ error: 'Confirm that you checked the printed PDF word.' }, { status: 400 });
        const surface = validateRecoveredSurface(body.correctedSurface || item.proposal?.correctedSurface);
        const language = /\p{Script=Greek}/u.test(surface) ? 'koine_greek' : /\p{Script=Hebrew}/u.test(surface) ? 'biblical_hebrew' : 'other';
        const unchanged = item.proposal?.correctedSurface === surface;
        const rawPronunciation = typeof body.pronunciation === 'string' ? body.pronunciation : unchanged ? item.proposal?.pronunciation : null;
        const pronunciation = rawPronunciation ? normalizeKokoroPronunciationCandidate(surface, rawPronunciation) : null;
        if (rawPronunciation && !pronunciation) return NextResponse.json({ error: 'Pronunciation is not compatible with Kokoro.' }, { status: 400 });
        item.proposal = { correctedSurface: surface, language,
          lemma: unchanged ? item.proposal?.lemma || null : null,
          dictionary: unchanged ? item.proposal?.dictionary || null : await recoveryDictionary(surface, language),
          explanation: 'Reading explicitly checked against the PDF page by the document owner.', pronunciation,
          pronunciationReference: unchanged && pronunciation === item.proposal?.pronunciation ? item.proposal?.pronunciationReference || null : null };
        item.status = 'approved';
        item.reviewedAt = Date.now();
      } else {
        item.status = body.action === 'reject' ? 'rejected' : 'unresolved';
        item.reviewedAt = Date.now();
        if (body.action === 'reset') delete item.proposal;
      }
      next.revision++;
      sourceRecoveryPronunciations(sourceRecoverySnapshot(next));
    } else return NextResponse.json({ error: 'Unknown recovery action' }, { status: 400 });
    await saveSourceRecovery(auth.userId, next, current.revision);
    return NextResponse.json({ analysis: next });
  } catch (error) {
    return NextResponse.json({ error: error instanceof SourceRecoveryConflict ? error.message : 'Source recovery could not be saved. Check the reading and retry.' },
      { status: error instanceof SourceRecoveryConflict ? 409 : 400 });
  }
}
