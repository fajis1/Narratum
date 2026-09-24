import unittest
import tempfile
import os
import json
import zipfile
from scripts.split_foreign_word_scan import split_scan


class TestSplitForeignWordScan(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.doc_id = 'test-doc-123'
        self.words = [
            {
                'word': f'word{i}',
                'count': 1,
                'contexts': [f'context {i}'],
                'occurrences': [{
                    'surfaceTerm': f'word{i}',
                    'normalizedTerm': f'word{i}',
                    'pdfPage': 5,
                    'bbox': [1, 2, 3, 4],
                    'context': f'context {i}',
                }],
            }
            for i in range(25)
        ]
        self.input_payload = {
            'format': 'openreader-foreign-word-scan',
            'version': 2,
            'documentId': self.doc_id,
            'exportedAt': '2026-09-24T00:00:00Z',
            'instructions': 'Test',
            'words': self.words,
        }
        self.input_file = os.path.join(self.temp_dir.name, 'foreign-words-test.json')
        with open(self.input_file, 'w', encoding='utf-8') as f:
            json.dump(self.input_payload, f)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_split_into_batches(self):
        out_dir = os.path.join(self.temp_dir.name, 'batches')
        files = split_scan(self.input_file, batch_size=10, output_dir=out_dir, compact=True, create_zip=True)

        self.assertEqual(len(files), 3)
        self.assertTrue(os.path.exists(files[0]))
        self.assertTrue(files[0].endswith('part-01.json'))
        self.assertTrue(files[1].endswith('part-02.json'))
        self.assertTrue(files[2].endswith('part-03.json'))

        # Check part 1 content
        with open(files[0], 'r', encoding='utf-8') as f:
            part1 = json.load(f)
        self.assertEqual(part1['format'], 'openreader-foreign-word-scan')
        self.assertEqual(part1['version'], 2)
        self.assertEqual(len(part1['words']), 10)
        # Check compact occurrence
        self.assertNotIn('bbox', part1['words'][0]['occurrences'][0])
        self.assertEqual(part1['words'][0]['occurrences'][0]['pdfPage'], 5)

        # Check part 3 content (5 words)
        with open(files[2], 'r', encoding='utf-8') as f:
            part3 = json.load(f)
        self.assertEqual(len(part3['words']), 5)

        # Check ZIP creation
        zip_path = os.path.join(out_dir, f'foreign-words-{self.doc_id}-batches.zip')
        self.assertTrue(os.path.exists(zip_path))
        with zipfile.ZipFile(zip_path, 'r') as zf:
            names = zf.namelist()
            self.assertEqual(len(names), 3)
            self.assertIn('foreign-words-test-doc-123-part-01.json', names)


if __name__ == '__main__':
    unittest.main()
