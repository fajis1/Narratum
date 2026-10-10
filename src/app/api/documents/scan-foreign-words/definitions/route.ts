import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { errorResponse } from '@/lib/server/errors/next-response';
import { serverLogger } from '@/lib/server/logger';
import { readBookLexicon, writeBookLexicon } from '@/lib/server/smart-audio/book-lexicon';
import {
  getDictionaryDefinitionQualityWarnings,
  normalizeDictionaryDefinition,
  shouldOmitDictionaryDefinition,
} from '@/lib/shared/dictionary-definition-policy';
import type { SmartAudioBookLexiconEntry } from '@/types/document-settings';

type SuspectDefinition = {
  term: string;
  definition: string;
  warnings: string[];
};

function collectSuspectDefinitions(
  entries: Record<string, SmartAudioBookLexiconEntry>,
): SuspectDefinition[] {
  return Object.entries(entries).flatMap(([term, entry]) => {
    const warnings = getDictionaryDefinitionQualityWarnings(entry.definition);
    return warnings.length > 0 && typeof entry.definition === 'string'
      ? [{ term, definition: entry.definition, warnings }]
      : [];
  });
}

async function requireDocumentLexicon(req: NextRequest, documentId: string) {
  const ctxOrRes = await requireAuthContext(req);
  if (ctxOrRes instanceof Response) return { response: ctxOrRes };
  if (!ctxOrRes.userId) {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  if (!documentId) {
    return { response: NextResponse.json({ error: 'Missing documentId' }, { status: 400 }) };
  }
  const lexicon = await readBookLexicon(ctxOrRes.userId, documentId);
  return { userId: ctxOrRes.userId, lexicon };
}

export async function GET(req: NextRequest) {
  try {
    const documentId = new URL(req.url).searchParams.get('documentId') || '';
    const result = await requireDocumentLexicon(req, documentId);
    if ('response' in result) return result.response;
    const suspects = result.lexicon ? collectSuspectDefinitions(result.lexicon.entries) : [];
    return NextResponse.json({ suspects });
  } catch (error) {
    return errorResponse(error, {
      logger: serverLogger,
      event: 'pdf.scan.definitions.audit.failed',
      msg: 'Failed to audit saved dictionary definitions',
      apiErrorMessage: 'Failed to audit saved dictionary definitions.',
    });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const documentId = typeof body.documentId === 'string' ? body.documentId : '';
    const result = await requireDocumentLexicon(req, documentId);
    if ('response' in result) return result.response;
    if (!result.lexicon) return NextResponse.json({ removed: [] });

    const requestedTerms = new Set(
      Array.isArray(body.terms)
        ? body.terms.filter((term: unknown): term is string => typeof term === 'string')
        : [],
    );
    const suspects = collectSuspectDefinitions(result.lexicon.entries);
    const selected = suspects
      .filter(({ term }) => requestedTerms.size === 0 || requestedTerms.has(term));
    const cleaned = selected.map(({ term, definition }) => ({
      term,
      definition: normalizeDictionaryDefinition(definition),
    }));
    for (const { term, definition } of cleaned) {
      result.lexicon.entries[term] = {
        ...result.lexicon.entries[term],
        definition,
        definitionOmitted: definition === null,
        needsReview: false,
      };
    }
    if (cleaned.length > 0) {
      result.lexicon.scannedAt = Date.now();
      await writeBookLexicon(result.userId, documentId, result.lexicon);
    }
    return NextResponse.json({
      cleaned,
      updated: cleaned.filter(({ definition }) => definition !== null).map(({ term }) => term),
      removed: cleaned.filter(({ definition }) => definition === null).map(({ term }) => term),
    });
  } catch (error) {
    return errorResponse(error, {
      logger: serverLogger,
      event: 'pdf.scan.definitions.cleanup.failed',
      msg: 'Failed to remove unusable dictionary definitions',
      apiErrorMessage: 'Failed to remove unusable dictionary definitions.',
    });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const documentId = typeof body.documentId === 'string' ? body.documentId : '';
    const term = typeof body.term === 'string' ? body.term.normalize('NFC').trim() : '';
    const result = await requireDocumentLexicon(req, documentId);
    if ('response' in result) return result.response;
    if (!result.lexicon || !term || !result.lexicon.entries[term]) {
      return NextResponse.json({ error: 'Dictionary entry not found.' }, { status: 404 });
    }
    if (body.definition !== null && typeof body.definition !== 'string') {
      return NextResponse.json({ error: 'Definition must be text or null.' }, { status: 400 });
    }
    if (shouldOmitDictionaryDefinition(body.definition)) {
      return NextResponse.json({
        error: 'Enter a useful contextual meaning, or leave the definition blank to omit it.',
      }, { status: 400 });
    }
    const definition = normalizeDictionaryDefinition(body.definition);
    result.lexicon.entries[term] = {
      ...result.lexicon.entries[term],
      definition,
      definitionOmitted: definition === null,
      needsReview: false,
      // A manual edit is authoritative even if the original entry was a default.
      reviewedDefaultVersion: undefined,
      reviewedDefinitionDefaultVersion: undefined,
    };
    result.lexicon.scannedAt = Date.now();
    await writeBookLexicon(result.userId, documentId, result.lexicon);
    return NextResponse.json({
      term,
      definition,
      definitionOmitted: definition === null,
    });
  } catch (error) {
    return errorResponse(error, {
      logger: serverLogger,
      event: 'pdf.scan.definitions.update.failed',
      msg: 'Failed to update a saved dictionary definition',
      apiErrorMessage: 'Failed to update the saved dictionary definition.',
    });
  }
}
