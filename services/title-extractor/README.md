# Optional local cover-title service

This CPU service cuts existing lettering out of a cover. It preserves detected foreground RGB and returns a PNG
with transparency. It cannot restore strokes hidden by a character or generate a missing title. The app keeps each
result private until an administrator applies it or the administrator's separate automatic-apply opt-in and all
available title/image checks pass. That opt-in is off by default; passing available checks is not a calibrated
guarantee that a title is complete.

The main app image does not contain Python, segmentation weights or an extra translation model. This service has
no library, database or application-config mount and requires no external network access during inference.

Detection uses three overlapping views so a second title line can be found independently of the dominant
line. A manual region also gets one full-cover context view; automatic detection already starts with that view. The pinned base SAM checkpoint refines up to four proposed lines or glyphs in one additional image pass.
This improves lettering that the text detector misses, while retaining original RGB. It can still include scenery
or miss a flourish, so a result remains a visual-review candidate. Model scores never approve automatic application.
Dark outline completion also considers weak native text-model support near established bright lettering. It
adds only original source pixels from small, nearby dark components that pass whole-image geometry, contrast,
model-support and area limits. Components are measured before clipping, so a large background region cannot
masquerade as a little outline. Enclosed transparent font counters are preserved from the original alpha; dark
cover pixels visible through a letter hole cannot become recovered lettering. Existing alpha and multicolour RGB are preserved. This can recover a shadow or
letter tip omitted by a hard text threshold; it does not reconstruct hidden strokes or certify a complete title.
An initial preview can take about a minute on three CPU threads; repeated views use bounded six-entry hard/weak
boolean mask caches. The extra manual context view is included in the application's 90-second worker budget.

Once a preview is ready, **Fine-tune title** offers Restore/Erase brushes, zoom, pan, undo and reset. This editor
changes only alpha using the saved original cover pixels; it does not run either model again. **Save corrections**
stores a private revision and reloads its final title preview. **Apply title artwork** remains a separate action.
An older tab cannot apply a corrected revision it has not loaded. Manual corrections require visual review and do
not qualify for automatic publication. Earlier drafts without an immutable raw mask need a new extraction first.

## Install the optional published image

Application releases also publish `ghcr.io/angelosha/uchiyomi:title-extractor-v<VERSION>` for native Linux amd64 and arm64.
These distinct tags reuse the existing public package; the app retains its normal version and `latest` tags.
The overlay pins v0.102.1; choose `title-extractor-latest` explicitly only when you intend rolling worker upgrades.
The image contains the CPU runtime and pinned Hi-SAM source, including its upstream Apache-2.0 license at
`/opt/hi-sam/LICENSE`; Uchiyomi's MPL-2.0 license and component notice are in `/service`. It contains **no model
checkpoints, OCR pack, cover images, application credentials or library files**. It downloads nothing at runtime.

For the standard [single-container install](../../deploy/docker-compose.yml), copy
[`deploy/docker-compose.title-extractor.yml`](../../deploy/docker-compose.title-extractor.yml) beside your existing
`docker-compose.yml`. The overlay preserves the existing app image, volumes and network, adding only the optional
service, its internal network and read-only OCR mount. Custom stacks can adapt those two service entries; the
development stack names its app `yomi-app`, rather than `uchiyomi`.

Stage data outside the source checkout. Put these lines in the existing `.env`, keeping its other values:

```dotenv
TITLE_EXTRACTOR_DATA=/absolute/path/to/title-art-data
TITLE_EXTRACTOR_IMAGE=ghcr.io/angelosha/uchiyomi:title-extractor-v0.102.1
```

Set the same absolute `TITLE_EXTRACTOR_DATA` path in your setup shell, then create its two directories:

```sh
export TITLE_EXTRACTOR_DATA=/absolute/path/to/title-art-data
mkdir -p "$TITLE_EXTRACTOR_DATA/models" "$TITLE_EXTRACTOR_DATA/ocr"
# Create once; noclobber preserves an existing token when these instructions are repeated.
(umask 077; set -C; printf 'TITLE_EXTRACTOR_TOKEN=%s\n' "$(openssl rand -hex 32)" > .env.title-extractor)
```

Download the two upstream checkpoints listed in [the extraction tools](../../scripts/title-art/README.md) into
`$TITLE_EXTRACTOR_DATA/models/`. Verify them before starting the service:

```sh
(cd "$TITLE_EXTRACTOR_DATA/models" && printf '%s\n' \
  'fa59d9c5ab9bdb7fbdb35b523bf3d64dbc8d00305e63fb9b23d742ddb00e4790  sam_tss_b_textseg.pth' \
  'ec2df62732614e57411cdcf32a23ffdf28910380d03139ee0f4fcbe91eb8c912  sam_vit_b_01ec64.pth' | sha256sum -c -)
```

From the matching release's source checkout, use Node 24+ and `tar` to stage the small OCR-only pack:

```sh
node scripts/title-art/prepare-ocr.mjs "$TITLE_EXTRACTOR_DATA/ocr"
chmod -R a+rX "$TITLE_EXTRACTOR_DATA/models" "$TITLE_EXTRACTOR_DATA/ocr"
```

The data directories contain only public model/runtime files; keep the private token file beside the Compose
files, outside them. The worker's uid 10002 and an app using a custom PUID must both be able to read the mounts.
The staging tool includes the PaddleOCR and ONNX Runtime licenses and verifies every downloaded file. It does
not stage a translation language model or an automatic-approval record.

