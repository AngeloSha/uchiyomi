"""Bounded original-SAM refinement of independently proposed text-line boxes.

This only returns alpha masks. It never edits RGB, generates lettering, downloads
weights or certifies title completeness. Callers must supply credible text seeds;
SAM's predicted mask-quality score is deliberately not used to select a mask.
"""
import hashlib
import math
import os
from pathlib import Path
import sys
from types import SimpleNamespace

import numpy as np

MAX_PROPOSALS = 4
MAX_PREPARED_PIXELS = 1200 * 1600
BASE_CHECKPOINT_SHA256 = 'ec2df62732614e57411cdcf32a23ffdf28910380d03139ee0f4fcbe91eb8c912'
MAX_CHECKPOINT_BYTES = 400 * 1024 * 1024


def _box(value, width, height):
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise ValueError('invalid_refinement_box')
    if any(isinstance(v, (bool, np.bool_)) or not isinstance(v, (int, np.integer)) for v in value):
        raise ValueError('invalid_refinement_box')
    left, top, right, bottom = map(int, value)
    if not (0 <= left < right <= width and 0 <= top < bottom <= height):
        raise ValueError('invalid_refinement_box')
    return left, top, right, bottom


def select_refinement(seed, candidates, box, *, min_seed_retention=.90,
                      max_area_ratio=4., max_foreground_fraction=.70):
    """Return the smallest bounded candidate that preserves credible seed ink.

    All masks use the same cropped-image coordinate system. A candidate leaking
    beyond the proposal is rejected, rather than clipped to hide background ink.
    If none qualifies, return None; the caller retains its unmodified seed mask.
    """
    seed = np.asarray(seed)
    if seed.ndim != 2 or seed.dtype != np.bool_ or seed.size > MAX_PREPARED_PIXELS:
        raise ValueError('invalid_refinement_seed')
    if not (math.isfinite(min_seed_retention) and .90 <= min_seed_retention <= 1
            and math.isfinite(max_area_ratio) and 1 <= max_area_ratio <= 4
            and math.isfinite(max_foreground_fraction) and 0 < max_foreground_fraction <= .70):
        raise ValueError('invalid_refinement_limits')
    height, width = seed.shape
    left, top, right, bottom = _box(box, width, height)
    local_seed = seed[top:bottom, left:right]
    seed_area = int(local_seed.sum())
    if not seed_area:
        return None
    box_area = (right - left) * (bottom - top)
    best, best_area = None, None
    # Original SAM has exactly four mask tokens, including its single-mask token.
    for index, value in enumerate(candidates):
        if index >= 4:
            break
        candidate = np.asarray(value)
        if candidate.shape != seed.shape or candidate.dtype != np.bool_:
            continue
        area = int(candidate.sum())
        local = candidate[top:bottom, left:right]
        local_area = int(local.sum())
        if area != local_area or area < seed_area * .90:
            continue
        retained = int(np.count_nonzero(local & local_seed))
        if retained < seed_area * min_seed_retention:
            continue
        if area > seed_area * max_area_ratio or area > box_area * max_foreground_fraction:
            continue
        if best_area is None or area < best_area:
            best, best_area = candidate.copy(), area
    return best


