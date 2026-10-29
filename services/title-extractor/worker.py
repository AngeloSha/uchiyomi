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
    'algorithm': 'hisam-lines-sam-refinement-v2', 'sourceRevision': SOURCE_REVISION, 'weights': WEIGHTS,
    'prepare': [1200, 1600], 'threshold': 0, 'views': 3,
    'refinement': 'bounded-line-and-glyph-v1', 'cleanup': 'added-speckles-v1',
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


def line_groups(mask):
    """Join nearby strokes into line proposals; retain original ink bounds, not dilation padding."""
    height, width = mask.shape
    joined = cv2.dilate(mask.astype(np.uint8), np.ones((max(3, height // 80), max(5, width // 18)), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(joined)
    groups = []
    for label in range(1, count):
        x, y, w, h, _ = map(int, stats[label])
        ink = mask[y:y + h, x:x + w] & (labels[y:y + h, x:x + w] == label)
        yy, xx = np.nonzero(ink)
        if len(xx) < max(24, width * height * .0002):
            continue
        groups.append(([x + int(xx.min()), y + int(yy.min()), x + int(xx.max()) + 1, y + int(yy.max()) + 1], len(xx)))
    return groups


def clamp_box(box, width, height):
    return [max(0, int(box[0])), max(0, int(box[1])), min(width, int(box[2])), min(height, int(box[3]))]


def selected_views(region):
    """Overlapping line-sized views give a faint second line its own model attention."""
    left, top, right, bottom = region
    w, h = right - left, bottom - top
    if min(w, h) < 24:
        return []
    if w >= h:
        split = max(2, round(h * .62))
        return [[left, top, right, top + split], [left, bottom - split, right, bottom]]
    split = max(2, round(w * .62))
    return [[left, top, left + split, bottom], [right - split, top, right, bottom]]


def neighboring_views(anchor, width, height):
    left, top, right, bottom = anchor
    w, h = right - left, bottom - top
    if w >= h:
        span = min(height * .30, max(h * 1.4, height * .12))
        boxes = [[left, top - span, right, top + h * .15], [left, bottom - h * .15, right, bottom + span]]
    else:
        span = min(width * .30, max(w * 1.4, width * .12))
        boxes = [[left - span, top, left + w * .15, bottom], [right - w * .15, top, right + span, bottom]]
    return [box for raw in boxes if (box := clamp_box(raw, width, height))[2] - box[0] >= 24 and box[3] - box[1] >= 24]


def complete_region(mask, anchor):
    """Keep neighboring title lines rather than selecting only the single largest text component."""
    height, width = mask.shape
    x0, y0, x1, y1 = anchor
    aw, ah = x1 - x0, y1 - y0
    horizontal = aw >= ah
    reference = ah if horizontal else aw
    selected = list(anchor)
    for _ in range(2):
        for (left, top, right, bottom), ink in line_groups(mask):
            thickness = bottom - top if horizontal else right - left
            if thickness < reference * .32 or ink < 32:
                continue
            if horizontal:
                overlap = min(selected[2], right) - max(selected[0], left)
                gap = max(top - selected[3], selected[1] - bottom, 0)
                same_line = min(selected[3], bottom) - max(selected[1], top) >= min(ah, thickness) * .5
                side_gap = max(left - selected[2], selected[0] - right, 0)
                adjacent = (same_line and side_gap <= reference * .9) or (
                    right - left >= aw * .24 and overlap >= min(aw, right - left) * .2 and gap <= max(reference, thickness) * 1.1)
            else:
                overlap = min(selected[3], bottom) - max(selected[1], top)
                gap = max(left - selected[2], selected[0] - right, 0)
                same_line = min(selected[2], right) - max(selected[0], left) >= min(aw, thickness) * .5
                side_gap = max(top - selected[3], selected[1] - bottom, 0)
                adjacent = (same_line and side_gap <= reference * .9) or (
                    bottom - top >= ah * .24 and overlap >= min(ah, bottom - top) * .2 and gap <= max(reference, thickness) * 1.1)
            candidate = [min(selected[0], left), min(selected[1], top), max(selected[2], right), max(selected[3], bottom)]
            if adjacent and candidate[3] - candidate[1] <= height * .75 and candidate[2] - candidate[0] <= width:
                selected = candidate
    margin = max(3, round(min(width, height) * .012))
    return clamp_box([selected[0] - margin, selected[1] - margin, selected[2] + margin, selected[3] + margin], width, height)


def refinement_proposals(mask, baseline, region):
    """Only refine substantial new text groups discovered by the smaller views."""
    left, top, right, bottom = region
    proposals = []
    local = mask[top:bottom, left:right]
    original = baseline[top:bottom, left:right]
    # A few isolated model speckles must not move a letter proposal far into scenery.
    # This only determines prompt bounds; it never deletes punctuation or original alpha.
    count, labels, stats, _ = cv2.connectedComponentsWithStats(local.astype(np.uint8))
    largest = max((int(stats[i, 4]) for i in range(1, count)), default=0)
    significant = np.zeros_like(local)
    for index in range(1, count):
        if stats[index, 4] >= max(8, largest * .02):
            significant |= labels == index
    for box, ink in line_groups(significant):
        x0, y0, x1, y1 = box
        if ink < 96 or min(x1 - x0, y1 - y0) < 12:
            continue
        novelty = np.count_nonzero(local[y0:y1, x0:x1] & ~original[y0:y1, x0:x1])
        if novelty < ink * .3:
            continue
        pad = max(8, round(max(x1 - x0, y1 - y0) * .08))
        line_box = clamp_box([x0 - pad, y0 - pad, x1 + pad, y1 + pad], right - left, bottom - top)
        glyphs = []
        # Separate letters can have flourishes outside the text model's alpha.
        # Column gaps provide independent prompts without naming or inventing a glyph.
        projection = significant[y0:y1, x0:x1].any(axis=0)
        starts, gaps, start = [0], [], None
        for index, present in enumerate(projection):
            if not present and start is None:
                start = index
            elif present and start is not None:
                if index - start >= max(4, round((y1 - y0) * .06)):
                    gaps.append((start, index))
                start = None
        if 1 <= len(gaps) <= 3:
            spans = [(a, b) for a, b in zip([0] + [end for _, end in gaps], [begin for begin, _ in gaps] + [x1 - x0])]
            for a, b in spans:
                ys, xs = np.nonzero(significant[y0:y1, x0 + a:x0 + b])
                if len(xs) < 96:
                    continue
                gx0, gy0, gx1, gy1 = x0 + a + int(xs.min()), y0 + int(ys.min()), x0 + a + int(xs.max()) + 1, y0 + int(ys.max()) + 1
                gh = gy1 - gy0
                context = clamp_box([gx0 - gh * .5, gy0 - gh * .12, gx1 + gh * .2, gy1 + gh * .12], right - left, bottom - top)
                glyphs.append({'box': context, 'seedBox': [gx0, gy0, gx1, gy1], 'additive': True})
        proposals.append((novelty, [line_box, *glyphs]))
    return [box for _, boxes in sorted(proposals, key=lambda item: -item[0]) for box in boxes][:4]


def clean_added_speckles(mask, baseline):
    """Remove isolated new inference noise; never erase baseline punctuation or small nearby strokes."""
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8))
    largest = max((int(stats[i, 4]) for i in range(1, count)), default=0)
    limit = max(32, largest * .03)
    anchors = [i for i in range(1, count) if stats[i, 4] >= limit]
    if not anchors:
        return mask.copy()
    solid = np.isin(labels, anchors)
    distance = cv2.distanceTransform((~solid).astype(np.uint8), cv2.DIST_L2, 3)
    nearby = max(2, float(np.median([stats[i, 3] for i in anchors])) * .12)
    output = mask.copy()
    for index in range(1, count):
        if stats[index, 4] >= limit:
            continue
        component = labels == index
        if not np.any(component & baseline) and float(distance[component].min()) > nearby:
            output[component] = False
    return output


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
        cv2.setNumThreads(1)
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
        self.source = source
        self.refiner = None

    def mask(self, key, rgb):
        if key in self.cache:
            self.cache.move_to_end(key)
            return self.cache[key]
        with self.torch.inference_mode():
            self.predictor.set_image(rgb)
            _, logits, _, score = self.predictor.predict(return_logits=True)
        value = np.squeeze(logits) > 0, float(np.squeeze(score))
        self.cache[key] = value
        while len(self.cache) > 6:
            self.cache.popitem(last=False)
        return value

    def view(self, source_hash, rgb, box):
        left, top, right, bottom = box
        key = source_hash + ':' + ','.join(map(str, box))
        local, score = self.mask(key, np.ascontiguousarray(rgb[top:bottom, left:right]))
        if local.shape != (bottom - top, right - left):
            raise ExtractionError('extract_failed', 500)
        mapped = np.zeros(rgb.shape[:2], dtype=bool)
        mapped[top:bottom, left:right] = local
        return mapped, score

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
        first_view = region or [0, 0, width, height]
        baseline, score = self.view(source_hash, rgb, first_view)
        anchor_mask = baseline.copy()
        for left, top, right, bottom in excluded:
            anchor_mask[top:bottom, left:right] = False
        try:
            anchor = region or complete_region(anchor_mask, automatic_region(anchor_mask))
        except ExtractionError:
            anchor = None
        views = selected_views(region) if region else neighboring_views(anchor, width, height) if anchor else [
            [0, 0, width, round(height * .62)], [0, round(height * .38), width, height]]
        mask = baseline.copy()
        for box in views[:2]:
            if box != first_view:
                extra, _ = self.view(source_hash, rgb, box)
                mask |= extra
        region = region or complete_region(mask, anchor or automatic_region(mask))
        reference = mask.copy()
        proposals = refinement_proposals(mask, baseline, region)
        if proposals:
            from sam_refinement import SamRefiner
            if self.refiner is None:
                self.refiner = SamRefiner(self.source)
            left, top, right, bottom = region
            mask[top:bottom, left:right] = self.refiner.refine(
                np.ascontiguousarray(rgb[top:bottom, left:right]), mask[top:bottom, left:right].copy(), proposals)
        left, top, right, bottom = region
        mask[top:bottom, left:right] = clean_added_speckles(mask[top:bottom, left:right], baseline[top:bottom, left:right])
        for left, top, right, bottom in excluded:
            mask[top:bottom, left:right] = False
            reference[top:bottom, left:right] = False
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
                'edgeInkFraction': float(border.mean()), 'maskRetainedFraction': float(np.count_nonzero(crop & reference[top:bottom, left:right]) / max(1, np.count_nonzero(reference[top:bottom, left:right]))),
                'foregroundChangedFraction': 0, 'darkBackgroundContrastRatio': contrast_on_dark(selected_rgb, selected_mask),
                'inkPixels': int(selected_mask.sum()), 'modelFingerprint': MODEL_FINGERPRINT,
            }}
