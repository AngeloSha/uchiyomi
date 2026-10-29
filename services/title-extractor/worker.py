"""Bounded local Hi-SAM inference. No network, application credentials, database or library access."""
from collections import OrderedDict
import base64
import hashlib
from io import BytesIO
import json
import math
import os
from pathlib import Path
import sys
from types import SimpleNamespace

import cv2
import numpy as np
from PIL import Image, ImageOps

MAX_IMAGE_BYTES = 11 * 1024 * 1024
MAX_PIXELS = 12_000_000
SOURCE_REVISION = '69009434d4dba5541f228d8f5acb0754c333d417'
WEIGHTS = {
    'sam_tss_b_textseg.pth': 'fa59d9c5ab9bdb7fbdb35b523bf3d64dbc8d00305e63fb9b23d742ddb00e4790',
    'sam_vit_b_01ec64.pth': 'ec2df62732614e57411cdcf32a23ffdf28910380d03139ee0f4fcbe91eb8c912',
}
MODEL_FINGERPRINT = hashlib.sha256(json.dumps({
    'algorithm': 'hisam-title-binary-v1', 'sourceRevision': SOURCE_REVISION, 'weights': WEIGHTS,
    'prepare': [1200, 1600], 'threshold': 0,
}, sort_keys=True).encode()).hexdigest()
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


class ExtractionError(Exception):
    def __init__(self, code, status=422):
        super().__init__(code)
        self.code, self.status = code, status


def rectangle(value, width, height):
    if not isinstance(value, dict) or set(value) != {'left', 'top', 'width', 'height'}:
        raise ExtractionError('invalid_region', 400)
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in value.values()):
        raise ExtractionError('invalid_region', 400)
    x, y, w, h = (value[k] for k in ('left', 'top', 'width', 'height'))
    if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > 1.00000001 or y + h > 1.00000001:
        raise ExtractionError('invalid_region', 400)
    box = [round(x * width), round(y * height), min(width, round((x + w) * width)), min(height, round((y + h) * height))]
    if box[2] - box[0] < 2 or box[3] - box[1] < 2:
        raise ExtractionError('invalid_region', 400)
    return box


def normalized(box, width, height):
    left, top, right, bottom = box
    return {'left': left / width, 'top': top / height, 'width': (right - left) / width, 'height': (bottom - top) / height}


