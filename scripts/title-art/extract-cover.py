#!/usr/bin/env python3
"""Offline cover-lettering trial. Outputs are review candidates; this never changes Uchiyomi artwork."""
import argparse
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps

SOURCE_REVISION = '69009434d4dba5541f228d8f5acb0754c333d417'
WEIGHTS = {
    'sam_tss_b_textseg.pth': 'fa59d9c5ab9bdb7fbdb35b523bf3d64dbc8d00305e63fb9b23d742ddb00e4790',
    'sam_vit_b_01ec64.pth': 'ec2df62732614e57411cdcf32a23ffdf28910380d03139ee0f4fcbe91eb8c912',
}
Image.MAX_IMAGE_PIXELS = 12_000_000


def read_cover_bytes(path, max_bytes=12_000_000):
    """Decode and hash the same bounded snapshot, even if the input path changes during inference."""
    with path.open('rb') as handle:
        data = handle.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ValueError('cover exceeds the trial byte limit')
    return data


def region_box(region, width, height):
    """An optional human-selected region: normalized left, top, right, bottom, inside the input."""
    if not isinstance(region, list) or len(region) != 4:
        raise ValueError('region must contain normalized left, top, right, bottom')
    if any(isinstance(n, bool) or not isinstance(n, (int, float)) or not np.isfinite(n) for n in region):
        raise ValueError('region coordinates must be finite numbers')
    left, top, right, bottom = region
    if not (0 <= left < right <= 1 and 0 <= top < bottom <= 1):
        raise ValueError('region must be nonempty and within the cover')
    box = [round(left * width), round(top * height), round(right * width), round(bottom * height)]
    if box[2] - box[0] < 2 or box[3] - box[1] < 2:
        raise ValueError('region is too small')
    return box


