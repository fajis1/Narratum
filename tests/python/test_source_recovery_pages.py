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
        for pages in ([], [0], [-1], ['1'], list(range(1, 8))):
            with self.assertRaises(ValueError):
                render_pages('unused.pdf', pages)
