#!/usr/bin/env python3
"""
Local dev server for We Move It. We Clear It.
Serves static files and auto-resolves clean URLs (no .html required).
Usage: python server.py
"""
from http.server import HTTPServer, SimpleHTTPRequestHandler
import os


class HtmlFallbackHandler(SimpleHTTPRequestHandler):
    """Extend SimpleHTTPRequestHandler to resolve /page → /page.html."""

    def translate_path(self, path):
        fs_path = super().translate_path(path)
        # If the resolved filesystem path doesn't exist AND has no extension,
        # check whether appending .html resolves to a real file.
        if not os.path.exists(fs_path) and '.' not in os.path.basename(fs_path):
            candidate = fs_path + '.html'
            if os.path.exists(candidate):
                return candidate
        return fs_path

    def end_headers(self):
        # Disable caching during development so CSS/JS changes appear immediately.
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        # Suppress the noisy favicon 404 so the console stays clean.
        if args and '"/favicon.ico"' in str(args[0]):
            return
        super().log_message(fmt, *args)


if __name__ == '__main__':
    port = 8000
    server = HTTPServer(('', port), HtmlFallbackHandler)
    print(f'Serving at http://localhost:{port}  (Ctrl+C to stop)')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nServer stopped.')