def text_regions(mask):
    """Group letter strokes. Size ranks candidates, not semantic title correctness."""
    height, width = mask.shape
    binary = mask.astype(np.uint8) * 255
    groups = cv2.dilate(binary, np.ones((max(3, height // 80), max(3, width // 24)), np.uint8))
    count, _, stats, _ = cv2.connectedComponentsWithStats(groups)
    options = []
    for label in range(1, count):
        x, y, w, h, _ = map(int, stats[label])
        ink = int(np.count_nonzero(binary[y:y + h, x:x + w]))
        if w < width * .18 or h < height * .025 or ink < width * height * .002 or h > height * .6:
            continue
        options.append({'box': [x, y, x + w, y + h], 'inkPixels': ink})
    return sorted(options, key=lambda candidate: candidate['inkPixels'], reverse=True)[:8]


def cutout(rgb, mask, box):
    """Preserve original RGB lettering, with genuine transparent background rather than a cover rectangle."""
    left, top, right, bottom = box
    alpha = (mask[top:bottom, left:right].astype(np.uint8) * 255)
    if not np.any(alpha):
        raise ValueError('no lettering detected in this region')
    image = Image.fromarray(np.dstack((rgb[top:bottom, left:right], alpha)))
    return image.crop(image.getbbox())


def validate_source(source, models):
    revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != SOURCE_REVISION:
        raise ValueError('use the documented Hi-SAM source revision')
    if subprocess.check_output(['git', '-C', str(source), 'diff', 'HEAD', '--'], text=True).strip():
        raise ValueError('Hi-SAM tracked source must be unmodified')
    for name, expected in WEIGHTS.items():
        digest = hashlib.sha256()
        with (models / name).open('rb') as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise ValueError('checkpoint checksum mismatch: ' + name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hi-sam-dir', type=Path, required=True)
    parser.add_argument('--models-dir', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--threads', type=int, default=3, choices=range(1, 5))
    args = parser.parse_args()
    source, models = args.hi_sam_dir.resolve(), args.models_dir.resolve()
    validate_source(source, models)
    manifest_path = args.manifest.resolve()
    rows = json.loads(manifest_path.read_text())
    if not isinstance(rows, list) or not 1 <= len(rows) <= 20:
        raise ValueError('the trial accepts between 1 and 20 covers')
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError('choose an empty output directory to preserve previous reviews')
    output.mkdir(parents=True, exist_ok=True)
    os.umask(0o077)
    try:
        os.nice(15)
    except OSError:
        pass
    # No uploads, downloads, database access, application credentials or production writes occur here.
    # Force tensor-only deserialization, including calls inside the pinned upstream builder.
    os.environ['TORCH_FORCE_WEIGHTS_ONLY_LOAD'] = '1'
    import torch
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    sys.path.insert(0, str(source))
    from hi_sam.modeling.build import model_registry
    from hi_sam.modeling.predictor import SamPredictor
    # The upstream builder resolves the frozen encoder relative to its source directory.
    if models != source / 'pretrained_checkpoint':
        raise ValueError('models-dir must be the checkout\'s pretrained_checkpoint directory')
    os.chdir(source)
    started = time.perf_counter()
    model = model_registry['vit_b'](SimpleNamespace(checkpoint=str(models / 'sam_tss_b_textseg.pth'),
        model_type='vit_b', hier_det=False, attn_layers=1, prompt_len=12)).eval().to('cpu')
    predictor = SamPredictor(model)
    model_seconds = time.perf_counter() - started
    tiles, results = [], []
    font = ImageFont.load_default(size=18)
    for index, row in enumerate(rows):
        item_started = time.perf_counter()
        title = str(row.get('title', 'Untitled'))[:200]
        name = f'{index + 1:02d}'
        path = (manifest_path.parent / row['input']).resolve()
        cover_bytes = read_cover_bytes(path)
        with Image.open(BytesIO(cover_bytes)) as original:
            if getattr(original, 'n_frames', 1) != 1:
                raise ValueError('choose a still cover image')
            if original.width * original.height > Image.MAX_IMAGE_PIXELS:
                raise ValueError('cover exceeds the trial decoded-pixel limit')
            image = ImageOps.exif_transpose(original).convert('RGB')
        image.thumbnail((1200, 1600))
        rgb = np.asarray(image)
        with torch.inference_mode():
            predictor.set_image(rgb)
            _, logits, _, scores = predictor.predict(return_logits=True)
        mask = np.squeeze(logits) > 0
        width, height = image.size
        exclusions = row.get('excludeRegions', [])
        if not isinstance(exclusions, list) or len(exclusions) > 8:
            raise ValueError('at most eight human-selected exclusion regions are supported')
        for exclusion in exclusions:
            left, top, right, bottom = region_box(exclusion, width, height)
            mask[top:bottom, left:right] = False
        options = text_regions(mask)
        box = region_box(row['region'], width, height) if 'region' in row else (options[0]['box'] if options else None)
        candidate = None
        if box:
            try:
                candidate = cutout(rgb, mask, box)
            except ValueError:
                pass
        if candidate:
            candidate.save(output / (name + '-candidate.png'))
        Image.fromarray(mask.astype(np.uint8) * 255).save(output / (name + '-mask.png'))
        canvas = Image.new('RGB', (1050, 560), '#15131f')
        draw = ImageDraw.Draw(canvas)
        draw.text((16, 12), title[:85], font=font, fill='white')
        cover = image.copy(); cover.thumbnail((310, 480)); canvas.paste(cover, (16, 62))
        if box:
            draw.rectangle((16 + box[0] / width * cover.width, 62 + box[1] / height * cover.height,
                16 + box[2] / width * cover.width, 62 + box[3] / height * cover.height), outline='#c7b2ff', width=2)
        all_text = Image.fromarray(np.dstack((rgb, mask.astype(np.uint8) * 255)))
        background = Image.new('RGBA', image.size, '#272132'); background.alpha_composite(all_text)
        background.thumbnail((310, 480)); canvas.paste(background.convert('RGB'), (352, 62))
        draw.text((352, 40), 'All detected lettering', font=font, fill='#ddd5ee')
        draw.text((690, 70), 'Candidate: review required', font=font, fill='white')
        if candidate:
            candidate.thumbnail((340, 340))
            preview = Image.new('RGBA', candidate.size, '#241c35'); preview.alpha_composite(candidate)
            canvas.paste(preview.convert('RGB'), (690, 130))
        canvas.save(output / (name + '-review.jpg'), quality=90)
        tiles.append(canvas)
        result = {'id': row.get('id'), 'title': title, 'sourceSha256': hashlib.sha256(cover_bytes).hexdigest(),
            'seconds': round(time.perf_counter() - item_started, 2), 'coverSize': [width, height],
            'foregroundFraction': round(float(mask.mean()), 4), 'modelMaskScore': float(np.squeeze(scores)),
            'region': box, 'selection': 'human_region' if 'region' in row else 'largest_text_region',
            'excludeRegions': exclusions,
            'alternatives': options, 'status': 'needs_review' if candidate else 'no_candidate',
            'candidate': name + '-candidate.png' if candidate else None, 'review': name + '-review.jpg',
            'published': False}
        results.append(result)
        print(json.dumps({'title': title, 'seconds': result['seconds'], 'status': result['status']}), flush=True)
    sheet = Image.new('RGB', (2100, 560 * ((len(tiles) + 1) // 2)), '#15131f')
    for i, tile in enumerate(tiles):
        sheet.paste(tile, ((i % 2) * 1050, (i // 2) * 560))
    sheet.save(output / 'contact-sheet.jpg', quality=90)
    report = {'model': 'Hi-SAM / SAM-TS-B TextSeg', 'sourceRevision': SOURCE_REVISION,
        'weightsSha256': WEIGHTS, 'modelLoadSeconds': round(model_seconds, 2), 'threads': args.threads,
        'networkRequests': 0, 'published': False, 'automaticAcceptance': False,
        'note': 'Mask score measures segmentation, not title identity or clean-cutout quality. Review every candidate.',
        'results': results}
    (output / 'results.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
