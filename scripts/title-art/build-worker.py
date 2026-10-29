#!/usr/bin/env python3
"""Stage or build the optional extractor from pinned source; never include weights or push an image."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

REVISION = '69009434d4dba5541f228d8f5acb0754c333d417'


def prepare_context(source, destination):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip() != REVISION:
        raise ValueError('Hi-SAM source revision mismatch')
    if subprocess.check_output(['git', '-C', str(source), 'diff', 'HEAD', '--'], text=True).strip():
        raise ValueError('Hi-SAM source has tracked changes')
    repository = Path(__file__).resolve().parents[2]
    directory = repository / 'services/title-extractor'
    # Never overwrite an existing checkout, data directory, or previous context.
    destination.mkdir(parents=True, exist_ok=False)
    try:
        for name in ['worker.py', 'server.py', 'sam_refinement.py', 'stroke_completion.py', 'requirements.txt', 'Dockerfile', 'NOTICE']:
            shutil.copyfile(directory / name, destination / name)
        shutil.copyfile(repository / 'LICENSE', destination / 'LICENSE')
        # git archive includes the upstream LICENSE and tracked source, never the operator's untracked checkpoints.
        subprocess.run(['git', '-C', str(source), 'archive', '--format=tar', '-o', str(destination / 'hi-sam.tar'), REVISION], check=True)
    except Exception:
        shutil.rmtree(destination)
        raise
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hi-sam-dir', type=Path, required=True)
    output = parser.add_mutually_exclusive_group(required=True)
    output.add_argument('--tag', help='Build a local Docker image with this tag.')
    output.add_argument('--prepare-context', type=Path, help='Create a new Docker context directory without building; used by CI/release.')
    args = parser.parse_args()
    if args.prepare_context:
        print(prepare_context(args.hi_sam_dir, args.prepare_context))
        return
    repository = Path(__file__).resolve().parents[2]
    revision = subprocess.check_output(['git', '-C', str(repository), 'rev-parse', 'HEAD'], text=True).strip()
    version = json.loads((repository / 'bff/package.json').read_text())['version']
    with tempfile.TemporaryDirectory(prefix='uchiyomi-title-extractor-build-') as stage:
        context = prepare_context(args.hi_sam_dir, Path(stage) / 'context')
        subprocess.run(['docker', 'build', '-t', args.tag, '--label', 'org.uchiyomi.hi-sam-revision=' + REVISION,
            '--label', 'org.opencontainers.image.revision=' + revision, '--label', 'org.opencontainers.image.version=' + version,
            str(context)], check=True)


if __name__ == '__main__':
    main()
