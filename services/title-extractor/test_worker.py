import base64
from collections import OrderedDict
from contextlib import nullcontext
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from io import BytesIO
import json
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from pathlib import Path

import numpy as np
from PIL import Image

from worker import Extractor, ExtractionError, MODEL_FINGERPRINT, clean_added_speckles, complete_region, decode_image, normalized, rectangle
from server import State, handler_for


def image_request(width=100, height=150, rgb=None):
    image = Image.fromarray(rgb) if rgb is not None else Image.new('RGB', (width, height), (91, 128, 200))
    output = BytesIO(); image.save(output, format='PNG')
    return {'imageBase64': base64.b64encode(output.getvalue()).decode()}


class CompleteTitleTest(unittest.TestCase):
    def test_cleanup_preserves_baseline_punctuation_and_nearby_new_strokes(self):
        baseline = np.zeros((80, 100), dtype=bool)
        baseline[30:50, 30:50] = True
        baseline[2, 2] = True
        mask = baseline.copy()
        mask[4, 90] = True
        mask[28, 35] = True
        output = clean_added_speckles(mask, baseline)
        self.assertTrue(output[2, 2], 'existing punctuation must never be erased')
        self.assertTrue(output[28, 35], 'a nearby recovered stroke must survive')
        self.assertFalse(output[4, 90], 'isolated new scenery noise should be removed')

    def test_separate_last_character_and_second_line_survive_without_skinny_scenery_or_credits(self):
        mask = np.zeros((340, 260), dtype=bool)
        mask[250:290, 20:160] = True
        mask[250:290, 180:220] = True
        mask[185:225, 50:110] = True
        mask[140:170, 140:150] = True
        mask[300:305, 30:120] = True
        box = complete_region(mask, [20, 250, 160, 290])
        self.assertGreaterEqual(box[2], 220)
        self.assertLessEqual(box[1], 185)
        self.assertGreater(box[1], 170)
        self.assertLess(box[3], 300)


def bounds_from_key(key):
    return list(map(int, key.rsplit(':', 1)[1].split(',')))


def cutout(result):
    return np.asarray(Image.open(BytesIO(base64.b64decode(result['candidateBase64']))))


def global_mask(result):
    """Reconstruct source-grid alpha from the public full-source candidate bounds."""
    width, height = result['sourceWidth'], result['sourceHeight']
    x0, y0, x1, y1 = rectangle(result['candidateRegion'], width, height)
    rgba = cutout(result)
    assert rgba.shape[:2] == (y1 - y0, x1 - x0)
    mask = np.zeros((height, width), dtype=bool)
    mask[y0:y1, x0:x1] = rgba[:, :, 3] > 0
    return mask


def fixture_extractor(infer, refiner=None):
    extractor = Extractor.__new__(Extractor)
    extractor.source = Path('/never-load-models-in-unit-tests')
    extractor.refiner = refiner
    extractor.mask = infer
    return extractor


