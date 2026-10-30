# Nightly cover titles

Local cover-title generation and automatic application have separate, default-off switches in Admin. The optional
local extraction worker is required for generation. Enabling automatic application additionally requires the pinned
OCR pack. The older calibrated fallback setting is retained for compatibility and does not enable this batch task.

A nightly run starts at03:00 in the server's reported timezone. Its next deadline, target queue and progress are
stored in PostgreSQL, so restart resumes work rather than restarting the library. Newly added series and changed
covers are picked up on the next night. **Run now** starts the same task immediately; it can prepare private previews
while the nightly switch is off. It cannot apply them while that switch is off. **Stop run** cancels that run's pending
and active work, keeping completed previews and all published artwork.

One existing extraction worker processes the queue. A manual extraction gets priority between batch items.
The task uses the actual selected cover and existing cover pipeline. When automatic online title logos and the
library's external lookups are enabled, a series with a checked AniList identity must finish online artwork lookup
before cover extraction. A usable online logo wins. Only a completed, current negative result permits cover fallback;
unchecked, pending, expired and failed requests stay queued with the provider's pacing and Retry-After deadlines.
A fresh cached negative result is reused until its seven-day expiry. Waiting does not consume cover-model retries.

After that online miss, missing canonical English, romaji and native titles are fetched for the exact checked manga
identity before cover retry history is compared. This lets an old review with missing aliases be evaluated once with
new verified titles. Identity and privacy are checked again after lookup; the task never guesses a manga link.
Unlinked series can still generate a local preview, reported as needing a link rather than as searched online.
Disabling online lookups globally or for a library permits local-only processing with no metadata requests.
These local previews still need a verified identity and complete-title checks before automatic application.

Custom/text title choices, active manual previews, selected first-page art and usable provider logos are protected. Source bytes, cover selection, title version and identity are checked again before publication.

**Apply results that pass checks** is a separate opt-in. It publishes only when generation and application are both
on and the output passes the actual available image and complete-title checks. Verified canonical identity and
matching source/candidate OCR remain required; unlinked, incomplete or uncertain results wait for review. Optional
calibration approval remains a separate stricter signal. Passing the available checks does not claim that calibration
was approved or guarantee every decorative edge. Manual brush corrections are never automatically certified.

Review previews are private and retained for14 days, with a2GiB generation budget. Manual corrections may grow retained drafts beyond that budget; their bytes are
counted, so new background generation pauses until space is available. They do not consume
the32 short-lived manual preview slots. The latest ready reviews are linked from the task status. Review reasons
count distinct ready drafts per friendly group: title identity, unclear text, incomplete lettering, contrast, unavailable
checks and other checks. Groups may overlap; they are not a partition or a pass rate. Calibration-only diagnostics do
not appear as blockers for the available-checks opt-in. A storage limit pauses remaining work instead of silently dropping targets. Failures have bounded retries; **Retry failed** explicitly
tries previous failures again. Source/model/verifier and cached canonical-alias fingerprints survive preview expiry and deletion, so the same unchanged
cover is not inferred every night or regenerated immediately after a preview expires. Newly available OCR or canonical
aliases, or newly enabled checked publication, allow one bounded reevaluation; unchanged verification inputs are skipped. A per-series manual preview
can always be created again when needed.

The status API is read-only. `ready` counts private review drafts, `applied` counts actual publication, and pending,
processing, ready, applied, skipped, failed and cancelled are disjoint states whose sum is the run total. Existing
reading progress, downloads and published title artwork remain untouched by generation or cancellation.

`online.waitingOnline` counts pending items in the latest run waiting for provider completion/backoff.
`online.needsLink` and `online.optedOut` describe current eligibility of that run's automatic, non-first-page series;
they may overlap and do not claim an online search occurred. `nextRetryAt` reports the persisted next deadline.
Review reason groups cover the latest 2,048 visible, unexpired ready batch previews across runs, with each draft
counted at most once in each group. Reading status never starts network requests or inference.
