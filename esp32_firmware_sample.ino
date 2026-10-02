/*
 * ======================================================================================
 * AI-BASED MINE GAS LEAKAGE DETECTION & SMART EVACUATION SYSTEM
 * ESP32 Microcontroller Firmware Sample (College Prototype)
 * ======================================================================================
 * 
 * Hardware Requirements:
 * - ESP32 NodeMCU (30 or 38 pin)
 * - MQ-4 Gas Sensor (Methane CH4) -> Analog Pin 34 (ADC1_CH6)
 * - MQ-7 Gas Sensor (Carbon Monoxide CO) -> Analog Pin 35 (ADC1_CH7)
 * - MQ-135 Gas Sensor (Air Quality / NH3 / Smoke) -> Analog Pin 32 (ADC1_CH4)
 * - DHT11 Temperature & Humidity Sensor -> GPIO Pin 4
 * - Green Indicator LED -> GPIO Pin 18 (Safe)
 * - Yellow Indicator LED -> GPIO Pin 19 (Warning)
 * - Red Indicator LED -> GPIO Pin 21 (Emergency Hazard)
 * - Piezo Buzzer -> GPIO Pin 22 (PWM or Digital)
 * - Exhaust Fan Relay Module -> GPIO Pin 23 (Ventilation Actuator)
 * 
 * Output:
 * - Hosts a local REST WebServer on port 80 (Endpoint: GET /data)
 * - Returns JSON matching the web dashboard specification.
 * - Controls hardware LEDs, Buzzer cadence, and Exhaust Fan based on safety status.
 * ======================================================================================
 */

#include <WiFi.h>
#include <WebServer.h>
#include <DHT.h>
#include <ArduinoJson.h> // ArduinoJson v6 or v7

// WiFi Credentials (change to your local hotspot/router)
const char* ssid = "MINE_SAFETY_NET";
const char* password = "SafeMinePassword";

// Pin Configuration
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

// Threshold Definitions
#define THRESHOLD_MQ4_WARN     1000
#define THRESHOLD_MQ4_DANGER   2500
#define THRESHOLD_MQ7_WARN     50
#define THRESHOLD_MQ7_DANGER   200
#define THRESHOLD_MQ135_WARN   300
#define THRESHOLD_MQ135_DANGER 800
#define THRESHOLD_TEMP_WARN    35.0
#define THRESHOLD_TEMP_DANGER  45.0

// Active Zone identifier for this ESP32 node
const char* CURRENT_ZONE = "M2";
const char* CURRENT_LOCATION = "Mine Zone M2";

// Global Variables
DHT dht(PIN_DHT, DHTTYPE);
WebServer server(80);

int valMethane = 0;
int valCO = 0;
int valMQ135 = 0;
float valTemp = 0.0;
float valHum = 0.0;
String currentStatus = "SAFE";
String safeRoute = "M2 -> M1 -> MAIN EXIT";

unsigned long lastSampleTime = 0;
const unsigned long sampleInterval = 1000; // 1 second

// Function to sound buzzer beeps
void soundBuzzer(int beepCount, int beepDuration, int pauseDuration) {
  for (int i = 0; i < beepCount; i++) {
    digitalWrite(PIN_BUZZER, HIGH);
    delay(beepDuration);
    digitalWrite(PIN_BUZZER, LOW);
    if (i < beepCount - 1) {
      delay(pauseDuration);
    }
  }
}

// REST API Handler for GET /data
void handleGetData() {
  StaticJsonDocument<384> doc;
  doc["zone"] = CURRENT_ZONE;
  doc["location"] = CURRENT_LOCATION;
  doc["methane"] = valMethane;
  doc["co"] = valCO;
  doc["mq135"] = valMQ135;
  doc["temperature"] = round(valTemp * 10) / 10.0;
  doc["humidity"] = round(valHum);
  doc["status"] = currentStatus;
  doc["safeRoute"] = safeRoute;

  String jsonResponse;
  serializeJson(doc, jsonResponse);

  // Enable CORS headers so dashboard can fetch from any domain/browser
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.send(200, "application/json", jsonResponse);
}

