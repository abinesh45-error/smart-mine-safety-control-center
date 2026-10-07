#!/usr/bin/env python3
"""
SMART MINE SAFETY CONTROL CENTER - RENDER & ESP32 PRODUCTION BACKEND
Serves the web dashboard, manages the SQLite database layer, provides secure REST API
for physical ESP32 devices (POST /api/esp32/data), and supports live polling and history.

Endpoints:
    GET  /                  -> Serves index.html dashboard
    POST /api/esp32/data    -> Secure ingestion endpoint for physical ESP32
    GET  /api/esp32/data    -> Live telemetry & online/offline device status
    GET  /api/esp32/history -> Historical sensor readings from SQLite database
    GET  /api/data          -> Compatibility endpoint for general telemetry
    POST /api/data          -> Compatibility telemetry update
    POST /api/preset        -> Preset switcher for college presentations
"""

import os
import sys
import json
import time
import random
import sqlite3
import datetime
import urllib.parse
from http.server import SimpleHTTPRequestHandler, HTTPServer

# Port configuration (respects Render dynamic $PORT)
PORT = int(os.environ.get('PORT', sys.argv[1] if len(sys.argv) > 1 else 5000))

# API Authentication Token (can be customized via environment variable)
ESP32_API_KEY = os.environ.get('ESP32_API_KEY', 'MINE_SECURE_ESP32_TOKEN_2026')

# Configurable timeout for ESP32 offline detection (in seconds)
OFFLINE_TIMEOUT = 25.0

# Database path (local SQLite file)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, 'mine_safety.db')

