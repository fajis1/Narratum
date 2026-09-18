import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { audiobookChapters } from '@/db/schema';
import { getAudiobookObjectBuffer, listAudiobookObjects } from './blobstore';
import { getDocumentBlob } from '@/lib/server/documents/blobstore';
import { getDocumentPreviewBuffer } from '@/lib/server/documents/previews-blobstore';
import { readCurrentParsedPdfArtifact, type ParsedPdfArtifact } from '@/lib/server/pdf-parse/artifact';
import { errorToLog, serverLogger } from '@/lib/server/logger';

export interface GenerateEpubOptions {
  bookId: string;
  userId: string;
  title: string;
  author?: string;
  namespace?: string | null;
}

export interface EpubParagraphBlock {
  text: string;
  isList?: boolean;
}

export interface EpubChapterInput {
  title: string;
  text: string;
  footnotes?: Array<{ num: string; text: string }>;
  isList?: boolean;
}

/**
 * Greek TeX symbols map for TeX sanitization.
 */
const GREEK_TEX_MAP: Record<string, string> = {
  '\\Sigma': 'Σ',
  '\\sigma': 'σ',
  '\\varsigma': 'ς',
  '\\Theta': 'Θ',
  '\\theta': 'θ',
  '\\vartheta': 'ϑ',
  '\\Delta': 'Δ',
  '\\delta': 'δ',
  '\\Gamma': 'Γ',
  '\\gamma': 'γ',
  '\\Lambda': 'Λ',
  '\\lambda': 'λ',
  '\\Omega': 'Ω',
  '\\omega': 'ω',
  '\\Phi': 'Φ',
  '\\phi': 'φ',
  '\\varphi': 'ϕ',
  '\\Psi': 'Ψ',
  '\\psi': 'ψ',
  '\\Pi': 'Π',
  '\\pi': 'π',
  '\\varpi': 'ϖ',
  '\\Upsilon': 'Υ',
  '\\upsilon': 'υ',
  '\\alpha': 'α',
  '\\beta': 'β',
  '\\epsilon': 'ε',
  '\\varepsilon': 'ϵ',
  '\\zeta': 'ζ',
  '\\eta': 'η',
  '\\iota': 'ι',
  '\\kappa': 'κ',
  '\\mu': 'μ',
  '\\nu': 'ν',
  '\\xi': 'ξ',
  '\\rho': 'ρ',
  '\\varrho': 'ϱ',
  '\\tau': 'τ',
  '\\chi': 'χ',
  '\\dots': '...',
  '\\ldots': '...',
  '\\cdots': '...',
};

/**
 * 1. TeX Sanitization (clean_tex)
 * Converts pseudo-LaTeX math symbols to Unicode, unwraps LaTeX formatting macros,
 * and strips dangling macro prefixes from OCR noise that could otherwise swallow text in Pandoc.
 */
export function clean_tex(text: string): string {
  if (!text) return '';
  let res = text;

  // Replace Greek TeX symbols
  for (const [macro, symbol] of Object.entries(GREEK_TEX_MAP)) {
    res = res.split(macro).join(symbol);
  }

  // Strip macro wrappers: \widetilde{...}, \overline{...}, \underline{...}, \dot{...}, \textbf{...}, etc.
  res = res.replace(
    /\\(?:widetilde|overline|underline|dot|ddot|hat|acute|grave|breve|check|tilde|vec|mathring|mathbf|mathit|mathrm|text|textbf|textit|textsf|texttt)\{([^}]*)\}/gu,
    '$1',
  );

  // Strip dangling unclosed macro prefixes caused by OCR noise: e.g. \widetilde{
  res = res.replace(
    /\\(?:widetilde|overline|underline|dot|ddot|hat|acute|grave|breve|check|tilde|vec|mathring)\{?/gu,
    '',
  );

  return res;
}

/**
 * 2. Intra-Block Line Reflow & Hyphen Healing (clean_block_text)
 * Splits lines within a physical block, heals hyphenated words across lines,
 * joins lines with single spaces, and normalizes spacing.
 */
