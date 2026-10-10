#ifndef CONFIG_EXAMPLE_H
#define CONFIG_EXAMPLE_H

// ======================================================================================
// SMART MINE SAFETY CONTROL CENTER - ESP32 NODE CONFIGURATION TEMPLATE
// Copy this file to "config.h" and insert your credentials.
// NOTE: "config.h" is gitignored and will NOT be committed to version control.
// ======================================================================================

// 1. Wi-Fi Access Point Credentials
#define WIFI_SSID     "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// 2. Cloud / Server Target
// Set USE_HTTPS to true for Render cloud deployment, false for local HTTP testing
#define USE_HTTPS false

// Local server target (e.g. your computer's LAN IP when running esp32_mock_server.py)
#define SERVER_HOST "192.168.1.100"
#define SERVER_PORT 5000
#define SERVER_PATH "/api/esp32/data"

// Cloud Render target (used when USE_HTTPS is true)
#define RENDER_CLOUD_URL "https://smart-mine-safety-control-center.onrender.com/api/esp32/data"

// 3. Authentication Token (Must match server environment variable ESP32_API_KEY)
#define API_KEY "MINE_SECURE_ESP32_TOKEN_2026"

// 4. Node Hardware Identity & Zone Assignment
#define NODE_ID "ESP32_M1" // Device ID matching ^[a-zA-Z0-9_-]{1,32}$
#define ZONE_ID "M1"       // Must be strictly one of: "M1", "M2", or "M3"

// 5. Telemetry Reporting Interval (2000 ms = 2.0 seconds)
#define TELEMETRY_INTERVAL_MS 2000

// 6. Actuator Relay Polarity (set true if relay module is active-LOW, common on Arduino relay boards)
#define RELAY_ACTIVE_LOW false

#endif // CONFIG_EXAMPLE_H
