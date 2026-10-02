#!/usr/bin/env python3
"""
SMART MINE SAFETY CONTROL CENTER - MOCK ESP32 REST SERVER
Serves both the web dashboard and provides a REST API endpoint matching
the exact JSON schema specified for the college prototype.

Usage:
    python esp32_mock_server.py [port]

Endpoints:
    GET  /           -> Serves index.html
    GET  /api/data   -> Returns current sensor payload in JSON
    POST /api/data   -> Updates sensor telemetry from external ESP32 or script
    POST /api/preset -> Switch presets ('normal', 'warning', 'emergency', 'toxic')
"""

import sys
import json
import random
from http.server import SimpleHTTPRequestHandler, HTTPServer
import urllib.parse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5000

# Global telemetry store matching exact expected format
sensor_payload = {
    "zone": "M2",
    "location": "Mine Zone M2",
    "methane": 1800,
    "co": 1200,
    "mq135": 1400,
    "temperature": 38,
    "humidity": 65,
    "status": "WARNING",
    "safeRoute": "M2 -> M1 -> MAIN EXIT"
}

class MineTelemetryHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Enable CORS for cross-origin local testing
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == '/api/data':
            # Slightly modulate values for realistic live streaming
            jittered_payload = dict(sensor_payload)
            jittered_payload["methane"] += random.randint(-15, 15)
            jittered_payload["co"] += random.randint(-5, 5)
            jittered_payload["mq135"] += random.randint(-10, 10)
            jittered_payload["temperature"] = round(jittered_payload["temperature"] + random.uniform(-0.2, 0.2), 1)
            jittered_payload["humidity"] = round(jittered_payload["humidity"] + random.uniform(-0.5, 0.5), 1)

            resp_bytes = json.dumps(jittered_payload, indent=2).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(resp_bytes)))
            self.end_headers()
            self.wfile.write(resp_bytes)
            return

        # Default: Serve static assets (index.html, styles.css, app.js)
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        if parsed.path == '/api/data':
            try:
                data = json.loads(body.decode('utf-8'))
                sensor_payload.update(data)
                resp = json.dumps({"status": "success", "updated": sensor_payload}).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(resp)))
                self.end_headers()
                self.wfile.write(resp)
            except Exception as e:
                self.send_error(400, f"Invalid JSON: {str(e)}")
            return

        if parsed.path == '/api/preset':
            try:
                data = json.loads(body.decode('utf-8'))
                mode = data.get('preset', 'normal')
                if mode == 'normal':
                    sensor_payload.update({
                        "zone": "M1",
                        "location": "Mine Zone M1",
                        "methane": 420,
                        "co": 18,
                        "mq135": 110,
                        "temperature": 27.4,
                        "humidity": 58,
                        "status": "SAFE",
                        "safeRoute": "M1 -> MAIN EXIT"
                    })
                elif mode == 'warning':
                    sensor_payload.update({
                        "zone": "M2",
                        "location": "Mine Zone M2",
                        "methane": 1800,
                        "co": 1200,
                        "mq135": 1400,
                        "temperature": 38,
                        "humidity": 65,
                        "status": "WARNING",
                        "safeRoute": "M2 -> M1 -> MAIN EXIT"
                    })
                elif mode == 'emergency':
                    sensor_payload.update({
                        "zone": "M2",
                        "location": "Mine Zone M2",
                        "methane": 2900,
                        "co": 1850,
                        "mq135": 2100,
                        "temperature": 48,
                        "humidity": 72,
                        "status": "EMERGENCY",
                        "safeRoute": "M2 -> M1 -> MAIN EXIT"
                    })
                resp = json.dumps({"status": "preset applied", "data": sensor_payload}).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(resp)))
                self.end_headers()
                self.wfile.write(resp)
            except Exception as e:
                self.send_error(400, f"Invalid preset: {str(e)}")
            return

        self.send_error(404, "Endpoint not found")

def run():
    server_address = ('', PORT)
    httpd = HTTPServer(server_address, MineTelemetryHandler)
    print(f"============================================================")
    print(f"  SMART MINE SAFETY CONTROL CENTER - HTTP SERVER")
    print(f"============================================================")
    print(f"  Dashboard UI:   http://localhost:{PORT}/")
    print(f"  REST Endpoint:  http://localhost:{PORT}/api/data")
    print(f"  CORS enabled:   Yes (accepts external requests)")
    print(f"============================================================")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server.")
        httpd.server_close()

if __name__ == '__main__':
    run()
