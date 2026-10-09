import type { SmartAudioProfile } from '@/types/client';
import type { SourceRecoverySnapshot } from '@/types/source-recovery';
import { normalizeKokoroPronunciationCandidate } from '@/lib/shared/kokoro-pronunciation-policy';
import { resolveSmartAudioBookLexicon } from './book-lexicon';

/** Resolve only missing document pronunciations; this service has no library writes. */
export async function resolveSourceRecoveryLexicon(input: {
  snapshot: SourceRecoverySnapshot; profile: SmartAudioProfile; texts: string[];
  knownPronunciations: Record<string, string>;
}) {
  const terms = new Map(input.snapshot.occurrences.filter((item) => item.status === 'approved' && item.proposal)
    .map((item) => [item.proposal!.correctedSurface, item]));
  const candidates = [...terms].flatMap(([term, item]) => {
    if (normalizeKokoroPronunciationCandidate(term, input.knownPronunciations[term])) return [];
    const source = input.texts.find((text) => text.includes(term));
    if (!source) return [];
    const start = source.indexOf(term);
    return [{ term, contexts: [source.slice(Math.max(0, start - 150), start + term.length + 150)],
      ...(item.proposal!.dictionary?.definitions[0] ? { definition: item.proposal!.dictionary.definitions[0] } : {}),
    }];
  });
  if (!candidates.length) return null;
  const lexicon = await resolveSmartAudioBookLexicon({ profile: input.profile, candidates });
  for (const candidate of candidates) {
    const entry = lexicon.entries[candidate.term];
    const pronunciation = normalizeKokoroPronunciationCandidate(candidate.term, entry?.pronunciation);
    if (!entry || !pronunciation) throw new Error('A reviewed PDF reading still needs a usable document pronunciation. Add it in PDF source review or retry generation.');
    entry.pronunciation = pronunciation;
  }
  return lexicon;
}