export function clean_block_text(text: string): string {
  if (!text) return '';
  const lines = text
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';

  const joined: string[] = [];
  for (const line of lines) {
    if (joined.length === 0) {
      joined.push(line);
      continue;
    }
    const prev = joined[joined.length - 1];
    // Heal hyphenated word split across physical lines (Latin + Greek Unicode)
    if (/([A-Za-z\u0370-\u03ff\u1f00-\u1fff]+)-$/u.test(prev) && /^[a-z\u0370-\u03ff\u1f00-\u1fff]/u.test(line)) {
      joined[joined.length - 1] = prev.slice(0, -1) + line;
    } else {
      joined[joined.length - 1] = prev + ' ' + line;
    }
  }

  let res = joined[0];
  // Heal remaining cross-line word hyphens
  res = res.replace(/(\b[A-Za-z\u0370-\u03ff\u1f00-\u1fff]+)-\s+([a-z\u0370-\u03ff\u1f00-\u1fff]+\b)/gu, '$1$2');
  res = res.replace(/[ \t]+/g, ' ');
  return res.trim();
}

/**
 * 3. Preserving Table of Contents & Chapter Lists (clean_toc_text)
 * Detects chapter entry boundaries (lines ending with page numbers or Roman numerals,
 * or lines starting with Chapter/Part/Introduction/Conclusion) and formats them
 * with Markdown hard line breaks (two trailing spaces + newline).
 */
export function clean_toc_text(text: string): string {
  if (!text) return '';
  const rawLines = text
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const entries: string[] = [];
  let curr = '';

  for (let l of rawLines) {
    l = clean_tex(l);
    if (!curr) {
      curr = l;
    } else if (
      /[\.\s]+(?:\d+|[IVXLCDM]+)$/i.test(curr) ||
      /^(?:Chapter|Part|Introduction|Conclusion|Bibliography|General Index|Index)\b/i.test(l)
    ) {
      entries.push(curr);
      curr = l;
    } else {
      curr += ' ' + l; // Sub-titles within the same entry wrap cleanly
    }
  }
  if (curr) {
    entries.push(curr);
  }
  // Format with Markdown hard line breaks (two trailing spaces + newline)
  return entries.join('  \n');
}

/**
 * 4. Page-Spanning Paragraph Stitcher (stitch_paragraphs)
 * Merges mid-sentence paragraph breaks across page transitions while explicitly
 * exempting list items and tables of contents from stitching.
 */
export function stitch_paragraphs(paragraphs: EpubParagraphBlock[]): EpubParagraphBlock[] {
  const stitched: EpubParagraphBlock[] = [];
  for (const p of paragraphs) {
    const ptext = p.text.trim();
    if (!ptext) continue;

    if (stitched.length === 0) {
      stitched.push({ ...p, text: ptext });
      continue;
    }

    const prev = stitched[stitched.length - 1];
    const prev_text = prev.text.trim();

    // Critical Guardrail: NEVER stitch lists or TOC items into adjacent paragraphs or across pages!
    if (p.isList || prev.isList) {
      stitched.push({ ...p, text: ptext });
      continue;
    }

    // Check if this paragraph is a mid-sentence continuation from the previous page
    if (prev_text.endsWith('-') && /^[a-z\u0370-\u03ff\u1f00-\u1fff]/u.test(ptext)) {
      prev.text = prev_text.slice(0, -1) + ptext;
    } else if (
      !/[\.!\?:"'\)]$/u.test(prev_text) &&
      (/^[a-z\u0370-\u03ff\u1f00-\u1fff]/u.test(ptext) || ptext.startsWith('('))
    ) {
      prev.text = prev_text + ' ' + ptext;
    } else {
      stitched.push({ ...p, text: ptext });
    }
  }
  return stitched;
}

/**
 * 5. The 4-Tier Regex Footnote Placement Engine (with Verse-Collision Guard)
 * Places a single footnote reference in the body text without colliding with Bible
 * verses (e.g. Romans 8:15) or multi-digit numbers.
 */
export function placeFootnoteInText(
  bodyText: string,
  num: string,
  refTag: string,
): { newText: string; placed: boolean } {
  const escapedNum = num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const patterns = [
    // 1. Explicit superscript carets or braces: ^12 or ^{12}
    new RegExp(`\\^(?:\\{${escapedNum}\\}|${escapedNum})(?![0-9])`, 'u'),

    // 2. Punctuation followed by footnote number: .12 or ,"12 or —12
    // Verse-collision guard: (?<!\d) ensures we do not match ":" preceded by verse chapter numbers (e.g. 8:15)
    new RegExp(`(?<!\\d)([,\.!\?;:"'\\)——-]+)\\s*(?:\\^)?(${escapedNum})(?![0-9])(?=[\\s"'\\)\\.,!\\?—\\-]|$|[A-Z])`, 'u'),

    // 3. Word immediately followed by footnote number: adoption12
    new RegExp(`(\\b[a-zA-Z\\u0370-\\u03ff\\u1f00-\\u1fff]+)\\s*(?:\\^)?(${escapedNum})(?![0-9])(?=[\\s"'\\)\\.,!\\?—\\-]|$|[A-Z])`, 'u'),

    // 4. Section decimal numbers: 1.2^3
    new RegExp(`(\\d+\\.\\d+)(?:\\^)?(${escapedNum})(?![0-9])(?=[\\s"'\\)\\.,!\\?—\\-]|$|[A-Z])`, 'u'),
  ];

  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i];
    if (pattern.test(bodyText)) {
      let replaced = false;
      const newText = bodyText.replace(pattern, (match, p1) => {
        if (replaced) return match;
        replaced = true;
        if (i === 0) {
          return refTag;
        }
        return `${p1}${refTag}`;
      });
      if (replaced) {
        return { newText, placed: true };
      }
    }
  }

  return { newText: bodyText, placed: false };
}

