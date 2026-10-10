#!/usr/bin/env python3
"""
SMART MINE SAFETY CONTROL CENTER - PRODUCTION BACKEND & REST TELEMETRY SERVER
AI-Based Mine Gas Leakage Detection and Smart Evacuation System

Security & Data Consistency Architecture:
  - Serves ONLY: '/', '/index.html', '/styles.css', '/app.js'. Never exposes .py, .db, .ino.
  - Requires environment variable ESP32_API_KEY (no hardcoded default).
  - Uses hmac.compare_digest for constant-time authentication.
  - Request body capped at 2 KB (2048 bytes) -> 413 if exceeded.
  - Validates zone strictly in {'M1', 'M2', 'M3'} and device_id with regex.
  - Single authoritative threshold table: server computes risk_score (0-100),
    safety status, trigger sensors, per-zone states, and BFS hazard-avoidance routes.
  - Full UTC ISO 8601 timestamps.
  - Multi-node state tracked per device_id / zone with 10.0s offline timeout.
  - BFS routing over tunnel graph avoiding all non-SAFE hazard zones.
  - SQLite persistent audit log (Note: Render containers have ephemeral disks).
"""

import os
import sys
import re
import json
import time
import hmac
import sqlite3
import datetime
import urllib.parse
from collections import deque
from http.server import SimpleHTTPRequestHandler, HTTPServer

# ==============================================================================
# CONFIGURATION & ENVIRONMENT
# ==============================================================================
PORT = int(os.environ.get("PORT", sys.argv[1] if len(sys.argv) > 1 else 5000))
ESP32_API_KEY = os.environ.get("ESP32_API_KEY")

OFFLINE_TIMEOUT = 10.0  # Fail-safe: Node offline after 10.0s of silence
MAX_REQUEST_BODY_BYTES = 2048  # Strict 2 KB maximum payload cap

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "mine_safety.db")

ALLOWED_STATIC_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/styles.css": "styles.css",
    "/app.js": "app.js"
}

# Regex for device_id: alphanumeric, underscores, hyphens (1-32 chars)
DEVICE_ID_REGEX = re.compile(r"^[a-zA-Z0-9_\-]{1,32}$")
VALID_ZONES = {"M1", "M2", "M3"}

# ==============================================================================
# AUTHORITATIVE SAFETY THRESHOLD TABLE (SERVER IS CANONICAL)
# ==============================================================================
THRESHOLDS = {
    "methane": {"warn": 1000.0, "danger": 2500.0},
    "co":      {"warn": 50.0,   "danger": 200.0},
    "toxic":   {"warn": 300.0,  "danger": 800.0},
    "temp":    {"warn": 35.0,   "danger": 45.0},
    "humidity":{"lowWarn": 40.0, "highWarn": 80.0}
}

# In-memory registry of edge nodes keyed by node_id
nodes_state = {}

# ==============================================================================
# DATABASE LAYER (SQLite)
# ==============================================================================
def init_database():
    """
    Initializes SQLite database table for telemetry history.
    DEPLOYMENT NOTE REGARDING RENDER CLOUD:
    Render web services operate on ephemeral container disks. Local files
    are wiped upon deployment restarts. For persistent production multi-month
    audit logging, configure a managed PostgreSQL instance or persistent volume.
    """
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS esp32_readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id TEXT NOT NULL,
                zone TEXT NOT NULL,
                methane REAL,
                co REAL,
                toxic REAL,
                temp REAL,
                humidity REAL,
                alarm_level TEXT NOT NULL,
                fan_on INTEGER NOT NULL,
                uptime INTEGER NOT NULL,
                risk_score REAL NOT NULL,
                status TEXT NOT NULL,
                trigger_sensor TEXT,
                sensor_fault INTEGER NOT NULL DEFAULT 0,
                timestamp TEXT NOT NULL,
                created_at REAL NOT NULL
            )
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_readings_created ON esp32_readings(created_at)")
        conn.commit()
        conn.close()
        print(f"[DATABASE] SQLite database initialized at {DB_PATH}")
        print("[DATABASE NOTE] Local disk is ephemeral on Render containers.")
    except Exception as e:
        print(f"[DATABASE ERROR] Failed to initialize SQLite: {e}")

