"""Offline image-build smoke check: exercise the exact runtime interpreter/script."""
import base64
import json
from pathlib import Path
import subprocess
import sys
import tempfile

import fitz


def check_runtime():
    renderer = Path(__file__).resolve().parent.parent / 'render_source_recovery_pages.py'
    with tempfile.TemporaryDirectory(prefix='renderer-check-') as directory:
        pdf = Path(directory) / 'fixture.pdf'
        with fitz.open() as document:
            document.new_page().insert_text((72, 72), 'Offline renderer prerequisite check')
            document.save(pdf)
        result = subprocess.run(
            [sys.executable, str(renderer), str(pdf), json.dumps([1])],
            check=True, capture_output=True, text=True, timeout=30,
        )
        pages = json.loads(result.stdout)
        assert len(pages) == 1 and pages[0]['page'] == 1 and pages[0]['kind'] == 'page'
        assert base64.b64decode(pages[0]['data']).startswith(b'\x89PNG\r\n\x1a\n')
    print('OCR renderer runtime verified: Python, PyMuPDF, script and PDF-to-PNG output')


if __name__ == '__main__':
    check_runtime()
