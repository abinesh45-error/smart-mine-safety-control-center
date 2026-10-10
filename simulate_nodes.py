#!/usr/bin/env python3
"""
SMART MINE SAFETY CONTROL CENTER - TEST & VERIFICATION SUITE
Simulates 3 edge ESP32 nodes (M1, M2, M3) and validates:
  - Security (bad key=401, oversized body=413, bad zone=400)
  - States (safe / warning / evacuate / sensor-fault / offline)
  - BFS Routing (M2 hazard with worker in M3 -> M3 ➔ AUX ➔ EXIT; M1 hazard with worker in M2 -> M2 ➔ AUX ➔ EXIT)
"""

import sys
import time
import json
import urllib.request
import urllib.error

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

API_URL = "http://localhost:5000/api/esp32/data"
API_KEY = "MINE_SECURE_ESP32_TOKEN_2026"

def post_telemetry(payload, url=API_URL, token=API_KEY):
    data_bytes = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data_bytes,
        headers={
            "Content-Type": "application/json",
            "X-API-Key": token
        },
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=4.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            print(f"[{payload.get('node_id')} ({payload.get('zone')})] HTTP {resp.status} | Status: {data.get('server_status')} | Risk: {data.get('risk_score')}%")
            return resp.status, data
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        print(f"[{payload.get('node_id')}] HTTP {e.code} Error: {err_body.strip()}")
        return e.code, err_body
    except Exception as e:
        print(f"[{payload.get('node_id')}] Connection Error: {e}")
        return 0, str(e)

def get_server_data():
    try:
        with urllib.request.urlopen(API_URL, timeout=4.0) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"GET /api/esp32/data Error: {e}")
        return {}

def test_security_protections():
    print("\n==================================================")
    print("  TEST 1: SECURITY & VALIDATION (401, 413, 400)")
    print("==================================================")

    # 1. Invalid API Key -> 401
    print("\n[A] Testing Invalid API Key (Expect 401):")
    code, _ = post_telemetry({
        "node_id": "ESP32_M1", "zone": "M1", "methane": 420, "co": 18,
        "toxic": 110, "temp": 27.0, "humidity": 55, "uptime": 10
    }, token="WRONG_UNAUTHORIZED_TOKEN")
    assert code == 401, f"Expected 401, got {code}"
    print(">>> PASS: 401 Unauthorized verified.")

    # 2. Oversized Payload (>2 KB) -> 413
    print("\n[B] Testing Oversized Request Body > 2048 Bytes (Expect 413):")
    bloated_payload = {
        "node_id": "ESP32_M1", "zone": "M1", "methane": 420, "co": 18,
        "toxic": 110, "temp": 27.0, "humidity": 55, "uptime": 10,
        "junk": "A" * 3000
    }
    code, _ = post_telemetry(bloated_payload)
    assert code == 413, f"Expected 413, got {code}"
    print(">>> PASS: 413 Payload Too Large verified.")

    # 3. Invalid Zone -> 400
    print("\n[C] Testing Invalid Zone 'M9' (Expect 400):")
    code, _ = post_telemetry({
        "node_id": "ESP32_M1", "zone": "M9", "methane": 420, "co": 18,
        "toxic": 110, "temp": 27.0, "humidity": 55, "uptime": 10
    })
    assert code == 400, f"Expected 400, got {code}"
    print(">>> PASS: 400 Bad Request on invalid zone verified.")

    # 4. Invalid Node ID regex -> 400
    print("\n[D] Testing Invalid Node ID 'ESP32$$$#' (Expect 400):")
    code, _ = post_telemetry({
        "node_id": "ESP32$$$#", "zone": "M1", "methane": 420, "co": 18,
        "toxic": 110, "temp": 27.0, "humidity": 55, "uptime": 10
    })
    assert code == 400, f"Expected 400, got {code}"
    print(">>> PASS: 400 Bad Request on regex failure verified.")

