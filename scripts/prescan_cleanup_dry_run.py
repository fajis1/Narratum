#!/usr/bin/env python3
"""Compare a foreign-word export with a fresh PDF prescan; never change records."""

import argparse
import hashlib
import json
import logging
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scan_pdf_foreign_words import scan_pdf_foreign_words  # noqa: E402


def compare_exports(old_export, fresh_words):
    if old_export.get('format') != 'openreader-foreign-word-scan' or old_export.get('version') not in (1, 2):
        raise ValueError('Expected a version-1 or version-2 OpenReader foreign-word export')
    old_rows = old_export.get('words')
    if not isinstance(old_rows, list):
        raise ValueError('Export words must be a list')
    old_terms = {row.get('word') for row in old_rows if isinstance(row, dict) and isinstance(row.get('word'), str)}
    fresh_by_term = {row['word']: row for row in fresh_words}
    status_counts = Counter(row.get('sourceStatus', 'unverified') for row in fresh_words)
    absent = sorted(old_terms - fresh_by_term.keys())
    source_review = sorted(term for term in old_terms & fresh_by_term.keys()
                           if fresh_by_term[term].get('sourceStatus') != 'unverified')
    return {
        'oldWordCount': len(old_terms),
        'freshWordCount': len(fresh_by_term),
        'oldTermsAbsentFromFreshScan': absent,
        'oldTermsWithFreshSourceQualityFlags': source_review,
        'freshStatusCounts': dict(status_counts),
        'advice': (
            'This is a dry-run inventory, not a deletion list. Different scan settings and occurrence ranking '
            'can change membership. The export does not prove which current pronunciations were manually '
            'approved. Back up scoped book/global records and verify source pages and provenance before cleanup.'
        ),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf', type=Path, required=True)
    parser.add_argument('--old-export', type=Path, required=True)
    parser.add_argument('--db', default='drizzle/sqlite.db')
    parser.add_argument('--mode', default='all_foreign', choices=('all_foreign', 'greek_hebrew', 'fantasy_litrpg'))
    parser.add_argument('--target', type=float, default=80.0)
    args = parser.parse_args()
    with args.old_export.open(encoding='utf-8') as source:
        old_export = json.load(source)
    with args.pdf.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    if old_export.get('documentId') != digest:
        parser.error('The export documentId does not match the PDF SHA-256 hash')
    logging.disable(logging.CRITICAL)  # pypdf may emit noisy extraction warnings.
    fresh_words = scan_pdf_foreign_words(str(args.pdf), args.db, args.target, mode=args.mode, quiet=True)
    report = compare_exports(old_export, fresh_words)
    report.update({'documentId': digest, 'scanMode': args.mode, 'targetPercentile': args.target})
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