def save_reading_to_db(data_dict):
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO esp32_readings (
                node_id, zone, methane, co, toxic, temp, humidity,
                alarm_level, fan_on, uptime, risk_score, status,
                trigger_sensor, sensor_fault, timestamp, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            data_dict["node_id"],
            data_dict["zone"],
            data_dict.get("methane"),
            data_dict.get("co"),
            data_dict.get("toxic"),
            data_dict.get("temp"),
            data_dict.get("humidity"),
            data_dict.get("alarm_level", "SAFE"),
            1 if data_dict.get("fan_on") else 0,
            data_dict.get("uptime", 0),
            data_dict.get("risk_score", 0.0),
            data_dict.get("status", "SAFE"),
            data_dict.get("trigger_sensor", "None"),
            1 if data_dict.get("sensor_fault") else 0,
            data_dict["last_seen_iso"],
            data_dict["last_seen_epoch"]
        ))
        cursor.execute("""
            DELETE FROM esp32_readings
            WHERE id NOT IN (SELECT id FROM esp32_readings ORDER BY id DESC LIMIT 500)
        """)
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[DATABASE ERROR] Failed to insert telemetry reading: {e}")

# ==============================================================================
# AUTHORITATIVE RISK EVALUATION & BFS GRAPH ROUTING
# ==============================================================================
def compute_server_risk(methane, co, toxic, temp):
    """
    Computes canonical 0-100 composite risk score.
    """
    if methane is None or co is None or toxic is None or temp is None:
        return {"overall": 0.0, "methane": 0.0, "co": 0.0, "toxic": 0.0, "temp": 0.0}

    risk_ch4   = min(100.0, round((max(0.0, methane) / THRESHOLDS["methane"]["danger"]) * 100.0, 1))
    risk_co    = min(100.0, round((max(0.0, co) / THRESHOLDS["co"]["danger"]) * 100.0, 1))
    risk_toxic = min(100.0, round((max(0.0, toxic) / THRESHOLDS["toxic"]["danger"]) * 100.0, 1))
    risk_temp  = min(100.0, round(max(0.0, (temp - 20.0) / (THRESHOLDS["temp"]["danger"] - 20.0) * 100.0), 1))

    comp_max = max(risk_ch4, risk_co, risk_toxic, risk_temp)
    avg_risk = (risk_ch4 + risk_co + risk_toxic + risk_temp) / 4.0
    overall = min(100.0, round(comp_max * 0.75 + avg_risk * 0.25, 1))

    return {
        "overall": overall,
        "methane": risk_ch4,
        "co": risk_co,
        "toxic": risk_toxic,
        "temp": risk_temp
    }

