"""Portable numbering/runtime selection checks; these do not execute WebKit."""
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT/'ios/scripts'))
from build_number import automatic_build, choose_build, LEGACY_BUILD_FLOOR
from simulator_runtime import select_runtime


class BuildNumberTests(unittest.TestCase):
    def test_automatic_sequence_exceeds_installed_builds_and_reruns_are_stable(self):
        timestamp = '2026-11-11T01:02:03Z'
        self.assertEqual(automatic_build(timestamp), str(LEGACY_BUILD_FLOOR + 3723))
        self.assertEqual(automatic_build(timestamp), automatic_build(timestamp))
        self.assertGreater(int(automatic_build('2026-11-11T01:02:04Z')), int(automatic_build(timestamp)))

    def test_explicit_builds_preserve_historical_reproduction(self):
        self.assertEqual(choose_build('1001'), '1001')
        self.assertEqual(choose_build('2026111104'), '2026111104')
        with self.assertRaises(ValueError):
            choose_build('1001', '2026-11-11T01:02:03Z')

    def test_automatic_allocation_rejects_pre_epoch_and_untrusted_time_formats(self):
        for value in ['2026-11-10T23:59:59Z', '2026-11-11T00:00:00Z', '2026-11-11T01:00:00+01:00',
                      '2026-11-11', '2026-99-99T01:00:00Z', '2026-11-11T01:00:00Z\n']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                automatic_build(value)

    def test_cli_retains_exact_build_and_fails_closed_on_invalid_values(self):
        script = str(ROOT/'ios/scripts/build-number.py')
        result = subprocess.run([sys.executable, script, '--timestamp', '2026-11-11T00:00:01Z'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), str(LEGACY_BUILD_FLOOR+1))
        for value in ['0', '01', '-1', '1.2', '1;echo unsafe']:
            with self.subTest(value=value):
                self.assertNotEqual(subprocess.run([sys.executable, script, '--build', value], capture_output=True).returncode, 0)


class SimulatorRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.device = 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo'
        self.runtime = {'identifier': 'com.apple.CoreSimulator.SimRuntime.iOS-27-2-fixture', 'version': '27.2',
                        'buildversion': '24B91016s', 'isAvailable': True,
                        'supportedDeviceTypes': [{'identifier': self.device}]}
        self.runtimes = {'runtimes': [self.runtime]}

    def select(self, **options):
        return select_runtime(self.runtimes, '27.2', self.device, **options)

    def test_exact_build_wins_over_same_version_in_enumeration_order(self):
        older = dict(self.runtime, identifier='com.apple.CoreSimulator.SimRuntime.iOS-27-2-other', buildversion='24B000')
        self.runtimes['runtimes'].insert(0, older)
        self.assertEqual(self.select(build='24B91016s'), self.runtime['identifier'])
        with self.assertRaisesRegex(ValueError, 'Multiple'):
            self.select()

    def test_missing_build_unavailable_unsupported_device_and_wrong_sdk_fail(self):
        for change in [dict(buildversion='24B000'), dict(isAvailable=False), dict(supportedDeviceTypes=[]), dict(version='27.1')]:
            self.runtimes = {'runtimes': [dict(self.runtime, **change)]}
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.select(build='24B91016s')

    def test_explicit_simulator_also_requires_pinned_runtime_and_device(self):
        device = {'udid': 'fixture-device', 'isAvailable': True, 'deviceTypeIdentifier': self.device}
        devices = {'devices': {self.runtime['identifier']: [device]}}
        self.assertEqual(self.select(build='24B91016s', devices=devices, simulator='fixture-device'), self.runtime['identifier'])
        for change in [dict(isAvailable=False), dict(deviceTypeIdentifier='other'), dict(udid='other')]:
            invalid = {'devices': {self.runtime['identifier']: [dict(device, **change)]}}
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.select(build='24B91016s', devices=invalid, simulator='fixture-device')
        with self.assertRaises(ValueError):
            self.select(build='24B000', devices=devices, simulator='fixture-device')


if __name__ == '__main__':
    unittest.main()
