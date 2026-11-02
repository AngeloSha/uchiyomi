#!/usr/bin/env python3
"""Fetch and verify public iOS release assets before generating the source."""
import argparse
from pathlib import Path
from github_release import fetch_records
from release_lib import repository_name

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--repository', required=True, type=repository_name)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=False)
fetch_records(args.repository, args.output)
