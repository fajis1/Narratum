import sys
import re
import json
import sqlite3
import argparse
import unicodedata
from collections import Counter
from functools import lru_cache
from bisect import bisect_right

try:
    from wordfreq import zipf_frequency
except ImportError:
    zipf_frequency = None

# Unicode ranges:
# Greek: 0370-03FF, 1F00-1FFF
# Hebrew: 0590-05FF
# Cyrillic: 0400-04FF
# CJK: 4E00-9FFF
# Arabic: 0600-06FF
# Latin Extended / Accented / Diacritics: 00C0-024F, 1E00-1EFF
ALL_FOREIGN_REGEX = re.compile(r'[\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF\u0400-\u04FF\u4E00-\u9FFF\u0600-\u06FF\u00C0-\u024F\u1E00-\u1EFF]+')
GREEK_HEBREW_REGEX = re.compile(r'[\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]+')
# Fantasy / LitRPG capitalized terms / uncommon non-dictionary words (e.g. Xylar, Eldoria, Statblock terms, Khar'Thok)
FANTASY_LITRPG_REGEX = re.compile(
    r"\b[A-Za-z]+(?:'[A-Za-z]+)?\b|\b(?:[A-Za-z]+[0-9]+[A-Za-z]*|[0-9]+[A-Za-z]+[A-Za-z0-9]*)\b"
)
LATIN_TRANSLITERATION_LETTERS = r"A-Za-z\u00C0-\u024F\u02B0-\u02FF\u1E00-\u1EFF\u0300-\u036F"
LATIN_TRANSLITERATION_REGEX = re.compile(
    rf"(?<![{LATIN_TRANSLITERATION_LETTERS}])"
    rf"[{LATIN_TRANSLITERATION_LETTERS}]+(?:['’][{LATIN_TRANSLITERATION_LETTERS}]+)?"
    rf"(?![{LATIN_TRANSLITERATION_LETTERS}])"
)
ALL_FOREIGN_TERM_CHARS = r"\u0300-\u036F\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF\u0400-\u04FF\u4E00-\u9FFF\u0600-\u06FF\u00C0-\u024F\u1E00-\u1EFF"
GREEK_HEBREW_TERM_CHARS = r"\u0300-\u036F\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF"
BIBLICAL_TERM_CHARS = GREEK_HEBREW_TERM_CHARS + LATIN_TRANSLITERATION_LETTERS

# Common English stop words for LitRPG / Fantasy filtering
ENGLISH_STOP_WORDS = {
    'The', 'A', 'An', 'And', 'Or', 'But', 'If', 'Then', 'Else', 'When', 'At', 'By', 'For', 'With',
    'About', 'Against', 'Between', 'Into', 'Through', 'During', 'Before', 'After', 'Above', 'Below',
    'To', 'From', 'Up', 'Down', 'In', 'Out', 'On', 'Off', 'Over', 'Under', 'Again', 'Further',
    'He', 'She', 'It', 'They', 'Them', 'His', 'Her', 'Its', 'Their', 'This', 'That', 'These', 'Those',
    'Is', 'Are', 'Was', 'Were', 'Be', 'Been', 'Being', 'Have', 'Has', 'Had', 'Do', 'Does', 'Did',
    'Can', 'Could', 'Will', 'Would', 'Shall', 'Should', 'May', 'Might', 'Must', 'Not', 'No', 'So'
}
ENGLISH_STOP_WORDS_CASEFOLD = {word.casefold() for word in ENGLISH_STOP_WORDS}

# Words at or above this frequency are familiar enough that Kokoro normally
# handles them without a book-specific pronunciation.  wordfreq's Zipf scale
# puts ordinary English vocabulary above this line while invented fantasy
# names and compounds generally score zero or very close to it.
STANDARD_ENGLISH_ZIPF_THRESHOLD = 2.5
MAX_FUZZY_GROUP_VARIANTS = 25


