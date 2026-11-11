"""GitHub publication helpers. No Apple credentials; no overwriting release assets."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import urllib.request

from release_lib import download_url, require, tag_version, validate_record, verify_ipa
from build_number import LEGACY_BUILD_FLOOR


def require_publication_progress(candidate, history, *, already_published=False):
    """Keep old history readable, but prevent promoting regressive new builds."""
    others = []
    for record in history:
        require(record['bundleIdentifier'] == candidate['bundleIdentifier'], 'Published bundle identity differs')
        same_identity = (record['version'], record['build']) == (candidate['version'], candidate['build'])
        if same_identity or record['releaseTag'] == candidate['releaseTag']:
            require(record == candidate, 'Conflicting published version/build or tag')
        else:
            require(record['build'] != candidate['build'], 'Build number already published under another version')
            others.append(record)
    if already_published:
        # The caller must verify every existing asset byte before an idempotent
        # retry is accepted. Later publications must not break that retry.
        return
    require(int(candidate['build']) > LEGACY_BUILD_FLOOR, 'New publication must exceed installed private builds')
    require(all(int(candidate['build']) > int(record['build']) for record in others),
            'New publication would move the native build number backwards')
    version = tuple(map(int, candidate['version'].split('.')))
    require(all(version >= tuple(map(int, record['version'].split('.'))) for record in others),
            'New publication would move the native version backwards')


def published_metadata(repository):
    """Read the complete publication ledger; API/download failures fail closed."""
    pages = json.loads(gh('api', '--paginate', '--slurp', f'repos/{repository}/releases?per_page=100'))
    records = []
    for release in (release for page in pages for release in page):
        tag = release['tag_name']
        if release['draft'] or not tag.startswith('ios-v'):
            continue
        tag_version(tag)
        with tempfile.TemporaryDirectory() as scratch:
            gh('release', 'download', tag, '--repo', repository, '--pattern', 'release.json', '--dir', scratch)
            record = validate_record(json.loads((Path(scratch)/'release.json').read_text()), publication=True)
        require(record['releaseTag'] == tag, 'Release tag differs from its metadata')
        release_assets(release, record)
        records.append(record)
    return records


def gh(*arguments):
    return subprocess.check_output(['gh', *arguments], text=True)


def find_release(repository, tag):
    # Resolve pending draft tags the same way as `gh release view`: GraphQL for
    # identity, then a direct REST read for current assets. The tag REST endpoint
    # excludes drafts, and release listings can lag after creation or uploads.
    owner, name = repository.split('/')
    query = ('query($owner: String!, $name: String!, $tag: String!) {'
             ' repository(owner: $owner, name: $name) {'
             ' release(tagName: $tag) { databaseId } } }')
    result = json.loads(gh('api', 'graphql', '-f', 'query='+query,
                          '-f', 'owner='+owner, '-f', 'name='+name, '-f', 'tag='+tag))
    release = result['data']['repository']['release']
    if release is None:
        return None
    return json.loads(gh('api', f"repos/{repository}/releases/{release['databaseId']}"))


def release_assets(release, record):
    expected = {record['artifact'], 'release.json', 'SHA256SUMS'}
    assets = {a['name']: a for a in release['assets']}
    require(expected <= assets.keys(), f"Missing published assets for {record['releaseTag']}")
    require(assets[record['artifact']]['size'] == record['size'], 'GitHub asset size differs from metadata')
    return expected


def download_public(url, path, limit):
    # Public, unauthenticated download proves that AltStore can fetch the published asset.
    with urllib.request.urlopen(url, timeout=60) as response, path.open('wb') as destination:
        require(response.url.startswith('https://'), 'Insecure release download redirect')
        count = 0
        while chunk := response.read(65536):
            count += len(chunk)
            require(count <= limit, 'Release download exceeds expected size')
            destination.write(chunk)


def fetch_records(repository, directory):
    pages = json.loads(gh('api', '--paginate', '--slurp', f'repos/{repository}/releases?per_page=100'))
    for release in (release for page in pages for release in page):
        tag = release['tag_name']
        if release['draft'] or not tag.startswith('ios-v'):
            continue
        target = directory/tag
        # Validate tag before using it as a directory component or URL.
        from release_lib import tag_version
        tag_version(tag)
        target.mkdir(parents=True, exist_ok=False)
        prefix = f'https://github.com/{repository}/releases/download/{tag}/'
        download_public(prefix+'release.json', target/'release.json', 1024*1024)
        record = validate_record(json.loads((target/'release.json').read_text()), publication=True)
        require(record['releaseTag'] == tag, 'Release tag differs from its metadata')
        release_assets(release, record)
        download_public(download_url(repository, record), target/record['artifact'], record['size'])
        verify_ipa(target/record['artifact'], record)
        download_public(prefix+'SHA256SUMS', target/'SHA256SUMS', 4096)
        require((target/'SHA256SUMS').read_text() == f"{record['sha256']}  {record['artifact']}\n", 'Published checksum file differs')


def verify_existing_files(directory, downloaded, names):
    for name in names:
        require(hashlib.sha256((directory/name).read_bytes()).digest() == hashlib.sha256((downloaded/name).read_bytes()).digest(),
                f'Published {name} differs; refusing to overwrite an immutable release')
