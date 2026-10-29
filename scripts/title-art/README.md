# Cover lettering tools

The app now supports **Edit details → Art → Title logo → Extract from cover** when the optional local service is
configured. It saves a private draft, lets an administrator adjust the region and exclusions, and previews the
cutout before an explicit Apply. See [the service setup](../../services/title-extractor/README.md) and
[verification requirements](../../docs/cover-title-verification.md). The command-line trial below remains useful
for a separate evaluation corpus; it does not change app artwork.

This optional tool tests whether lettering already present on a cover can become a transparent hero title.
It runs locally, keeps the original RGB strokes, and writes review images and candidates to a separate directory.
It does **not** change the library, upload covers, generate new lettering, download models during inference, or
apply candidates automatically. A segmentation score is not evidence that the complete manga title was selected.

The application does not depend on Python or these models. Use a separate environment on the server and keep
the checkout, weights, environment, covers and outputs outside the Uchiyomi source tree and configuration volume.

## Set up the isolated environment

```sh
python3 -m venv /path/to/title-trial/venv
/path/to/title-trial/venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu \
  torch==2.8.0+cpu torchvision==0.23.0+cpu
/path/to/title-trial/venv/bin/pip install -r scripts/title-art/requirements.txt
git clone https://github.com/ymy-k/Hi-SAM.git /path/to/title-trial/Hi-SAM
git -C /path/to/title-trial/Hi-SAM checkout 69009434d4dba5541f228d8f5acb0754c333d417
```

Use the authors' [Hi-SAM implementation](https://github.com/ymy-k/Hi-SAM), licensed under Apache-2.0.
Place these two checkpoints in that checkout's `pretrained_checkpoint/` directory:

| File | Download | SHA-256 |
| --- | --- | --- |
| `sam_tss_b_textseg.pth` | [public mirror of the authors' TextSeg checkpoint](https://huggingface.co/GoGiants1/Hi-SAM/resolve/main/sam_tss_b_textseg.pth) | `fa59d9c5ab9bdb7fbdb35b523bf3d64dbc8d00305e63fb9b23d742ddb00e4790` |
| `sam_vit_b_01ec64.pth` | [Meta's SAM encoder](https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth) | `ec2df62732614e57411cdcf32a23ffdf28910380d03139ee0f4fcbe91eb8c912` |

The original Hi-SAM OneDrive download was inaccessible during the server trial; the mirror is identified explicitly.
The tool requires these exact checksums and the unmodified pinned source, and forces tensor-only checkpoint loading.
The checkpoints occupy about 425 MB; the separate CPU Python environment requires additional space.

## Run and review

A manifest contains one to twenty local cover files. Paths are relative to the manifest or absolute.
`region` is optional and specifies normalized **left, top, right, bottom** coordinates for a human-selected title.
`excludeRegions` can remove author names, volume numbers or promotional text from the mask.
Without a region, the largest detected text block is only a proposal; it may be a partial title.

```json
[
  {"id": "example", "title": "Example manga", "input": "cover.webp"},
  {"id": "another", "title": "Another manga", "input": "another.webp",
   "region": [0.04, 0.60, 0.96, 0.92], "excludeRegions": [[0.8, 0.6, 0.96, 0.7]]}
]
```

```sh
/path/to/title-trial/venv/bin/python scripts/title-art/extract-cover.py \
  --hi-sam-dir /path/to/title-trial/Hi-SAM \
  --models-dir /path/to/title-trial/Hi-SAM/pretrained_checkpoint \
  --manifest /path/to/title-trial/manifest.json \
  --output /path/to/title-trial/review-01 --threads 3

/path/to/title-trial/venv/bin/python -m unittest discover -s scripts/title-art -p 'test_*.py'
```

Open `contact-sheet.jpg`, the individual `NN-review.jpg` images, and transparent `NN-candidate.png` files.
Review the **whole** title against the cover: missing characters, severed strokes, unwanted credits/numbers,
background fragments, original-language readability, and contrast on the actual hero. The mask score measures a
different task and must never serve as an acceptance threshold. Missing strokes hidden by characters cannot be
faithfully recovered by this tool. A thin outline or decorative emblem may not be detected as lettering.

Every output remains `needs_review` (or `no_candidate`) and `published: false`. A reviewed candidate can be applied
explicitly through the existing **Edit details → Art → Title logo → Upload** control. It then becomes a manual
choice with the readable manga title beneath it. Reset to automatic restores normal provider discovery.

The server trial uses a small sample, not a claim about library-wide success. Keep separate records of the raw
automatic result and any human region corrections so assisted quality is not presented as automatic accuracy.