@lru_cache(maxsize=None)
def is_fantasy_litrpg_candidate(word):
    """Keep book-specific terms, not ordinary English vocabulary."""
    normalized = word.casefold()
    if len(word) <= 2 or normalized in ENGLISH_STOP_WORDS_CASEFOLD:
        return False
    if any(char.isdigit() for char in word):
        return True
    if zipf_frequency is None:
        raise RuntimeError(
            "Fantasy/LitRPG scanning requires the wordfreq Python package."
        )
    return zipf_frequency(normalized, 'en') < STANDARD_ENGLISH_ZIPF_THRESHOLD


@lru_cache(maxsize=None)
def is_latin_transliteration_candidate(word):
    """Keep uncommon Latin spellings for Gemini's biblical-language check."""
    base_letters = ''.join(
        character for character in unicodedata.normalize('NFD', word)
        if unicodedata.category(character) != 'Mn'
    )
    plain_letters = re.sub(r"['’ʾʿ]", "", base_letters)
    has_explicit_transliteration_marker = any(character in word for character in 'ʾʿ')
    if (len(plain_letters) < 4 and not has_explicit_transliteration_marker) or not re.fullmatch(r"[A-Za-z]+", plain_letters):
        return False
    if base_letters.casefold() in ENGLISH_STOP_WORDS_CASEFOLD:
        return False
    # Keep Greek/Hebrew-script extraction available in minimal environments;
    # the production image installs wordfreq for this additional candidate pass.
    if has_explicit_transliteration_marker:
        return True
    if zipf_frequency is None:
        return False
    return zipf_frequency(word.casefold(), 'en') < STANDARD_ENGLISH_ZIPF_THRESHOLD


def classify_standard_english_words(words):
    """Return English-frequency evidence for dictionary cleanup previews."""
    if zipf_frequency is None:
        raise RuntimeError(
            "English dictionary cleanup requires the wordfreq Python package."
        )
    results = []
    for word in words:
        if not isinstance(word, str) or not re.fullmatch(r"[A-Za-z]+(?:'[A-Za-z]+)?", word):
            continue
        score = zipf_frequency(word.casefold(), 'en')
        if score >= STANDARD_ENGLISH_ZIPF_THRESHOLD:
            results.append({"word": word, "zipfFrequency": round(score, 3)})
    return results

STOP_WORDS = {
    'ὁ', 'ἡ', 'τό', 'τοῦ', 'τῆς', 'τῷ', 'τήν', 'τόν', 'οἱ', 'αἱ', 'τά', 'τῶν', 'τοῖς', 'ταῖς', 'τούς', 'τάς',
    'καί', 'δέ', 'τε', 'γάρ', 'ἀλλά', 'μή', 'οὐ', 'οὐκ', 'οὐχ', 'ἐν', 'εἰς', 'ἐκ', 'ἐξ', 'πρός', 'ἀπό', 'διά',
    'μετά', 'κατά', 'περί', 'ὑπέρ', 'ὑπό', 'ἐπί', 'παρά', 'σύν', 'ὦ', 'εἰ', 'ὡς', 'ἄν', 'ὅτι', 'ἵνα',
    'אֵת', 'אֶת', 'וְ', 'הַ', 'בְּ', 'לְ', 'כְּ', 'מִ', 'עַל', 'אֶל', 'כִּי', 'אֲשֶׁר', 'עַד', 'עִם'
}
STOP_WORDS_FOLDED = {
    ''.join(
        character for character in unicodedata.normalize('NFD', word.casefold())
        if unicodedata.category(character) != 'Mn'
    )
    for word in STOP_WORDS
}


def normalize_foreign_term_for_fuzzy_match(word):
    """Fold case and accents so inflection/OCR variants group consistently."""
    return ''.join(
        character for character in unicodedata.normalize('NFD', word.casefold())
        if unicodedata.category(character) != 'Mn'
    )

