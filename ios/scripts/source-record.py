#!/usr/bin/env python3
"""Fingerprint the exact non-ignored working sources, including uncommitted wrapper files."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
def git(*args):
    return subprocess.check_output(['git', *args], cwd=root)

paths = set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').decode().split('\0')) - {''}
records = []
for path in sorted(paths):
    file = root / path
    if file.is_file():
        records.append({'path': path, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()})
encoded = json.dumps(records, separators=(',', ':'), ensure_ascii=False).encode()
json.dump({'revision': git('rev-parse', 'HEAD').decode().strip(),
           'dirty': bool(git('status', '--porcelain')),
           'sourceSha256': hashlib.sha256(encoded).hexdigest(), 'files': records}, sys.stdout, indent=2)
print()
