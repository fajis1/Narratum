"""Deterministic extracted-PDF evidence; no model, dictionary, or network calls."""
import json
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import scan_pdf_foreign_words as scanner


def fixture():
    pages = [(page, 'The word xatagyéw means abolish. ' * 25) for page in (1, 2, 3)]
    pages += [(4, 'The word xataoyéw appears here. ' * 8 + 'The word téAoc appears here. ' * 19),
              (5, 'The Greek discussion includes xatagew. An ambiguous év appears. Ordinary vocabulary and katargeo are legitimate Latin text.')]
    text = ''
    spans = []
    for page, passage in pages:
        start = len(text)
        text += passage + '\n'
        spans.append((start, len(text), page))
    extracted = scanner.ExtractedPdfText(text, spans, 'fixture-pypdf')
    with (patch.object(scanner, 'load_pdf_text', return_value=extracted),
          patch.object(scanner, 'fetch_global_pronunciations', return_value={}),
          patch.object(scanner, 'zipf_frequency', side_effect=lambda word, language: 0.0 if word == 'xatagew' else 4.0)):
        rows = scanner.scan_pdf_foreign_words('fixture.pdf', target_percentile=100, mode='all_foreign', quiet=True)
    return {'rows': rows, 'pages': [{'pageNumber': page, 'text': passage} for page, passage in pages]}


if __name__ == '__main__':
    print(json.dumps(fixture(), ensure_ascii=False))
