#!/usr/bin/env python3
"""Allocate a native build number; supply --build to reproduce an existing candidate."""
import argparse

from build_number import choose_build

parser = argparse.ArgumentParser(description=__doc__)
choice = parser.add_mutually_exclusive_group()
choice.add_argument('--build')
choice.add_argument('--timestamp', help='Immutable UTC run-created timestamp for reproducible hosted reruns')
args = parser.parse_args()
try:
    print(choose_build(args.build, args.timestamp))
except ValueError as error:
    parser.error(str(error))
