"""Private authenticated local inference service; one active model request, responsive health checks."""
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import threading
import time

from worker import Extractor, ExtractionError, MODEL_FINGERPRINT

MAX_BODY = 16 * 1024 * 1024


class State:
    def __init__(self, token, extractor=None):
        if len(token) < 32:
            raise ValueError('TITLE_EXTRACTOR_TOKEN must contain at least 32 characters')
        self.token = token
        self.extractor = extractor
        self.lock = threading.BoundedSemaphore(1)


def handler_for(state):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *args):
            pass  # Never log request bodies, source images or credentials.

        def reply(self, status, body):
            data = json.dumps(body, allow_nan=False).encode()
            self.send_response(status)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(data)))
            self.send_header('cache-control', 'no-store')
            self.send_header('connection', 'close')
            if status == 429:
                self.send_header('retry-after', '3')
            self.end_headers()
            self.close_connection = True
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def authorized(self):
            value = self.headers.get('authorization', '')
            if not hmac.compare_digest(value.encode(), ('Bearer ' + state.token).encode()):
                self.reply(401, {'error': 'unauthorized'})
                return False
            return True

        def do_GET(self):
            if not self.authorized():
                return
            if self.path != '/healthz':
                return self.reply(404, {'error': 'not_found'})
            return self.reply(200 if state.extractor else 503, {'ready': state.extractor is not None,
                'version': 1, 'model': 'Hi-SAM / SAM-TS-B TextSeg', 'modelFingerprint': MODEL_FINGERPRINT,
                'ocrReady': False, 'maxInputBytes': 11 * 1024 * 1024, 'maxInputPixels': 12_000_000})

        def do_POST(self):
            if not self.authorized():
                return
            if self.path != '/v1/extract':
                return self.reply(404, {'error': 'not_found'})
            if state.extractor is None:
                return self.reply(503, {'error': 'not_ready'})
            if self.headers.get('content-type', '').split(';')[0].strip() != 'application/json' or self.headers.get('transfer-encoding'):
                return self.reply(400, {'error': 'bad_request'})
            try:
                length = int(self.headers.get('content-length', ''))
            except ValueError:
                return self.reply(411, {'error': 'length_required'})
            if not 1 <= length <= MAX_BODY:
                return self.reply(413, {'error': 'too_large'})
            if not state.lock.acquire(blocking=False):
                return self.reply(429, {'error': 'busy'})
            try:
                self.connection.settimeout(20)
                body = self.rfile.read(length)
                if len(body) != length:
                    return self.reply(400, {'error': 'bad_request'})
                started = time.monotonic()
                result = state.extractor.extract(json.loads(body))
                result['ms'] = round((time.monotonic() - started) * 1000)
                return self.reply(200, result)
            except ExtractionError as error:
                return self.reply(error.status, {'error': error.code})
            except (ValueError, UnicodeError, TimeoutError):
                return self.reply(400, {'error': 'bad_request'})
            except Exception:
                return self.reply(500, {'error': 'extraction_failed'})
            finally:
                state.lock.release()
    return Handler


def main():
    state = State(os.environ.get('TITLE_EXTRACTOR_TOKEN', ''))
    server = ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('PORT', '3081'))), handler_for(state))
    server.daemon_threads = True

    def load():
        try:
            os.nice(10)
            threads = max(1, min(3, int(os.environ.get('INFERENCE_THREADS', '3'))))
            state.extractor = Extractor(os.environ.get('HI_SAM_DIR', '/opt/hi-sam'), threads)
            print('Title extractor ready', flush=True)
        except Exception as error:
            print('Title extractor unavailable: ' + type(error).__name__, flush=True)
    threading.Thread(target=load, daemon=True).start()
    server.serve_forever(poll_interval=.5)


if __name__ == '__main__':
    main()
