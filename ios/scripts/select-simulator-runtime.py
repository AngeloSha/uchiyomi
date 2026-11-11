#!/usr/bin/env python3
"""Portable simctl JSON selector, including validation of explicit simulator IDs."""
import argparse
import json
from pathlib import Path
from simulator_runtime import select_runtime

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--runtimes', required=True, type=Path)
parser.add_argument('--sdk', required=True)
parser.add_argument('--device-type', required=True)
parser.add_argument('--build')
parser.add_argument('--devices', type=Path)
parser.add_argument('--simulator')
args = parser.parse_args()
try:
    print(select_runtime(json.loads(args.runtimes.read_text()), args.sdk, args.device_type,
                         build=args.build, simulator=args.simulator,
                         devices=json.loads(args.devices.read_text()) if args.devices else None))
except ValueError as error:
    parser.error(str(error))
