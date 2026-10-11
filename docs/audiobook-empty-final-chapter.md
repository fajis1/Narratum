# Omit an empty final chapter

A completed generation job or an empty diagnostic log does not guarantee that
every required chapter has a recording. “No text available for this chapter”
means that saved chapter text could not be loaded; it does not prove that the
source is blank.

For a final placeholder with no saved content or recording, open **Review
Progress**, select the last chapter and click **Omit empty final chapter**.
Confirm that it contains nothing you want included. The same control appears
beside the chapter in the audiobook generation dialog. Refresh the installation
after deploying a build that includes this control.

The server requires this to be the only missing chapter at the end of the book,
with other valid recordings present. It refuses saved narrative text, existing
chapter recording records, audio artifacts, diagnostics, later chapter artifacts
and active generation. Unsaved edits must be resolved before confirming.

The omission is an explicit owner decision, separate from automatic source-based
omission evidence. It preserves recordings, original source mappings and required
chapter indexes, and stores a document-local confirmation bound to the current
generation and source snapshot. Restored text or a changed generation invalidates
that confirmation. Full-book compilation and Audiobookshelf upload then use the
remaining recordings. No Gemini or TTS request is needed to omit the placeholder.

If the control is absent, use normal chapter review/recovery: a missing text file
alone is insufficient to discard a chapter that still has saved source or audio.
