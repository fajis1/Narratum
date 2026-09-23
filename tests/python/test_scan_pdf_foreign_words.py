import unittest
from unittest.mock import patch

import scan_pdf_foreign_words


class ForeignWordContextTests(unittest.TestCase):
    def test_all_foreign_keeps_complete_transliterations(self):
        text = 'Aššurbanipal met haššāmayim. The short form ʾîš also appears.'
        with (
            patch.object(scan_pdf_foreign_words, 'load_pdf_text', return_value=text),
            patch.object(scan_pdf_foreign_words, 'fetch_global_pronunciations', return_value={}),
        ):
            rows = scan_pdf_foreign_words.scan_pdf_foreign_words('unused.pdf', target_percentile=100, mode='all_foreign', quiet=True)
        words = {row['word'] for row in rows}
        self.assertIn('Aššurbanipal', words)
        self.assertIn('haššāmayim', words)
        self.assertIn('ʾîš', words)
        self.assertNotIn('šš', words)
        self.assertNotIn('ššā', words)

    def test_context_retains_target_and_wrapped_gloss(self):
        text = 'Preface. ' + ('ordinary prose ' * 40) + 'haššāmayim\nmeans the heavens in this passage. End.'
        with (
            patch.object(scan_pdf_foreign_words, 'load_pdf_text', return_value=text),
            patch.object(scan_pdf_foreign_words, 'fetch_global_pronunciations', return_value={}),
        ):
            rows = scan_pdf_foreign_words.scan_pdf_foreign_words('unused.pdf', target_percentile=100, mode='all_foreign', quiet=True)
        row = next(row for row in rows if row['word'] == 'haššāmayim')
        self.assertIn('haššāmayim means the heavens', row['contexts'][0])
        self.assertIn('haššāmayim', row['contexts'][0])
        self.assertEqual(row['occurrences'][0]['surfaceTerm'], 'haššāmayim')
        self.assertEqual(row['occurrences'][0]['context'][row['occurrences'][0]['contextTargetStart']:row['occurrences'][0]['contextTargetEnd']], 'haššāmayim')

    def test_combining_marks_and_page_offsets_survive_tokenization(self):
        first_page = 'On this page, Aššurbanipal appears.\n'
        second_page = 'The NFD spelling haššāmayim has a gloss.\n'
        text = scan_pdf_foreign_words.ExtractedPdfText(
            first_page + second_page,
            [(0, len(first_page), 1), (len(first_page), len(first_page + second_page), 2)],
            'pypdf',
        )
        with (
            patch.object(scan_pdf_foreign_words, 'load_pdf_text', return_value=text),
            patch.object(scan_pdf_foreign_words, 'fetch_global_pronunciations', return_value={}),
        ):
            rows = scan_pdf_foreign_words.scan_pdf_foreign_words('unused.pdf', target_percentile=100, mode='all_foreign', quiet=True)
        by_word = {row['word']: row for row in rows}
        occurrence = by_word['haššāmayim']['occurrences'][0]
        self.assertEqual(occurrence['pdfPage'], 2)
        self.assertEqual(occurrence['sourceStart'], text.index('haššāmayim'))
        self.assertEqual(occurrence['normalizedTerm'], 'haššāmayim')

    def test_internal_editorial_letters_remain_one_candidate_with_original_context(self):
        text = 'The gifts of God (ἐκ τῶν τοῦ θε(οῦ) δωρεῶν). Hebrew של(ו)ם remains.'
        for mode in ('greek_hebrew', 'all_foreign'):
            with (
                patch.object(scan_pdf_foreign_words, 'load_pdf_text', return_value=text),
                patch.object(scan_pdf_foreign_words, 'fetch_global_pronunciations', return_value={}),
                patch.object(scan_pdf_foreign_words, 'zipf_frequency', return_value=6.0),
            ):
                rows = scan_pdf_foreign_words.scan_pdf_foreign_words('unused.pdf', target_percentile=100, mode=mode, quiet=True)
            by_word = {row['word']: row for row in rows}
            self.assertIn('θεοῦ', by_word)
            self.assertIn('שלום', by_word)
            self.assertNotIn('θε', by_word)
            self.assertNotIn('οῦ', by_word)
            self.assertEqual(by_word['θεοῦ']['editorialSpellings'], ['θε(οῦ)'])
            self.assertIn('θε(οῦ)', by_word['θεοῦ']['contexts'][0])

    def test_editorial_expansion_does_not_join_phrases_or_alternatives(self):
        for text in ('(θεοῦ)', 'θε (οῦ)', 'θε(οῦ λόγος)', 'θε(οῦ/ός)', 'θε(אב)', 'the(o)', 'aθε(οῦ)'):
            self.assertEqual(scan_pdf_foreign_words.collect_editorial_words(text), [], text)
        self.assertEqual(scan_pdf_foreign_words.collect_editorial_words('θ(ε)ο(ῦ)')[0][3], 'θεοῦ')

    def test_classifies_only_frequent_english_dictionary_words(self):
        scores = {"the": 7.7, "dungeon": 4.1, "aethrian": 0.0, "don't": 6.2}
        with patch.object(
            scan_pdf_foreign_words,
            "zipf_frequency",
            side_effect=lambda word, _language: scores.get(word, 0.0),
        ):
            results = scan_pdf_foreign_words.classify_standard_english_words(
                ["The", "Dungeon", "Aethrian", "don't", "Rank42", "λόγος"],
            )

        self.assertEqual(
            results,
            [
                {"word": "The", "zipfFrequency": 7.7},
                {"word": "Dungeon", "zipfFrequency": 4.1},
                {"word": "don't", "zipfFrequency": 6.2},
            ],
        )

    def test_litrpg_mode_rejects_standard_english_and_keeps_book_terms(self):
        text = (
            "The hero entered the Dungeon with Aethrian and cast manamancy. "
            "THE common words should disappear, but Khar'Thok and Rank42 remain."
        )
        standard_english = {
            "the", "hero", "entered", "dungeon", "with", "and", "cast",
            "common", "words", "should", "disappear", "but", "remain",
        }

        def fake_zipf(word, _language):
            return 5.0 if word in standard_english else 0.0

        with (
            patch.object(scan_pdf_foreign_words, "load_pdf_text", return_value=text),
            patch.object(scan_pdf_foreign_words, "fetch_global_pronunciations", return_value={}),
            patch.object(scan_pdf_foreign_words, "zipf_frequency", side_effect=fake_zipf),
        ):
            results = scan_pdf_foreign_words.scan_pdf_foreign_words(
                "unused.pdf", target_percentile=100, mode="fantasy_litrpg", quiet=True,
            )

        terms = {item["word"] for item in results}
        self.assertEqual(terms, {"Aethrian", "manamancy", "Khar'Thok", "Rank42"})

    def test_biblical_mode_adds_rare_latin_transliteration_candidates(self):
        text = (
            "The scholar compares phronein with qādôš and ordinary words. "
            "The Greek spelling φρονεῖν also appears."
        )
        rare_transliterations = {"phronein", "qādôš"}
        with (
            patch.object(scan_pdf_foreign_words, "load_pdf_text", return_value=text),
            patch.object(scan_pdf_foreign_words, "fetch_global_pronunciations", return_value={}),
            patch.object(
                scan_pdf_foreign_words,
                "zipf_frequency",
                side_effect=lambda word, _language: 0.0 if word in rare_transliterations else 5.0,
            ),
        ):
            results = scan_pdf_foreign_words.scan_pdf_foreign_words(
                "unused.pdf", target_percentile=100, mode="greek_hebrew", quiet=True,
            )

        by_word = {item["word"]: item for item in results}
        self.assertIn("φρονεῖν", by_word)
        for term in rare_transliterations:
            self.assertTrue(by_word[term]["latinTransliterationCandidate"])
        self.assertNotIn("ordinary", by_word)

    def test_known_ocr_fragments_are_not_returned_as_dictionary_candidates(self):
        text = "The fragment κω appears beside the valid term λόγος."
        for mode in ("greek_hebrew", "all_foreign"):
            with self.subTest(mode=mode):
                with (
                    patch.object(scan_pdf_foreign_words, "load_pdf_text", return_value=text),
                    patch.object(scan_pdf_foreign_words, "fetch_global_pronunciations", return_value={}),
                ):
                    results = scan_pdf_foreign_words.scan_pdf_foreign_words(
                        "unused.pdf",
                        target_percentile=100,
                        mode=mode,
                        quiet=True,
                    )

                    self.assertNotIn("κω", [item["word"] for item in results])
                    self.assertIn("λόγος", [item["word"] for item in results])

    def test_contexts_match_complete_foreign_terms_not_compound_substrings(self):
        text = (
            "The compound θεολόγος appears first. "
            "Another θεολόγος appears second. "
            "The standalone λόγος means word."
        )
        with (
            patch.object(scan_pdf_foreign_words, "load_pdf_text", return_value=text),
            patch.object(scan_pdf_foreign_words, "fetch_global_pronunciations", return_value={}),
        ):
            results = scan_pdf_foreign_words.scan_pdf_foreign_words(
                "unused.pdf",
                target_percentile=100,
                mode="greek_hebrew",
                quiet=True,
            )

        logos = next(item for item in results if item["word"] == "λόγος")
        self.assertEqual(logos["contexts"], ["The standalone λόγος means word."])

    def test_preserves_mixed_script_ocr_evidence_for_gemini_review(self):
        text = "The damaged OCR token vio[θεσ]iα appears beside υἱοθεσία."
        with (
            patch.object(scan_pdf_foreign_words, "load_pdf_text", return_value=text),
            patch.object(scan_pdf_foreign_words, "fetch_global_pronunciations", return_value={}),
        ):
            results = scan_pdf_foreign_words.scan_pdf_foreign_words(
                "unused.pdf",
                target_percentile=100,
                mode="greek_hebrew",
                quiet=True,
            )

        shard = next(item for item in results if item["word"] == "θεσ")
        intact = next(item for item in results if item["word"] == "υἱοθεσία")
        self.assertTrue(shard["ocrSuspect"])
        self.assertEqual(shard["ocrEvidence"], ["vio[θεσ]iα"])
        self.assertNotIn("ocrSuspect", intact)

    def test_exposes_fuzzy_group_priority_and_variants(self):
        text = "Aethrian Aethrian Aethriann Common Common Common Common."
        with (
            patch.object(scan_pdf_foreign_words, "load_pdf_text", return_value=text),
            patch.object(scan_pdf_foreign_words, "fetch_global_pronunciations", return_value={}),
            patch.object(
                scan_pdf_foreign_words,
                "zipf_frequency",
                side_effect=lambda word, _language: 5.0 if word == "common" else 0.0,
            ),
        ):
            results = scan_pdf_foreign_words.scan_pdf_foreign_words(
                "unused.pdf",
                target_percentile=100,
                mode="fantasy_litrpg",
                quiet=True,
            )

        aethrian = next(item for item in results if item["word"] == "Aethrian")
        self.assertEqual(aethrian["fuzzyGroupCount"], 3)
        self.assertEqual(aethrian["fuzzyGroupVariants"], ["Aethrian", "Aethriann"])
        self.assertNotIn("Common", [item["word"] for item in results])

    def test_does_not_chain_indirect_fuzzy_matches_into_one_group(self):
        text = "Aaaa Aaaa Aaaa Aabb Aabb Bbbb"
        with (
            patch.object(scan_pdf_foreign_words, "load_pdf_text", return_value=text),
            patch.object(scan_pdf_foreign_words, "fetch_global_pronunciations", return_value={}),
            patch.object(scan_pdf_foreign_words, "zipf_frequency", return_value=0.0),
        ):
            results = scan_pdf_foreign_words.scan_pdf_foreign_words(
                "unused.pdf",
                target_percentile=100,
                mode="fantasy_litrpg",
                quiet=True,
            )

        by_word = {item["word"]: item for item in results}
        self.assertEqual(by_word["Aaaa"]["fuzzyGroupCount"], 5)
        self.assertEqual(by_word["Aaaa"]["fuzzyGroupVariants"], ["Aaaa", "Aabb"])
        self.assertEqual(by_word["Bbbb"]["fuzzyGroupCount"], 1)
        self.assertEqual(by_word["Bbbb"]["fuzzyGroupVariants"], ["Bbbb"])

    def test_folds_accents_for_function_terms_and_fuzzy_priority(self):
        text = "τὸ καὶ δὲ ἁρπαγμός ἁρπαγμός ἅρπαγμα Θεσμοφόρος"
        with (
            patch.object(scan_pdf_foreign_words, "load_pdf_text", return_value=text),
            patch.object(scan_pdf_foreign_words, "fetch_global_pronunciations", return_value={}),
        ):
            results = scan_pdf_foreign_words.scan_pdf_foreign_words(
                "unused.pdf", target_percentile=100, mode="greek_hebrew", quiet=True,
            )

        by_word = {item["word"]: item for item in results}
        self.assertNotIn("τὸ", by_word)
        self.assertNotIn("καὶ", by_word)
        self.assertNotIn("δὲ", by_word)
        self.assertEqual(by_word["ἁρπαγμός"]["fuzzyGroupCount"], 3)
        self.assertEqual(by_word["ἁρπαγμός"]["fuzzyGroupVariants"], ["ἁρπαγμός", "ἅρπαγμα"])
        self.assertIn("Θεσμοφόρος", by_word)

    def test_marks_safe_extraction_artifacts_for_automatic_ignore(self):
        text = "δ᾽ σ᾿ υἱοθεσ דמותὁμοίωμα Θεσμοφόρος θεός·"
        with (
            patch.object(scan_pdf_foreign_words, "load_pdf_text", return_value=text),
            patch.object(scan_pdf_foreign_words, "fetch_global_pronunciations", return_value={}),
        ):
            results = scan_pdf_foreign_words.scan_pdf_foreign_words(
                "unused.pdf", target_percentile=100, mode="greek_hebrew", quiet=True,
            )

        by_word = {item["word"]: item for item in results}
        for artifact in ("δ᾽", "σ᾿", "υἱοθεσ", "דמותὁμοίωμα"):
            self.assertTrue(by_word[artifact]["ocrFragment"])
            self.assertTrue(by_word[artifact]["automaticIgnoreReason"])
        self.assertNotIn("ocrFragment", by_word["Θεσμοφόρος"])
        self.assertNotIn("ocrFragment", by_word["θεός"])


if __name__ == "__main__":
    unittest.main()