# Known extraction fragments that are not usable standalone dictionary terms.
# Keep this intentionally narrow; Gemini handles genuine inflected forms using context.
KNOWN_OCR_FRAGMENTS = {'κω'}

# Keep enough of a mixed-script extraction artifact for Gemini to decide
# whether a matched Greek/Hebrew segment is a real lexical term.  For example,
# a regex match of ``θεσ`` inside ``vio[θεσ]iα`` is not independently useful,
# but Python must not guess which original word the OCR intended.
OCR_TOKEN_DELIMITERS = re.compile(r'[\s,;:!?"\'“”(){}<>]+')
ASCII_LETTER_REGEX = re.compile(r'[A-Za-z]')
GREEK_OR_HEBREW_REGEX = re.compile(r'[\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]')
GREEK_REGEX = re.compile(r'[\u0370-\u03FF\u1F00-\u1FFF]')
HEBREW_REGEX = re.compile(r'[\u0590-\u05FF]')
GREEK_ELISION_REGEX = re.compile(r"^[\u0370-\u03FF\u1F00-\u1FFF][\u1FBD\u1FBF'’]$")
TOKEN_JOINERS = {"'", '’'}
GREEK_TERMINAL_ELISION = {'\u1fbd', '\u1fbf', '᾿'}


def iter_complete_word_tokens(text):
    """Yield complete lexical surfaces and offsets, including attached marks.

    Apostrophes join letters only internally; ordinary hyphens and Hebrew
    maqqef remain boundaries until a source-aware compound policy is added.
    """
    index = 0
    while index < len(text):
        if unicodedata.category(text[index])[0] not in 'LN':
            index += 1
            continue
        start = index
        index += 1
        while index < len(text):
            character = text[index]
            category = unicodedata.category(character)[0]
            if category in 'LMN':
                index += 1
            elif character in TOKEN_JOINERS and index + 1 < len(text) and unicodedata.category(text[index + 1])[0] == 'L':
                index += 1
            elif character in GREEK_TERMINAL_ELISION and GREEK_REGEX.search(text[start:index]):
                index += 1
            else:
                break
        yield start, index, text[start:index]


def has_foreign_marker(word):
    return any(
        GREEK_OR_HEBREW_REGEX.match(character)
        or '\u0400' <= character <= '\u04ff'
        or '\u0600' <= character <= '\u06ff'
        or '\u4e00' <= character <= '\u9fff'
        or (character.isalpha() and ord(character) > 127)
        or unicodedata.category(character) == 'Mn'
        for character in word
    )


def get_ocr_suspect_evidence(full_text, start, end):
    """Return the raw token when a foreign-script match is embedded in OCR noise."""
    token_start = start
    while token_start > 0 and not OCR_TOKEN_DELIMITERS.match(full_text[token_start - 1]):
        token_start -= 1
    token_end = end
    while token_end < len(full_text) and not OCR_TOKEN_DELIMITERS.match(full_text[token_end]):
        token_end += 1
    raw_token = full_text[token_start:token_end]
    if (
        ('[' in raw_token or ']' in raw_token)
        and ASCII_LETTER_REGEX.search(raw_token)
        and GREEK_OR_HEBREW_REGEX.search(raw_token)
    ):
        return raw_token[:160]
    return None


def collect_foreign_matches(full_text, regex):
    """Collect matches plus any raw mixed-script OCR evidence around them."""
    matches = []
    editorial = collect_editorial_words(full_text)
    matches.extend((expanded, None) for _start, _end, _printed, expanded in editorial)
    for start, end, surface in iter_complete_word_tokens(full_text):
        if any(editorial_start <= start < editorial_end for editorial_start, editorial_end, _printed, _expanded in editorial):
            continue
        if not regex.search(surface):
            continue
        matches.append((surface, get_ocr_suspect_evidence(full_text, start, end)))
    return matches


