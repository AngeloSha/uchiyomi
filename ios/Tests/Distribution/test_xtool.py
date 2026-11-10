"""Portable staging/IPA validation. These are not iPhone runtime or code-signing tests."""
import importlib.util
import json
from pathlib import Path
import plistlib
import shutil
import struct
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[3]
def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

prepare = module('prepare_xtool', ROOT / 'ios/scripts/prepare-xtool.py')
inspect = module('inspect_linux_ipa', ROOT / 'ios/scripts/inspect-linux-ipa.py')

class XtoolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='uchiyomi-xtool-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_adapter_copies_canonical_sources_and_keeps_xcode_settings(self):
        before = (ROOT / 'ios/Uchiyomi.xcodeproj/project.pbxproj').read_bytes()
        staged = self.root / 'app'
        record = prepare.prepare(staged, build='2026111002')
        info = plistlib.loads((staged / 'Info.plist').read_bytes())
        self.assertEqual(info['CFBundleIdentifier'], 'com.uchiyomi.reader')
        self.assertEqual(info['CFBundleVersion'], '2026111002')
        self.assertEqual(info['UIDeviceFamily'], [1, 2])
        self.assertEqual(info['WKAppBoundDomains'], ['localhost'])
        self.assertEqual(info['NSAppTransportSecurity'], {'NSAllowsLocalNetworking': True})
        self.assertEqual(info['MinimumOSVersion'], '17.0')
        self.assertNotIn('$(', repr(info))
        self.assertEqual(before, (ROOT / 'ios/Uchiyomi.xcodeproj/project.pbxproj').read_bytes())
        for subtree in ['Core', 'App']:
            originals = list((ROOT / 'ios/Sources' / subtree).rglob('*.swift'))
            self.assertTrue(originals)
            for file in originals:
                self.assertEqual(file.read_bytes(), (staged / 'Sources/Uchiyomi' / subtree / file.relative_to(ROOT / 'ios/Sources' / subtree)).read_bytes())
        self.assertTrue((staged / 'Sources/Uchiyomi/Resources/BrandMark.png').is_file())
        self.assertIn('iconPath: AppIcon.png', (staged / 'xtool.yml').read_text())
        self.assertIn('.library(name: "Uchiyomi"', (staged / 'Package.swift').read_text())
        self.assertNotIn('.executableTarget', (staged / 'Package.swift').read_text())
        self.assertIn('\"-platform_version\"', (staged / 'Package.swift').read_text())
        self.assertIn('\"27.2\"', (staged / 'Package.swift').read_text())
        self.assertEqual(record['iPhoneSDKVersion'], '27.2')
        self.assertEqual(record['xtoolVersion'], '1.24.0')
        self.assertFalse(record['published'])
        self.assertFalse(record['physicalDeviceVerified'])
        self.assertEqual(record['nativeProtocolVersion'], 2)
        self.assertEqual(record['nativeSourceSha256'], prepare.prepare(staged)['nativeSourceSha256'])

    def test_staging_rejects_unowned_output_and_invalid_versions(self):
        (self.root / 'personal').mkdir()
        (self.root / 'personal/keep').write_text('retain')
        with self.assertRaisesRegex(ValueError, 'not owned'):
            prepare.prepare(self.root / 'personal')
        self.assertEqual((self.root / 'personal/keep').read_text(), 'retain')
        for path in [ROOT, ROOT.parent, ROOT / 'ios', ROOT / 'ios/Sources/App']:
            with self.assertRaises(ValueError):
                prepare.prepare(path)
        for build in ['0', '-1', '12; echo x', '1.1', 'a', '1' * 20]:
            with self.assertRaises(ValueError):
                prepare.prepare(self.root / 'app', build=build)
        with self.assertRaises(ValueError):
            prepare.prepare(self.root / 'app', version='latest')
        for sdk in ['17.0', '27.0', 'latest', '27.2;unsafe']:
            with self.assertRaises(ValueError):
                prepare.prepare(self.root / 'app', sdk_version=sdk)

    def payload(self, *, platform=2, cpu=0x0100000c, extra=None, info_changes=None):
        staged = self.root / 'staged'
        prepare.prepare(staged)
        info = plistlib.loads((staged / 'Info.plist').read_bytes())
        info.update(info_changes or {})
        macho = struct.pack('<8I', 0xfeedfacf, cpu, 0, 2, 1, 24, 0, 0) + struct.pack('<6I', 0x32, 24, platform, 17 << 16, (27 << 16) + (2 << 8), 0)
        ipa = self.root / 'candidate.ipa'
        with zipfile.ZipFile(ipa, 'w') as archive:
            archive.writestr('Payload/Uchiyomi.app/Info.plist', plistlib.dumps(info))
            archive.writestr('Payload/Uchiyomi.app/Uchiyomi', macho)
            archive.writestr('Payload/Uchiyomi.app/AppIcon.png', b'test-only-icon')
            if extra:
                archive.writestr(*extra)
        return ipa

    def test_inspector_identifies_unsigned_device_candidate_honestly(self):
        record = inspect.inspect(self.payload())
        self.assertEqual(record['buildSDK'], [27, 2, 0])
        self.assertEqual(record['distribution'], 'unsigned-private-candidate')
        self.assertTrue(record['signingRequiredForInstall'])
        self.assertFalse(record['signatureVerified'])
        self.assertFalse(record['physicalDeviceVerified'])
        self.assertFalse(record['published'])

    def test_inspector_rejects_simulator_host_private_signing_and_wrong_transport(self):
        for opts in [dict(platform=7), dict(cpu=0x01000007), dict(extra=('Payload/Uchiyomi.app/embedded.mobileprovision', 'private')),
                     dict(extra=('Payload/Uchiyomi.app/mobile-assets.json', '{}')),
                     dict(extra=('../escape', 'unsafe')),
                     dict(info_changes={'NSAppTransportSecurity': {'NSAllowsArbitraryLoads': True}}),
                     dict(info_changes={'CFBundleSupportedPlatforms': ['iPhoneSimulator']})]:
            with self.assertRaises(ValueError):
                inspect.inspect(self.payload(**opts))

if __name__ == '__main__':
    unittest.main()