def test_states_and_routing():
    print("\n==================================================")
    print("  TEST 2: MULTI-NODE STATES & BFS ROUTING")
    print("==================================================")

    # 1. Normal / Safe across all 3 nodes (M1, M2, M3)
    print("\n[A] Setting All 3 Nodes to SAFE:")
    post_telemetry({"node_id": "ESP32_M1", "zone": "M1", "methane": 380, "co": 15, "toxic": 100, "temp": 26.5, "humidity": 55, "uptime": 100})
    post_telemetry({"node_id": "ESP32_M2", "zone": "M2", "methane": 410, "co": 18, "toxic": 110, "temp": 27.0, "humidity": 58, "uptime": 100})
    post_telemetry({"node_id": "ESP32_M3", "zone": "M3", "methane": 400, "co": 16, "toxic": 105, "temp": 27.2, "humidity": 56, "uptime": 100})
    data = get_server_data()
    print(f"Server Status: {data.get('status')} | Routes: {data.get('routes')}")
    assert data.get('status') == "SAFE"

    # 2. Warning in M2
    print("\n[B] Warning in Zone M2 (Methane 1500 ppm):")
    post_telemetry({"node_id": "ESP32_M2", "zone": "M2", "methane": 1500, "co": 60, "toxic": 350, "temp": 36.0, "humidity": 65, "uptime": 105})
    data = get_server_data()
    print(f"Server Status: {data.get('status')} | Hazard Zones: {data.get('hazard_zones')}")
    assert data.get('status') == "WARNING"

    # 3. Critical Hazard in M2 -> Test Worker M3 routing: M3 -> AUX -> EXIT
    print("\n[C] Critical Hazard in Zone M2 (CH4=3100 ppm) -> Test Worker in M3 routing:")
    post_telemetry({"node_id": "ESP32_M2", "zone": "M2", "methane": 3100, "co": 95, "toxic": 850, "temp": 42.0, "humidity": 70, "uptime": 110})
    data = get_server_data()
    routes = data.get("routes", {})
    route_m3 = routes.get("M3", "")
    print(f"M3 Safe Route: '{route_m3}'")
    assert "AUXILIARY ESCAPE SHAFT" in route_m3 and "MAIN EXIT" in route_m3, f"Unexpected route for M3: {route_m3}"
    print(">>> PASS: Worker in M3 safely routes through AUXILIARY ESCAPE SHAFT bypassing M2!")

    # 4. Critical Hazard in M1 -> Test Worker M2 routing: M2 -> AUX -> EXIT
    print("\n[D] Critical Hazard in Zone M1 (CO=250 ppm) & Safe in M2 -> Test Worker in M2 routing:")
    post_telemetry({"node_id": "ESP32_M1", "zone": "M1", "methane": 400, "co": 250, "toxic": 200, "temp": 28.0, "humidity": 55, "uptime": 115})
    post_telemetry({"node_id": "ESP32_M2", "zone": "M2", "methane": 410, "co": 18, "toxic": 110, "temp": 27.0, "humidity": 58, "uptime": 115})
    data = get_server_data()
    routes = data.get("routes", {})
    route_m2 = routes.get("M2", "")
    print(f"M2 Safe Route: '{route_m2}'")
    assert "AUXILIARY ESCAPE SHAFT" in route_m2 and "MAIN EXIT" in route_m2, f"Unexpected route for M2: {route_m2}"
    print(">>> PASS: Worker in M2 safely routes through AUXILIARY ESCAPE SHAFT bypassing blocked M1 portal!")

    # 5. Sensor Fault in Zone M3
    print("\n[E] Testing Sensor Fault (temp=None / sensor_fault=True):")
    post_telemetry({"node_id": "ESP32_M3", "zone": "M3", "methane": 400, "co": 20, "toxic": 100, "temp": None, "sensor_fault": True, "uptime": 120})
    data = get_server_data()
    zone_m3 = data.get("zones", {}).get("M3", {})
    print(f"Zone M3 State: {zone_m3}")
    assert zone_m3.get("status") == "SENSOR_FAULT", f"Expected SENSOR_FAULT, got {zone_m3.get('status')}"
    print(">>> PASS: SENSOR_FAULT correctly identified without fake fallback.")

def test_offline_fail_safe():
    print("\n==================================================")
    print("  TEST 3: FAIL-SAFE 10-SECOND OFFLINE TIMEOUT")
    print("==================================================")
    print("Waiting 11 seconds without telemetry packets...")
    for s in range(11, 0, -1):
        print(f"Waiting {s}s...", flush=True)
        time.sleep(1.0)
    print("\nQuerying GET /api/esp32/data:")
    data = get_server_data()
    print(f"Online: {data.get('online')} | Status: {data.get('status')} | Route: {data.get('safeRoute')}")
    assert not data.get("online"), "Expected online=False"
    assert data.get("status") == "OFFLINE", f"Expected status='OFFLINE', got {data.get('status')}"
    assert data.get("safeRoute") == "NO DATA - SENSOR OFFLINE", f"Expected 'NO DATA - SENSOR OFFLINE', got {data.get('safeRoute')}"
    print(">>> PASS: Fail-safe offline verified. System NEVER reports SAFE when sensors are silent!")

def main():
    arg = sys.argv[1].lower() if len(sys.argv) > 1 else "all"

    print("==================================================================")
    print("  SMART MINE SAFETY - AUTOMATED VERIFICATION SUITE")
    print(f"  Target: {API_URL}")
    print("==================================================================")

    if arg == "security":
        test_security_protections()
    elif arg == "states":
        test_states_and_routing()
    elif arg == "offline":
        test_offline_fail_safe()
    else:
        test_security_protections()
        test_states_and_routing()
        test_offline_fail_safe()
        print("\n==================================================")
        print("  ALL VERIFICATION TESTS COMPLETED SUCCESSFULLY!")
        print("==================================================")

if __name__ == "__main__":
    main()
