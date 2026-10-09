import base64
import tempfile
import unittest
from pathlib import Path
import fitz
from render_source_recovery_pages import render_pages


class SourceRecoveryPageTests(unittest.TestCase):
    def test_rendered_evidence_has_exact_pdf_page_numbers_and_png_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fixture.pdf'
            with fitz.open() as document:
                for index in range(2):
                    document.new_page().insert_text((72, 72), f'Page {index + 1}: source evidence')
                document.save(path)
            result = render_pages(str(path), [2, 1, 2])
            self.assertEqual([item['page'] for item in result], [1, 2])
            for item in result:
                self.assertTrue(base64.b64decode(item['data']).startswith(b'\x89PNG\r\n\x1a\n'))
            with self.assertRaises(ValueError):
                render_pages(str(path), [3])

    def test_invalid_and_unbounded_page_requests_are_rejected_before_reading_a_pdf(self):
        for pages in ([], [0], [-1], ['1'], [{'page': 0}], list(range(1, 8))):
            with self.assertRaises(ValueError):
                render_pages('unused.pdf', pages)

    def test_targeted_crop_is_returned_with_its_occurrence_id_and_full_page_context(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fixture.pdf'
            with fitz.open() as document:
                page = document.new_page()
                page.insert_text((120, 120), 'xatagyéw', fontsize=12)
                document.save(path)
            result = render_pages(str(path), [{'page': 1, 'bbox': [118, 105, 180, 125], 'occurrenceId': 'occ-1'}])
            self.assertEqual([(item['page'], item['kind']) for item in result], [(1, 'page'), (1, 'crop')])
            self.assertEqual(result[1]['occurrenceId'], 'occ-1')
            self.assertTrue(base64.b64decode(result[1]['data']).startswith(b'\x89PNG\r\n\x1a\n'))
