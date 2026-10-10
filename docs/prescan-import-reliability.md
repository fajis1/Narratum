# Pre-scan JSON imports and rescans

Successful JSON imports save pronunciation and definition edits in the selected
book's lexicon. The import response includes the updated scan job, so the table,
manual-review count and manual-review export update together. Successfully saved
terms are removed from the persisted manual-review list; skipped and untouched
terms remain. Reopening the pre-scan shows the same updated list. Historical
Gemini generation counters are retained.

An import with saved edits shows All Words, making the accepted edits visible
even when other rows were skipped. Skipped rows retain their individual reasons.
A corrected re-import clears the import-validation flag and restores the source
status recorded before that import failure. Independent source-quality warnings
remain; older warnings without stored source-status provenance are preserved.

Rescans reuse compatible book pronunciations for the same Smart Audio profile,
display them as document choices, and keep imported definitions and explicit
definition omissions. Personal overrides retain precedence for ordinary terms;
verified OCR readings retain their existing document-local precedence. Imported
definitions are not automatically promoted to the global dictionary. A Scholar
scan can still request missing definitions, and invalid stored pronunciations
still need repair.

An imported pronunciation does not verify damaged PDF source text. Source-repair
rows remain blocked until the OCR recovery workflow resolves the printed reading.
Setting `omitDefinition: true` only omits the spoken gloss: it does not bypass the
requirement for a valid pronunciation or the source-repair checks.

Regression coverage includes the real scan/import API lifecycle with SQLite and
mocked providers, repeated rescans, personal/global precedence, explicit
omissions, import-only flag cleanup, and a mounted browser import/reopen flow.
These fixtures do not verify a particular production book's database or PDF.