def evaluate_safety_authoritative(methane, co, toxic, temp, sensor_fault=False):
    """
    Server-authoritative threshold evaluation.
    Returns: (status, risk_level, trigger_sensor, risk_scores)
    """
    if sensor_fault or temp is None or methane is None or co is None or toxic is None:
        return "SENSOR_FAULT", "CRITICAL", "Hardware Sensor Fault / Disconnected", compute_server_risk(0, 0, 0, 0)

    status = "SAFE"
    risk_level = "LOW"
    triggers = []

    # Check Evacuation Thresholds
    if methane >= THRESHOLDS["methane"]["danger"]:
        triggers.append(f"MQ-4 Methane ({int(methane)} >= {int(THRESHOLDS['methane']['danger'])} ppm)")
    if co >= THRESHOLDS["co"]["danger"]:
        triggers.append(f"MQ-7 CO ({int(co)} >= {int(THRESHOLDS['co']['danger'])} ppm)")
    if toxic >= THRESHOLDS["toxic"]["danger"]:
        triggers.append(f"MQ-135 Toxic ({int(toxic)} >= {int(THRESHOLDS['toxic']['danger'])} ppm)")
    if temp >= THRESHOLDS["temp"]["danger"]:
        triggers.append(f"Temperature ({temp:.1f}C >= {THRESHOLDS['temp']['danger']}C)")

    if triggers:
        status = "EVACUATE"
        risk_level = "CRITICAL"
    else:
        # Check Warning Thresholds
        if methane >= THRESHOLDS["methane"]["warn"]:
            triggers.append(f"MQ-4 Methane ({int(methane)} >= {int(THRESHOLDS['methane']['warn'])} ppm)")
        if co >= THRESHOLDS["co"]["warn"]:
            triggers.append(f"MQ-7 CO ({int(co)} >= {int(THRESHOLDS['co']['warn'])} ppm)")
        if toxic >= THRESHOLDS["toxic"]["warn"]:
            triggers.append(f"MQ-135 Toxic ({int(toxic)} >= {int(THRESHOLDS['toxic']['warn'])} ppm)")
        if temp >= THRESHOLDS["temp"]["warn"]:
            triggers.append(f"Temperature ({temp:.1f}C >= {THRESHOLDS['temp']['warn']}C)")

        if triggers:
            status = "WARNING"
            risk_level = "HIGH"

    trigger_str = ", ".join(triggers) if triggers else "None (All Nominal)"
    risk_scores = compute_server_risk(methane, co, toxic, temp)

    return status, risk_level, trigger_str, risk_scores

# Graph specification:
# M1: [M2, EXIT]
# M2: [M1, M3, AUX]
# M3: [M2, AUX]
# AUX: [EXIT]
MINE_GRAPH = {
    "M1": ["M2", "EXIT"],
    "M2": ["M1", "M3", "AUX"],
    "M3": ["M2", "AUX"],
    "AUX": ["EXIT"]
}

def bfs_find_route(worker_zone, hazard_zones):
    """
    Breadth-First Search (BFS) over mine tunnel graph.
    Excludes all hazard zones from transit.
    If the worker is currently standing in a hazard zone, they can start there
    to flee towards adjacent non-hazard corridors, but cannot transit through any OTHER hazard zones.
    Returns: Formatted route string, or 'NO SAFE ROUTE' if trapped.
    """
    if worker_zone == "EXIT":
        return "MAIN EXIT"

    queue = deque([[worker_zone]])
    visited = {worker_zone}

    while queue:
        path = queue.popleft()
        current_node = path[-1]

        if current_node == "EXIT":
            # Map canonical node names to display names
            display_map = {
                "M1": "M1",
                "M2": "M2",
                "M3": "M3",
                "AUX": "AUXILIARY ESCAPE SHAFT",
                "EXIT": "MAIN EXIT"
            }
            return " ➔ ".join(display_map.get(n, n) for n in path)

        for neighbor in MINE_GRAPH.get(current_node, []):
            if neighbor in visited:
                continue

            # Cannot enter any neighbor that is an active hazard zone
            if neighbor != "EXIT" and neighbor in hazard_zones:
                continue

            visited.add(neighbor)
            queue.append(path + [neighbor])

    return "NO SAFE ROUTE"