void handleOptions() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.send(200, "text/plain", "");
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n[BOOT] Smart Mine Safety Node Starting...");

  // Initialize GPIOs
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_YELLOW, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_FAN_RELAY, OUTPUT);

  // Default state: all off
  digitalWrite(PIN_LED_GREEN, HIGH);
  digitalWrite(PIN_LED_YELLOW, LOW);
  digitalWrite(PIN_LED_RED, LOW);
  digitalWrite(PIN_BUZZER, LOW);
  digitalWrite(PIN_FAN_RELAY, LOW); // Relay OFF

  // Initialize DHT
  dht.begin();

  // Connect to WiFi or create Access Point
  Serial.print("[WIFI] Connecting to ");
  Serial.println(ssid);
  WiFi.begin(ssid, password);

  int wifiAttempts = 0;
  while (WiFi.status() != WL_CONNECTED && wifiAttempts < 20) {
    delay(500);
    Serial.print(".");
    wifiAttempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WIFI] Connected successfully!");
    Serial.print("[WIFI] Node IP: http://");
    Serial.println(WiFi.localIP());
  } else {
    // Fallback: Start SoftAP if WiFi router is not available at college
    Serial.println("\n[WIFI] WiFi connection failed. Starting SoftAP mode...");
    WiFi.softAP("MINE_SAFETY_AP", "12345678");
    Serial.print("[WIFI] AP IP: http://");
    Serial.println(WiFi.softAPIP());
  }

  // Setup Web Server Endpoints
  server.on("/data", HTTP_GET, handleGetData);
  server.on("/data", HTTP_OPTIONS, handleOptions);
  server.begin();
  Serial.println("[SERVER] HTTP Server active on /data");

  // Initial boot beep
  soundBuzzer(1, 150, 100);
}

void loop() {
  server.handleClient();

  unsigned long currentMillis = millis();
  if (currentMillis - lastSampleTime >= sampleInterval) {
    lastSampleTime = currentMillis;

    // 1. Read Analog Gas Sensors
    // Map raw ADC (0-4095 on ESP32) to realistic PPM ranges for demonstration
    int rawMQ4 = analogRead(PIN_MQ4);
    int rawMQ7 = analogRead(PIN_MQ7);
    int rawMQ135 = analogRead(PIN_MQ135);

    valMethane = map(rawMQ4, 0, 4095, 200, 4500);
    valCO = map(rawMQ7, 0, 4095, 10, 800);
    valMQ135 = map(rawMQ135, 0, 4095, 80, 2000);

    // 2. Read Climate Sensors
    float t = dht.readTemperature();
    float h = dht.readHumidity();

    if (!isnan(t)) valTemp = t;
    if (!isnan(h)) valHum = h;

    // 3. Determine Safety Condition
    if (valMethane >= THRESHOLD_MQ4_DANGER || valCO >= THRESHOLD_MQ7_DANGER || 
        valMQ135 >= THRESHOLD_MQ135_DANGER || valTemp >= THRESHOLD_TEMP_DANGER) {
      currentStatus = "EMERGENCY";
      safeRoute = "M2 -> M1 -> MAIN EXIT";

      // Hardware LEDs: RED ON
      digitalWrite(PIN_LED_GREEN, LOW);
      digitalWrite(PIN_LED_YELLOW, LOW);
      digitalWrite(PIN_LED_RED, HIGH);

      // Ventilation Fan Relay: ACTIVE (Full Spool)
      digitalWrite(PIN_FAN_RELAY, HIGH);

      // Buzzer: 3 alert beeps (Danger)
      soundBuzzer(3, 100, 80);

    } else if (valMethane >= THRESHOLD_MQ4_WARN || valCO >= THRESHOLD_MQ7_WARN || 
               valMQ135 >= THRESHOLD_MQ135_WARN || valTemp >= THRESHOLD_TEMP_WARN) {
      currentStatus = "WARNING";
      safeRoute = "M2 -> M1 -> MAIN EXIT";

      // Hardware LEDs: YELLOW ON
      digitalWrite(PIN_LED_GREEN, LOW);
      digitalWrite(PIN_LED_YELLOW, HIGH);
      digitalWrite(PIN_LED_RED, LOW);

      // Ventilation Fan Relay: ACTIVE
      digitalWrite(PIN_FAN_RELAY, HIGH);

      // Buzzer: 2 alert beeps (Warning)
      soundBuzzer(2, 120, 100);

    } else {
      currentStatus = "SAFE";
      safeRoute = "M2 -> M1 -> MAIN EXIT";

      // Hardware LEDs: GREEN ON
      digitalWrite(PIN_LED_GREEN, HIGH);
      digitalWrite(PIN_LED_YELLOW, LOW);
      digitalWrite(PIN_LED_RED, LOW);

      // Ventilation Fan Relay: Standby (OFF)
      digitalWrite(PIN_FAN_RELAY, LOW);

      // Buzzer: Periodic 1 alert pulse (Safe heartbeat - every 15s)
      static unsigned long lastSafeBeep = 0;
      if (currentMillis - lastSafeBeep > 15000) {
        lastSafeBeep = currentMillis;
        soundBuzzer(1, 60, 50);
      }
    }

    // Telemetry log to Serial monitor
    Serial.printf("[TELEMETRY] CH4: %d ppm | CO: %d ppm | AQI: %d | Temp: %.1f C | Hum: %.1f%% | Status: %s\n",
                  valMethane, valCO, valMQ135, valTemp, valHum, currentStatus.c_str());
  }
}
