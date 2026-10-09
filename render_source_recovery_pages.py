"""Render bounded source-recovery evidence; never rewrite the PDF."""
import base64
import json
import sys
import fitz


def render_pages(pdf_path, pages):
    if not pages or len(pages) > 6 or any(not isinstance(page, int) or page < 1 for page in pages):
        raise ValueError('Request between one and six PDF pages')
    with fitz.open(pdf_path) as document:
        result = []
        for page in sorted(set(pages)):
            if page > len(document):
                raise ValueError('PDF page is out of range')
            source_page = document[page - 1]
            scale = min(1.5, 2048 / max(source_page.rect.width, source_page.rect.height))
            pixmap = source_page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            result.append({'page': page, 'data': base64.b64encode(pixmap.tobytes('png')).decode('ascii')})
        return result


if __name__ == '__main__':
    print(json.dumps(render_pages(sys.argv[1], json.loads(sys.argv[2]))))