def init_database():
    """Initializes SQLite database and tables for persistent sensor telemetry."""
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS esp32_readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                zone TEXT NOT NULL,
                mq4 REAL NOT NULL,
                mq7 REAL NOT NULL,
                mq135 REAL NOT NULL,
                temperature REAL NOT NULL,
                humidity REAL NOT NULL,
                risk_level TEXT NOT NULL,
                status TEXT NOT NULL,
                trigger_sensor TEXT,
                timestamp TEXT NOT NULL,
                created_at REAL NOT NULL
            )
        ''')
        cursor.execute('''
            CREATE INDEX IF NOT EXISTS idx_readings_created ON esp32_readings(created_at)
        ''')
        conn.commit()
        conn.close()
        print(f"[DATABASE] SQLite database initialized at {DB_PATH}")
    except Exception as e:
        print(f"[DATABASE ERROR] Failed to initialize SQLite: {e}")

# In-memory latest state store
latest_esp32_state = {
    "online": False,
    "device_id": "ESP32_M1",
    "zone": "M1",
    "location": "Mine Zone M1",
    "mq4": 420.0,
    "mq7": 18.0,
    "mq135": 110.0,
    "temperature": 27.4,
    "humidity": 58.0,
    "risk_level": "LOW",
    "status": "SAFE",
    "trigger_sensor": "None (All Nominal)",
    "safeRoute": "M1 -> MAIN EXIT",
    "last_seen_epoch": 0.0,
    "last_seen_iso": "Never"
}

# Compatibility payload for backward-compatible /api/data endpoint
sensor_payload = {
    "zone": "M1",
    "location": "Mine Zone M1",
    "methane": 420,
    "co": 18,
    "mq135": 110,
    "temperature": 27.4,
    "humidity": 58,
    "status": "SAFE",
    "safeRoute": "M1 -> MAIN EXIT"
}

def evaluate_mine_safety(mq4, mq7, mq135, temp, humidity, zone="M1"):
    """
    Evaluates multi-sensor thresholds according to mine safety engineering limits.
    Returns: status, risk_level, trigger_sensor, safe_route
    """
    status = "SAFE"
    risk_level = "LOW"
    trigger_sensors = []

    # Check Critical / Emergency thresholds
    if mq4 >= 2500:
        status = "EMERGENCY"
        risk_level = "CRITICAL"
        trigger_sensors.append(f"MQ-4 Methane ({int(mq4)} ppm > 2500)")
    if mq7 >= 200:
        status = "EMERGENCY"
        risk_level = "CRITICAL"
        trigger_sensors.append(f"MQ-7 Carbon Monoxide ({int(mq7)} ppm > 200)")
    if mq135 >= 800:
        status = "EMERGENCY"
        risk_level = "CRITICAL"
        trigger_sensors.append(f"MQ-135 Toxic Air ({int(mq135)} ppm > 800)")
    if temp >= 45.0:
        status = "EMERGENCY"
        risk_level = "CRITICAL"
        trigger_sensors.append(f"DHT11 Heat ({temp:.1f}°C > 45°C)")

    # Check Warning thresholds if not already Emergency
    if status != "EMERGENCY":
        if mq4 >= 1000:
            status = "WARNING"
            risk_level = "HIGH" if risk_level != "CRITICAL" else risk_level
            trigger_sensors.append(f"MQ-4 Methane ({int(mq4)} ppm > 1000)")
        if mq7 >= 50:
            status = "WARNING"
            risk_level = "HIGH" if risk_level != "CRITICAL" else risk_level
            trigger_sensors.append(f"MQ-7 Carbon Monoxide ({int(mq7)} ppm > 50)")
        if mq135 >= 300:
            status = "WARNING"
            risk_level = "MEDIUM" if risk_level not in ["CRITICAL", "HIGH"] else risk_level
            trigger_sensors.append(f"MQ-135 Air Anomaly ({int(mq135)} ppm > 300)")
        if temp >= 35.0:
            status = "WARNING"
            risk_level = "MEDIUM" if risk_level not in ["CRITICAL", "HIGH"] else risk_level
            trigger_sensors.append(f"DHT11 Elevated Temp ({temp:.1f}°C > 35°C)")
        if humidity < 40 or humidity > 80:
            if status == "SAFE":
                risk_level = "LOW"

    trigger_str = ", ".join(trigger_sensors) if trigger_sensors else "None (All Nominal)"

    # Dynamic Evacuation Route (Hazard avoidance)
    if status == "EMERGENCY":
        if zone == "M2":
            safe_route = "M2 -> M1 -> MAIN EXIT"
        elif zone == "M3":
            safe_route = "M3 -> AUXILIARY ESCAPE SHAFT -> MAIN EXIT"
        else:
            safe_route = "M1 -> MAIN EXIT"
    elif status == "WARNING":
        safe_route = f"{zone} -> M1 -> MAIN EXIT" if zone != "M1" else "M1 -> MAIN EXIT"
    else:
        safe_route = f"{zone} -> MAIN EXIT" if zone == "M1" else f"{zone} -> M1 -> MAIN EXIT"

    return status, risk_level, trigger_str, safe_route


class MineTelemetryHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Enable full CORS for cross-origin and Render cloud access
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def send_json_response(self, status_code, data):
        resp_bytes = json.dumps(data, indent=2).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(resp_bytes)))
        self.end_headers()
        self.wfile.write(resp_bytes)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        # 1. LIVE ESP32 STATUS & TELEMETRY STREAM
        if parsed.path == '/api/esp32/data':
            now = time.time()
            elapsed = now - latest_esp32_state["last_seen_epoch"]
            is_online = (latest_esp32_state["last_seen_epoch"] > 0) and (elapsed <= OFFLINE_TIMEOUT)

            response_data = {
                "online": is_online,
                "status_badge": "ONLINE" if is_online else "OFFLINE",
                "device_id": latest_esp32_state["device_id"],
                "zone": latest_esp32_state["zone"],
                "location": latest_esp32_state["location"],
                "mq4": round(latest_esp32_state["mq4"], 1),
                "mq7": round(latest_esp32_state["mq7"], 1),
                "mq135": round(latest_esp32_state["mq135"], 1),
                "temperature": round(latest_esp32_state["temperature"], 1),
                "humidity": round(latest_esp32_state["humidity"], 1),
                "risk_level": latest_esp32_state["risk_level"],
                "status": latest_esp32_state["status"],
                "trigger_sensor": latest_esp32_state["trigger_sensor"],
                "safeRoute": latest_esp32_state["safeRoute"],
                "last_seen_seconds_ago": round(elapsed, 1) if latest_esp32_state["last_seen_epoch"] > 0 else None,
                "last_seen_timestamp": latest_esp32_state["last_seen_iso"],
                "server_time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            }
            self.send_json_response(200, response_data)
            return

        # 2. RECENT SENSOR HISTORY FROM DATABASE
        if parsed.path == '/api/esp32/history':
            history_list = []
            try:
                conn = sqlite3.connect(DB_PATH)
                cursor = conn.cursor()
                cursor.execute('''
                    SELECT id, timestamp, device_id, zone, mq4, mq7, mq135, temperature, humidity, risk_level, status, trigger_sensor
                    FROM esp32_readings
                    ORDER BY id DESC
                    LIMIT 20
                ''')
                rows = cursor.fetchall()
                conn.close()

                for r in rows:
                    history_list.append({
                        "id": r[0],
                        "timestamp": r[1],
                        "device_id": r[2],
                        "zone": r[3],
                        "mq4": round(r[4], 1),
                        "mq7": round(r[5], 1),
                        "mq135": round(r[6], 1),
                        "temperature": round(r[7], 1),
                        "humidity": round(r[8], 1),
                        "risk_level": r[9],
                        "status": r[10],
                        "trigger_sensor": r[11] or "None"
                    })
            except Exception as e:
                print(f"[DB ERROR] Query failed: {e}")

            self.send_json_response(200, {"count": len(history_list), "history": history_list})
            return

        # 3. COMPATIBILITY TELEMETRY ENDPOINT (/api/data)
        if parsed.path == '/api/data':
            now = time.time()
            elapsed = now - latest_esp32_state["last_seen_epoch"]
            is_online = (latest_esp32_state["last_seen_epoch"] > 0) and (elapsed <= OFFLINE_TIMEOUT)

            if is_online:
                # Mirror real live ESP32 values
                resp = {
                    "zone": latest_esp32_state["zone"],
                    "location": latest_esp32_state["location"],
                    "methane": int(latest_esp32_state["mq4"]),
                    "co": int(latest_esp32_state["mq7"]),
                    "mq135": int(latest_esp32_state["mq135"]),
                    "temperature": latest_esp32_state["temperature"],
                    "humidity": latest_esp32_state["humidity"],
                    "status": latest_esp32_state["status"],
                    "safeRoute": latest_esp32_state["safeRoute"],
                    "device_id": latest_esp32_state["device_id"],
                    "online": True
                }
            else:
                # Simulated telemetry with mild jitter when no hardware is transmitting
                resp = dict(sensor_payload)
                resp["methane"] += random.randint(-10, 10)
                resp["co"] += random.randint(-3, 3)
                resp["mq135"] += random.randint(-5, 5)
                resp["temperature"] = round(resp["temperature"] + random.uniform(-0.1, 0.1), 1)
                resp["humidity"] = round(resp["humidity"] + random.uniform(-0.3, 0.3), 1)
                resp["online"] = False

            self.send_json_response(200, resp)
            return

        # Default: Serve static assets (index.html, styles.css, app.js, etc.)
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        # 1. SECURE PHYSICAL ESP32 INGESTION ENDPOINT (/api/esp32/data)
        if parsed.path == '/api/esp32/data':
            # Authentication Check (Header X-API-Key or JSON field api_key)
            req_api_key = self.headers.get('X-API-Key')
            
            try:
                data = json.loads(body.decode('utf-8'))
            except Exception as e:
                self.send_json_response(400, {"status": "error", "message": f"Malformed JSON: {str(e)}"})
                return

            if not req_api_key and isinstance(data, dict):
                req_api_key = data.get('api_key') or data.get('token')

            if req_api_key != ESP32_API_KEY:
                print(f"[AUTH FAILED] Unauthorized ESP32 access attempt. Received key: {req_api_key}")
                self.send_json_response(401, {"status": "error", "message": "Unauthorized: Invalid or missing API key"})
                return

            # Required field validation
            required_fields = ['device_id', 'zone', 'mq4', 'mq7', 'mq135', 'temperature', 'humidity']
            missing = [f for f in required_fields if f not in data]
            if missing:
                self.send_json_response(400, {"status": "error", "message": f"Missing required fields: {', '.join(missing)}"})
                return

            try:
                device_id = str(data['device_id'])
                zone = str(data['zone'])
                mq4 = float(data['mq4'])
                mq7 = float(data['mq7'])
                mq135 = float(data['mq135'])
                temp = float(data['temperature'])
                hum = float(data['humidity'])
            except ValueError as e:
                self.send_json_response(400, {"status": "error", "message": f"Invalid numeric format: {str(e)}"})
                return

            # Multi-gas AI Risk & Safety Evaluation
            status, risk_level, trigger_sensor, safe_route = evaluate_mine_safety(mq4, mq7, mq135, temp, hum, zone)

            # Override with client values if explicitly provided and valid
            if data.get('risk_level'):
                risk_level = str(data['risk_level']).upper()
            if data.get('status'):
                status = str(data['status']).upper()

            now_epoch = time.time()
            now_iso = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

            # Update In-Memory State
            latest_esp32_state.update({
                "online": True,
                "device_id": device_id,
                "zone": zone,
                "location": f"Mine Zone {zone}",
                "mq4": mq4,
                "mq7": mq7,
                "mq135": mq135,
                "temperature": temp,
                "humidity": hum,
                "risk_level": risk_level,
                "status": status,
                "trigger_sensor": trigger_sensor,
                "safeRoute": safe_route,
                "last_seen_epoch": now_epoch,
                "last_seen_iso": now_iso
            })

            # Mirror to compatibility payload
            sensor_payload.update({
                "zone": zone,
                "location": f"Mine Zone {zone}",
                "methane": int(mq4),
                "co": int(mq7),
                "mq135": int(mq135),
                "temperature": temp,
                "humidity": hum,
                "status": status,
                "safeRoute": safe_route
            })

            # Persistent Storage in SQLite Database
            try:
                conn = sqlite3.connect(DB_PATH)
                cursor = conn.cursor()
                cursor.execute('''
                    INSERT INTO esp32_readings (
                        device_id, zone, mq4, mq7, mq135, temperature, humidity,
                        risk_level, status, trigger_sensor, timestamp, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''', (device_id, zone, mq4, mq7, mq135, temp, hum, risk_level, status, trigger_sensor, now_iso, now_epoch))

                # Keep database lean by rotating to recent 500 records
                cursor.execute('''
                    DELETE FROM esp32_readings WHERE id NOT IN (
                        SELECT id FROM esp32_readings ORDER BY id DESC LIMIT 500
                    )
                ''')
                conn.commit()
                conn.close()
            except Exception as e:
                print(f"[DB ERROR] Insertion failed: {e}")

            print(f"[ESP32 INGESTION] {device_id} ({zone}) | CH4: {mq4} | CO: {mq7} | AQI: {mq135} | Temp: {temp}C | Hum: {hum}% | Status: {status}")

            self.send_json_response(200, {
                "status": "success",
                "message": "ESP32 telemetry recorded and broadcasted live",
                "device_id": device_id,
                "zone": zone,
                "safety_status": status,
                "risk_level": risk_level,
                "trigger_sensor": trigger_sensor,
                "timestamp": now_iso
            })
            return

        # 2. GENERAL COMPATIBILITY POST (/api/data)
        if parsed.path == '/api/data':
            try:
                data = json.loads(body.decode('utf-8'))
                sensor_payload.update(data)
                self.send_json_response(200, {"status": "success", "updated": sensor_payload})
            except Exception as e:
                self.send_json_response(400, {"status": "error", "message": str(e)})
            return

        # 3. PRESET SWITCHER (/api/preset)
        if parsed.path == '/api/preset':
            try:
                data = json.loads(body.decode('utf-8'))
                mode = data.get('preset', 'normal')
                if mode == 'normal':
                    sensor_payload.update({
                        "zone": "M1", "location": "Mine Zone M1",
                        "methane": 420, "co": 18, "mq135": 110,
                        "temperature": 27.4, "humidity": 58,
                        "status": "SAFE", "safeRoute": "M1 -> MAIN EXIT"
                    })
                elif mode == 'warning':
                    sensor_payload.update({
                        "zone": "M2", "location": "Mine Zone M2",
                        "methane": 1800, "co": 1200, "mq135": 1400,
                        "temperature": 38, "humidity": 65,
                        "status": "WARNING", "safeRoute": "M2 -> M1 -> MAIN EXIT"
                    })
                elif mode == 'emergency':
                    sensor_payload.update({
                        "zone": "M2", "location": "Mine Zone M2",
                        "methane": 2900, "co": 1850, "mq135": 2100,
                        "temperature": 48, "humidity": 72,
                        "status": "EMERGENCY", "safeRoute": "M2 -> M1 -> MAIN EXIT"
                    })
                self.send_json_response(200, {"status": "preset applied", "data": sensor_payload})
            except Exception as e:
                self.send_json_response(400, {"status": "error", "message": str(e)})
            return

        self.send_json_response(404, {"status": "error", "message": "Endpoint not found"})


def run():
    init_database()
    server_address = ('', PORT)
    httpd = HTTPServer(server_address, MineTelemetryHandler)
    print(f"============================================================")
    print(f"  SMART MINE SAFETY CONTROL CENTER - RENDER & ESP32 SERVER")
    print(f"============================================================")
    print(f"  Listening Port:     {PORT}")
    print(f"  ESP32 Ingestion:    POST /api/esp32/data")
    print(f"  ESP32 Live Stream:  GET  /api/esp32/data")
    print(f"  Sensor History:     GET  /api/esp32/history")
    print(f"  API Key Protection: {'Enabled' if ESP32_API_KEY else 'Disabled'}")
    print(f"  CORS Enabled:       Yes (*)")
    print(f"============================================================")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[SHUTDOWN] Stopping server...")
        httpd.server_close()

if __name__ == '__main__':
    run()
