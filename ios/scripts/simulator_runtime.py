"""Select the exact available iOS runtime supported by the requested device."""
import re


def select_runtime(runtimes, sdk, device_type, *, build=None, devices=None, simulator=None):
    if not re.fullmatch(r'[0-9]+\.[0-9]+(?:\.[0-9]+)?', sdk):
        raise ValueError('Invalid simulator SDK version')
    compatible = [runtime for runtime in runtimes['runtimes']
                  if runtime.get('isAvailable') and '.iOS-' in runtime['identifier']
                  and runtime['version'].split('.')[:2] == sdk.split('.')[:2]
                  and (not build or runtime.get('buildversion') == build)
                  and device_type in {item['identifier'] for item in runtime.get('supportedDeviceTypes', [])}]
    if simulator:
        selected = [(runtime, device) for runtime, entries in (devices or {}).get('devices', {}).items()
                    for device in entries if device.get('udid') == simulator]
        if len(selected) != 1:
            raise ValueError('Requested simulator is missing or ambiguous')
        identifier, device = selected[0]
        compatible = [runtime for runtime in compatible if runtime['identifier'] == identifier
                      and device.get('isAvailable') and device.get('deviceTypeIdentifier') == device_type]
    if not compatible:
        raise ValueError('Install an available iOS runtime matching the exact SDK, runtime build and device type')
    # Never depend on simctl enumeration order when several runtime builds exist.
    if len(compatible) != 1:
        raise ValueError('Multiple matching simulator runtimes; set UCHI_SIMULATOR_RUNTIME_BUILD')
    return compatible[0]['identifier']