/**
 * Parses raw footnote text block to extract footnote number and definition text.
 */
export function parseFootnoteBlock(rawText: string, defaultNum: number): { num: string; text: string } {
  const cleaned = clean_tex(rawText).trim();
  // Match e.g. "12. text", "12 text", "[12] text", "^12 text", "12) text"
  const match = cleaned.match(/^(?:\[(\d+)\]|(\d+)[\.\)]?|\^(\d+))\s+([\s\S]*)$/);
  if (match) {
    const num = match[1] || match[2] || match[3];
    const text = match[4].trim();
    return { num, text };
  }
  return { num: String(defaultNum), text: cleaned };
}

/**
 * Cleans chapter text by applying TeX sanitization, TTS pronunciation stripping,
 * line reflow, and paragraph stitching.
 */
export function cleanChapterTextForEpub(rawText: string, isList = false): string {
  // 1. Sanitize TeX symbols & macro wrappers
  let text = clean_tex(rawText);

  // 2. Remove TTS pronunciation annotations e.g. [word](/ipa/) -> word
  text = text.replace(/\[([^\]]+)\]\(\/[^)]+\/\)/gu, '$1');

  // 3. Remove simple square brackets around words if any remain e.g. [word] (guard against [^key])
  text = text.replace(/\[([^[\]\^\n]+)\]/gu, '$1');

  if (isList) {
    return clean_toc_text(text);
  }

  // 4. Split into paragraph blocks and clean each
  const rawParas = text.split(/\n{2,}|\r\n\r\n/).map((p) => p.trim()).filter(Boolean);
  const blocks: EpubParagraphBlock[] = rawParas.map((p) => ({
    text: clean_block_text(p),
    isList: false,
  }));

  // 5. Stitch continuous cross-page sentences
  const stitched = stitch_paragraphs(blocks);
  return stitched.map((b) => b.text).join('\n\n');
}

/**
 * Builds structured Markdown document with chapter headers, interactive pop-up footnotes,
 * and delimited unplaced fallbacks.
 */
