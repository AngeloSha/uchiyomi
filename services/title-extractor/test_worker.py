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

import numpy as np
from PIL import Image

from worker import Extractor, ExtractionError, MODEL_FINGERPRINT, decode_image, rectangle
from server import State, handler_for


def image_request():
    image = Image.new('RGB', (100, 150), (91, 128, 200))
    output = BytesIO(); image.save(output, format='PNG')
    return {'imageBase64': base64.b64encode(output.getvalue()).decode()}


class MaskTest(unittest.TestCase):
    def extractor(self):
        extractor = Extractor.__new__(Extractor)
        mask = np.zeros((150, 100), dtype=bool)
        mask[45:70, 15:25] = True
        mask[60:70, 25:80] = True
        extractor.mask = lambda key, rgb: (mask, .81)
        return extractor

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

    def test_mask_cache_is_bounded_and_region_independent(self):
        extractor = Extractor.__new__(Extractor)
        extractor.cache = OrderedDict()
        extractor.torch = SimpleNamespace(inference_mode=nullcontext)
        seen = []
        extractor.predictor = SimpleNamespace(set_image=lambda rgb: seen.append(rgb.shape),
            predict=lambda **kwargs: (None, np.ones((1, 12, 20)), None, np.array([.9])))
        rgb = np.zeros((12, 20, 3), dtype=np.uint8)
        extractor.mask('a', rgb); extractor.mask('a', rgb); self.assertEqual(len(seen), 1)
        extractor.mask('b', rgb); extractor.mask('c', rgb)
        self.assertEqual(len(extractor.cache), 2); self.assertNotIn('a', extractor.cache)


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
