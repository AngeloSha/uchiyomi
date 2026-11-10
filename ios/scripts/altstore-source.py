#!/usr/bin/env python3
"""Build an unpublished Pages directory from inspected release records."""
import argparse
import html
import json
from pathlib import Path
import shutil

from release_lib import make_source

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--records-dir', required=True, type=Path)
parser.add_argument('--repository', required=True, help='OWNER/REPOSITORY')
parser.add_argument('--base-url', required=True, help='HTTPS Pages base URL, including project path')
parser.add_argument('--listing', type=Path, default=root/'ios/distribution/listing.json')
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
records = [json.loads(path.read_text()) for path in sorted(args.records_dir.rglob('release.json'))]
source = make_source(records, json.loads(args.listing.read_text()), args.repository, args.base_url)
args.output.mkdir(parents=True, exist_ok=False)
(args.output/'altstore.json').write_text(json.dumps(source, indent=2)+'\n')
shutil.copyfile(root/'ios/Sources/App/Assets.xcassets/AppIcon.appiconset/AppIcon.png', args.output/'icon.png')
(args.output/'.nojekyll').touch()
(args.output/'index.html').write_text(
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
    '<title>Uchiyomi iOS Beta</title><h1>Uchiyomi iOS Beta</h1>'
    '<p>Add this <a href="altstore.json">source URL</a> to AltStore Classic.</p>'
    '<p>Requires a compatible Uchiyomi server with offline preparation support.</p>'
    f'<p><a href="{html.escape(source["website"], quote=True)}/releases">Releases and installation details</a></p></html>\n')
print(args.output/'altstore.json')
