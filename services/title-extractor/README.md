# Optional local cover-title service

This CPU service cuts existing lettering out of a cover. It preserves detected foreground RGB and returns a PNG
with transparency. It cannot restore strokes hidden by a character or generate a missing title. The app keeps each
result private until an administrator applies it or an empirically approved automatic assessment passes.

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
