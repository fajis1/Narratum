# Foreign-word prescan: local source-quality check

Date: 2026-09-23. This is a development check against the two PDFs supplied locally by the maintainer, not a production migration or a live Gemini evaluation. The PDFs and their text are not included in the repository.

## Inputs and scope

| Local source | SHA-256 document ID | Pages | New `all_foreign`, target 100% candidates |
| --- | --- | ---: | ---: |
| Constructing the Human | `8721c242553b57a17d7f1e830d27d82d81d82d1c07910d2f3b8ecc5f8fed9417` | 237 | 2,191 |
| Inventing the Individual | `94a1126621774aa4c8b5f4720ce94bcae05122d5be6d9470b3c77ccc5ead6a77` | 364 | 16 |

The uploaded 2,055-entry version-1 JSON belongs only to *Constructing the Human*. Its original scan settings cannot be established from the JSON alone, so 2,055 versus 2,191 is **not** a like-for-like recall measurement.

A separate read-only comparison using the scanner's default 80% target returned 1,686 new candidates: 90 unverified, 405 source-review recommended, and 1,191 needing source repair. Of the 2,055 old unique terms, 1,628 are absent from that new 80% selection and 426 intersect a newly flagged candidate. **Absence is not evidence that an old entry should be deleted**: settings, candidate ranking, and tokenization all affect selection. This comparison is reproducible with `scripts/prescan_cleanup_dry_run.py --pdf <local-pdf> --old-export <local-json>`; it reads but does not change records.

The new tokenizer retains `Aššurbanipal` and `haššāmayim` as complete candidates. The former `šš` and `ššā` substrings are no longer created from those terms. Every selected new occurrence context contains its recorded surface term; four old exported rows lacked their exact word in their context.

## Source extraction requiring review

| Constructing candidate status | Count | Meaning |
| --- | ---: | --- |
| `unverified` | 142 | No configured quality signal; not a claim of correctness. |
| `source_review_recommended` | 514 | Extraction disagreement or another quality signal; a reading may still be valid. |
| `needs_source_repair` | 1,535 | Selected occurrences combine extractor disagreement with direct token anomalies. Do not manufacture IPA from these strings. |

On PDF page 179 (printed page 165), pypdf and PyMuPDF share only 5 Hebrew tokens among 44 and 49 unique tokens respectively (overlap 0.114 by the scanner's comparison). Neither extraction was automatically preferred. On that page, 26 selected occurrences need source repair, 14 recommend review, and one is unverified. PyMuPDF block geometry was uniquely associated with only seven of those selected occurrences. This is insufficient to reconstruct all printed readings automatically.

## Page 179 manual source-to-token check

The local rendered page crops are `/tmp/narratum-page-179-note1.png` and `/tmp/narratum-page-179-note3.png`; they are intentionally not committed. In note 3, the page image supports this **consonantal** reading:

```text
Broken pypdf extraction:
ָאָדםַע ד־ְּבַהָּמהַע ד־ַרְמׁשַו ַעד־עֹוףַה ְּׁשִמים

Image-checked consonants:
מאדם עד־בהמה עד־רמש ועד־עוף השמים
```

The vowel points have not been certified. The image-to-text reading is evidence for word boundaries only and must not overwrite the book's pointed text as a verified transcription. A separate Chapter 1 note visibly contains `אדם` and the author's transliteration `'adam` with the gloss “human being”; pypdf omits that sentence, while PyMuPDF returns the Hebrew in reversed/damaged order.

Passing the consonantal phrase as a page-179 corrected-text fixture through the `greek_hebrew` scanner at 100% yields six complete dictionary candidates: `מאדם`, `בהמה`, `רמש`, `ועד`, `עוף`, and `השמים`. Each candidate retains page 179 and the complete phrase as context; `עד` is tokenized but excluded as a low-value function word. The context preserves maqqef (`־`) without inserting spaces around it. Regression coverage is in `tests/python/test_scan_pdf_foreign_words.py`.

This was a local visual transcription and tokenizer check. The requested live demonstration remains incomplete: this checkout has no Gemini key configured, and `127.0.0.1:8880` has no running Kokoro-compatible TTS service. No live image transcription, Gemini IPA, or audio sample was generated. The exact status and needed setup are in `docs/narratum-prescan-agent-handoff.md`.

All 16 selected candidates from *Inventing the Individual* were `unverified` under the current quality checks. This does not validate their pronunciations or prove the book has no missed terms.

## Operational implications

- Candidate-cache version 12 invalidates old version-10/11 candidate records so a new scan re-extracts the PDFs. It does not modify or delete existing book/global pronunciation entries.
- Version-2 exports carry page/context/source-quality evidence. The importer checks the stored job's source status and rejects pronunciation/definition edits for `needs_source_repair`; changing the JSON's status cannot bypass that check. Version-1 edit semantics remain supported for unchanged terms.
- Suspect extracted word keys cannot be repaired by renaming JSON rows. A corrected reading needs a source-region transcription with page evidence, occurrence remapping, and a new scan. No such mass transcription or production dictionary cleanup was performed.
- No live Gemini or Groq call was made in the broad scan. Provider success, repair-request counts, and production runtime are therefore not measured.

Before cleaning old dictionary records, inventory the actual book/global entry provenance as well as the export comparison, back up the affected records, and keep manual/user-approved entries untouched. Validate recovered terms against the rendered source pages; do not infer them from the damaged JSON strings.