def automatic_region(mask):
    height, width = mask.shape
    binary = mask.astype(np.uint8) * 255
    joined = cv2.dilate(binary, np.ones((max(3, height // 80), max(3, width // 24)), np.uint8))
    count, _, stats, _ = cv2.connectedComponentsWithStats(joined)
    regions = []
    for label in range(1, count):
        x, y, w, h, _ = map(int, stats[label])
        ink = int(np.count_nonzero(mask[y:y + h, x:x + w]))
        if w < width * .18 or h < height * .025 or h > height * .6 or ink < width * height * .002:
            continue
        regions.append((ink, [x, y, x + w, y + h]))
    if not regions:
        raise ExtractionError('no_text')
    return max(regions, key=lambda value: value[0])[1]


def decode_image(encoded):
    if not isinstance(encoded, str) or len(encoded) > ((MAX_IMAGE_BYTES + 2) // 3) * 4:
        raise ExtractionError('bad_image', 400)
    try:
        data = base64.b64decode(encoded, validate=True)
        if not 1 <= len(data) <= MAX_IMAGE_BYTES:
            raise ValueError('byte limit')
        with Image.open(BytesIO(data)) as source:
            if source.format not in {'PNG', 'WEBP', 'JPEG', 'AVIF'} or getattr(source, 'n_frames', 1) != 1:
                raise ValueError('format')
            if source.width * source.height > MAX_PIXELS:
                raise ValueError('pixel limit')
            image = ImageOps.exif_transpose(source).convert('RGB')
            image.thumbnail((1200, 1600))
        return data, np.asarray(image)
    except Exception as error:
        raise ExtractionError('bad_image', 400) from error


def contrast_on_dark(rgb, mask):
    pixels = rgb[mask].astype(np.float64) / 255
    linear = np.where(pixels <= .04045, pixels / 12.92, ((pixels + .055) / 1.055) ** 2.4)
    luminance = linear @ np.array([.2126, .7152, .0722])
    # A measured lower quartile avoids treating a few bright decorative pixels as readable lettering.
    return float((np.quantile(luminance, .25) + .05) / (.006 + .05))


class Extractor:
    def __init__(self, source, threads=3):
        source = Path(source).resolve()
        for name, expected in WEIGHTS.items():
            digest = hashlib.sha256()
            with (source / 'pretrained_checkpoint' / name).open('rb') as handle:
                while chunk := handle.read(1024 * 1024):
                    digest.update(chunk)
            if digest.hexdigest() != expected:
                raise RuntimeError('model_checksum_mismatch')
        os.environ['TORCH_FORCE_WEIGHTS_ONLY_LOAD'] = '1'
        import torch
        torch.set_num_threads(threads)
        torch.set_num_interop_threads(1)
        sys.path.insert(0, str(source))
        from hi_sam.modeling.build import model_registry
        from hi_sam.modeling.predictor import SamPredictor
        os.chdir(source)
        self.torch = torch
        self.predictor = SamPredictor(model_registry['vit_b'](SimpleNamespace(
            checkpoint=str(source / 'pretrained_checkpoint/sam_tss_b_textseg.pth'), model_type='vit_b',
            hier_det=False, attn_layers=1, prompt_len=12)).eval().to('cpu'))
        self.cache = OrderedDict()

    def mask(self, key, rgb):
        if key in self.cache:
            self.cache.move_to_end(key)
            return self.cache[key]
        with self.torch.inference_mode():
            self.predictor.set_image(rgb)
            _, logits, _, score = self.predictor.predict(return_logits=True)
        value = np.squeeze(logits) > 0, float(np.squeeze(score))
        self.cache[key] = value
        while len(self.cache) > 2:
            self.cache.popitem(last=False)
        return value

    def extract(self, request):
        if not isinstance(request, dict) or set(request) - {'imageBase64', 'region', 'exclusions', 'expectedTitles'}:
            raise ExtractionError('bad_request', 400)
        expected = request.get('expectedTitles', [])
        if not isinstance(expected, list) or len(expected) > 8 or any(not isinstance(s, str) or len(s) > 200 for s in expected):
            raise ExtractionError('bad_request', 400)
        data, rgb = decode_image(request.get('imageBase64'))
        height, width = rgb.shape[:2]
        region = rectangle(request['region'], width, height) if request.get('region') is not None else None
        exclusions = request.get('exclusions', [])
        if not isinstance(exclusions, list) or len(exclusions) > 8:
            raise ExtractionError('invalid_region', 400)
        excluded = [rectangle(value, width, height) for value in exclusions]
        source_hash = hashlib.sha256(data).hexdigest()
        original_mask, score = self.mask(source_hash, rgb)
        mask = original_mask.copy()
        for left, top, right, bottom in excluded:
            mask[top:bottom, left:right] = False
        region = region or automatic_region(mask)
        left, top, right, bottom = region
        crop = mask[top:bottom, left:right]
        if not np.any(crop):
            raise ExtractionError('no_text')
        ys, xs = np.nonzero(crop)
        tight = [left + int(xs.min()), top + int(ys.min()), left + int(xs.max()) + 1, top + int(ys.max()) + 1]
        x0, y0, x1, y1 = tight
        selected_rgb, selected_mask = rgb[y0:y1, x0:x1], mask[y0:y1, x0:x1]
        candidate = Image.fromarray(np.dstack((selected_rgb, selected_mask.astype(np.uint8) * 255)))
        output = BytesIO(); candidate.save(output, format='PNG')
        png = output.getvalue()
        if len(png) > MAX_IMAGE_BYTES:
            raise ExtractionError('bad_image')
        border = np.concatenate((crop[0], crop[-1], crop[1:-1, 0], crop[1:-1, -1]))
        return {'version': 1, 'sourceSha256': source_hash, 'modelFingerprint': MODEL_FINGERPRINT,
            'candidateBase64': base64.b64encode(png).decode(), 'width': candidate.width, 'height': candidate.height,
            'sourceWidth': width, 'sourceHeight': height, 'region': normalized(region, width, height),
            'candidateRegion': normalized(tight, width, height), 'evidence': {
                'maskScore': score, 'foregroundFraction': float(selected_mask.mean()),
                'edgeInkFraction': float(border.mean()), 'maskRetainedFraction': 1,
                'foregroundChangedFraction': 0, 'darkBackgroundContrastRatio': contrast_on_dark(selected_rgb, selected_mask),
                'inkPixels': int(selected_mask.sum()), 'modelFingerprint': MODEL_FINGERPRINT,
            }}