export function buildEpubMarkdown(chapters: EpubChapterInput[]): string {
  let md = '';

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    const chapIdx = i + 1;
    let chapterBody = cleanChapterTextForEpub(chapter.text, Boolean(chapter.isList));
    if (!chapterBody && (!chapter.footnotes || chapter.footnotes.length === 0)) continue;

    const heading = chapter.title.trim() || `Chapter ${chapIdx}`;
    md += `# ${heading}\n\n`;

    // 4-Tier Footnote Placement & Delimited Fallback
    const footnotes = chapter.footnotes || [];
    if (footnotes.length > 0) {
      const usedKeys = new Map<string, number>();
      const assignedFootnotes: Array<{ num: string; text: string; key: string }> = [];

      for (const fn of footnotes) {
        const baseKey = `c${chapIdx}_${fn.num}`;
        const count = (usedKeys.get(baseKey) || 0) + 1;
        usedKeys.set(baseKey, count);
        const key = count === 1 ? baseKey : `${baseKey}_${count}`;
        assignedFootnotes.push({
          num: fn.num,
          text: fn.text,
          key,
        });
      }

      const unplaced: Array<{ num: string; text: string; key: string }> = [];

      for (const fn of assignedFootnotes) {
        const refTag = `[^${fn.key}]`;
        const result = placeFootnoteInText(chapterBody, fn.num, refTag);
        if (result.placed) {
          chapterBody = result.newText;
        } else {
          unplaced.push(fn);
        }
      }

      // 2. Delimited Unplaced Fallback (Preventing the Clumping Bug)
      if (unplaced.length > 0) {
        chapterBody += '\n\n' + unplaced.map((fn) => `[^${fn.key}]`).join(', ');
      }

      // 3. Chapter-Scoped Pop-Up Footnote Definitions
      for (const fn of assignedFootnotes) {
        chapterBody += `\n\n[^${fn.key}]: ${fn.text}`;
      }
    }

    md += `${chapterBody}\n\n`;
  }

  return md;
}

/**
 * Compiles an audiobook's cleaned chapter texts and PP-DocLayout footnotes into
 * a publication-grade EPUB eBook using Pandoc with interactive pop-up footnotes,
 * digital table of contents, and cover image.
 */
