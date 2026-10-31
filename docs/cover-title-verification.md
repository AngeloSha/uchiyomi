# Extracted title verification

The extractor proposes a transparent cutout from existing cover pixels. Segmentation and OCR scores do not measure
whether an entire title design was recovered. A high score can accompany a missing character, emblem, outline or
subtitle. Valid uncertain candidates remain available for explicit visual review.

Automatic application requires the administrator's opt-in and passing title and image checks from `strict-v1`.
The legacy calibrated mode additionally requires explicit empirical approval. The separate
[nightly batch option](cover-title-batch.md) can apply results that pass the available runtime checks without
claiming that calibration is approved. The policy module itself does not publish artwork. Its caller must still
recheck the current series, cover, title choice, tracker identity, job version and applicable automatic-artwork
settings before publishing a result.

## Necessary evidence

- Expected titles are full English, native or romanized titles from the current checked manga identity. Scraped
  synonyms, abbreviations, a stale tracker cache and guesses derived from OCR cannot establish that identity.
- Source OCR inside the selected region and OCR of the candidate on the actual **dark hero** must read the same
  complete expected title, in physical reading order, with every nonempty line scoring at least 0.98.
  Unicode normalization preserves scripts, numbers and meaningful punctuation such as `+99` and `Re:Zero`.
- Candidate author credits, volume labels, contradictory titles and clipped source title lines require review.
  Credits elsewhere on the source cover are harmless. An empty or weak light inspection is permitted because
  white lettering disappears on white; confidently contradictory light OCR still blocks automatic application.
- The cutout must decode with real, nonempty transparency. Mask preservation must be complete, original foreground
  RGB must be unchanged, and selected-region edge ink must be zero. These measurements establish faithful copying
  of the detected mask; they do not prove that segmentation detected every part of the original design.
- Geometry, resolution, foreground density and dark-background contrast must satisfy the policy. The lower
  quartile contrast must be at least 3. Low-resolution and dark-on-dark designs may remain manual candidates.

The OCR adapter loads only the pinned OCR runtime, detection/recognition models and alphabets. It does not load a
translation language model or download anything. Source bytes and their hash are checked before caching. OCR runs
serially with two CPU threads. Detector expansion is bounded independently of compressed bytes and source pixels:
a very thin image can otherwise become an enormous tensor when OCR enlarges its short side.

## Explicit empirical approval

`TITLE_EXTRACTOR_CALIBRATION_FILE` is an operator-controlled, read-only JSON file. It must never be supplied by an
API request or accepted as a claim from the extraction worker. Its `verifierFingerprint` binds the segmentation
model, pinned OCR pack and verification/preprocessing revision. A changed pipeline needs a new assessment.

The current record format requires at least ten actual, visually audited cases, at least three known unsafe cases
all rejected, zero observed false acceptances, and at least one complete unassisted positive. The record identifies
the audit method and whether the reviewer was a person or Codex. An agent audit must not be described as human
ground truth. Synthetic test fixtures validate code paths; they cannot populate these empirical counts.

These checks are a conservative operational gate, not a statistically calibrated accuracy estimate or a guarantee.
A small reviewed sample cannot establish library-wide reliability. OCR may confidently misread stylized lettering,
and text recognition does not assess every decorative part of a title. A corpus with no qualifying positive must
remain unapproved; lowering thresholds or inventing a positive to enable the setting would invalidate the evidence.

Keep source/candidate hashes, model fingerprints, selected geometry, source/light/dark OCR and audit verdicts with
the private corpus record. Keep user covers and cutouts outside the repository. Preserve raw automatic proposals
separately from candidates improved with human-selected regions or exclusions.

In calibrated mode, missing OCR, an absent/unapproved record, a changed fingerprint or a failed necessary check
leaves automatic application disabled for that result. The nightly available-checks mode still requires pinned OCR,
current canonical identity and every necessary title and image check; it does not convert a missing calibration
record into approval. Failed checks do not discard a valid preview or prevent an explicitly reviewed manual
application. Empty, opaque or invalid cutouts cannot be applied through that review path either.
