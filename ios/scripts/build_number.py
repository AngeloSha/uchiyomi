"""Shared native build allocation for Linux and hosted Xcode candidates.

Explicit numbers allow exact historical reproduction. New automatic numbers use an
anchored UTC clock above the private beta sequence that already reached devices.
Publication separately refuses regressions and conflicting immutable identities.
"""
import datetime as dt
import re

LEGACY_BUILD_FLOOR = 2026111104
BUILD_EPOCH = dt.datetime(2026, 11, 11, tzinfo=dt.timezone.utc)


def explicit_build(value):
    if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]{0,15}', value):
        raise ValueError('Use a positive integer build number of at most 16 digits')
    return value


def automatic_build(timestamp=None):
    if timestamp is None:
        instant = dt.datetime.now(dt.timezone.utc)
    else:
        if not isinstance(timestamp, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z', timestamp):
            raise ValueError('Use an explicit UTC ISO build timestamp')
        instant = dt.datetime.fromisoformat(timestamp[:-1] + '+00:00')
    seconds = int((instant - BUILD_EPOCH).total_seconds())
    if seconds <= 0:
        raise ValueError('Automatic build timestamps must be after the build-sequence epoch')
    return explicit_build(str(LEGACY_BUILD_FLOOR + seconds))


def choose_build(value=None, timestamp=None):
    if value is not None:
        if timestamp is not None:
            raise ValueError('Choose an explicit build number or an allocation timestamp')
        return explicit_build(value)
    return automatic_build(timestamp)
