#!/usr/bin/env python3
"""
Split an OpenReader foreign-word scan JSON export into compact, AI-friendly batch files.

Usage:
    python3 scripts/split_foreign_word_scan.py --input foreign-words-doc123.json --batch-size 100 --compact --zip
"""

import os
import sys
import json
import zipfile
import argparse
from datetime import datetime, timezone


def split_scan(input_path, batch_size=100, output_dir=None, compact=True, create_zip=False):
    if not os.path.exists(input_path):
        print(f"Error: input file '{input_path}' not found.", file=sys.stderr)
        sys.exit(1)

    with open(input_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    if not isinstance(data, dict) or data.get('format') != 'openreader-foreign-word-scan':
        print(f"Error: '{input_path}' is not a valid OpenReader foreign word scan JSON.", file=sys.stderr)
        sys.exit(1)

    words = data.get('words', [])
    doc_id = data.get('documentId', 'document')
    total_words = len(words)

    if output_dir is None:
        output_dir = os.path.dirname(os.path.abspath(input_path))
    os.makedirs(output_dir, exist_ok=True)

    if total_words == 0:
        print("Scan contains 0 words; nothing to split.")
        return []

    total_parts = (total_words + batch_size - 1) // batch_size
    pad_len = max(2, len(str(total_parts)))
    generated_files = []

    print(f"Splitting {total_words} words into {total_parts} batches of ~{batch_size} words...")

    for i in range(total_parts):
        chunk = words[i * batch_size : (i + 1) * batch_size]
        part_num = i + 1
        part_str = str(part_num).zfill(pad_len)
        filename = f"foreign-words-{doc_id}-part-{part_str}.json"
        filepath = os.path.join(output_dir, filename)

        processed_chunk = []
        for row in chunk:
            row_copy = dict(row)
            if compact and 'occurrences' in row_copy and isinstance(row_copy['occurrences'], list):
                compact_occurrences = []
                for occ in row_copy['occurrences'][:2]:
                    if isinstance(occ, dict):
                        compact_occurrences.append({
                            'surfaceTerm': occ.get('surfaceTerm'),
                            'normalizedTerm': occ.get('normalizedTerm'),
                            'pdfPage': occ.get('pdfPage'),
                            'context': occ.get('context'),
                            'qualityFlags': occ.get('qualityFlags', []),
                            'sourceStatus': occ.get('sourceStatus', 'unverified'),
                        })
                row_copy['occurrences'] = compact_occurrences
            processed_chunk.append(row_copy)

        batch_payload = {
            'format': 'openreader-foreign-word-scan',
            'version': 2,
            'documentId': doc_id,
            'exportedAt': datetime.now(timezone.utc).isoformat(),
            'instructions': (
                f"Batch {part_num} of {total_parts} ({len(chunk)} words). "
                "Read sourceStatus, qualityFlags, and occurrences before proposing edits. "
                "Edit proposedPronunciation and proposedDefinition only for verified complete words. "
                "Import back into OpenReader after processing."
            ),
            'words': processed_chunk,
        }

        with open(filepath, 'w', encoding='utf-8') as out_f:
            json.dump(batch_payload, out_f, ensure_ascii=False, indent=2)

        generated_files.append(filepath)
        print(f"  -> Wrote {filename} ({len(chunk)} words)")

    if create_zip:
        zip_filename = f"foreign-words-{doc_id}-batches.zip"
        zip_filepath = os.path.join(output_dir, zip_filename)
        with zipfile.ZipFile(zip_filepath, 'w', zipfile.ZIP_DEFLATED) as zf:
            for fpath in generated_files:
                zf.write(fpath, arcname=os.path.basename(fpath))
        print(f"\nCreated ZIP archive: {zip_filepath}")

    print(f"\nDone! Successfully generated {len(generated_files)} batch files.")
    return generated_files


def main():
    parser = argparse.ArgumentParser(description="Split OpenReader scan JSON into LLM-friendly batches.")
    parser.add_argument("--input", "-i", required=True, help="Path to foreign-words-<id>.json file")
    parser.add_argument("--batch-size", "-b", type=int, default=100, help="Number of words per batch (default: 100)")
    parser.add_argument("--output-dir", "-o", default=None, help="Output directory (default: same as input file)")
    parser.add_argument("--compact", action="store_true", default=True, help="Omit internal bounding-box coordinates (default: True)")
    parser.add_argument("--no-compact", dest="compact", action="store_false", help="Preserve full bounding-box coordinates")
    parser.add_argument("--zip", "-z", action="store_true", help="Package all generated batch JSONs into a single .zip file")

    args = parser.parse_args()
    split_scan(args.input, batch_size=args.batch_size, output_dir=args.output_dir, compact=args.compact, create_zip=args.zip)


if __name__ == "__main__":
    main()
