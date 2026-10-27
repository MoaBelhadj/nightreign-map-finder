# Serves this folder on localhost for the Live companion. "no-cache" makes Edge recheck each file, so an update shows on the next reload.
import http.server, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
print(f"Live companion: http://localhost:{port}/nightreign-map-finder.html#live  (close this window to stop)")
http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
