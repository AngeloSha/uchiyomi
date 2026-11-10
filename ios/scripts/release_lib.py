"""Shared IPA inspection and AltStore source rules; standard library only."""
import datetime as dt
import hashlib
import plistlib
import re
import zipfile
from pathlib import PurePosixPath
from urllib.parse import urlsplit

VERSION = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
TAG = re.compile(rf"ios-v({VERSION})(?:-beta\.[1-9][0-9]*)?")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def tag_version(tag):
    match = TAG.fullmatch(tag)
    require(match is not None, "Use ios-vMAJOR.MINOR.PATCH, optionally followed by -beta.N")
    return match[1]


def https_url(value):
    parts = urlsplit(value)
    require(parts.scheme == "https" and parts.netloc and not parts.username and not parts.password
            and not parts.query and not parts.fragment, f"Expected a public HTTPS URL: {value}")
    return value.rstrip("/")


def repository_name(value):
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value) is not None, "Expected OWNER/REPOSITORY")
    return value


def inspect_payload(ipa):
    with zipfile.ZipFile(ipa) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), "Duplicate ZIP entries")
        require(archive.testzip() is None, "Corrupt IPA ZIP")
        for name in names:
            path = PurePosixPath(name)
            require(not path.is_absolute() and ".." not in path.parts and "\\" not in name, "Unsafe IPA path")
            require(name == "Payload/" or name.startswith("Payload/Uchiyomi.app/"), "Unexpected app payload")
            require(not any(part.endswith((".xctest", ".appex")) for part in path.parts), "Test bundle/extension requires a packaging review")
            require(path.name != "mobile-assets.json", "Web UI must not be bundled")
        info = plistlib.loads(archive.read("Payload/Uchiyomi.app/Info.plist"))
        require(info["CFBundleSupportedPlatforms"] == ["iPhoneOS"], "Not a physical-device build")
        require(info["WKAppBoundDomains"] == ["localhost"], "Unexpected app-bound domains")
        require(info["NSAppTransportSecurity"] == {"NSAllowsLocalNetworking": True}, "Unexpected transport policy")
        require("AppIcon" in info["CFBundleIcons"]["CFBundlePrimaryIcon"]["CFBundleIconName"], "Missing app icon")
        require("Payload/Uchiyomi.app/" + info["CFBundleExecutable"] in names, "Missing executable")
        privacy = {k: v for k, v in info.items() if re.fullmatch(r"NS.+UsageDescription.*", k)}
        require(all(isinstance(v, str) and v for v in privacy.values()), "Invalid privacy description")
        return info, privacy, names


def artifact_name(version, build):
    require(re.fullmatch(VERSION, version) is not None, "Expected a numeric three-component version")
    require(re.fullmatch(r"[1-9][0-9]*", build) is not None, "Expected a positive integer build number")
    return f"Uchiyomi-{version}-{build}.ipa"


def require_full_display_sdk(info):
    # New packages must opt into Duo's full display through the actual build SDK.
    # Keep historical IPAs readable by applying this only during packaging.
    sdk = re.fullmatch(r"iphoneos([0-9]+)\.([0-9]+)(?:\.[0-9]+)?", info.get('DTSDKName', ''))
    require(sdk is not None and (int(sdk[1]), int(sdk[2])) >= (27, 1),
            'Build with the iOS 27.1 SDK or later to support the full iPhone Duo display')


