#!/usr/bin/env python3

"""
SMART MINE SAFETY CONTROL CENTER - RENDER & ESP32 PRODUCTION BACKEND

Serves the web dashboard, manages the SQLite database layer,
provides secure REST API for physical ESP32 devices,
and supports live polling and history.

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


# ============================================================
# PORT CONFIGURATION
# ============================================================

PORT = int(
    os.environ.get(
        "PORT",
        sys.argv[1] if len(sys.argv) > 1 else 5000
    )
)


# ============================================================
# ESP32 API KEY
# ============================================================

ESP32_API_KEY = os.environ.get(
    "ESP32_API_KEY",
    "MINE_SECURE_ESP32_TOKEN_2026"
)


# ============================================================
# ESP32 OFFLINE TIMEOUT
# ============================================================

OFFLINE_TIMEOUT = 25.0


# ============================================================
# DATABASE CONFIGURATION
# ============================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

DB_PATH = os.path.join(
    BASE_DIR,
    "mine_safety.db"
)


# ============================================================
# DATABASE INITIALIZATION
# ============================================================

def init_database():

    try:

        conn = sqlite3.connect(DB_PATH)

        cursor = conn.cursor()

        cursor.execute(
            """
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
            """
        )

        cursor.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_readings_created
            ON esp32_readings(created_at)
            """
        )

        conn.commit()

        conn.close()

        print(
            f"[DATABASE] SQLite database initialized at {DB_PATH}"
        )

    except Exception as e:

        print(
            f"[DATABASE ERROR] Failed to initialize SQLite: {e}"
        )


# ============================================================
# IN-MEMORY LATEST ESP32 STATE
# ============================================================

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


# ============================================================
# COMPATIBILITY SENSOR PAYLOAD
# ============================================================

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


# ============================================================
# MINE SAFETY EVALUATION
# ============================================================

def evaluate_mine_safety(
    mq4,
    mq7,
    mq135,
    temp,
    humidity,
    zone="M1"
):

    """
    Evaluates mine safety using the SAME thresholds
    used by the ESP32 firmware.

    Thresholds:

    MQ4:
        SAFE       < 500
        WARNING    500 - 1000
        EMERGENCY  > 1000

    MQ7:
        SAFE       < 35
        WARNING    35 - 70
        EMERGENCY  > 70

    MQ135:
        SAFE       < 200
        WARNING    200 - 400
        EMERGENCY  > 400

    Temperature:
        SAFE       < 38 C
        WARNING    38 - 45 C
        EMERGENCY  > 45 C
    """

    status = "SAFE"

    risk_level = "LOW"

    trigger_sensors = []


    # ========================================================
    # EMERGENCY THRESHOLDS
    # ========================================================

    if mq4 > 1000:

        status = "EMERGENCY"

        risk_level = "CRITICAL"

        trigger_sensors.append(
            f"MQ-4 Methane ({int(mq4)} > 1000)"
        )


    if mq7 > 70:

        status = "EMERGENCY"

        risk_level = "CRITICAL"

        trigger_sensors.append(
            f"MQ-7 Carbon Monoxide ({int(mq7)} > 70)"
        )


    if mq135 > 400:

        status = "EMERGENCY"

        risk_level = "CRITICAL"

        trigger_sensors.append(
            f"MQ-135 Air Quality ({int(mq135)} > 400)"
        )


    if temp > 45:

        status = "EMERGENCY"

        risk_level = "CRITICAL"

        trigger_sensors.append(
            f"DHT11 Temperature ({temp:.1f} C > 45 C)"
        )


    # ========================================================
    # WARNING THRESHOLDS
    # ========================================================

    if status != "EMERGENCY":

        if mq4 >= 500:

            status = "WARNING"

            risk_level = "HIGH"

            trigger_sensors.append(
                f"MQ-4 Methane ({int(mq4)} >= 500)"
            )


        if mq7 >= 35:

            status = "WARNING"

            risk_level = "HIGH"

            trigger_sensors.append(
                f"MQ-7 Carbon Monoxide ({int(mq7)} >= 35)"
            )


        if mq135 >= 200:

            status = "WARNING"

            risk_level = "HIGH"

            trigger_sensors.append(
                f"MQ-135 Air Quality ({int(mq135)} >= 200)"
            )


        if temp >= 38:

            status = "WARNING"

            risk_level = "HIGH"

            trigger_sensors.append(
                f"DHT11 Temperature ({temp:.1f} C >= 38 C)"
            )


    # ========================================================
    # TRIGGER SENSOR MESSAGE
    # ========================================================

    if trigger_sensors:

        trigger_str = ", ".join(
            trigger_sensors
        )

    else:

        trigger_str = "None (All Nominal)"


    # ========================================================
    # EVACUATION ROUTE
    # ========================================================

    if status == "EMERGENCY":

        if zone == "M2":

            safe_route = (
                "M2 -> M1 -> MAIN EXIT"
            )

        elif zone == "M3":

            safe_route = (
                "M3 -> AUXILIARY ESCAPE SHAFT -> MAIN EXIT"
            )

        else:

            safe_route = (
                "M1 -> MAIN EXIT"
            )


    elif status == "WARNING":

        if zone != "M1":

            safe_route = (
                f"{zone} -> M1 -> MAIN EXIT"
            )

        else:

            safe_route = (
                "M1 -> MAIN EXIT"
            )


    else:

        if zone == "M1":

            safe_route = (
                "M1 -> MAIN EXIT"
            )

        else:

            safe_route = (
                f"{zone} -> M1 -> MAIN EXIT"
            )


    return (
        status,
        risk_level,
        trigger_str,
        safe_route
    )


