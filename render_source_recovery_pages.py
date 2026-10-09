"""Render bounded source-recovery evidence; never rewrite the PDF."""
import base64
import json
import sys
import fitz


def render_pages(pdf_path, pages):
    if not pages or len(pages) > 6 or any(
        (not isinstance(item, int) and not isinstance(item, dict))
        or (isinstance(item, int) and item < 1)
        or (isinstance(item, dict) and (not isinstance(item.get('page'), int) or item['page'] < 1))
        for item in pages
    ):
        raise ValueError('Request between one and six PDF pages')
    with fitz.open(pdf_path) as document:
        result = []
        requests = [({'page': page} if isinstance(page, int) else page) for page in pages]
        unique_pages = sorted({request['page'] for request in requests})
        for page in unique_pages:
            if page > len(document):
                raise ValueError('PDF page is out of range')
            source_page = document[page - 1]
            scale = min(1.5, 2048 / max(source_page.rect.width, source_page.rect.height))
            pixmap = source_page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            result.append({'page': page, 'kind': 'page', 'data': base64.b64encode(pixmap.tobytes('png')).decode('ascii')})
        for request in requests:
            bbox = request.get('bbox')
            if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
                continue
            try:
                x0, y0, x1, y1 = [float(value) for value in bbox]
            except (TypeError, ValueError):
                continue
            page = document[request['page'] - 1]
            rect = fitz.Rect(x0, y0, x1, y1) & page.rect
            if rect.is_empty or rect.width <= 0 or rect.height <= 0:
                continue
            margin_x = min(180, max(72, rect.width * 2.5))
            margin_y = min(100, max(36, rect.height * 3))
            clip = fitz.Rect(rect.x0 - margin_x, rect.y0 - margin_y,
                             rect.x1 + margin_x, rect.y1 + margin_y) & page.rect
            scale = min(3.0, 2048 / max(clip.width, clip.height))
            crop = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=clip, alpha=False)
            result.append({'page': request['page'], 'kind': 'crop', 'cropKind': 'text_block',
                           'occurrenceId': request.get('occurrenceId'),
                           'data': base64.b64encode(crop.tobytes('png')).decode('ascii')})
        return result


if __name__ == '__main__':
    print(json.dumps(render_pages(sys.argv[1], json.loads(sys.argv[2]))))