# ==============================================================================
# HTTP HANDLER WITH STRICT SECURITY POLICIES
# ==============================================================================
class MineTelemetryHandler(SimpleHTTPRequestHandler):

    def end_headers(self):
        # Strict CORS & security response headers
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Authorization")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def send_json(self, status_code, payload):
        data_bytes = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data_bytes)))
        self.end_headers()
        self.wfile.write(data_bytes)

    def verify_auth_constant_time(self):
        """
        Constant-time HMAC comparison for API key verification.
        Requires ESP32_API_KEY environment variable.
        """
        if not ESP32_API_KEY:
            print("[SECURITY ERROR] ESP32_API_KEY environment variable is not configured on server!")
            return False, "SERVER_UNCONFIGURED"

        header_key = self.headers.get("X-API-Key")
        if not header_key:
            auth_header = self.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                header_key = auth_header[7:].strip()

        if not header_key:
            return False, "MISSING_KEY"

        # Constant-time comparison prevents timing attacks
        matches = hmac.compare_digest(header_key.encode("utf-8"), ESP32_API_KEY.encode("utf-8"))
        return matches, "OK" if matches else "INVALID_KEY"

    # --------------------------------------------------------------------------
    # GET REQUESTS - RESTRICTED WHITE-LIST
    # --------------------------------------------------------------------------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        req_path = parsed.path

        # 1. LIVE TELEMETRY QUERY (/api/esp32/data)
        if req_path == "/api/esp32/data":
            now_epoch = time.time()
            now_utc = datetime.datetime.now(datetime.timezone.utc).isoformat()

            # Compile per-zone and per-node states
            online_nodes = {}
            hazard_zones = set()
            zones_summary = {
                "M1": {"status": "UNKNOWN", "risk_score": 0.0, "online": False, "node_id": None},
                "M2": {"status": "UNKNOWN", "risk_score": 0.0, "online": False, "node_id": None},
                "M3": {"status": "UNKNOWN", "risk_score": 0.0, "online": False, "node_id": None}
            }

            for nid, node in nodes_state.items():
                elapsed = now_epoch - node["last_seen_epoch"]
                is_node_online = (node["last_seen_epoch"] > 0 and elapsed <= OFFLINE_TIMEOUT)
                node_copy = dict(node)
                node_copy["online"] = is_node_online
                node_copy["last_seen_seconds_ago"] = round(elapsed, 1)

                if is_node_online:
                    online_nodes[nid] = node_copy
                    z = node_copy["zone"]
                    if z in zones_summary:
                        zones_summary[z] = {
                            "status": node_copy["status"],
                            "risk_score": node_copy["risk_score"],
                            "methane": node_copy.get("methane"),
                            "co": node_copy.get("co"),
                            "toxic": node_copy.get("toxic"),
                            "temp": node_copy.get("temp"),
                            "humidity": node_copy.get("humidity"),
                            "online": True,
                            "sensor_fault": node_copy.get("sensor_fault", False),
                            "node_id": nid,
                            "last_seen_seconds_ago": round(elapsed, 1)
                        }

                    # Any non-SAFE zone is a hazard zone for evacuation routing
                    if node_copy["status"] != "SAFE":
                        hazard_zones.add(z)
                else:
                    # Node is offline -> zone is unverified hazard
                    z = node["zone"]
                    if z in zones_summary and not zones_summary[z]["online"]:
                        zones_summary[z]["status"] = "OFFLINE"

            is_system_online = len(online_nodes) > 0

            # Compute authoritative BFS route for every worker zone
            routes = {
                "M1": bfs_find_route("M1", hazard_zones),
                "M2": bfs_find_route("M2", hazard_zones),
                "M3": bfs_find_route("M3", hazard_zones)
            }

            # Overall system state selection
            if not is_system_online:
                overall_status = "OFFLINE"
                overall_risk = 0.0
                primary_node = None
                primary_route = "NO DATA - SENSOR OFFLINE"
            else:
                # Prioritize EVACUATE, then SENSOR_FAULT, then WARNING, then SAFE
                severity_order = {"EVACUATE": 1, "SENSOR_FAULT": 2, "WARNING": 3, "SAFE": 4}
                sorted_nodes = sorted(
                    online_nodes.values(),
                    key=lambda n: (severity_order.get(n["status"], 5), -n["risk_score"], -n["last_seen_epoch"])
                )
                primary_node = sorted_nodes[0]
                overall_status = primary_node["status"]
                overall_risk = primary_node["risk_score"]
                primary_route = routes.get(primary_node["zone"], "NO SAFE ROUTE")

            response = {
                "online": is_system_online,
                "status_badge": "ONLINE" if is_system_online else "OFFLINE",
                "active_nodes_count": len(online_nodes),
                "nodes": {nid: n for nid, n in (online_nodes.items() if is_system_online else nodes_state.items())},
                "zones": zones_summary,
                "hazard_zones": sorted(list(hazard_zones)),
                "routes": routes,
                "offline_timeout_seconds": OFFLINE_TIMEOUT,

                # Primary telemetry view
                "node_id": primary_node["node_id"] if primary_node else "NONE",
                "zone": primary_node["zone"] if primary_node else "M1",
                "location": f"Mine Zone {primary_node['zone']}" if primary_node else "Mine Zone M1",
                "methane": primary_node.get("methane") if primary_node else None,
                "co": primary_node.get("co") if primary_node else None,
                "toxic": primary_node.get("toxic") if primary_node else None,
                "temp": primary_node.get("temp") if primary_node else None,
                "humidity": primary_node.get("humidity") if primary_node else None,
                "alarm_level": primary_node.get("alarm_level", "OFFLINE") if primary_node else "OFFLINE",
                "fan_on": primary_node.get("fan_on", False) if primary_node else False,
                "uptime": primary_node.get("uptime", 0) if primary_node else 0,
                "sensor_fault": primary_node.get("sensor_fault", False) if primary_node else False,
                "risk_score": overall_risk,
                "risk_components": primary_node.get("risk_components", {}) if primary_node else {},
                "risk_level": primary_node.get("risk_level", "UNKNOWN") if primary_node else "UNKNOWN",
                "status": overall_status,
                "trigger_sensor": primary_node.get("trigger_sensor", "No Sensor Connected") if primary_node else "No Sensor Connected",
                "safeRoute": primary_route,
                "last_seen_seconds_ago": round(now_epoch - primary_node["last_seen_epoch"], 1) if (primary_node and primary_node["last_seen_epoch"] > 0) else None,
                "last_seen_timestamp": primary_node["last_seen_iso"] if primary_node else "Never",
                "server_time_utc": now_utc
            }
            self.send_json(200, response)
            return

        # 2. SENSOR HISTORY QUERY (/api/esp32/history)
        if req_path == "/api/esp32/history":
            history_list = []
            try:
                conn = sqlite3.connect(DB_PATH)
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT id, timestamp, node_id, zone, methane, co, toxic,
                           temp, humidity, alarm_level, risk_score, status, trigger_sensor, sensor_fault
                    FROM esp32_readings
                    ORDER BY id DESC
                    LIMIT 25
                """)
                rows = cursor.fetchall()
                conn.close()
                for r in rows:
                    history_list.append({
                        "id": r[0],
                        "timestamp": r[1],
                        "node_id": r[2],
                        "zone": r[3],
                        "methane": round(r[4], 1) if r[4] is not None else None,
                        "co": round(r[5], 1) if r[5] is not None else None,
                        "toxic": round(r[6], 1) if r[6] is not None else None,
                        "temp": round(r[7], 1) if r[7] is not None else None,
                        "humidity": round(r[8], 1) if r[8] is not None else None,
                        "alarm_level": r[9],
                        "risk_score": r[10],
                        "status": r[11],
                        "trigger_sensor": r[12] or "None",
                        "sensor_fault": bool(r[13])
                    })
            except Exception as e:
                print(f"[DB ERROR] Query failed: {e}")

            self.send_json(200, {"count": len(history_list), "history": history_list})
            return

        # 3. STRICT STATIC FILE SERVING (ONLY /, /index.html, /styles.css, /app.js)
        # NEVER expose .py, .db, .ino, etc.
        if req_path in ALLOWED_STATIC_FILES:
            filename = ALLOWED_STATIC_FILES[req_path]
            full_filepath = os.path.join(BASE_DIR, filename)

            if os.path.isfile(full_filepath):
                ctype = "text/html; charset=utf-8"
                if filename.endswith(".css"):
                    ctype = "text/css; charset=utf-8"
                elif filename.endswith(".js"):
                    ctype = "application/javascript; charset=utf-8"

                try:
                    with open(full_filepath, "rb") as f:
                        file_content = f.read()
                    self.send_response(200)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Content-Length", str(len(file_content)))
                    self.end_headers()
                    self.wfile.write(file_content)
                    return
                except Exception as e:
                    self.send_json(500, {"status": "error", "message": f"File read error: {str(e)}"})
                    return

        # Refuse all other paths
        self.send_json(404, {"status": "error", "message": "Resource not found"})

    # --------------------------------------------------------------------------
    # POST REQUESTS - INGESTION ONLY
    # --------------------------------------------------------------------------
    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        req_path = parsed.path

        if req_path != "/api/esp32/data":
            self.send_json(404, {"status": "error", "message": "Endpoint not found"})
            return

        # 1. Cap request body at 2 KB (2048 bytes)
        content_length_header = self.headers.get("Content-Length")
        if not content_length_header:
            self.send_json(411, {"status": "error", "message": "Length Required"})
            return

        try:
            content_length = int(content_length_header)
        except ValueError:
            self.send_json(400, {"status": "error", "message": "Invalid Content-Length header"})
            return

        if content_length > MAX_REQUEST_BODY_BYTES:
            print(f"[SECURITY] Rejected oversized payload: {content_length} bytes > {MAX_REQUEST_BODY_BYTES} bytes cap.")
            self.send_json(413, {"status": "error", "message": f"Payload Too Large: Exceeds {MAX_REQUEST_BODY_BYTES} byte cap."})
            return

        # 2. Authentication: Constant-time comparison
        auth_ok, auth_reason = self.verify_auth_constant_time()
        if not auth_ok:
            if auth_reason == "SERVER_UNCONFIGURED":
                self.send_json(500, {"status": "error", "message": "Server configuration error: ESP32_API_KEY environment variable is not configured on server."})
            else:
                self.send_json(401, {"status": "error", "message": "Unauthorized: Invalid or missing API key."})
            return

        body_bytes = self.rfile.read(content_length)
        try:
            body_json = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
        except Exception as e:
            self.send_json(400, {"status": "error", "message": f"Malformed JSON: {str(e)}"})
            return

        # 3. Validate node_id / device_id with regex
        node_id = str(body_json.get("node_id") or body_json.get("device_id") or "").strip()
        if not node_id or not DEVICE_ID_REGEX.match(node_id):
            self.send_json(400, {
                "status": "error",
                "message": "Invalid or missing node_id. Must match ^[a-zA-Z0-9_-]{1,32}$"
            })
            return

        # 4. Validate zone in strictly {'M1', 'M2', 'M3'}
        zone = str(body_json.get("zone") or "").strip().upper()
        if zone not in VALID_ZONES:
            self.send_json(400, {
                "status": "error",
                "message": f"Invalid zone '{zone}'. Must be strictly one of: {sorted(list(VALID_ZONES))}"
            })
            return

        # 5. Extract telemetry values & handle sensor fault
        sensor_fault = bool(body_json.get("sensor_fault", False))
        try:
            raw_methane = body_json.get("methane") if "methane" in body_json else body_json.get("mq4")
            raw_co      = body_json.get("co")      if "co"      in body_json else body_json.get("mq7")
            raw_toxic   = body_json.get("toxic")   if "toxic"   in body_json else body_json.get("mq135")
            raw_temp    = body_json.get("temp")    if "temp"    in body_json else body_json.get("temperature")
            raw_humidity= body_json.get("humidity")

            # Check if sensors reported null/fault
            if raw_temp is None or raw_methane is None or raw_co is None or raw_toxic is None:
                sensor_fault = True

            methane = float(raw_methane) if raw_methane is not None else None
            co      = float(raw_co)      if raw_co is not None else None
            toxic   = float(raw_toxic)   if raw_toxic is not None else None
            temp    = float(raw_temp)    if raw_temp is not None else None
            humidity= float(raw_humidity)if raw_humidity is not None else None
            uptime  = int(body_json.get("uptime", 0))
            fan_on  = bool(body_json.get("fan_on", False))
            reported_alarm = str(body_json.get("alarm_level") or body_json.get("status") or "SAFE").upper()
        except (ValueError, TypeError) as num_err:
            self.send_json(400, {"status": "error", "message": f"Invalid numeric field format: {str(num_err)}"})
            return

        # 6. Authoritative Safety Evaluation on Server
        srv_status, srv_risk_level, trigger_sensor, risk_scores = evaluate_safety_authoritative(
            methane, co, toxic, temp, sensor_fault
        )

        now_epoch = time.time()
        now_utc = datetime.datetime.now(datetime.timezone.utc).isoformat()

        # 7. Update in-memory node state
        node_record = {
            "node_id": node_id,
            "zone": zone,
            "methane": methane,
            "co": co,
            "toxic": toxic,
            "temp": temp,
            "humidity": humidity,
            "alarm_level": reported_alarm,
            "fan_on": fan_on,
            "uptime": uptime,
            "sensor_fault": sensor_fault,
            "risk_score": risk_scores["overall"],
            "risk_components": risk_scores,
            "risk_level": srv_risk_level,
            "status": srv_status,
            "trigger_sensor": trigger_sensor,
            "last_seen_epoch": now_epoch,
            "last_seen_iso": now_utc
        }
        nodes_state[node_id] = node_record

        # 8. Save persistent record to SQLite
        save_reading_to_db(node_record)

        print(f"[INGESTION] Node: {node_id} ({zone}) | CH4: {methane} | CO: {co} | Toxic: {toxic} | Temp: {temp}C | Status: {srv_status} | Risk: {risk_scores['overall']}%")

        self.send_json(200, {
            "status": "success",
            "message": "Telemetry verified and accepted",
            "node_id": node_id,
            "zone": zone,
            "server_status": srv_status,
            "risk_score": risk_scores["overall"],
            "timestamp": now_utc
        })

# ==============================================================================
# SERVER INITIALIZATION & LIFECYCLE
# ==============================================================================
def run():
    init_database()
    server_address = ("", PORT)
    httpd = HTTPServer(server_address, MineTelemetryHandler)

    print("==================================================================")
    print("  SMART MINE SAFETY CONTROL CENTER - PRODUCTION BACKEND")
    print("==================================================================")
    print(f"  Server URL:         http://localhost:{PORT}/")
    print(f"  White-listed Paths: {list(ALLOWED_STATIC_FILES.keys())}")
    print(f"  API Ingestion:      POST /api/esp32/data (Max: 2048 bytes)")
    print(f"  API Live Telemetry: GET  /api/esp32/data")
    print(f"  API History:        GET  /api/esp32/history")
    print(f"  Fail-Safe Timeout:  {OFFLINE_TIMEOUT} seconds")
    print(f"  API Key Protection: {'Configured (ESP32_API_KEY env var)' if ESP32_API_KEY else 'WARNING: ESP32_API_KEY env var NOT SET!'}")
    print("------------------------------------------------------------------")
    print("  DEPLOYMENT & HARDWARE NOTICE:")
    print("  1. RENDER DISK: Free Render instance disks are ephemeral. SQLite")
    print("     history resets on dyno sleep/restart. For persistent multi-day")
    print("     history in production, configure PostgreSQL or a Persistent Disk.")
    print("  2. THRESHOLDS: Calibrated as demo values for laboratory simulation.")
    print("  3. DISCLAIMER: Prototype educational system. Not intrinsically-safe")
    print("     (IS) certified equipment (ATEX, IECEx, or DGMS).")
    print("==================================================================")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[SHUTDOWN] Telemetry server closed.")
        httpd.server_close()

if __name__ == "__main__":
    run()
