# Optional local cover-title service

This CPU service cuts existing lettering out of a cover. It preserves detected foreground RGB and returns a PNG
with transparency. It cannot restore strokes hidden by a character or generate a missing title. The app keeps each
result private until an administrator applies it or an empirically approved automatic assessment passes.

The main app image does not contain Python, segmentation weights or an extra translation model. This service has
no library, database or application-config mount and requires no external network access during inference.

Detection uses up to three overlapping views so a second title line can be found independently of the dominant
line. The pinned base SAM checkpoint refines up to four proposed lines or glyphs in one additional image pass.
This improves lettering that the text detector misses, while retaining original RGB. It can still include scenery
or miss a flourish, so a result remains a visual-review candidate. Model scores never approve automatic application.
An initial preview can take about a minute on three CPU threads; repeated views use a small bounded mask cache.

## Build and stage

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

The default-off automatic option lives under **Admin → Series → Automatic title logos**. It becomes usable only
when worker readiness, pinned OCR and an approved verification record are present. It processes confirmed provider
misses, preserves manual/text choices and lookup opt-outs, and leaves uncertain drafts for review. Existing provider
logos take priority. See [the strict verification policy](../../docs/cover-title-verification.md) before approving
any record; a model score or a synthetic test cannot establish that a complete title was extracted.

## Verify

```sh
python3 -m unittest discover -s services/title-extractor -p 'test_*.py'
```

App tests cover private job ownership, immutable source bytes, cancellation, expiry, stale cover/title/identity
rejection and explicit Apply. The browser fixture walk is `web/test/e2e/titleExtractionWalk.mjs` with
`E2E_TITLE_EXTRACTION=1`; that fixture verifies the UI and API contract, not real model quality. Audit actual covers
separately. Keep the previous app image and Compose configuration available when enabling this optional service.