class MaskTest(unittest.TestCase):
    def extractor(self):
        mask = np.zeros((150, 100), dtype=bool)
        mask[45:70, 15:25] = True
        mask[60:70, 25:80] = True
        def infer(key, rgb):
            left, top, right, bottom = bounds_from_key(key)
            return mask[top:bottom, left:right].copy(), .81
        return fixture_extractor(infer)

    def test_invalid_inputs_and_rectangles_fail_closed(self):
        for rect in ({}, {'left': 0, 'top': 0, 'width': 2, 'height': 1},
                     {'left': 0, 'top': float('nan'), 'width': 1, 'height': 1},
                     {'left': True, 'top': 0, 'width': 1, 'height': 1}):
            with self.subTest(rect=rect), self.assertRaises(ExtractionError):
                rectangle(rect, 100, 150)
        for encoded in ('not base64', '', base64.b64encode(b'not an image').decode()):
            with self.subTest(encoded=encoded), self.assertRaises(ExtractionError):
                decode_image(encoded)
        with self.assertRaises(ExtractionError):
            self.extractor().extract({**image_request(), 'path': '/etc/passwd'})
        with self.assertRaises(ExtractionError):
            self.extractor().extract({**image_request(), 'exclusions': [{}] * 9})

    def test_preview_preserves_real_rgb_alpha_fingerprint_and_exclusions(self):
        extractor = self.extractor()
        request = {**image_request(), 'region': {'left': .05, 'top': .2, 'width': .9, 'height': .4}}
        first = extractor.extract(request)
        self.assertEqual(first['modelFingerprint'], MODEL_FINGERPRINT)
        image = Image.open(BytesIO(base64.b64decode(first['candidateBase64'])))
        rgba = np.asarray(image)
        self.assertEqual(set(np.unique(rgba[:, :, 3])), {0, 255})
        self.assertTrue(np.all(rgba[rgba[:, :, 3] == 255][:, :3] == [91, 128, 200]))
        self.assertEqual(first['evidence']['foregroundChangedFraction'], 0)
        self.assertEqual(first['evidence']['edgeInkFraction'], 0)
        modified = extractor.extract({**request, 'exclusions': [{'left': .1, 'top': .25, 'width': .2, 'height': .3}]})
        self.assertLess(modified['evidence']['inkPixels'], first['evidence']['inkPixels'])
        self.assertEqual(extractor.extract(request)['candidateBase64'], first['candidateBase64'], 'exclusions cannot mutate a cached mask')
        with self.assertRaises(ExtractionError):
            extractor.extract({**image_request(), 'region': {'left': 0, 'top': 0, 'width': .1, 'height': .1}})

    def test_mask_cache_is_bounded_and_separates_equal_sized_view_coordinates(self):
        extractor = Extractor.__new__(Extractor)
        extractor.cache = OrderedDict()
        extractor.torch = SimpleNamespace(inference_mode=nullcontext)
        seen = []
        current = {}
        def set_image(rgb):
            seen.append(rgb.copy()); current['shape'] = rgb.shape[:2]
        extractor.predictor = SimpleNamespace(set_image=set_image,
            predict=lambda **kwargs: (None, np.ones((1, *current['shape'])), None, np.array([.9])))
        rgb = np.zeros((80, 100, 3), dtype=np.uint8)
        rgb[:, 20:40] = [100, 150, 200]
        first, _ = extractor.view('same-source', rgb, [0, 0, 20, 12])
        extractor.view('same-source', rgb, [0, 0, 20, 12]); self.assertEqual(len(seen), 1)
        second, _ = extractor.view('same-source', rgb, [20, 0, 40, 12]); self.assertEqual(len(seen), 2)
        self.assertFalse(np.array_equal(seen[0], seen[1]))
        self.assertTrue(first[:12, :20].all()); self.assertFalse(first[:, 20:].any())
        self.assertTrue(second[:12, 20:40].all()); self.assertFalse(second[:, :20].any())
        for x in range(1, 7): extractor.view('same-source', rgb, [x, 20, x + 20, 32])
        self.assertEqual(len(extractor.cache), 6)
        self.assertNotIn('same-source:0,0,20,12', extractor.cache)
        self.assertEqual(set(extractor.weak_cache), set(extractor.cache))
        self.assertEqual(len(extractor.weak_cache), 6)
        self.assertTrue(all(value.dtype == np.bool_ for value in extractor.weak_cache.values()))

    def test_manual_roi_and_split_masks_map_to_original_rgb_and_global_bounds(self):
        yy, xx = np.indices((150, 100)); rgb = np.dstack((xx, yy, (xx + yy) % 255)).astype(np.uint8)
        region = [20, 40, 90, 110]; observed = []; refinements = []
        baseline = np.zeros((150, 100), dtype=bool); baseline[83:97, 40:80] = True
        upper = baseline.copy(); upper[47:64, 25:48] = True
        def infer(key, view):
            box = bounds_from_key(key); observed.append(box)
            self.assertEqual(view.shape[:2], (box[3] - box[1], box[2] - box[0]))
            self.assertTrue(np.array_equal(view, rgb[box[1]:box[3], box[0]:box[2]]))
            chosen = baseline if box == region else upper
            return chosen[box[1]:box[3], box[0]:box[2]].copy(), .9
        class FakeRefiner:
            def __init__(self, source): refinements.append(('factory', str(source)))
            def refine(self, view, mask, proposals):
                refinements.append(('refine', view.shape, proposals)); return mask
        extractor = fixture_extractor(infer)
        with patch.dict('sys.modules', {'sam_refinement': SimpleNamespace(SamRefiner=FakeRefiner)}):
            result = extractor.extract({**image_request(rgb=rgb), 'region': normalized(region, 100, 150)})
        self.assertEqual(observed, [region, [20, 40, 90, 83], [20, 67, 90, 110]])
        expected = upper.copy(); expected[:40] = False; expected[110:] = False; expected[:, :20] = False; expected[:, 90:] = False
        self.assertTrue(np.array_equal(global_mask(result), expected))
        self.assertEqual(rectangle(result['candidateRegion'], 100, 150), [25, 47, 80, 97])
        self.assertEqual(result['region'], normalized(region, 100, 150))
        self.assertEqual((result['sourceWidth'], result['sourceHeight']), (100, 150))
        rgba = cutout(result); self.assertTrue(np.array_equal(rgba[:, :, :3], rgb[47:97, 25:80]))
        self.assertEqual([item[0] for item in refinements], ['factory', 'refine'])
        local_proposal = refinements[1][2][0]
        self.assertTrue(0 <= local_proposal[0] < local_proposal[2] <= 70)
        self.assertTrue(0 <= local_proposal[1] < local_proposal[3] <= 70)

    def test_exclusions_win_even_when_split_views_and_refinement_reintroduce_ink(self):
        region = [20, 40, 90, 110]; baseline = np.zeros((150, 100), dtype=bool); baseline[83:97, 40:80] = True
        extra = baseline.copy(); extra[47:66, 25:48] = True
        def infer(key, rgb):
            box = bounds_from_key(key); mask = baseline if box == region else extra
            return mask[box[1]:box[3], box[0]:box[2]].copy(), .9
        refined = []
        class FakeRefiner:
            def __init__(self, source): pass
            def refine(self, rgb, mask, proposals):
                refined.append(proposals); return np.ones_like(mask)
        extractor = fixture_extractor(infer)
        with patch.dict('sys.modules', {'sam_refinement': SimpleNamespace(SamRefiner=FakeRefiner)}):
            result = extractor.extract({**image_request(), 'region': normalized(region, 100, 150),
                'exclusions': [normalized([30, 50, 40, 60], 100, 150)]})
        self.assertEqual(len(refined), 1)
        mapped = global_mask(result)
        self.assertFalse(mapped[50:60, 30:40].any(), 'A refiner cannot paint back an excluded author/volume region')
        self.assertTrue(mapped[40:50, 20:90].all())
        self.assertFalse(mapped[:40].any()); self.assertFalse(mapped[110:].any())

    def test_adjacent_full_sized_title_lines_are_grouped_but_small_credits_are_not(self):
        for vertical in [False, True]:
            mask = np.zeros((300, 260), dtype=bool)
            if not vertical:
                mask[160:190, 40:220] = True; mask[110:140, 60:180] = True; mask[205:211, 70:190] = True
                result = complete_region(mask, [40, 160, 220, 190])
                self.assertLessEqual(result[1], 110); self.assertGreaterEqual(result[3], 190); self.assertLess(result[3], 205)
            else:
                mask[60:220, 150:180] = True; mask[90:210, 110:140] = True; mask[90:210, 198:204] = True
                result = complete_region(mask, [150, 60, 180, 220])
                self.assertLessEqual(result[0], 110); self.assertGreaterEqual(result[2], 180); self.assertLess(result[2], 198)

    def test_automatic_neighbor_views_recover_a_global_second_line_without_keeping_small_credits(self):
        baseline = np.zeros((300, 260), dtype=bool)
        baseline[170:205, 50:230] = True; baseline[230:236, 60:220] = True
        recovered = baseline.copy(); recovered[130:160, 80:190] = True
        seen = []
        def infer(key, rgb):
            box = bounds_from_key(key); seen.append(box)
            mask = baseline if box == [0, 0, 260, 300] else recovered
            self.assertEqual(rgb.shape[:2], (box[3] - box[1], box[2] - box[0]))
            return mask[box[1]:box[3], box[0]:box[2]].copy(), .91
        class FakeRefiner:
            def __init__(self, source): pass
            def refine(self, rgb, mask, proposals): return mask
        with patch.dict('sys.modules', {'sam_refinement': SimpleNamespace(SamRefiner=FakeRefiner)}):
            result = fixture_extractor(infer).extract(image_request(260, 300))
        self.assertEqual(seen[0], [0, 0, 260, 300]); self.assertEqual(len(seen), 3)
        mapped = global_mask(result)
        self.assertTrue(mapped[130:160, 80:190].all(), 'A newly detected adjacent title line must remain in source coordinates')
        self.assertTrue(mapped[170:205, 50:230].all())
        self.assertFalse(mapped[230:236, 60:220].any(), 'Small nearby credits must not expand the chosen title region')
        self.assertEqual(rectangle(result['candidateRegion'], 260, 300), [50, 130, 230, 205])

    def test_exclusions_do_not_mutate_real_view_cache_entries(self):
        extractor = Extractor.__new__(Extractor); extractor.cache = OrderedDict(); extractor.torch = SimpleNamespace(inference_mode=nullcontext)
        predictor_input = {}; count = []
        def set_image(rgb): predictor_input['rgb'] = rgb; count.append(1)
        # Every view independently detects the same colored fixture lettering, with no real CPU model loaded.
        def predict(**kwargs):
            rgb = predictor_input['rgb']; found = rgb[:, :, 0] == 220
            return None, np.where(found[None], 1, -1), None, np.array([.9])
        extractor.predictor = SimpleNamespace(set_image=set_image, predict=predict); extractor.source = Path('/unused'); extractor.refiner = None
        rgb = np.zeros((150, 100, 3), dtype=np.uint8); rgb[45:70, 15:25] = [220, 180, 90]; rgb[60:70, 25:80] = [220, 180, 90]
        request = {**image_request(rgb=rgb), 'region': normalized([5, 30, 95, 90], 100, 150)}
        first = extractor.extract(request); cache = {key: value[0].copy() for key, value in extractor.cache.items()}; calls = len(count)
        weak_cache = {key: value.copy() for key, value in extractor.weak_cache.items()}
        removed = extractor.extract({**request, 'exclusions': [normalized([10, 35, 30, 80], 100, 150)]})
        self.assertLess(removed['evidence']['inkPixels'], first['evidence']['inkPixels'])
        self.assertEqual(len(count), calls)
        self.assertTrue(all(np.array_equal(mask, extractor.cache[key][0]) for key, mask in cache.items()))
        self.assertTrue(all(np.array_equal(mask, extractor.weak_cache[key]) for key, mask in weak_cache.items()))
        self.assertEqual(extractor.extract(request)['candidateBase64'], first['candidateBase64'])

    def test_wrong_view_shape_is_rejected_before_any_global_paste(self):
        extractor = fixture_extractor(lambda key, rgb: (np.zeros((150, 100), dtype=bool), .9))
        with self.assertRaises(ExtractionError) as problem:
            extractor.view('fixture', np.zeros((150, 100, 3), dtype=np.uint8), [20, 40, 90, 110])
        self.assertEqual(problem.exception.code, 'extract_failed')
        self.assertEqual(problem.exception.status, 500)


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.token = 'test-local-extraction-token-' + 'x' * 32
        self.state = State(self.token, SimpleNamespace(extract=lambda value: {'ok': True}))
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(self.state))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.port = self.server.server_port

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(2)

    def request(self, method, path, body=None, authorized=True, headers=None):
        connection = HTTPConnection('127.0.0.1', self.port, timeout=3)
        try:
            actual = {'authorization': 'Bearer ' + self.token} if authorized else {}
            actual.update(headers or {})
            if body is not None:
                body = json.dumps(body); actual['content-type'] = 'application/json'
            connection.request(method, path, body, actual)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_private_health_and_unavailable_service(self):
        self.assertEqual(self.request('GET', '/healthz', authorized=False)[0], 401)
        self.assertEqual(self.request('GET', '/healthz')[1]['modelFingerprint'], MODEL_FINGERPRINT)
        self.state.extractor = None
        self.assertEqual(self.request('GET', '/healthz')[0], 503)
        self.assertEqual(self.request('POST', '/v1/extract', {})[0], 503)
        with self.assertRaises(ValueError):
            State('short')

    def test_body_limits_and_unknown_paths(self):
        self.assertEqual(self.request('POST', '/v1/extract', headers={'content-length': str(17 * 1024 * 1024), 'content-type': 'application/json'})[0], 413)
        self.assertEqual(self.request('POST', '/other', {})[0], 404)
        self.assertEqual(self.request('POST', '/v1/extract')[0], 400)

    def test_busy_inference_does_not_block_health_and_gate_always_releases(self):
        started, release = threading.Event(), threading.Event()
        results = []
        def blocked(body):
            started.set(); release.wait(3); return {'ok': True}
        self.state.extractor = SimpleNamespace(extract=blocked)
        pending = threading.Thread(target=lambda: results.append(self.request('POST', '/v1/extract', {})))
        pending.start()
        try:
            self.assertTrue(started.wait(2))
            self.assertEqual(self.request('GET', '/healthz')[0], 200)
            self.assertEqual(self.request('POST', '/v1/extract', {})[0], 429)
        finally:
            release.set(); pending.join(3)
        self.assertEqual(results[0][0], 200)
        self.state.extractor = SimpleNamespace(extract=lambda body: (_ for _ in ()).throw(RuntimeError('private internal error')))
        self.assertEqual(self.request('POST', '/v1/extract', {})[1], {'error': 'extraction_failed'})
        self.assertEqual(self.request('GET', '/healthz')[0], 200)


if __name__ == '__main__':
    unittest.main()
