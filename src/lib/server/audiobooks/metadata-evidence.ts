import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { getDocumentBlob } from '@/lib/server/documents/blobstore';
import { readCurrentParsedPdfArtifact } from '@/lib/server/pdf-parse/artifact';
import { getAudiobookObjectBuffer, listAudiobookObjects } from './blobstore';
import { catalogAuthor } from '@/lib/shared/catalog-author';

const SAMPLE_LIMIT = 12000;
const array = <T,>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
function xmlText(value: unknown): string {
  return typeof value === 'string' ? value : value && typeof value === 'object' && '#text' in value ? String(value['#text'] || '') : '';
}
function htmlText(value: string) {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, '')
    .replace(/<\/(?:p|div|h[1-6])>|<br\s*\/?\s*>/giu, '\n').replace(/<[^>]+>/gu, ' ');
}

/** Read existing source artifacts only; never start extraction/AI jobs or treat
 * PDF/ZIP bytes as prose. Keep front matter separate from narrated text. */
export async function collectMetadataEvidence(input: { bookId: string; userId: string; namespace: string | null; document?: { id: string; type: string } | null }) {
  const sections: string[] = [];
  const sources: string[] = [];
  let remaining = SAMPLE_LIMIT;
  let embeddedTitle = '';
  let embeddedAuthors: string[] = [];
  const append = (source: string, text: string, limit: number) => {
    const value = text.trim().slice(0, Math.min(limit, remaining));
    if (!value) return;
    const section = `${source}:\n${value}`.slice(0, remaining);
    sections.push(section); sources.push(source); remaining -= section.length;
  };
  const doc = input.document;
  try {
    if (doc?.type === 'pdf') {
      const artifact = await readCurrentParsedPdfArtifact({ documentId: doc.id, namespace: input.namespace });
      for (const page of artifact?.parsed.pages.slice(0, 6) || []) {
        append(`Original PDF page ${page.pageNumber}`, page.blocks.map(block => block.text).join('\n'), 1600);
      }
    } else if (doc) {
      const buffer = await getDocumentBlob(doc.id, input.namespace);
      if (doc.type === 'txt' || doc.type === 'html') append('Original document beginning', doc.type === 'html' ? htmlText(buffer.toString('utf8')) : buffer.toString('utf8'), 6000);
      if (doc.type === 'epub') {
        const zip = await JSZip.loadAsync(buffer);
        const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false });
        const container = parser.parse(await zip.file('META-INF/container.xml')?.async('string') || '');
        const opfPath = array<{ '@_full-path'?: string }>(container.container?.rootfiles?.rootfile)[0]?.['@_full-path'];
        if (opfPath) {
          const opf = parser.parse(await zip.file(opfPath)?.async('string') || '').package;
          embeddedTitle = xmlText(array(opf?.metadata?.title)[0]).trim();
          const roles = array<{ '@_property'?: string; '@_refines'?: string; '#text'?: string }>(opf?.metadata?.meta);
          embeddedAuthors = array<unknown>(opf?.metadata?.creator).filter(creator => {
            if (!creator || typeof creator !== 'object') return true;
            const fields = creator as Record<string, string>;
            const role = fields['@_role'] || roles.find(meta => meta['@_property'] === 'role' && meta['@_refines'] === `#${fields['@_id']}`)?.['#text'];
            return !role || role === 'aut';
          }).map(xmlText).map(catalogAuthor).filter(Boolean);
          embeddedAuthors = [...new Set(embeddedAuthors)];
          append('EPUB catalog metadata', JSON.stringify({ title: embeddedTitle, authors: embeddedAuthors }), 2000);
          const basePath = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
          const manifest = array<{ '@_id': string; '@_href': string }>(opf?.manifest?.item);
          for (const ref of array<{ '@_idref': string }>(opf?.spine?.itemref).slice(0, 4)) {
            const href = manifest.find(item => item['@_id'] === ref['@_idref'])?.['@_href'];
            if (!href) continue;
            const html = await zip.file(basePath + href)?.async('string');
            if (html) append('Original EPUB front matter', htmlText(html), 1600);
          }
        }
      }
    }
  } catch { /* Missing/corrupt source artifacts must not prevent other evidence. */ }
  try {
    const objects = await listAudiobookObjects(input.bookId, input.userId, input.namespace);
    const names = new Set(objects.map(object => object.fileName));
    const indices = [...new Set([...names].filter(name => /^\d{1,6}__(?:original|text)\.txt$/u.test(name)).map(name => name.split('__')[0]))]
      .sort((a, b) => Number(a) - Number(b)).slice(0, 4);
    for (const index of indices) {
      if (remaining <= 0) break;
      const original = `${index}__original.txt`;
      const candidates = names.has(original) ? [original, `${index}__text.txt`] : [`${index}__text.txt`];
      for (const file of candidates) {
        if (!names.has(file)) continue;
        try {
          const text = (await getAudiobookObjectBuffer(input.bookId, input.userId, file, input.namespace)).toString('utf8');
          if (!text.trim()) continue;
          append(file === original ? `Original chapter ${Number(index)}` : `Cleaned chapter ${Number(index)} (may omit front matter)`, text, 2000);
          break;
        } catch { /* Try its cleaned counterpart and later chapters. */ }
      }
    }
  } catch { /* Catalog inference can still use filename and existing metadata. */ }
  return { sampleText: sections.join('\n\n').slice(0, SAMPLE_LIMIT), sources, embeddedTitle, embeddedAuthors };
}
