#!/usr/bin/env python3
"""Inspect a just-packaged archive. Development mode remains the default."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib

from release_lib import artifact_name, inspect_payload, require, require_full_display_sdk, verify_ipa

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', type=Path)
parser.add_argument('--mode', choices=['development', 'altstore'], default='development')
args = parser.parse_args()
output = args.output.resolve()
ipa = output / 'Uchiyomi.ipa'
entitlements = plistlib.loads((output / 'entitlements.plist').read_bytes())
source = json.loads((output / 'source.json').read_text())
info, privacy, names = inspect_payload(ipa)
require_full_display_sdk(info)
bundle = info['CFBundleIdentifier']
profile = None
if args.mode == 'development':
    profile = plistlib.loads((output / 'provisioning.plist').read_bytes())
    require('Payload/Uchiyomi.app/embedded.mobileprovision' in names, 'Missing development profile')
    require(entitlements['application-identifier'].endswith('.' + bundle), 'Signing bundle mismatch')
    require(entitlements['com.apple.developer.team-identifier'] in profile['TeamIdentifier'], 'Signing team mismatch')
    require(profile['ExpirationDate'] > datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None), 'Expired profile')
else:
    require(entitlements == {}, 'Unexpected AltStore entitlements')
    require('Signature=adhoc' in (output / 'signature.txt').read_text(), 'Expected an ad-hoc signature')
    require(not any(name.endswith('.mobileprovision') for name in names), 'Personal provisioning profile in IPA')
    ipa = ipa.rename(output / artifact_name(info['CFBundleShortVersionString'], info['CFBundleVersion']))

report = {
    'artifact': ipa.name, 'distribution': args.mode,
    'sha256': hashlib.sha256(ipa.read_bytes()).hexdigest(), 'size': ipa.stat().st_size,
    'version': info['CFBundleShortVersionString'], 'build': info['CFBundleVersion'],
    'bundleIdentifier': bundle, 'applicationIdentifier': entitlements.get('application-identifier'),
    'teamIdentifier': entitlements.get('com.apple.developer.team-identifier'),
    'minimumIOS': info['MinimumOSVersion'], 'protocolVersion': 1, 'offlineSchemaVersion': 2,
    'buildSDK': info['DTSDKName'], 'buildSDKBuild': info['DTSDKBuild'], 'xcodeBuild': info['DTXcodeBuild'],
    'sourceRevision': source['revision'], 'sourceDirty': source['dirty'], 'sourceSha256': source['sourceSha256'],
    'createdUTC': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
    'provisioningExpiresUTC': profile['ExpirationDate'].isoformat() + 'Z' if profile else None,
    'provisionedDeviceCount': len(profile.get('ProvisionedDevices', [])) if profile else 0,
    'entitlements': entitlements, 'privacyPermissions': privacy,
    'physicalDeviceVerified': False, 'altStoreVerified': False,
    'notes': 'Candidate. Earlier device results do not verify this build. AltStore replaces the signature; inspect its effective identity and expiration.'
}
if args.mode == 'altstore':
    report['releaseTag'] = os.environ.get('UCHI_RELEASE_TAG', f"ios-v{report['version']}-beta.{report['build']}")
    verify_ipa(ipa, report)
(output / 'release.json').write_text(json.dumps(report, indent=2) + '\n')
(output / 'SHA256SUMS').write_text(f"{report['sha256']}  {ipa.name}\n")
print(json.dumps({key: report[key] for key in ['artifact', 'distribution', 'version', 'build', 'bundleIdentifier', 'sha256', 'provisioningExpiresUTC']}, indent=2))
