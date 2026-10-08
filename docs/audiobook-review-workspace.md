# Audiobook Review workspace — 2026-10-07

The Review page now follows chapter selection → listening/source comparison → issue review → editing → Save & Re-record. This is a presentation and navigation change. Existing server endpoints, processing, pronunciation safeguards, Director/TTS behavior and persisted review flags are unchanged.

## Action inventory and destination

Inventory was taken against main's `6c582a6` tree (identical to local `e9ac80b`). ListenPage retains data, polling, fetch calls, handlers and existing specialized modals. Extracted components receive callbacks.

| Previous control | New destination | Existing callback/behavior |
| --- | --- | --- |
| List / Original / Edit | Desktop workspace Layout toggles | `setShowLeftPane`, `setShowMiddlePane`, `setShowRightPane`; independent toggles |
| Chapter panes on phone | Mobile Chapters / Original / Edit | One mobile pane; desktop visibility state retained independently |
| Prev Chapter / Prev Flagged | Review header Previous | `handlePrevChapter`, guarded visible-chapter navigation |
| Next Chapter / Next Flagged | Review header Next | `handleNextChapter`, guarded visible-chapter navigation |
| Chapter selection | Chapter list | Shared `requestChapterSelection`, persisted sparse chapter ID |
| All / Needs Review / Filter list | Chapter list filter | `setChapterFilter`; filtered automatic selection uses guard |
| Chapter search / Clear search | Chapter list | `setChapterSearch` |
| Chapter sort | Chapter list | `setChapterSort` |
| Audio Drama Studio | Desktop workspace toolbar | `setShowMultiVoiceStudio`; existing studio unchanged |
| Mobile Player | Mobile Review Audio | `setShowMobilePlayer`; existing player/flagging unchanged |
| Scan Pronunciation Issues | Book Tools → Review | `setShowPronunciationIssues` |
| Review AI Changes | Book Tools → Review, or active job Review Changes | `setShowBatchRefineReview`; no duplicate during active batch job |
| Fix All Abbreviations | Book Tools → Book Text | `handleFixAllAbbreviations` |
| AI Batch Refine | Book Tools → Book Text | `handleOpenBatchRefine`; original configuration modal |
| Re-record All Modified chunks | Book Tools → Recording | `handleRebuildAllModified`; unchanged dry-run check |
| Add to Audiobookshelf | Book Tools → Export | `setShowAudiobookshelfModal` |
| Force Re-record All | Book Tools → Danger | Shared confirmation dialog → `handleForceRebuildAll` |
| Dictionary | Chapter Tools → Chapter Text | `setIsPronunciationModalOpen`; selection-based lookup preserved |
| Abbreviations | Chapter Tools → Chapter Text → Add abbreviation | Existing abbreviation modal and profile save |
| Fix Abbreviations | Chapter Tools → Chapter Text | `handleFixAbbreviations` |
| Clean with AI | Workspace AI Clean Chapter… → configuration dialog | `handleAiClean`; same existing chapter API payload |
| Clean Edited checkbox | AI Clean dialog Edited/Original radio choices | Same `cleanTarget` state |
| Smart Audio profile | AI Clean dialog Profile | Same `selectedProfileId` state |
| Profile settings gear | AI Clean dialog AI Settings… / Chapter Tools → AI | `setIsSettingsModalOpen`; same settings UI |
| Save to Audiobook / Re-record with Gemini Drama | Dirty chapter Save & Re-record; clean Chapter Tools → Recording | `handleRegenerate`; successful API response clears submitted dirty state |
| View Error Log | Chapter Tools → Diagnostics, conditional | `setErrorLogModalChapter` |
| Per-row Log | Select chapter → Chapter Tools diagnostics; issues Details | Same diagnostic modal, no nested row buttons |
| View All Error Logs | Expanded Review Issues | `setErrorLogModalChapter({ index: null })` |
| Refresh flags | Expanded Review Issues refresh icon | `fetchReviewFlags` |
| Details | Expanded Review Issues, current chapter first | Same chapter diagnostic modal |
| Retry chapter | Expanded Review Issues Retry | `retryReviewFlag`; same saved-text recovery API |
| Resolve | Expanded Review Issues Resolve | `resolveReviewFlag`; same PATCH API |
| Review Changes | Compact active batch job strip | Existing batch review modal |
| Raw Changelog | Job overflow | Same changelog URL/run ID, new tab |
| Stop & Cancel | Job overflow, danger | Same DELETE queue endpoint; cancellation errors surfaced |
| Speaker character assignment | Selected multi-voice chapter rows | `updateSpeakerAssignment` |
| Speaker text | Selected speaker rows | Local drafts; no blur reset of other drafts |
| Speaker audio preview | Selected speaker rows | `previewSpeakerSegment` |
| Restore omitted speaker | Selected speaker rows | `restoreOmittedSegment` |
| Speaker Re-record | Selected speaker rows, secondary | `rerecordSpeakerSegment` |
| Apply Changes & Re-record Chunk | Selected speaker section bottom, dirty only | Same regeneration API; all speaker drafts included |
| Gemini Speaker turns / Edit full text | Edited pane header | Same `showGeminiFullText`, existing Gemini speaker review |
| Native chapter audio | Workspace bottom | Same audio source, playback/speaker tracking |
| No-audiobook Scan / Return to Dashboard | Empty state | Same modal and dashboard navigation |
| Existing modal controls: abbreviation save, settings, batch submit/help/cancel, approvals, dictionary, pronunciation scan/repair, exports, studio and mobile playback/flags | Existing specialized modals, opened through destinations above | Existing callbacks/APIs retained; no modal redesign |