class SamRefiner:
    """Lazy original-SAM ViT-B using the already pinned local base checkpoint.

    Hi-SAM changes its encoder through trained adapters and its decoder through
    text training. We restore every original-SAM weight, disable both encoder
    adapters and run only the original low-resolution prompted decoder. Passing
    points to Hi-SAM's ordinary text predictor would not do this.
    """
    def __init__(self, source, torch_module=None):
        self.source = Path(source).resolve()
        self.torch = torch_module
        self.predictor = None

    def _ensure_model(self):
        if self.predictor is not None:
            return
        os.environ['TORCH_FORCE_WEIGHTS_ONLY_LOAD'] = '1'
        if self.torch is None:
            import torch
            self.torch = torch
        torch = self.torch
        sys.path.insert(0, str(self.source))
        from hi_sam.modeling.build import model_registry
        from hi_sam.modeling.predictor import SamPredictor
        # Verify and deserialize the same file descriptor; never download models.
        checkpoint = self.source / 'pretrained_checkpoint' / 'sam_vit_b_01ec64.pth'
        with checkpoint.open('rb') as handle:
            if os.fstat(handle.fileno()).st_size > MAX_CHECKPOINT_BYTES:
                raise RuntimeError('sam_checkpoint_size')
            digest = hashlib.sha256()
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
            if digest.hexdigest() != BASE_CHECKPOINT_SHA256:
                raise RuntimeError('sam_checkpoint_checksum')
            handle.seek(0)
            state = torch.load(handle, map_location='cpu', weights_only=True)
        model = model_registry['vit_b'](SimpleNamespace(
            checkpoint=None, model_type='vit_b', hier_det=False,
            attn_layers=1, prompt_len=12)).eval().to('cpu')
        info = model.load_state_dict(state, strict=False)
        # The verified base checkpoint has every original encoder/prompt/decoder
        # key. Only Hi-SAM additions, all unused below, may remain uninitialized.
        if info.unexpected_keys or any(not (
                'Adapter' in key or key.startswith('modal_aligner.') or '_hr.' in key
        ) for key in info.missing_keys):
            raise RuntimeError('sam_checkpoint_architecture')
        del state
        for block in model.image_encoder.blocks:
            block.Space_Adapter = torch.nn.Identity()
            block.MLP_Adapter = torch.nn.Identity()
            block.scale = 0
        self.predictor = SamPredictor(model)

    def _predict_masks(self, box):
        torch, predictor = self.torch, self.predictor
        model, decoder = predictor.model, predictor.model.mask_decoder
        transformed = predictor.transform.apply_boxes(np.asarray([box], dtype=np.float32), predictor.original_size)
        boxes = torch.as_tensor(transformed, dtype=torch.float32, device=model.device)
        sparse, dense = model.prompt_encoder(points=None, boxes=boxes, masks=None)
        tokens = torch.cat((torch.cat((decoder.iou_token.weight, decoder.mask_tokens.weight), dim=0)[None], sparse), dim=1)
        features = predictor.features + dense
        batch, channels, height, width = features.shape
        hidden, features = decoder.transformer(features, model.prompt_encoder.get_dense_pe(), tokens)
        mask_tokens = hidden[:, 1:1 + decoder.num_mask_tokens]
        upscaled = decoder.output_upscaling(features.transpose(1, 2).view(batch, channels, height, width))
        hyper = torch.stack([decoder.output_hypernetworks_mlps[index](mask_tokens[:, index])
                             for index in range(decoder.num_mask_tokens)], dim=1)
        masks = (hyper @ upscaled.flatten(2)).view(batch, decoder.num_mask_tokens, *upscaled.shape[-2:])
        masks = model.postprocess_masks(masks, predictor.input_size, predictor.original_size)
        # No predicted quality score enters selection; four independent alphas.
        return (masks[0] > 0).detach().cpu().numpy()

    def refine(self, rgb_crop, seed_mask, proposals):
        rgb, seed = np.asarray(rgb_crop), np.asarray(seed_mask)
        if (rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.dtype != np.uint8
                or min(rgb.shape[:2]) < 2 or rgb.shape[0] * rgb.shape[1] > MAX_PREPARED_PIXELS
                or seed.shape != rgb.shape[:2] or seed.dtype != np.bool_):
            raise ValueError('invalid_refinement_image')
        if not isinstance(proposals, (list, tuple)) or len(proposals) > MAX_PROPOSALS:
            raise ValueError('invalid_refinement_proposals')
        height, width = seed.shape
        boxes = []
        for value in proposals:
            if isinstance(value, dict):
                if set(value) != {'box', 'seedBox', 'additive'} or value['additive'] is not True:
                    raise ValueError('invalid_refinement_proposal')
                box = _box(value['box'], width, height)
                seed_box = _box(value['seedBox'], width, height)
                if not (box[0] <= seed_box[0] < seed_box[2] <= box[2] and box[1] <= seed_box[1] < seed_box[3] <= box[3]):
                    raise ValueError('invalid_refinement_seed_box')
                boxes.append((box, seed_box, True))
            else:
                box = _box(value, width, height)
                boxes.append((box, box, False))
        # A proposal without credible seed must never trigger model inference.
        boxes = [entry for entry in boxes if seed[entry[1][1]:entry[1][3], entry[1][0]:entry[1][2]].any()]
        output = seed.copy()
        if not boxes:
            return output
        self._ensure_model()
        with self.torch.inference_mode():
            try:
                self.predictor.set_image(np.ascontiguousarray(rgb))
                for box, seed_box, additive in boxes:
                    credible = np.zeros_like(seed)
                    sx0, sy0, sx1, sy1 = seed_box
                    credible[sy0:sy1, sx0:sx1] = seed[sy0:sy1, sx0:sx1]
                    chosen = select_refinement(credible, self._predict_masks(box), box)
                    if chosen is not None:
                        if additive:
                            output |= chosen
                            continue
                        # Accepted candidates may remove weak-seed contamination
                        # inside the proposal. Outside it, original alpha survives.
                        left, top, right, bottom = box
                        output[top:bottom, left:right] = chosen[top:bottom, left:right]
            finally:
                # This helper is called infrequently; do not retain source image
                # embeddings after returning or after a decoder exception.
                self.predictor.reset_image()
        return output
