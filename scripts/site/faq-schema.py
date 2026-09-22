#!/usr/bin/env python3
"""Generate and verify the FAQPage structured data on uchiyomi.com/faq from the page's own markup.

Google's FAQPage rules are simple and easy to break later: every question and its FULL answer must be
visible on the page, verbatim. Hand-maintaining a JSON-LD block beside the HTML guarantees that one day
somebody trims a paragraph and the structured data starts quoting text that is no longer there.

So the HTML is the source and this derives the block from it:

    python3 scripts/site/faq-schema.py /opt/compose/koryomi/site/faq.html            # verify (exit 1 on drift)
    python3 scripts/site/faq-schema.py /opt/compose/koryomi/site/faq.html --write    # regenerate in place

Paragraphs marked `data-live` are skipped: they are filled by nginx SSI at request time, so their text is
not fixed and must not be quoted as an answer.

The site is not in git, so this lives here, where it is versioned, rather than beside the page it checks.
"""
import json
import re
import sys
from html.parser import HTMLParser

MARK = ('<script type="application/ld+json" id="faq-schema">', '</script>')


class Faq(HTMLParser):
    """Collect (question, answer) from every `div.faq-q`: its h3, then its non-live paragraphs."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.pairs, self.depth, self.mode, self.buf, self.q, self.answers = [], 0, None, [], None, []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'div' and 'faq-q' in (a.get('class') or ''):
            self.depth, self.q, self.answers = 1, None, []
        elif self.depth:
            if tag == 'div':
                self.depth += 1
            elif tag == 'h3':
                self.mode, self.buf = 'q', []
            elif tag == 'p' and 'data-live' not in a:
                self.mode, self.buf = 'a', []

    def handle_endtag(self, tag):
        if not self.depth:
            return
        if tag in ('h3', 'p') and self.mode:
            text = re.sub(r'\s+', ' ', ''.join(self.buf)).strip()
            if self.mode == 'q':
                self.q = text
            elif text:
                self.answers.append(text)
            self.mode, self.buf = None, []
        elif tag == 'div':
            self.depth -= 1
            if self.depth == 0 and self.q and self.answers:
                self.pairs.append((self.q, ' '.join(self.answers)))

    def handle_data(self, data):
        if self.mode:
            self.buf.append(data)


def build(html: str) -> str:
    p = Faq()
    p.feed(html)
    if len(p.pairs) < 10:
        sys.exit(f'only {len(p.pairs)} question(s) found — the markup shape changed')
    doc = {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        '@id': 'https://uchiyomi.com/faq#faq',
        'inLanguage': 'en-GB',
        'mainEntity': [
            {'@type': 'Question', 'name': q,
             'acceptedAnswer': {'@type': 'Answer', 'text': a}}
            for q, a in p.pairs
        ],
    }
    return json.dumps(doc, ensure_ascii=False, indent=1)


def main() -> int:
    path = sys.argv[1]
    write = '--write' in sys.argv[2:]
    html = open(path, encoding='utf-8').read()
    want = build(html)

    start = html.find(MARK[0])
    if start < 0:
        sys.exit(f'{path}: no <script ... id="faq-schema"> block to fill')
    end = html.index(MARK[1], start)
    have = html[start + len(MARK[0]):end].strip()

    if write:
        open(path, 'w', encoding='utf-8').write(html[:start + len(MARK[0])] + '\n' + want + '\n' + html[end:])
        print(f'{path}: wrote {len(json.loads(want)["mainEntity"])} questions')
        return 0

    if have != want:
        print(f'{path}: the FAQ structured data no longer matches the page.', file=sys.stderr)
        print('Re-run with --write, then look at the diff before publishing.', file=sys.stderr)
        return 1
    print(f'{path}: {len(json.loads(want)["mainEntity"])} questions, structured data matches the page')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