def collect_editorial_words(text):
    """Keep same-script internal editorial letters in one pronunciation candidate.

    Retain original offsets/spelling for context; do not alter the source PDF.
    Whole phrases, alternatives and mixed-script expansions are not joined.
    """
    results = []
    for script in (r"\u0370-\u03FF\u1F00-\u1FFF", r"\u0590-\u05FF"):
        letters = f"[{script}\\u0300-\\u036F]"
        pattern = re.compile(rf"{letters}+(?:\({letters}+\){letters}*)+")
        for match in pattern.finditer(text):
            if (
                (match.start() > 0 and text[match.start() - 1].isalpha())
                or (match.end() < len(text) and text[match.end()].isalpha())
            ):
                continue
            printed = match.group(0)
            if any(character not in '()' and unicodedata.category(character)[0] not in 'LM' for character in printed):
                continue
            results.append((match.start(), match.end(), printed, printed.replace('(', '').replace(')', '')))
    return results


def classify_automatic_ocr_ignore(word):
    """Identify extraction artifacts that are unsafe to send to the dictionary."""
    if GREEK_ELISION_REGEX.fullmatch(word):
        return "single-letter Greek elision"
    if GREEK_REGEX.search(word) and HEBREW_REGEX.search(word):
        return "adjacent Hebrew and Greek text without a separator"
    if word.endswith('σ'):
        return "Greek OCR fragment ending in non-final sigma"
    return None


class ExtractedPdfText(str):
    """Keep page offsets attached to the legacy flattened-text interface."""

    def __new__(cls, text, page_spans, extraction_method):
        value = super().__new__(cls, text)
        value.page_spans = page_spans
        value.extraction_method = extraction_method
        return value