## Unsaved edits

All user chapter-selection routes (Previous/Next, list, filtered selection, mobile player, diagnostic navigation and export's review filter) share one guard. Stay keeps edits; Discard restores saved text and loads the target; Save & Re-record continues only after the existing chapter request succeeds. Failures keep edits and the intended target. Successful submission does not clear newer edits made while a request was pending.

Text polling is suppressed while either normal text or speaker drafts are dirty. In-flight responses must still match the current chapter, latest request, and clean editor before applying. Status polling preserves the selected persisted chapter ID and never removes a dirty chapter. Browser reload/exit uses the standard beforeunload dirty-state protection; arbitrary SPA route interception is deliberately outside this change.

## Layout and accessibility

Desktop pane buttons are independent `aria-pressed` toggles. Mobile uses the existing radio-style SegmentedControl and shows one pane. Menus reuse Headless UI through Narratum primitives for keyboard navigation, Escape and restored focus. Status labels carry text, icon controls have accessible names/titles, danger commands use danger styling. Theme tokens replace old palette-specific Review styling. Review Issues starts collapsed, limits expanded height, puts current chapter first and discloses other issues separately. Missing/failed chapter recordings remain visibly marked even without a persisted flag.

The normal desktop header/workspace rows target 104px total; job strip targets 40px. Mobile Save & Re-record gets a separate 44px action above the existing audio player to preserve touch targets without horizontal toolbar overflow. No new endpoints or database changes.

## Verification

See the implementation report for executed commands/results. `tests/audiobook-review.spec.ts` renders the real Next.js page with all browser API requests mocked; it never starts real AI/TTS work. Unit tests exercise actual chapter model helpers, actual rendered presentation components and scoped callback definitions. Existing processing/approval/recording suites remain the regression gate.

Verified locally on 2026-10-07:

- Baseline: 19 existing Review/sparse-index tests and TypeScript passed. Review page ESLint baseline was 64 errors / 9 warnings.
- Focused: 97 tests across Review, sparse-index, GPU queue, multi-voice and Smart Audio integrity suites passed.
- Full `pnpm test:unit`: 202 files / 1,715 tests passed.
- `pnpm exec tsc --noEmit`: passed.
- Direct ESLint on the page, all new review components and affected tests: passed with zero errors/warnings.
- Chromium real-page mocked-API suite: 13 passed, including navigation save/stay/discard/failure, independently toggled panes, scoped menus, current issues first, job overflow, AI-clean payload, mobile radio keyboard navigation, multiple speaker drafts/save, force confirmation and pending-poll protection.
- Responsive screenshot/keyboard checks passed at 1280 / 1024 / 768 / 390px in light and dark themes. Desktop header + tools ≤112px; active job strip ≤48px. Dirty multi-voice toolbar verified at 1280 / 1024 / 768px; Studio moves into Chapter Tools at tablet width. No horizontal overflow.

Limitations: browser verification mocked media and provider/export requests; no live TTS, Gemini, Audiobookshelf upload or worker deployment was performed. Specialized modals retain their existing internal UX. Arbitrary SPA route interception is not introduced; browser reload/exit and every chapter-selection route are protected. Local full-suite verification includes pre-existing unrelated working-tree work, which was preserved and excluded from this UX change.

## Pre-merge state hardening (2026-10-07)

Review job presentation is centralized: legacy generation/batch-regeneration jobs omit `jobType`; batch refine and pronunciation repair have distinct labels, combine has its own label, and unknown types show Background Job. Only batch refine exposes its review/changelog controls. Standalone Review AI Changes requires a known run ID; the Batch Refine dialog retains Review Existing Changes for historical discovery.

AI Clean shares the Save & Re-record snapshot predicate. Successful requests reload authoritative chapter text and refresh the audio revision. Only the same chapter/editor/speaker-draft snapshot can be replaced and cleared; newer typing remains dirty. Original-source cleanup with dirty text requires explicit confirmation. Failed requests retain local edits and reopen the configuration dialog.

Book command safety:

| Command | While dirty / incompatible book job active |
| --- | --- |
| Fix All Abbreviations | Disabled: processes saved text |
| AI Batch Refine | Disabled: processes saved text |
| Re-record Modified Chapters | Disabled: records saved text |
| Force Re-record All | Disabled: records saved text |
| Scan Pronunciation Issues | Disabled: scans saved text and opens repair workflow |
| Add to Audiobookshelf | Disabled: exports saved audio/content |
| Review AI Changes | Read-only entry remains available when a run is known; existing approval protections remain authoritative |

Disabled menu items display the reason. Mutating book handlers also check the boundary again before submitting, including dialogs opened before state changed and the Studio recording entry point. Queued, running, waiting_for_pdf and pausing jobs block new saved-content operations; issue inspection, logs and navigation remain available.

Hardening verification: focused Review/Smart Audio integrity suites passed (62 tests); full unit suite passed after final edits (202 files / 1,719 tests); TypeScript and affected-file ESLint with zero warnings passed. The complete Chromium suite passed (19 tests), followed by six affected-case checks after tightening Revert's saved baseline. Browser coverage includes authoritative AI-clean reload/audio revision, preservation of newer typing, Revert to the newly saved result, Original confirmation/back/submit, failure recovery, disabled saved-content commands and pronunciation-job labels/capabilities. Provider/media/export calls remain mocked.

## Pronunciation attention and book-specific review mode (2026-10-08)

Review mode now follows the saved audiobook profile rather than the globally selected AI cleanup profile. A normal book (including legacy books without saved profile metadata) does not open Gemini Drama speaker review merely because that profile is selected globally. Explicit saved Gemini Drama books retain speaker review and use their saved profile for recording. Cleanup defaults prefer the saved book profile, with a non-Drama fallback.

Known pronunciation findings and pending pronunciation proposals color chapter badges and participate in Needs Review. Book Tools and its Scan Pronunciation Issues item slowly cycle warning/danger surface and border colors four seconds per cycle, ten cycles (40 seconds), then retain a static warning. Reduced-motion preferences suppress animation. Shared warning theme tokens now exist in light/dark themes. The current chapter uses the existing local scanner after a short typing debounce; saved proposals and modal scan results supply other known chapter findings without automatic Gemini calls. Generic TTS/Director failures alone do not trigger pronunciation animation. Unscanned other chapters are discovered through the existing scan workflow.

Verified: full unit suite 203 files / 1,729 tests passed; TypeScript and affected-file ESLint with zero warnings passed; real-page Chromium mocked-API suite 24 passed, including animation timing/count, reduced motion, corrected normal-book default, retained Drama behavior and existing Review workflows. Existing pronunciation modal Chromium suite 7 passed, including Override. Provider/media requests remain mocked; no production deployment performed.
