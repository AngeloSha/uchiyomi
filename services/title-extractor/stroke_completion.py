"""Conservative, model-supported completion of dark lettering edges. Alpha only; no invented RGB.

Dark components are measured on the WHOLE prepared image before any proposal,
model-support or distance clipping. A large connected background region cannot
become a plausible little outline by cutting away its inconvenient pixels.
"""
import cv2
import numpy as np

STROKE_COMPLETION_POLICY = {
    'version': 'model-dark-components-v2-counter-safe', 'weakLogit': -6., 'coreQuantile': .6,
    'coreRatio': .65, 'darkRatio': .35, 'darkCap': 64., 'nearFraction': .04, 'nearMax': 24.,
    'componentAreaRatio': .15, 'totalAddedRatio': .2, 'supportFraction': .5, 'minArea': 4,
    'maxComponentWork': 8_000_000, 'componentWorkPerPixel': 4, 'preserveCounters': 'seed-complement-4-connected',
}
MAX_PIXELS = 1200 * 1600


def complete_dark_strokes(rgb, seed, supported, region):
    rgb, seed, supported = np.asarray(rgb), np.asarray(seed), np.asarray(supported)
    if (rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.dtype != np.uint8
            or seed.shape != rgb.shape[:2] or seed.dtype != np.bool_
            or supported.shape != seed.shape or supported.dtype != np.bool_
            or not 1 <= seed.size <= MAX_PIXELS):
        raise ValueError('invalid_stroke_completion_image')
    height, width = seed.shape
    if (not isinstance(region, (list, tuple)) or len(region) != 4
            or any(isinstance(v, (bool, np.bool_)) or not isinstance(v, (int, np.integer)) for v in region)):
        raise ValueError('invalid_stroke_completion_region')
    left, top, right, bottom = map(int, region)
    if not (0 <= left < right <= width and 0 <= top < bottom <= height):
        raise ValueError('invalid_stroke_completion_region')
    output = seed.copy()
    local_seed = seed[top:bottom, left:right]
    seed_area = int(local_seed.sum())
    if seed_area < 40:
        return output
    policy = STROKE_COMPLETION_POLICY
    luma = rgb @ np.array([.2126, .7152, .0722])
    core_luma = float(np.quantile(luma[top:bottom, left:right][local_seed], policy['coreQuantile']))
    # There is no evidence for a darker surrounding stroke on an already dark title.
    if core_luma < 64:
        return output
    credible = np.zeros_like(seed)
    credible[top:bottom, left:right] = local_seed & (luma[top:bottom, left:right] >= core_luma * policy['coreRatio'])
    distance = cv2.distanceTransform((~credible).astype(np.uint8), cv2.DIST_L2, 5)
    radius = max(3., min(policy['nearMax'], min(width, height) * policy['nearFraction']))
    # Preserve transparent counters (font holes) from the ORIGINAL seed before adding any outline.
    # Padding gives all image-edge background one common exterior flood-fill entry point.
    exterior = np.pad((~seed).astype(np.uint8), 1, constant_values=1)
    cv2.floodFill(exterior, None, (0, 0), 0, flags=4)
    counters = exterior[1:-1, 1:-1] != 0
    dark = luma < min(policy['darkCap'], core_luma * policy['darkRatio'])
    count, labels, stats, _ = cv2.connectedComponentsWithStats(dark.astype(np.uint8))
    additions = []
    work = 0
    for index in range(1, count):
        x, y, w, h, area = map(int, stats[index])
        if (area < policy['minArea'] or area > seed_area * policy['componentAreaRatio']
                or x <= 0 or y <= 0 or x + w >= width or y + h >= height
                or x < left or y < top or x + w > right or y + h > bottom):
            continue
        work += w * h
        if work > min(policy['maxComponentWork'], seed.size * policy['componentWorkPerPixel']):
            return output
        component = labels[y:y + h, x:x + w] == index
        # Reject the whole source component, rather than trimming a counter out of an unsafe addition.
        if np.any(component & counters[y:y + h, x:x + w]):
            continue
        distances = distance[y:y + h, x:x + w][component]
        if float(distances.min()) > 2 or float(distances.max()) > radius:
            continue
        support = supported[y:y + h, x:x + w]
        if int(np.count_nonzero(component & support)) < area * policy['supportFraction']:
            continue
        # Only actual model-supported source pixels are eligible. Never accept a color-only dilation.
        add = component & support & ~seed[y:y + h, x:x + w]
        if add.any():
            additions.append((x, y, add))
    # Refuse the entire uncertain expansion rather than clipping it down to an arbitrary area budget.
    if sum(int(add.sum()) for _, _, add in additions) > seed_area * policy['totalAddedRatio']:
        return output
    for x, y, add in additions:
        h, w = add.shape
        output[y:y + h, x:x + w] |= add
    return output