def target_centered_context(text, start, end, page_start=0, page_end=None, max_chars=1000):
    """Return a wrapped-line-normalized context that always retains the target."""
    page_end = len(text) if page_end is None else page_end
    left = max(page_start, start - max_chars // 2)
    right = min(page_end, end + max_chars // 2)
    # A sentence boundary is preferable when it does not hide nearby glosses.
    prefix = text[left:start]
    sentence_starts = [match.end() for match in re.finditer(r'[.!?]\s+', prefix)]
    if sentence_starts and start - (left + sentence_starts[-1]) <= max_chars // 2:
        left += sentence_starts[-1]
    suffix = text[end:right]
    sentence_end = re.search(r'[.!?](?:\s|$)', suffix)
    if sentence_end:
        right = end + sentence_end.start() + 1

    def collapse(value):
        return re.sub(r'\s+', ' ', value).strip()

    before = collapse(text[left:start])
    target = collapse(text[start:end])
    after = collapse(text[end:right])
    context = ' '.join(part for part in (before, target, after) if part)
    target_start = len(before) + (1 if before else 0)
    return context, target_start, target_start + len(target)

def load_pdf_text(pdf_path):
    """Extract text from a PDF file using pypdf or PyMuPDF if available."""
    try:
        import pypdf
        reader = pypdf.PdfReader(pdf_path)
        text = ""
        page_spans = []
        for page_number, page in enumerate(reader.pages, start=1):
            t = page.extract_text()
            if t:
                start = len(text)
                text += t + "\n"
                page_spans.append((start, len(text), page_number))
        if text.strip():
            return ExtractedPdfText(text, page_spans, 'pypdf')
    except Exception:
        pass

    try:
        import fitz # PyMuPDF
        doc = fitz.open(pdf_path)
        text = ""
        page_spans = []
        for page_number, page in enumerate(doc, start=1):
            start = len(text)
            text += page.get_text() + "\n"
            page_spans.append((start, len(text), page_number))
        return ExtractedPdfText(text, page_spans, 'pymupdf')
    except Exception:
        pass

    raise RuntimeError("Please install pypdf or PyMuPDF (pymupdf) in your Python environment: pip install pypdf")

def fetch_global_pronunciations(sqlite_db_path="drizzle/sqlite.db"):
    """Query the adminSettings table for global pronunciations."""
    try:
        conn = sqlite3.connect(sqlite_db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT valueJson FROM adminSettings WHERE key = 'global_pronunciations'")
        row = cursor.fetchone()
        conn.close()
        if row and row[0]:
            data = json.loads(row[0])
            result = {}
            for k, v in data.items():
                if isinstance(v, list):
                    result[k] = v
                elif isinstance(v, str):
                    result[k] = [v]
            return result
    except Exception as e:
        sys.stderr.write(f"Warning: Could not read global_pronunciations from DB ({e})\n")
    return {}

def scan_pdf_foreign_words(pdf_path, db_path="drizzle/sqlite.db", target_percentile=80.0, mode="all_foreign", query=None, quiet=False):
    if not quiet:
        print(f"Reading PDF text from: {pdf_path} (Mode: {mode}, Target: {target_percentile}%)...")
    full_text = load_pdf_text(pdf_path)
    editorial_words = collect_editorial_words(full_text)

    ocr_suspect_evidence = {}
    latin_transliteration_candidates = set()
    occurrences_by_word = {}
    editorial_by_start = {start: (end, printed, expanded) for start, end, printed, expanded in editorial_words}
    editorial_spans = [(start, end) for start, end, _printed, _expanded in editorial_words]
    tokens = (
        ((match.start(), match.end(), match.group(0), None) for match in re.finditer(re.escape(query), full_text, re.IGNORECASE))
        if mode == 'custom' and query
        else ((start, end, surface, None) for start, end, surface in iter_complete_word_tokens(full_text))
    )

    def add_occurrence(word, start, end, surface):
        occurrences_by_word.setdefault(word, []).append({
            'start': start, 'end': end, 'surfaceTerm': surface,
        })
        evidence = get_ocr_suspect_evidence(full_text, start, end)
        if evidence:
            ocr_suspect_evidence.setdefault(word, set()).add(evidence)

    for start, end, surface, _unused in tokens:
        if any(editorial_start <= start < editorial_end for editorial_start, editorial_end in editorial_spans):
            continue
        word = surface.strip('.,;:!?·\'"()[]{}«»')
        if not word:
            continue
        if mode == 'fantasy_litrpg':
            accepted = bool(FANTASY_LITRPG_REGEX.fullmatch(word)) and is_fantasy_litrpg_candidate(word)
        elif mode == 'greek_hebrew':
            biblical_script = bool(GREEK_OR_HEBREW_REGEX.search(word))
            transliteration = not biblical_script and is_latin_transliteration_candidate(word)
            accepted = biblical_script or transliteration
            if transliteration:
                latin_transliteration_candidates.add(word)
        elif mode == 'custom':
            accepted = True
        else:
            accepted = has_foreign_marker(word)
        if not accepted:
            continue
        if mode in ('greek_hebrew', 'all_foreign') and (
            len(word) <= 1
            or normalize_foreign_term_for_fuzzy_match(word) in STOP_WORDS_FOLDED
            or word in KNOWN_OCR_FRAGMENTS
        ):
            continue
        add_occurrence(word, start, end, surface)

    for start, (end, printed, expanded) in editorial_by_start.items():
        if mode == 'fantasy_litrpg' or mode == 'custom':
            continue
        if mode == 'greek_hebrew' and not GREEK_OR_HEBREW_REGEX.search(expanded):
            continue
        if len(expanded) <= 1 or normalize_foreign_term_for_fuzzy_match(expanded) in STOP_WORDS_FOLDED:
            continue
        add_occurrence(expanded, start, end, printed)

    filtered_matches = [word for word, occurrences in occurrences_by_word.items() for _ in occurrences]

    if not filtered_matches:
        if not quiet:
            print("No significant matching terms found in the document.")
        return []

    counts = Counter(filtered_matches)
    total_occurrences = sum(counts.values())

    global_dict = fetch_global_pronunciations(db_path)

    def is_similar(aa, bb):
        if not aa or not bb: return False
        if aa == bb: return True
        if len(aa) > 3 and aa in bb: return True
        if len(bb) > 3 and bb in aa: return True
        if len(aa) < 4 or abs(len(aa) - len(bb)) > 2: return False

        v0 = list(range(len(aa) + 1))
        v1 = [0] * (len(aa) + 1)
        for i in range(len(bb)):
            v1[0] = i + 1
            for j in range(len(aa)):
                cost = 0 if aa[j] == bb[i] else 1
                v1[j + 1] = min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost)
            for j in range(len(aa) + 1):
                v0[j] = v1[j]
        return v0[len(aa)] <= 2

    unique_words = list(counts.keys())
    unique_words_lower = [normalize_foreign_term_for_fuzzy_match(w) for w in unique_words]
    
    PRONOUNS_AND_ARTICLES = {
        "the", "a", "an", "this", "that", "these", "those",
        "i", "me", "my", "mine", "we", "us", "our", "ours",
        "you", "your", "yours", "he", "him", "his",
        "she", "her", "hers", "it", "its",
        "they", "them", "their", "theirs",
        "who", "whom", "whose", "which", "what"
    }

    # Anchor each group on its most frequent unassigned spelling. Members must
    # match that anchor directly; do not union A~B and B~C into an A~C chain.
    # A small cap is a final guard against a very broad OCR neighborhood
    # dominating the priority list.
    normalized_by_word = dict(zip(unique_words, unique_words_lower))
    ordered_anchors = sorted(
        unique_words,
        key=lambda word: (-counts[word], word.casefold()),
    )
    assigned_words = set()
    groups = []
    for anchor in ordered_anchors:
        if anchor in assigned_words:
            continue
        direct_matches = [
            word for word in ordered_anchors
            if word not in assigned_words
            and is_similar(normalized_by_word[anchor], normalized_by_word[word])
        ][:MAX_FUZZY_GROUP_VARIANTS]
        assigned_words.update(direct_matches)
        groups.append(direct_matches)
        
    word_sort_weight = {}
    fuzzy_group_metadata = {}
    for members in groups:
        group_sum = sum(counts[m] for m in members)
        # Deflate if any member of the group is a pronoun or article
        is_deflated = any(m.lower() in PRONOUNS_AND_ARTICLES for m in members)
        effective_group_sum = (group_sum / 10000.0) if is_deflated else group_sum
        
        for m in members:
            effective_indiv_count = (counts[m] / 10000.0) if m.lower() in PRONOUNS_AND_ARTICLES else counts[m]
            word_sort_weight[m] = (effective_group_sum, effective_indiv_count, counts[m])
            fuzzy_group_metadata[m] = {
                "fuzzyGroupCount": group_sum,
                "fuzzyGroupVariants": sorted(
                    members,
                    key=lambda variant: (-counts[variant], variant.casefold()),
                ),
            }

    sorted_unique_words = sorted(unique_words, key=lambda w: word_sort_weight[w], reverse=True)

    # Calculate cumulative percentage coverage threshold
    target_count = (target_percentile / 100.0) * total_occurrences
    cumulative = 0
    top_words = []

    for word in sorted_unique_words:
        freq = counts[word]
        cumulative += freq
        top_words.append((word, freq))
        if cumulative >= target_count:
            break

    if not quiet:
        print(f"\nFound {len(unique_words)} unique terms ({total_occurrences} total occurrences).")
        print(f"Target {target_percentile:.0f}% cumulative frequency consists of {len(top_words)} unique words.\n")

    results = []
    page_spans = getattr(full_text, 'page_spans', [(0, len(full_text), 1)])
    page_starts = [start for start, _end, _number in page_spans]
    for word, freq in top_words:
        pct = (freq / total_occurrences) * 100
        pronunciations = global_dict.get(word, ["No global pronunciation recorded yet"])
        contexts = []
        selected_occurrences = []
        editorial_spellings = sorted({
            printed for _start, _end, printed, expanded in editorial_words
            if expanded.casefold() == word.casefold()
        })
        for occurrence in occurrences_by_word[word]:
            source_start = occurrence['start']
            source_end = occurrence['end']
            page_index = max(0, bisect_right(page_starts, source_start) - 1)
            page_start, page_end, pdf_page = page_spans[page_index]
            context, target_start, target_end = target_centered_context(
                full_text, source_start, source_end, page_start, page_end,
            )
            if not context or context in contexts:
                continue
            contexts.append(context)
            selected_occurrences.append({
                'surfaceTerm': occurrence['surfaceTerm'],
                'normalizedTerm': unicodedata.normalize('NFC', word),
                'pdfPage': pdf_page,
                'sourceStart': source_start,
                'sourceEnd': source_end,
                'context': context,
                'contextTargetStart': target_start,
                'contextTargetEnd': target_end,
                'extractionMethod': getattr(full_text, 'extraction_method', 'provided-text'),
            })
            if len(selected_occurrences) >= 2:
                break
        result = {
            "word": word,
            "count": freq,
            **fuzzy_group_metadata[word],
            "percentage": round(pct, 2),
            "pronunciations": pronunciations,
            "contexts": contexts,
            "occurrences": selected_occurrences,
        }
        if editorial_spellings:
            result["editorialSpellings"] = sorted(set(editorial_spellings))
        automatic_ignore_reason = classify_automatic_ocr_ignore(word)
        if automatic_ignore_reason:
            result["ocrFragment"] = True
            result["automaticIgnoreReason"] = automatic_ignore_reason
        if word in ocr_suspect_evidence:
            result["ocrSuspect"] = True
            result["ocrEvidence"] = sorted(ocr_suspect_evidence[word])[:2]
        if word in latin_transliteration_candidates:
            result["latinTransliterationCandidate"] = True
        results.append(result)

    return results

def main():
    parser = argparse.ArgumentParser(description="Scan PDF for foreign words / LitRPG terms and output frequencies.")
    parser.add_argument("pdf_path", nargs="?", help="Path to the PDF file")
    parser.add_argument("--db", default="drizzle/sqlite.db", help="Path to SQLite database")
    parser.add_argument("--target", type=float, default=80.0, help="Target percentage threshold (80.0 or 100.0)")
    parser.add_argument("--mode", default="all_foreign", choices=["all_foreign", "fantasy_litrpg", "greek_hebrew", "custom"], help="Scanning mode")
    parser.add_argument("--query", default=None, help="Custom search query term")
    parser.add_argument("--json", action="store_true", help="Output raw JSON format")
    parser.add_argument("--classify-english-json", default=None, help="Classify words from a JSON file for admin cleanup")

    args = parser.parse_args()

    if args.classify_english_json:
        with open(args.classify_english_json, "r", encoding="utf-8") as source:
            words = json.load(source)
        if not isinstance(words, list):
            raise ValueError("English cleanup input must be a JSON array.")
        print(json.dumps(classify_standard_english_words(words), ensure_ascii=False))
        return
    if not args.pdf_path:
        parser.error("pdf_path is required unless --classify-english-json is used")

    results = scan_pdf_foreign_words(args.pdf_path, args.db, args.target, mode=args.mode, query=args.query, quiet=args.json)

    if args.json:
        print(json.dumps(results, indent=2, ensure_ascii=False))
    else:
        print(f"{'WORD':<20} | {'COUNT':<6} | {'GLOBAL PRONUNCIATION(S)'}")
        print("-" * 65)
        for r in results:
            pron_str = ", ".join(r['pronunciations']) if isinstance(r['pronunciations'], list) else str(r['pronunciations'])
            print(f"{r['word']:<20} | {r['count']:<6} | {pron_str}")

if __name__ == "__main__":
    main()
