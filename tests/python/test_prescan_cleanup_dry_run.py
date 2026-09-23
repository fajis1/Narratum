import unittest

from scripts.prescan_cleanup_dry_run import compare_exports


class PrescanCleanupDryRunTests(unittest.TestCase):
    def test_reports_absent_and_flagged_terms_without_declaring_deletions(self):
        old = {
            'format': 'openreader-foreign-word-scan', 'version': 1,
            'words': [{'word': 'šš'}, {'word': 'haššāmayim'}, {'word': 'אדם'}],
        }
        fresh = [
            {'word': 'haššāmayim', 'sourceStatus': 'unverified'},
            {'word': 'אדם', 'sourceStatus': 'needs_source_repair'},
        ]
        report = compare_exports(old, fresh)
        self.assertEqual(report['oldTermsAbsentFromFreshScan'], ['šš'])
        self.assertEqual(report['oldTermsWithFreshSourceQualityFlags'], ['אדם'])
        self.assertIn('not a deletion list', report['advice'])

    def test_rejects_an_unrecognized_export(self):
        with self.assertRaises(ValueError):
            compare_exports({'format': 'other', 'version': 1, 'words': []}, [])


if __name__ == '__main__':
    unittest.main()