# ============================================================
# HTTP HANDLER
# ============================================================

class MineTelemetryHandler(
    SimpleHTTPRequestHandler
):


    # ========================================================
    # CORS
    # ========================================================

    def end_headers(self):

        self.send_header(
            "Access-Control-Allow-Origin",
            "*"
        )

        self.send_header(
            "Access-Control-Allow-Methods",
            "GET, POST, OPTIONS"
        )

        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, X-API-Key, Authorization"
        )

        super().end_headers()


    # ========================================================
    # OPTIONS
    # ========================================================

    def do_OPTIONS(self):

        self.send_response(200)

        self.end_headers()


    # ========================================================
    # JSON RESPONSE
    # ========================================================

    def send_json_response(
        self,
        status_code,
        data
    ):

        resp_bytes = json.dumps(
            data,
            indent=2
        ).encode("utf-8")


        self.send_response(
            status_code
        )

        self.send_header(
            "Content-Type",
            "application/json"
        )

        self.send_header(
            "Content-Length",
            str(len(resp_bytes))
        )

        self.end_headers()

        self.wfile.write(
            resp_bytes
        )


    # ========================================================
    # GET REQUESTS
    # ========================================================

    def do_GET(self):

        parsed = urllib.parse.urlparse(
            self.path
        )


        # ====================================================
        # LIVE ESP32 DATA
        # ====================================================

        if parsed.path == "/api/esp32/data":

            now = time.time()

            elapsed = (
                now
                - latest_esp32_state["last_seen_epoch"]
            )


            is_online = (
                latest_esp32_state["last_seen_epoch"] > 0
                and
                elapsed <= OFFLINE_TIMEOUT
            )


            response_data = {

                "online": is_online,

                "status_badge": (
                    "ONLINE"
                    if is_online
                    else "OFFLINE"
                ),

                "device_id":
                    latest_esp32_state["device_id"],

                "zone":
                    latest_esp32_state["zone"],

                "location":
                    latest_esp32_state["location"],

                "mq4":
                    round(
                        latest_esp32_state["mq4"],
                        1
                    ),

                "mq7":
                    round(
                        latest_esp32_state["mq7"],
                        1
                    ),

                "mq135":
                    round(
                        latest_esp32_state["mq135"],
                        1
                    ),

                "temperature":
                    round(
                        latest_esp32_state["temperature"],
                        1
                    ),

                "humidity":
                    round(
                        latest_esp32_state["humidity"],
                        1
                    ),

                "risk_level":
                    latest_esp32_state["risk_level"],

                "status":
                    latest_esp32_state["status"],

                "trigger_sensor":
                    latest_esp32_state["trigger_sensor"],

                "safeRoute":
                    latest_esp32_state["safeRoute"],

                "last_seen_seconds_ago":
                    round(
                        elapsed,
                        1
                    )
                    if latest_esp32_state[
                        "last_seen_epoch"
                    ] > 0
                    else None,

                "last_seen_timestamp":
                    latest_esp32_state[
                        "last_seen_iso"
                    ],

                "server_time":
                    datetime.datetime.now().strftime(
                        "%Y-%m-%d %H:%M:%S"
                    )
            }


            self.send_json_response(
                200,
                response_data
            )

            return


        # ====================================================
        # ESP32 HISTORY
        # ====================================================

        if parsed.path == "/api/esp32/history":

            history_list = []


            try:

                conn = sqlite3.connect(
                    DB_PATH
                )

                cursor = conn.cursor()


                cursor.execute(
                    """
                    SELECT
                        id,
                        timestamp,
                        device_id,
                        zone,
                        mq4,
                        mq7,
                        mq135,
                        temperature,
                        humidity,
                        risk_level,
                        status,
                        trigger_sensor
                    FROM esp32_readings
                    ORDER BY id DESC
                    LIMIT 20
                    """
                )


                rows = cursor.fetchall()


                conn.close()


                for r in rows:

                    history_list.append({

                        "id": r[0],

                        "timestamp": r[1],

                        "device_id": r[2],

                        "zone": r[3],

                        "mq4": round(
                            r[4],
                            1
                        ),

                        "mq7": round(
                            r[5],
                            1
                        ),

                        "mq135": round(
                            r[6],
                            1
                        ),

                        "temperature": round(
                            r[7],
                            1
                        ),

                        "humidity": round(
                            r[8],
                            1
                        ),

                        "risk_level": r[9],

                        "status": r[10],

                        "trigger_sensor":
                            r[11] or "None"
                    })


            except Exception as e:

                print(
                    f"[DB ERROR] Query failed: {e}"
                )


            self.send_json_response(
                200,
                {
                    "count": len(history_list),
                    "history": history_list
                }
            )

            return


        # ====================================================
        # COMPATIBILITY /api/data
        # ====================================================

        if parsed.path == "/api/data":

            now = time.time()

            elapsed = (
                now
                - latest_esp32_state[
                    "last_seen_epoch"
                ]
            )


            is_online = (
                latest_esp32_state[
                    "last_seen_epoch"
                ] > 0
                and
                elapsed <= OFFLINE_TIMEOUT
            )


            if is_online:

                # Use REAL ESP32 values

                resp = {

                    "zone":
                        latest_esp32_state[
                            "zone"
                        ],

                    "location":
                        latest_esp32_state[
                            "location"
                        ],

                    "methane":
                        int(
                            latest_esp32_state[
                                "mq4"
                            ]
                        ),

                    "co":
                        int(
                            latest_esp32_state[
                                "mq7"
                            ]
                        ),

                    "mq135":
                        int(
                            latest_esp32_state[
                                "mq135"
                            ]
                        ),

                    "temperature":
                        latest_esp32_state[
                            "temperature"
                        ],

                    "humidity":
                        latest_esp32_state[
                            "humidity"
                        ],

                    "status":
                        latest_esp32_state[
                            "status"
                        ],

                    "safeRoute":
                        latest_esp32_state[
                            "safeRoute"
                        ],

                    "device_id":
                        latest_esp32_state[
                            "device_id"
                        ],

                    "online": True
                }


            else:

                # Simulated telemetry only when
                # ESP32 is offline

                resp = dict(
                    sensor_payload
                )

                resp["methane"] += random.randint(
                    -10,
                    10
                )

                resp["co"] += random.randint(
                    -3,
                    3
                )

                resp["mq135"] += random.randint(
                    -5,
                    5
                )

                resp["temperature"] = round(
                    resp["temperature"]
                    + random.uniform(
                        -0.1,
                        0.1
                    ),
                    1
                )

                resp["humidity"] = round(
                    resp["humidity"]
                    + random.uniform(
                        -0.3,
                        0.3
                    ),
                    1
                )

                resp["online"] = False


            self.send_json_response(
                200,
                resp
            )

            return


        # ====================================================
        # STATIC DASHBOARD
        # ====================================================

        return super().do_GET()


    # ========================================================
    # POST REQUESTS
    # ========================================================

    def do_POST(self):

        parsed = urllib.parse.urlparse(
            self.path
        )


        content_length = int(
            self.headers.get(
                "Content-Length",
                0
            )
        )


        body = self.rfile.read(
            content_length
        )


        # ====================================================
        # PHYSICAL ESP32 INGESTION
        # ====================================================

        if parsed.path == "/api/esp32/data":

            # ------------------------------------------------
            # API KEY AUTHENTICATION
            # ------------------------------------------------

            req_api_key = self.headers.get(
                "X-API-Key"
            )


            try:

                data = json.loads(
                    body.decode(
                        "utf-8"
                    )
                )

            except Exception as e:

                self.send_json_response(
                    400,
                    {
                        "status": "error",
                        "message":
                            f"Malformed JSON: {str(e)}"
                    }
                )

                return


            # ------------------------------------------------
            # API KEY FROM JSON IF HEADER NOT PRESENT
            # ------------------------------------------------

            if (
                not req_api_key
                and
                isinstance(data, dict)
            ):

                req_api_key = (
                    data.get("api_key")
                    or
                    data.get("token")
                )


            # ------------------------------------------------
            # CHECK API KEY
            # ------------------------------------------------

            if req_api_key != ESP32_API_KEY:

                print(
                    "[AUTH FAILED] "
                    "Unauthorized ESP32 access attempt."
                )

                self.send_json_response(
                    401,
                    {
                        "status": "error",
                        "message":
                            "Unauthorized: Invalid or missing API key"
                    }
                )

                return


            # ------------------------------------------------
            # REQUIRED FIELDS
            # ------------------------------------------------

            required_fields = [

                "device_id",

                "zone",

                "mq4",

                "mq7",

                "mq135",

                "temperature",

                "humidity"
            ]


            missing = [

                f
                for f in required_fields
                if f not in data
            ]


            if missing:

                self.send_json_response(
                    400,
                    {
                        "status": "error",
                        "message":
                            "Missing required fields: "
                            + ", ".join(missing)
                    }
                )

                return


            # ------------------------------------------------
            # CONVERT VALUES
            # ------------------------------------------------

            try:

                device_id = str(
                    data["device_id"]
                )

                zone = str(
                    data["zone"]
                )

                mq4 = float(
                    data["mq4"]
                )

                mq7 = float(
                    data["mq7"]
                )

                mq135 = float(
                    data["mq135"]
                )

                temp = float(
                    data["temperature"]
                )

                hum = float(
                    data["humidity"]
                )


            except (
                ValueError,
                TypeError
            ) as e:

                self.send_json_response(
                    400,
                    {
                        "status": "error",
                        "message":
                            f"Invalid numeric format: {str(e)}"
                    }
                )

                return


            # ------------------------------------------------
            # SAFETY EVALUATION
            # ------------------------------------------------

            (
                status,
                risk_level,
                trigger_sensor,
                safe_route
            ) = evaluate_mine_safety(

                mq4,

                mq7,

                mq135,

                temp,

                hum,

                zone
            )


            # ------------------------------------------------
            # OPTIONAL CLIENT VALUES
            # ------------------------------------------------

            if data.get("risk_level"):

                risk_level = str(
                    data["risk_level"]
                ).upper()


            if data.get("status"):

                status = str(
                    data["status"]
                ).upper()


            # ------------------------------------------------
            # TIMESTAMP
            # ------------------------------------------------

            now_epoch = time.time()

            now_iso = (
                datetime.datetime.now()
                .strftime(
                    "%Y-%m-%d %H:%M:%S"
                )
            )


            # ------------------------------------------------
            # UPDATE LATEST ESP32 STATE
            # ------------------------------------------------

            latest_esp32_state.update({

                "online": True,

                "device_id":
                    device_id,

                "zone":
                    zone,

                "location":
                    f"Mine Zone {zone}",

                "mq4":
                    mq4,

                "mq7":
                    mq7,

                "mq135":
                    mq135,

                "temperature":
                    temp,

                "humidity":
                    hum,

                "risk_level":
                    risk_level,

                "status":
                    status,

                "trigger_sensor":
                    trigger_sensor,

                "safeRoute":
                    safe_route,

                "last_seen_epoch":
                    now_epoch,

                "last_seen_iso":
                    now_iso
            })


            # ------------------------------------------------
            # UPDATE COMPATIBILITY PAYLOAD
            # ------------------------------------------------

            sensor_payload.update({

                "zone":
                    zone,

                "location":
                    f"Mine Zone {zone}",

                "methane":
                    int(mq4),

                "co":
                    int(mq7),

                "mq135":
                    int(mq135),

                "temperature":
                    temp,

                "humidity":
                    hum,

                "status":
                    status,

                "safeRoute":
                    safe_route
            })


            # ------------------------------------------------
            # SAVE TO SQLITE
            # ------------------------------------------------

            try:

                conn = sqlite3.connect(
                    DB_PATH
                )

                cursor = conn.cursor()


                cursor.execute(
                    """
                    INSERT INTO esp32_readings (
                        device_id,
                        zone,
                        mq4,
                        mq7,
                        mq135,
                        temperature,
                        humidity,
                        risk_level,
                        status,
                        trigger_sensor,
                        timestamp,
                        created_at
                    )
                    VALUES (
                        ?,
                        ?,
                        ?,
                        ?,
                        ?,
                        ?,
                        ?,
                        ?,
                        ?,
                        ?,
                        ?,
                        ?
                    )
                    """,
                    (
                        device_id,
                        zone,
                        mq4,
                        mq7,
                        mq135,
                        temp,
                        hum,
                        risk_level,
                        status,
                        trigger_sensor,
                        now_iso,
                        now_epoch
                    )
                )


                # Keep latest 500 records

                cursor.execute(
                    """
                    DELETE FROM esp32_readings
                    WHERE id NOT IN (
                        SELECT id
                        FROM esp32_readings
                        ORDER BY id DESC
                        LIMIT 500
                    )
                    """
                )


                conn.commit()

                conn.close()


            except Exception as e:

                print(
                    f"[DB ERROR] Insertion failed: {e}"
                )


            # ------------------------------------------------
            # CONSOLE LOG
            # ------------------------------------------------

            print(
                f"[ESP32 INGESTION] "
                f"{device_id} ({zone}) | "
                f"CH4: {mq4} | "
                f"CO: {mq7} | "
                f"AQI: {mq135} | "
                f"Temp: {temp}C | "
                f"Hum: {hum}% | "
                f"Status: {status}"
            )


            # ------------------------------------------------
            # RESPONSE TO ESP32
            # ------------------------------------------------

            self.send_json_response(
                200,
                {

                    "status":
                        "success",

                    "message":
                        "ESP32 telemetry recorded and broadcasted live",

                    "device_id":
                        device_id,

                    "zone":
                        zone,

                    "safety_status":
                        status,

                    "risk_level":
                        risk_level,

                    "trigger_sensor":
                        trigger_sensor,

                    "timestamp":
                        now_iso
                }
            )

            return


        # ====================================================
        # GENERAL /api/data POST
        # ====================================================

        if parsed.path == "/api/data":

            try:

                data = json.loads(
                    body.decode(
                        "utf-8"
                    )
                )


                sensor_payload.update(
                    data
                )


                self.send_json_response(
                    200,
                    {
                        "status":
                            "success",

                        "updated":
                            sensor_payload
                    }
                )


            except Exception as e:

                self.send_json_response(
                    400,
                    {
                        "status":
                            "error",

                        "message":
                            str(e)
                    }
                )


            return


        # ====================================================
        # PRESET SWITCHER
        # ====================================================

        if parsed.path == "/api/preset":

            try:

                data = json.loads(
                    body.decode(
                        "utf-8"
                    )
                )


                mode = data.get(
                    "preset",
                    "normal"
                )


                # ------------------------------------------------
                # NORMAL PRESET
                # ------------------------------------------------

                if mode == "normal":

                    sensor_payload.update({

                        "zone":
                            "M1",

                        "location":
                            "Mine Zone M1",

                        "methane":
                            420,

                        "co":
                            18,

                        "mq135":
                            110,

                        "temperature":
                            27.4,

                        "humidity":
                            58,

                        "status":
                            "SAFE",

                        "safeRoute":
                            "M1 -> MAIN EXIT"
                    })


                # ------------------------------------------------
                # WARNING PRESET
                # ------------------------------------------------

                elif mode == "warning":

                    sensor_payload.update({

                        "zone":
                            "M2",

                        "location":
                            "Mine Zone M2",

                        "methane":
                            1800,

                        "co":
                            1200,

                        "mq135":
                            1400,

                        "temperature":
                            38,

                        "humidity":
                            65,

                        "status":
                            "WARNING",

                        "safeRoute":
                            "M2 -> M1 -> MAIN EXIT"
                    })


                # ------------------------------------------------
                # EMERGENCY PRESET
                # ------------------------------------------------

                elif mode == "emergency":

                    sensor_payload.update({

                        "zone":
                            "M2",

                        "location":
                            "Mine Zone M2",

                        "methane":
                            2900,

                        "co":
                            1850,

                        "mq135":
                            2100,

                        "temperature":
                            48,

                        "humidity":
                            72,

                        "status":
                            "EMERGENCY",

                        "safeRoute":
                            "M2 -> M1 -> MAIN EXIT"
                    })


                self.send_json_response(
                    200,
                    {
                        "status":
                            "preset applied",

                        "data":
                            sensor_payload
                    }
                )


            except Exception as e:

                self.send_json_response(
                    400,
                    {
                        "status":
                            "error",

                        "message":
                            str(e)
                    }
                )


            return


        # ====================================================
        # UNKNOWN ENDPOINT
        # ====================================================

        self.send_json_response(
            404,
            {
                "status":
                    "error",

                "message":
                    "Endpoint not found"
            }
        )


# ============================================================
# RUN SERVER
# ============================================================

def run():

    init_database()


    server_address = (
        "",
        PORT
    )


    httpd = HTTPServer(
        server_address,
        MineTelemetryHandler
    )


    print(
        "============================================================"
    )

    print(
        "  SMART MINE SAFETY CONTROL CENTER - RENDER & ESP32 SERVER"
    )

    print(
        "============================================================"
    )

    print(
        f"  Listening Port:     {PORT}"
    )

    print(
        "  ESP32 Ingestion:    POST /api/esp32/data"
    )

    print(
        "  ESP32 Live Stream:  GET  /api/esp32/data"
    )

    print(
        "  Sensor History:     GET  /api/esp32/history"
    )

    print(
        f"  API Key Protection: "
        f"{'Enabled' if ESP32_API_KEY else 'Disabled'}"
    )

    print(
        "  CORS Enabled:       Yes (*)"
    )

    print(
        "============================================================"
    )


    try:

        httpd.serve_forever()


    except KeyboardInterrupt:

        print(
            "\n[SHUTDOWN] Stopping server..."
        )

        httpd.server_close()


# ============================================================
# MAIN
# ============================================================

if __name__ == "__main__":

    run()