export async function compileDocumentToEpub(options: GenerateEpubOptions): Promise<Buffer> {
  const { bookId, userId, title, author, namespace = null } = options;

  // 1. Fetch chapter metadata from DB
  const chapterRows = await db
    .select({
      chapterIndex: audiobookChapters.chapterIndex,
      title: audiobookChapters.title,
    })
    .from(audiobookChapters)
    .where(and(eq(audiobookChapters.bookId, bookId), eq(audiobookChapters.userId, userId)))
    .orderBy(asc(audiobookChapters.chapterIndex));

  const titleByIndex = new Map<number, string>();
  for (const row of chapterRows) {
    if (row.title?.trim()) {
      titleByIndex.set(row.chapterIndex, row.title.trim());
    }
  }

  // 2. Retrieve chapter text chunks from blobstore
  const objects = await listAudiobookObjects(bookId, userId, namespace);
  const textFiles = objects
    .map((o) => o.fileName)
    .filter((name) => /^\d{1,6}__text\.txt$/u.test(name))
    .sort();

  const chapters: EpubChapterInput[] = [];

  if (textFiles.length > 0) {
    for (let i = 0; i < textFiles.length; i++) {
      const fileName = textFiles[i];
      const match = fileName.match(/^(\d{1,6})__text\.txt$/u);
      const parsedNum = match ? parseInt(match[1], 10) : i + 1;
      const chapterIndex = parsedNum > 0 ? parsedNum - 1 : i;
      const chapterTitle = titleByIndex.get(chapterIndex) || `Chapter ${i + 1}`;

      try {
        const textBuf = await getAudiobookObjectBuffer(bookId, userId, fileName, namespace);
        const rawText = textBuf.toString('utf8');
        const isList = /contents?|outline|index|references?|bibliography/i.test(chapterTitle);
        chapters.push({
          title: chapterTitle,
          text: rawText,
          isList,
        });
      } catch (err) {
        serverLogger.warn(
          { event: 'epub.chapter_read_failed', bookId, fileName, error: errorToLog(err) },
          'Failed to read chapter text chunk for EPUB compilation',
        );
      }
    }
  }

  // Fallback: if no individual chapter text files were found, try reading original document blob
  if (chapters.length === 0) {
    try {
      const docBuf = await getDocumentBlob(bookId, namespace);
      const rawText = docBuf.toString('utf8');
      chapters.push({
        title: title || 'Chapter 1',
        text: rawText,
      });
    } catch {
      throw new Error(`No text content found for book ${bookId} to generate EPUB.`);
    }
  }

  // 3. Extract Footnotes & Lists from PP-DocLayout-V3 analysis if available
  try {
    const parsedArtifact = await readCurrentParsedPdfArtifact({ documentId: bookId, namespace });
    if (parsedArtifact?.parsed?.pages) {
      interface ExtractedFootnote {
        pageNumber: number;
        num: string;
        text: string;
      }
      const allExtractedFootnotes: ExtractedFootnote[] = [];
      let globalFnIdx = 1;

      for (const page of parsedArtifact.parsed.pages) {
        for (const block of page.blocks) {
          if (block.kind === 'footnote' || block.kind === 'vision_footnote') {
            const parsedFn = parseFootnoteBlock(block.text, globalFnIdx++);
            allExtractedFootnotes.push({
              pageNumber: page.pageNumber,
              num: parsedFn.num,
              text: parsedFn.text,
            });
          }
        }
      }

      if (allExtractedFootnotes.length > 0) {
        if (chapters.length === 1) {
          chapters[0].footnotes = allExtractedFootnotes.map((f) => ({ num: f.num, text: f.text }));
        } else {
          // Distribute footnotes across chapters based on footnote numbers restarting or matching
          let currentFootnotePool = [...allExtractedFootnotes];
          for (let c = 0; c < chapters.length; c++) {
            const chap = chapters[c];
            const chapNotes: Array<{ num: string; text: string }> = [];
            let lastSeenNum = -1;

            const remainingPool: ExtractedFootnote[] = [];
            for (const fn of currentFootnotePool) {
              const numericVal = parseInt(fn.num, 10);
              const isNumbered = !isNaN(numericVal);

              // Detect footnote restart at 1 in subsequent chapters
              if (chapNotes.length > 0 && isNumbered && numericVal <= lastSeenNum && numericVal === 1) {
                remainingPool.push(fn);
                continue;
              }

              // Test if footnote number is referenced in this chapter's text
              const escapedNum = fn.num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const patternCheck = new RegExp(`(?:\\^|[,\\.!\?;:"'\\)\\w])(?:\\^)?(${escapedNum})(?![0-9])`, 'u');
              if (patternCheck.test(chap.text) || c === chapters.length - 1) {
                chapNotes.push({ num: fn.num, text: fn.text });
                if (isNumbered) lastSeenNum = numericVal;
              } else {
                remainingPool.push(fn);
              }
            }

            chap.footnotes = chapNotes;
            currentFootnotePool = remainingPool;
          }
        }
      }
    }
  } catch (err) {
    serverLogger.warn(
      { event: 'epub.layout_footnote_enrichment_failed', error: errorToLog(err), bookId },
      'Failed to extract PP-DocLayout footnotes; proceeding with text-only EPUB',
    );
  }

  // 4. Retrieve cover thumbnail if available
  let coverBuffer: Buffer | null = null;
  try {
    coverBuffer = await getDocumentPreviewBuffer(bookId, namespace);
  } catch {
    coverBuffer = null;
  }

  // 5. Assemble Markdown and compile via Pandoc with raw TeX suppression
  const markdown = buildEpubMarkdown(chapters);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openreader-epub-'));

  try {
    const inputMdPath = path.join(tmpDir, 'input.md');
    const outputEpubPath = path.join(tmpDir, 'output.epub');

    await fs.writeFile(inputMdPath, markdown, 'utf8');

    // Disable raw TeX and math environments to prevent macro absorption
    const args = [
      '-f',
      'markdown-raw_tex-tex_math_dollars-tex_math_single_backslash-tex_math_double_backslash',
      '-o',
      outputEpubPath,
      '--toc',
      '--toc-depth=2',
      '--metadata',
      `title=${title}`,
    ];

    if (author?.trim()) {
      args.push('--metadata', `author=${author.trim()}`);
    }

    if (coverBuffer && coverBuffer.length > 0) {
      const coverPath = path.join(tmpDir, 'cover.jpg');
      await fs.writeFile(coverPath, coverBuffer);
      args.push(`--epub-cover-image=${coverPath}`);
    }

    args.push(inputMdPath);

    await new Promise<void>((resolve, reject) => {
      execFile('pandoc', args, { cwd: tmpDir }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Pandoc conversion failed: ${err.message}${stderr ? ` - ${stderr}` : ''}`));
        } else {
          resolve();
        }
      });
    });

    const epubBuffer = await fs.readFile(outputEpubPath);
    return epubBuffer;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
