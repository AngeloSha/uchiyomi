#!/usr/bin/env python3
"""Build the optional local extractor from an unmodified, pinned Hi-SAM checkout; never push an image."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

REVISION = '69009434d4dba5541f228d8f5acb0754c333d417'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hi-sam-dir', type=Path, required=True)
    parser.add_argument('--tag', required=True)
    args = parser.parse_args()
    source = args.hi_sam_dir.resolve()
    if subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip() != REVISION:
        raise ValueError('Hi-SAM source revision mismatch')
    if subprocess.check_output(['git', '-C', str(source), 'diff', 'HEAD', '--'], text=True).strip():
        raise ValueError('Hi-SAM source has tracked changes')
    directory = Path(__file__).resolve().parents[2] / 'services/title-extractor'
    repository = directory.parents[1]
    revision = subprocess.check_output(['git', '-C', str(repository), 'rev-parse', 'HEAD'], text=True).strip()
    version = json.loads((repository / 'bff/package.json').read_text())['version']
    with tempfile.TemporaryDirectory(prefix='uchiyomi-title-extractor-build-') as stage:
        context = Path(stage)
        for name in ['worker.py', 'server.py', 'requirements.txt', 'Dockerfile']:
            shutil.copyfile(directory / name, context / name)
        subprocess.run(['git', '-C', str(source), 'archive', '--format=tar', '-o', str(context / 'hi-sam.tar'), REVISION], check=True)
        subprocess.run(['docker', 'build', '-t', args.tag, '--label', 'org.uchiyomi.hi-sam-revision=' + REVISION,
            '--label', 'org.opencontainers.image.revision=' + revision, '--label', 'org.opencontainers.image.version=' + version,
            str(context)], check=True)


if __name__ == '__main__':
    main()