Run from the directory containing your existing Compose file and volumes:

```sh
docker compose -f docker-compose.yml -f docker-compose.title-extractor.yml --profile title-art pull uchiyomi title-extractor
docker compose -f docker-compose.yml -f docker-compose.title-extractor.yml --profile title-art up -d uchiyomi title-extractor
```

Wait for the worker to become healthy, then use **Edit details → Art → Title logo → Extract from cover**.
Installing this service does not change any automatic or nightly opt-in setting. Manual previews and optional
nightly generation need a ready worker. The separate default-off option to apply results that pass available
checks also needs the pinned OCR pack, current verified canonical title aliases and every runtime title/image
check to pass. Uncertain results stay private for review and expire after 14 days. This overlay supports the
single-container Docker install. Desktop installations do not download or launch the Python service automatically.

## Build from source

Use the pinned Hi-SAM checkout and checkpoints documented in
[the extraction tools](../../scripts/title-art/README.md). Build with:

```sh
python3 scripts/title-art/build-worker.py --help
node scripts/title-art/prepare-ocr.mjs --help
```

`build-worker.py` verifies the checkout revision and supplies a source archive to Docker. The worker verifies both
checkpoint hashes before becoming ready. `prepare-ocr.mjs` stages a pinned, checksum-verified OCR-only pack; it does
not install the translation language model. Keep checkpoint and OCR files in persistent server storage, outside
the source checkout. Mount both read-only. Keep user covers and generated candidates outside Git.
For a local image, pass `--hi-sam-dir /path/to/Hi-SAM --tag uchiyomi-title-extractor:local`. CI uses
`--prepare-context /new/empty/path` with the same verified source, builds both native architectures without weights,
and tests that a worker without checkpoints rejects requests and never becomes ready. Release tags publish the image
alongside the three application images; the shared `latest` gate waits for all four multi-architecture indexes.

## Upgrade or disable

Keep the worker image tag matched to the app release (or pin both to reviewed immutable digests). Back up the app
database/configuration, retain the old Compose files and image IDs, update the worker tag in `.env`, and use the same
two-file `pull` and `up -d` commands above. Reuse the existing model/OCR directories and token. A worker without the
required checkpoint hashes stays unavailable; normal manga reading and provider logos remain usable.

To stop just inference, run the same two-file Compose command with `stop title-extractor`; saved artwork is kept.
Do not use `down -v` to disable this feature: that would also remove the existing application's named volumes.

## Connect the app

Run the worker only on a private internal Docker network shared with the app. Publish no worker port. Its default
port is 3081. Use a read-only container filesystem, a bounded writable `/tmp`, no Linux capabilities, three CPU
threads and a memory limit of at least 4 GiB. The worker runs as uid/gid 10002 and accepts one inference at a time.

Set these on the app:

| Variable | Value |
| --- | --- |
| `TITLE_EXTRACTOR_URL` | Private worker URL, e.g. `http://title-extractor:3081` |
| `TITLE_EXTRACTOR_TOKEN` | Random shared secret, at least 32 characters |
| `TITLE_EXTRACTOR_OCR_DIR` | Read-only OCR pack directory inside the app |
| `TITLE_EXTRACTOR_CALIBRATION_FILE` | Optional approved verification JSON inside that directory |

Set the same token on the worker and mount the two checkpoint files at `/models`. Store the token in a mode-0600
environment file used only by these two containers. Do not add other app credentials to the worker. The worker's
authenticated `/healthz` reports readiness; model loading can take longer than the app startup.

The two default-off cover-title options, **Automatically extract cover titles** and **Apply cover titles that pass
checks**, live under **Admin → Series → Automatic title logos**. Nightly generation
runs at 03:00 in the server's time zone, with **Run now** for an initial batch; it can create local previews without
an external metadata link. Automatic application is a separate opt-in: it requires current verified canonical
title aliases, source and candidate OCR agreement, and the available geometry, alpha and image checks. Missing
identity or failed checks leave a private review draft instead. Local generation does not fetch external aliases
when external metadata sharing is disabled. With online title logos and library external lookup enabled, checked
manga identities finish online artwork lookup first; only a current completed miss permits cover fallback. Provider
errors and pending lookups wait for their retry deadline. After a miss, missing canonical aliases are warmed for the
exact checked identity before verification. Unlinked series remain local previews, not claimed online misses. Existing
provider artwork and manual/text choices take priority. See [batch behavior and status](../../docs/cover-title-batch.md).

The older calibrated automatic-application setting remains separate and still requires an approved verification
record. The available-checks opt-in does not create or claim that approval. See
[the verification policy](../../docs/cover-title-verification.md): a model score, successful OCR or a synthetic test
cannot guarantee that every flourish or outline was extracted correctly.

## Verify

```sh
python3 -m unittest discover -s services/title-extractor -p 'test_*.py'
```

App tests cover private job ownership, immutable source bytes, cancellation, expiry, stale cover/title/identity
rejection and explicit Apply. The browser fixture walk is `web/test/e2e/titleExtractionWalk.mjs` with
`E2E_TITLE_EXTRACTION=1`; that fixture verifies the UI and API contract, not real model quality. Audit actual covers
separately. Keep the previous app image and Compose configuration available when enabling this optional service.
