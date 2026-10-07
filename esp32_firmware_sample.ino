/*
 * ======================================================================================
 * SMART MINE SAFETY CONTROL CENTER - ESP32 FIRMWARE (PRODUCTION CLIENT)
 * AI-Based Mine Gas Leakage Detection and Smart Evacuation System
 * ======================================================================================
 * 
 * Target Board: ESP32 Dev Module / NodeMCU-32S
 * Communication: Wi-Fi -> HTTPS POST -> Render Cloud Backend -> Live Web Dashboard
 * Cloud Target: https://smart-mine-safety-control-center.onrender.com/api/esp32/data
 * 
 * Hardware Connected:
 *  - MQ-4 Gas Sensor (Methane CH4)        -> GPIO 34 (Analog ADC1_CH6)
 *  - MQ-7 Gas Sensor (Carbon Monoxide CO)  -> GPIO 35 (Analog ADC1_CH7)
 *  - MQ-135 Gas Sensor (Air Quality/NH3)  -> GPIO 32 (Analog ADC1_CH4)
 *  - DHT11 Sensor (Temperature & Humidity) -> GPIO 4  (Digital I/O)
 *  - Green LED (Safe Indicator)            -> GPIO 18 (Digital Output)
 *  - Yellow LED (Warning Indicator)        -> GPIO 19 (Digital Output)
 *  - Red LED (Emergency Hazard Indicator)  -> GPIO 21 (Digital Output)
 *  - Piezo Buzzer (Cadence Audio Alarm)    -> GPIO 22 (Digital Output)
 *  - 5V DC Ventilation Fan (Relay Module)  -> GPIO 23 (Digital Output)
 * 
 * Required Arduino Libraries (Install via Arduino Library Manager):
 *  1. "DHT sensor library" by Adafruit
 *  2. "Adafruit Unified Sensor" by Adafruit
 *  3. "ArduinoJson" by Benoit Blanchon (Version 6 or 7)
 * ======================================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <DHT.h>
#include <ArduinoJson.h>

// ======================================================================================
// 1. NETWORK & CLOUD API CONFIGURATION
// ======================================================================================
// Replace with your Wi-Fi router / mobile hotspot credentials
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Render Cloud API Endpoint (HTTPS)
const char* RENDER_API_URL = "https://smart-mine-safety-control-center.onrender.com/api/esp32/data";

// Security API Key (Matches server ESP32_API_KEY)
const char* API_KEY   = "MINE_SECURE_ESP32_TOKEN_2026";
const char* DEVICE_ID = "ESP32_M1";
const char* ZONE_ID   = "M1";

// Telemetry Transmission Interval (in milliseconds: 3000ms = 3 seconds)
const unsigned long SEND_INTERVAL = 3000;

// ======================================================================================
// 2. PIN DEFINITIONS
// ======================================================================================
#define PIN_MQ4        34
#define PIN_MQ7        35
#define PIN_MQ135      32
#define PIN_DHT        4
#define DHTTYPE        DHT11

#define PIN_LED_GREEN  18
#define PIN_LED_YELLOW 19
#define PIN_LED_RED    21
#define PIN_BUZZER     22
#define PIN_FAN_RELAY  23

// Safety Thresholds (According to Mine Safety Standards)
#define THRESHOLD_MQ4_WARN     1000
#define THRESHOLD_MQ4_DANGER   2500
#define THRESHOLD_MQ7_WARN     50
#define THRESHOLD_MQ7_DANGER   200
#define THRESHOLD_MQ135_WARN   300
#define THRESHOLD_MQ135_DANGER 800
#define THRESHOLD_TEMP_WARN    35.0
#define THRESHOLD_TEMP_DANGER  45.0

// Sensor instance
DHT dht(PIN_DHT, DHTTYPE);

// Tracking timers
unsigned long lastSendTime = 0;
unsigned long lastBuzzerHeartbeat = 0;

// ======================================================================================
// 3. HARDWARE ACTUATOR HELPERS
// ======================================================================================
void soundBuzzerCadence(int beeps, int beepDuration, int pauseDuration) {
  for (int i = 0; i < beeps; i++) {
    digitalWrite(PIN_BUZZER, HIGH);
    delay(beepDuration);
    digitalWrite(PIN_BUZZER, LOW);
    if (i < beeps - 1) {
      delay(pauseDuration);
    }
  }
}

void applyActuatorState(String status) {
  if (status == "EMERGENCY") {
    digitalWrite(PIN_LED_GREEN, LOW);
    digitalWrite(PIN_LED_YELLOW, LOW);
    digitalWrite(PIN_LED_RED, HIGH);
    digitalWrite(PIN_FAN_RELAY, HIGH); // Exhaust Fan: 100% Full Spool
    soundBuzzerCadence(3, 90, 80);      // 3 Rapid Danger Alarm Beeps
  } else if (status == "WARNING") {
    digitalWrite(PIN_LED_GREEN, LOW);
    digitalWrite(PIN_LED_YELLOW, HIGH);
    digitalWrite(PIN_LED_RED, LOW);
    digitalWrite(PIN_FAN_RELAY, HIGH); // Exhaust Fan: Spooling ON
    soundBuzzerCadence(2, 120, 100);    // 2 Warning Beeps
  } else {
    digitalWrite(PIN_LED_GREEN, HIGH);
    digitalWrite(PIN_LED_YELLOW, LOW);
    digitalWrite(PIN_LED_RED, LOW);
    digitalWrite(PIN_FAN_RELAY, LOW);  // Exhaust Fan: Normal Standby
    
    // Heartbeat single beep every 15 seconds
    if (millis() - lastBuzzerHeartbeat > 15000) {
      lastBuzzerHeartbeat = millis();
      soundBuzzerCadence(1, 50, 50);
    }
  }
}

// ======================================================================================
// 4. WI-FI CONNECTION & RECONNECT
// ======================================================================================
void connectToWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.println("\n--------------------------------------------------");
  Serial.print("[WIFI] Connecting to SSID: ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WIFI] Connected Successfully!");
    Serial.print("[WIFI] IP Address: ");
    Serial.println(WiFi.localIP());
    Serial.print("[WIFI] Signal Strength (RSSI): ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
  } else {
    Serial.println("\n[WIFI WARNING] Connection failed. Will retry on next cycle.");
  }
  Serial.println("--------------------------------------------------");
}

// ======================================================================================
// 5. DATA TRANSMISSION TO RENDER CLOUD
// ======================================================================================
void sendTelemetryToRender(int rawMQ4, int rawMQ7, int rawMQ135, float temp, float hum, String riskLevel, String safetyStatus) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[HTTP ERROR] Wi-Fi not connected. Skipping cloud transmission.");
    connectToWiFi();
    return;
  }

  // Create secure client (setInsecure bypasses TLS root cert bundle limitations)
  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(5000);

  HTTPClient https;
  Serial.print("[HTTP] Sending POST to: ");
  Serial.println(RENDER_API_URL);

  if (https.begin(client, RENDER_API_URL)) {
    https.addHeader("Content-Type", "application/json");
    https.addHeader("X-API-Key", API_KEY);

    // Build JSON payload matching dashboard specification
    StaticJsonDocument<384> doc;
    doc["device_id"]   = DEVICE_ID;
    doc["zone"]        = ZONE_ID;
    doc["mq4"]         = rawMQ4;
    doc["mq7"]         = rawMQ7;
    doc["mq135"]       = rawMQ135;
    doc["temperature"] = round(temp * 10.0) / 10.0;
    doc["humidity"]    = round(hum);
    doc["risk_level"]  = riskLevel;
    doc["status"]      = safetyStatus;

    String jsonString;
    serializeJson(doc, jsonString);

    Serial.print("[HTTP PAYLOAD] ");
    Serial.println(jsonString);

    int httpCode = https.POST(jsonString);

    if (httpCode > 0) {
      Serial.printf("[HTTP RESPONSE] Code: %d\n", httpCode);
      if (httpCode == HTTP_CODE_OK || httpCode == HTTP_CODE_CREATED) {
        String response = https.getString();
        Serial.print("[HTTP RESPONSE BODY] ");
        Serial.println(response);
      } else {
        Serial.printf("[HTTP WARNING] Non-200 status code: %d\n", httpCode);
      }
    } else {
      Serial.printf("[HTTP ERROR] POST failed: %s\n", https.errorToString(httpCode).c_str());
    }

    https.end();
  } else {
    Serial.println("[HTTP ERROR] Unable to initiate HTTPS connection.");
  }
}

// ======================================================================================
// 6. SETUP & MAIN LOOP
// ======================================================================================
void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n========================================================");
  Serial.println("  SMART MINE SAFETY CONTROL CENTER - ESP32 TELEMETRY");
  Serial.println("  AI Gas Leakage Detection & Smart Evacuation Node");
  Serial.println("========================================================");

  // Initialize GPIO outputs
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_YELLOW, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_FAN_RELAY, OUTPUT);

  // Initial actuator state
  digitalWrite(PIN_LED_GREEN, HIGH);
  digitalWrite(PIN_LED_YELLOW, LOW);
  digitalWrite(PIN_LED_RED, LOW);
  digitalWrite(PIN_BUZZER, LOW);
  digitalWrite(PIN_FAN_RELAY, LOW);

  // Initialize DHT sensor
  dht.begin();
  Serial.println("[SENSORS] DHT11 initialized.");

  // Configure ADC attenuation for 0-3.3V full range
  analogSetAttenuation(ADC_11db);
  Serial.println("[SENSORS] ADC configured for MQ gas sensors.");

  // Boot beep
  soundBuzzerCadence(1, 100, 50);

  // Initial Wi-Fi connection
  connectToWiFi();
}

void loop() {
  // Ensure Wi-Fi remains connected
  if (WiFi.status() != WL_CONNECTED) {
    connectToWiFi();
  }

  unsigned long currentMillis = millis();

  if (currentMillis - lastSendTime >= SEND_INTERVAL) {
    lastSendTime = currentMillis;

    // 1. Read Analog Gas Sensors
    // Raw ESP32 ADC is 0 - 4095. Map to standard operational prototype PPM.
    int rawMQ4ADC   = analogRead(PIN_MQ4);
    int rawMQ7ADC   = analogRead(PIN_MQ7);
    int rawMQ135ADC = analogRead(PIN_MQ135);

    int valMethane = map(rawMQ4ADC, 0, 4095, 200, 4500);
    int valCO      = map(rawMQ7ADC, 0, 4095, 10, 800);
    int valMQ135   = map(rawMQ135ADC, 0, 4095, 80, 2000);

    // 2. Read Climate Sensors
    float t = dht.readTemperature();
    float h = dht.readHumidity();

    // Fallback if sensor temporarily glitches
    if (isnan(t)) t = 27.5;
    if (isnan(h)) h = 60.0;

    // 3. Multi-Gas AI Safety Assessment (Edge calculation)
    String safetyStatus = "SAFE";
    String riskLevel    = "LOW";

    if (valMethane >= THRESHOLD_MQ4_DANGER || valCO >= THRESHOLD_MQ7_DANGER || 
        valMQ135 >= THRESHOLD_MQ135_DANGER || t >= THRESHOLD_TEMP_DANGER) {
      safetyStatus = "EMERGENCY";
      riskLevel    = "CRITICAL";
    } else if (valMethane >= THRESHOLD_MQ4_WARN || valCO >= THRESHOLD_MQ7_WARN || 
               valMQ135 >= THRESHOLD_MQ135_WARN || t >= THRESHOLD_TEMP_WARN) {
      safetyStatus = "WARNING";
      riskLevel    = "MEDIUM";
    } else {
      safetyStatus = "SAFE";
      riskLevel    = "LOW";
    }

    // 4. Update Local Hardware Actuators (LEDs, Fan, Buzzer)
    applyActuatorState(safetyStatus);

    // 5. Serial Monitor Printout
    Serial.println("\n--------------------------------------------------");
    Serial.printf("[READINGS] CH4: %d ppm | CO: %d ppm | AQI: %d ppm | Temp: %.1f C | Hum: %.1f %%\n",
                  valMethane, valCO, valMQ135, t, h);
    Serial.printf("[STATUS] Risk: %s | Safety State: %s\n", riskLevel.c_str(), safetyStatus.c_str());

    // 6. Transmit to Render Cloud
    sendTelemetryToRender(valMethane, valCO, valMQ135, t, h, riskLevel, safetyStatus);
  }
}
