# Constructing the Human — Hebrew OCR trace, PDF page 179

## Finding

The damaged word boundaries do **not** originate in Surya's recognition for this line. Surya's retained page-179 OCR result and Unicode export preserve spaces between words. The loss occurs when the Surya searchable PDF is assembled: its RTL text-layer writer skips whitespace characters and relies on geometric gaps. Poppler can infer spaces from those gaps here; Narratum's reported pypdf extraction does not. The evidence therefore points to PDF text-layer construction combined with extractor behavior, not a Hebrew-recognition failure.

Narratum's supplied PDF SHA-256, `8721c242553b57a17d7f1e830d27d82d81d82d1c07910d2f3b8ecc5f8fed9417`, matches Paperless's Surya archive byte-for-byte. It is **not** the original image-only upload.

The line-level Surya confidence is `0.8870803337777033` for the entire line. It is not a confidence score for individual letters or vowel points; the niqqud remains unverified. I used the cached rendering of the actual page as the visual reference and did not substitute a Bible edition.

## Files and fingerprints

| Artifact | Path | SHA-256 |
|---|---|---|
| Original uploaded PDF (Document 22) | `paperless-webserver-1:/usr/src/paperless/media/documents/originals/0000022.pdf` | `0dac82b337e6202c57973ef12300a927c7c8032f7854ab03eabe5269c25038ea` |
| Surya searchable archive PDF | `paperless-webserver-1:/usr/src/paperless/media/documents/archive/0000022.pdf` | `8721c242553b57a17d7f1e830d27d82d81d82d1c07910d2f3b8ecc5f8fed9417` |
| Saved Unicode export | `CT 113:/opt/paperless/export/surya-document-22.txt` (also `/usr/src/paperless/export/surya-document-22.txt` in the webserver container) | `552f4ef4615307b3f27b5cbe205fc74e94c7e97d1db22f95f95484a3b3a52473` |
| Retained Surya page result | `CT 113:/var/cache/surya-ocr-api/3142a1648705fb706779456d05901c45654dcda50749d58bf992888f401f267e/page-00179.json` | `277bc02416094be102b2d5694499f8984e9961f9f05b2f5dbe71f9f0d3aca8ba` |
| Retained Surya page raster | `CT 113:/var/cache/surya-ocr-api/3142a1648705fb706779456d05901c45654dcda50749d58bf992888f401f267e/page-00179.png` | `2c29bf9f1d1026cbb8cd6f8dc926e3b477af962feb0aced12b3970dd8c090c09` |

The Surya cache contains 237 page JSON files and 237 page PNGs. Its directory key is derived from the original PDF bytes plus the OCR cache-version and render-DPI string; the target page is therefore from the original input. No page-level OCR was rerun for this investigation. The original page has no selectable text (`pdftotext` returns only a form-feed for page 179); the visible page is represented by the retained scan/raster.

No `doclayout-document-22.json` was present in either the CT 113 export directory or the Paperless webserver export directory. CT 101's DocLayout service journal had no entries for the original OCR date range. The retained per-page Surya JSON does contain line-level text and geometry, but it is not a PP-DocLayout result.

## Passage comparison

Image-checked consonantal reading supplied for comparison (vowels intentionally omitted):

```text
מאדם עד־בהמה עד־רמש ועד־עוף השמים
```

Narratum's reported pypdf extraction, preserved verbatim from the request:

```text
ָאָדםַע ד־ְּבַהָּמהַע ד־ַרְמׁשַו ַעד־עֹוףַה ְּׁשִמים
```

Surya's retained page-179 line 44 (`source_markup` and normalized `text` are identical) is in logical reading order and has inter-word spaces:

```text
יַאמר יָהוָה אַמַחָה אַת־הָאָדָם אַשַּׁר־בָּרָאתִי מַעל פּנִי הָאָדָמָה מָאָדָם עַד־בְּהַמָּה עַד־רַמְשׁ וַעַד־עוֹף הַשְּׁמִים
```

The same target line appears in the saved Unicode text export at line 6942, with the same word boundaries and vowel marks.

Independent `pdftotext -layout` extraction from the archive also returns geometrically inferred spaces, though in visual/reversed RTL order. The embedding controls below are part of the exact extracted line:

```text
    ‫םיִמְּׁשַה ףֹוע־דַעַו ׁשְמַר־דַע הָּמַהְּב־דַע םָדָאָמ הָמָדָאָה יִנּפ לעַמ יִתאָרָּב־רַּׁשַא םָדָאָה־תַא הָחַמַא הָוהָי רמאַי‬
```

The pypdf string above was supplied by Narratum; pypdf is not installed in the Paperless container, so I did not independently reproduce that particular extractor output. The archive identity is independently established by its SHA-256, and its text layer was inspected with Poppler.

## Why boundaries disappear

In `/root/surya-ocr-api/app.py`, `_recognize` retains `text`, `source_markup`, whole-line `confidence`, `bbox`, and `polygon` per OCR line. `_build_layout_pdf` handles RTL lines by iterating grapheme units and calls `page.insert_text` only when `not unit.isspace()`. For a space it advances the cursor but inserts no space character into the PDF text stream. Thus the searchable PDF contains positioned glyphs with a visual gap, not an explicit word separator. Some extractors reconstruct the gap; pypdf did not in Narratum's report.

The Paperless adapter validates the response bundle/JSON, requires nonempty text, checks that the generated PDF is valid, and compares generated and expected page counts before replacing the archive and updating Paperless text/search. These are existence/structure checks; they do not validate RTL reading order, inter-word boundaries, or niqqud placement. There is no per-character or per-vowel confidence in this OCR result.

## Can Narratum avoid this extraction failure?

Yes. Use `surya-document-22.txt` or, preferably when page association matters, the retained 237 per-page Surya JSON results as the OCR text source instead of deriving text from the searchable PDF. The page-179 JSON provides logical-order line text, page number, confidence, bounding box, polygon, and raster dimensions; its sibling PNG is the source-page rendering. This avoids pypdf's RTL separator reconstruction for the OCR text. The word boundaries are supported by Surya's existing OCR; the vowel points should remain unverified pending image-based review.

## Change scope

Read-only investigation apart from temporary visual crops. No full-book rerun, Paperless record update, original/archive overwrite, or production configuration change was performed.