def validate_record(record, publication=False):
    require(record["distribution"] == "altstore", "Public source requires an AltStore package")
    require(record["artifact"] == artifact_name(record["version"], record["build"]), "Unexpected artifact name")
    require(tag_version(record["releaseTag"]) == record["version"], "Tag and native version differ")
    require(re.fullmatch(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", record["bundleIdentifier"]) is not None, "Invalid bundle ID")
    require(re.fullmatch(r"[0-9a-f]{64}", record["sha256"]) is not None, "Invalid IPA checksum")
    require(type(record["size"]) is int and record["size"] > 0, "Invalid IPA size")
    require(re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,2}", record["minimumIOS"]) is not None, "Invalid minimum iOS")
    require(record["entitlements"] == {}, "AltStore package must have no personal signing entitlements")
    require(not record.get("teamIdentifier") and not record.get("applicationIdentifier")
            and not record.get("provisioningExpiresUTC"), "Personal signing data in public package")
    require(type(record["privacyPermissions"]) is dict and all(
        re.fullmatch(r"NS.+UsageDescription.*", k) and isinstance(v, str) and v
        for k, v in record["privacyPermissions"].items()), "Invalid privacy permissions")
    require(dt.datetime.fromisoformat(record["createdUTC"].replace("Z", "+00:00")).utcoffset() is not None, "Release date must include timezone")
    require(re.fullmatch(r"[0-9a-f]{40}", record["sourceRevision"]) is not None, "Invalid source revision")
    require(re.fullmatch(r"[0-9a-f]{64}", record["sourceSha256"]) is not None, "Invalid source fingerprint")
    if publication:
        require(record["sourceDirty"] is False, "Publish only a clean tagged checkout")
    return record


def verify_ipa(ipa, record):
    validate_record(record)
    require(ipa.stat().st_size == record["size"], "IPA size differs from metadata")
    require(hashlib.sha256(ipa.read_bytes()).hexdigest() == record["sha256"], "IPA checksum differs from metadata")
    info, privacy, names = inspect_payload(ipa)
    require(not any(name.endswith(".mobileprovision") for name in names), "Personal provisioning profile in AltStore package")
    for key, field in [("CFBundleIdentifier", "bundleIdentifier"), ("CFBundleShortVersionString", "version"),
                       ("CFBundleVersion", "build"), ("MinimumOSVersion", "minimumIOS")]:
        require(info[key] == record[field], f"IPA {key} differs from metadata")
    require(privacy == record["privacyPermissions"], "IPA privacy permissions differ from metadata")
    for key, field in [('DTSDKName', 'buildSDK'), ('DTSDKBuild', 'buildSDKBuild'), ('DTXcodeBuild', 'xcodeBuild')]:
        if field in record:
            require(info.get(key) == record[field], f'IPA {key} differs from metadata')


def download_url(repository, record):
    return f"https://github.com/{repository_name(repository)}/releases/download/{record['releaseTag']}/{record['artifact']}"


def source_date(value):
    # Use the documented whole-second ISO 8601 form, including for older source decoders.
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def make_source(records, listing, repository, base_url):
    repository_name(repository)
    base_url = https_url(base_url)
    require(bool(records), "No published iOS releases")
    unique = {}
    tags = set()
    for record in records:
        validate_record(record)
        require(record["bundleIdentifier"] == listing["bundleIdentifier"], "Release/listing bundle IDs differ")
        key = (record["version"], record["build"])
        if key in unique:
            require(unique[key] == record, "Conflicting records for the same version/build")
            continue
        require(record["releaseTag"] not in tags, "Multiple builds for the same immutable release tag")
        tags.add(record["releaseTag"])
        unique[key] = record
    ordered = sorted(unique.values(), key=lambda r: (*map(int, r["version"].split(".")), int(r["build"])), reverse=True)
    # Declare permissions for all retained versions. Prefer current wording for shared keys.
    privacy = {}
    for record in reversed(ordered):
        privacy.update(record["privacyPermissions"])
    versions = [{"version": r["version"], "buildVersion": r["build"], "date": source_date(r["createdUTC"]),
                 "downloadURL": download_url(repository, r), "size": r["size"], "sha256": r["sha256"],
                 "minOSVersion": r["minimumIOS"],
                 "localizedDescription": f"Beta native wrapper {r['version']} ({r['build']}). Release notes: https://github.com/{repository}/releases/tag/{r['releaseTag']}"}
                for r in ordered]
    app = {key: listing[key] for key in ["name", "bundleIdentifier", "developerName", "subtitle", "localizedDescription", "tintColor", "category"]}
    app.update(iconURL=base_url + "/icon.png", versions=versions,
               appPermissions={"entitlements": [], "privacy": privacy})
    return {"name": listing["sourceName"], "identifier": "io.github." + repository.lower().replace("/", ".") + ".ios.beta",
            "sourceURL": base_url + "/altstore.json", "subtitle": listing["subtitle"],
            "description": "Beta iOS releases for compatible self-hosted Uchiyomi servers.",
            "website": "https://github.com/" + repository, "iconURL": base_url + "/icon.png",
            "tintColor": listing["tintColor"], "nsfw": False, "apps": [app], "news": []}
