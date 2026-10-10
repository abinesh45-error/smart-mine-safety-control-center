/*
 * ======================================================================================
 * SMART MINE SAFETY CONTROL CENTER - ESP32 FIRMWARE (PRODUCTION CLIENT)
 * AI-Based Mine Gas Leakage Detection and Smart Evacuation System
 * ======================================================================================
 *
 * Target Board: ESP32 Dev Module / NodeMCU-32S
 * Communication: Wi-Fi -> HTTP / HTTPS POST -> Surface SCADA Backend -> Live Web Dashboard
 *
 * --------------------------------------------------------------------------------------
 * ⚠️ HARDWARE SAFETY SPECIFICATIONS & WIRING INSTRUCTIONS
 * --------------------------------------------------------------------------------------
 * 1. VOLTAGE DIVIDER ON MQ ANALOG OUTPUTS:
 *    The MQ-4, MQ-7, and MQ-135 sensors require 5V VCC for their internal heating coils
 *    and output an analog signal (AOUT) between 0.0V and 5.0V.
 *    CRITICAL: ESP32 ADC pins (GPIO 32, 34, 35) are rated for a MAXIMUM of 3.3V!
 *    Connecting 5V directly will destroy the ESP32 ADC multiplexer.
 *
 *    REQUIRED VOLTAGE DIVIDER CIRCUIT:
 *      MQ Sensor AOUT ----[ R1: 10k ohm ]----+----> ESP32 ADC Pin (GPIO 34 / 35 / 32)
 *                                           |
 *                                       [ R2: 20k ohm ]
 *                                           |
 *                                          GND
 *    Formula: V_adc = V_sensor * (20k / (10k + 20k)) = V_sensor * (2/3) ≈ max 3.33V.
 *
 * 2. EXTERNAL 5V POWER SUPPLY:
 *    MQ sensor heating coils consume 150-180 mA EACH (~550 mA total). The ESP32's onboard
 *    linear voltage regulator (AMS1117) cannot supply this current from USB without brownout.
 *    USE A DEDICATED 5V 2A EXTERNAL DC POWER SUPPLY for sensor heating pins (VCC), and
 *    ALWAYS connect the external power supply GND and ESP32 GND together (COMMON GROUND).
 *
 * 3. RELAY ACTIVE-LOW CONFIGURATION:
 *    Most optoisolated Arduino/ESP relay modules trigger on active-LOW logic (IN pulled to GND).
 *    Configure RELAY_ACTIVE_LOW in config.h (true for active-LOW, false for active-HIGH).
 *
 * --------------------------------------------------------------------------------------
 * ⚠️ LABELLING & INTRINSIC SAFETY DISCLAIMER
 * --------------------------------------------------------------------------------------
 * DEMO VALUES ONLY: All threshold constants in this firmware are demonstration values
 * calibrated for laboratory simulation and final-year engineering demonstrations.
 * PROTOTYPE DISCLAIMER: This educational prototype is NOT intrinsically-safe (IS)
 * certified equipment (ATEX, IECEx, or DGMS certified) for real hazardous explosive mines.
 * ======================================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <DHT.h>
#include <ArduinoJson.h>

// Load credentials, server endpoint, and node assignment from separate config file (gitignored)
#include "config.h"

// Relay Polarity Support
#ifndef RELAY_ACTIVE_LOW
#define RELAY_ACTIVE_LOW false
#endif
#define RELAY_ON  (RELAY_ACTIVE_LOW ? LOW : HIGH)
#define RELAY_OFF (RELAY_ACTIVE_LOW ? HIGH : LOW)

// ======================================================================================
// PIN DEFINITIONS
// ======================================================================================
#define PIN_MQ4        34  // MQ-4 Methane CH4 (ADC1_CH6 via voltage divider)
#define PIN_MQ7        35  // MQ-7 Carbon Monoxide CO (ADC1_CH7 via voltage divider)
#define PIN_MQ135      32  // MQ-135 Toxic Air Quality (ADC1_CH4 via voltage divider)
#define PIN_DHT        4   // DHT11 Temp & Humidity Digital I/O
#define DHTTYPE        DHT11

#define PIN_LED_GREEN  18  // Safe Indicator LED (3.3V via 220 ohm)
#define PIN_LED_YELLOW 19  // Warning Indicator LED (3.3V via 220 ohm)
#define PIN_LED_RED    21  // Evacuation / Emergency Hazard LED (3.3V via 220 ohm)
#define PIN_BUZZER     22  // Piezo Buzzer
#define PIN_FAN_RELAY  23  // Exhaust Fan Relay Module

// ======================================================================================
// DEMO THRESHOLDS (Canonical table identical to server)
// ======================================================================================
#define THRESHOLD_MQ4_WARN     1000  // Methane Warning (ppm)
#define THRESHOLD_MQ4_DANGER   2500  // Methane Evacuate (ppm)

#define THRESHOLD_MQ7_WARN     50    // Carbon Monoxide Warning (ppm)
#define THRESHOLD_MQ7_DANGER   200   // Carbon Monoxide Evacuate (ppm)

#define THRESHOLD_MQ135_WARN   300   // Toxic / Air Quality Warning (ppm)
#define THRESHOLD_MQ135_DANGER 800   // Toxic / Air Quality Evacuate (ppm)

#define THRESHOLD_TEMP_WARN    35.0  // Temperature Warning (°C)
#define THRESHOLD_TEMP_DANGER  45.0  // Temperature Evacuate (°C)

// Hardware Sensor Instance
DHT dht(PIN_DHT, DHTTYPE);

// 120-Second Warm-up Timing
const unsigned long MQ_WARMUP_MS = 120000;
unsigned long systemStartMillis = 0;
bool warmupComplete = false;

// Calibrated Clean-Air Baseline Resistances (R0)
float R0_MQ4   = 10.0;
float R0_MQ7   = 10.0;
float R0_MQ135 = 10.0;
const float RL_VALUE = 10.0; // 10k ohm load resistor on breakout board

// Non-blocking Timing Variables
unsigned long lastTelemetryMillis = 0;
unsigned long lastWiFiRetryMillis = 0;
const unsigned long WIFI_RECONNECT_INTERVAL_MS = 5000;

// Local Buzzer State Machine (Non-blocking)
unsigned long lastBuzzerActionMillis = 0;
int buzzerPulseCount = 0;
int buzzerTargetPulses = 0;
bool buzzerIsOn = false;

// ======================================================================================
// NON-BLOCKING BUZZER HANDLER
// ======================================================================================
void triggerBuzzerPattern(int pulses) {
  if (buzzerTargetPulses == 0) {
    buzzerTargetPulses = pulses;
    buzzerPulseCount = 0;
    buzzerIsOn = false;
    lastBuzzerActionMillis = millis();
  }
}

void updateBuzzerAsync() {
  unsigned long now = millis();
  if (buzzerTargetPulses > 0) {
    if (buzzerIsOn) {
      if (now - lastBuzzerActionMillis >= 90) {
        digitalWrite(PIN_BUZZER, LOW);
        buzzerIsOn = false;
        lastBuzzerActionMillis = now;
        buzzerPulseCount++;
        if (buzzerPulseCount >= buzzerTargetPulses) {
          buzzerTargetPulses = 0;
          buzzerPulseCount = 0;
        }
      }
    } else {
      if (now - lastBuzzerActionMillis >= 100) {
        digitalWrite(PIN_BUZZER, HIGH);
        buzzerIsOn = true;
        lastBuzzerActionMillis = now;
      }
    }
  } else {
    digitalWrite(PIN_BUZZER, LOW);
  }
}

// ======================================================================================
// 10-SAMPLE ADC AVERAGING & CLEAN-AIR CALIBRATION
// ======================================================================================
int readAnalogAverage(int pin, int samples = 10) {
  long sum = 0;
  for (int i = 0; i < samples; i++) {
    sum += analogRead(pin);
    delayMicroseconds(200);
  }
  return (int)(sum / samples);
}

float calculateRs(int adcValue) {
  // ADC 12-bit (0-4095) with voltage divider (2/3 ratio):
  // Vadc = (adc / 4095.0) * 3.3V
  // Vsensor = Vadc * 1.5 (reconstructs 0-5V sensor output)
  float vAdc = (adcValue / 4095.0) * 3.3;
  float vSensor = vAdc * 1.5;
  if (vSensor < 0.1) vSensor = 0.1;
  if (vSensor > 4.9) vSensor = 4.9;
  // Sensor resistance: Rs = RL * (Vc - Vsensor) / Vsensor
  return RL_VALUE * (5.0 - vSensor) / vSensor;
}

// Calibrate R0 during the clean-air warm-up phase
void calibrateCleanAirBaselines() {
  int raw4   = readAnalogAverage(PIN_MQ4, 10);
  int raw7   = readAnalogAverage(PIN_MQ7, 10);
  int raw135 = readAnalogAverage(PIN_MQ135, 10);

  float rs4   = calculateRs(raw4);
  float rs7   = calculateRs(raw7);
  float rs135 = calculateRs(raw135);

  // Clean air ratios: MQ4 ≈ 4.4, MQ7 ≈ 27.0, MQ135 ≈ 3.6
  R0_MQ4   = rs4 / 4.4;
  R0_MQ7   = rs7 / 27.0;
  R0_MQ135 = rs135 / 3.6;

  if (R0_MQ4 < 1.0) R0_MQ4 = 1.0;
  if (R0_MQ7 < 1.0) R0_MQ7 = 1.0;
  if (R0_MQ135 < 1.0) R0_MQ135 = 1.0;
}

// Calculate PPM using clean-air calibrated R0 power-law curves
int calculateMethanePpm(int adcVal) {
  float rs = calculateRs(adcVal);
  float ratio = rs / R0_MQ4;
  // MQ-4 CH4 curve approximation: PPM = 1000 * (Rs/R0)^(-2.6)
  float ppm = 1000.0 * pow(ratio, -2.6);
  return (int)constrain(ppm, 100.0, 10000.0);
}

int calculateCoPpm(int adcVal) {
  float rs = calculateRs(adcVal);
  float ratio = rs / R0_MQ7;
  // MQ-7 CO curve approximation: PPM = 100 * (Rs/R0)^(-1.5)
  float ppm = 100.0 * pow(ratio, -1.5);
  return (int)constrain(ppm, 5.0, 2000.0);
}

int calculateToxicPpm(int adcVal) {
  float rs = calculateRs(adcVal);
  float ratio = rs / R0_MQ135;
  // MQ-135 Air Quality curve approximation: PPM = 110 * (Rs/R0)^(-2.8)
  float ppm = 110.0 * pow(ratio, -2.8);
  return (int)constrain(ppm, 20.0, 3000.0);
}

// ======================================================================================
// LOCAL FAIL-SAFE ACTUATOR LOGIC (OPERATES 100% INDEPENDENTLY OF WI-FI)
// ======================================================================================
void applyLocalActuators(const String& alarmLevel, bool fanOn) {
  if (alarmLevel == "EVACUATE" || alarmLevel == "EMERGENCY") {
    digitalWrite(PIN_LED_GREEN, LOW);
    digitalWrite(PIN_LED_YELLOW, LOW);
    digitalWrite(PIN_LED_RED, HIGH);
    digitalWrite(PIN_FAN_RELAY, RELAY_ON); // Exhaust Fan: 100% Spool
    triggerBuzzerPattern(3);               // 3 Rapid Danger Alarm Pulses
  } else if (alarmLevel == "WARNING") {
    digitalWrite(PIN_LED_GREEN, LOW);
    digitalWrite(PIN_LED_YELLOW, HIGH);
    digitalWrite(PIN_LED_RED, LOW);
    digitalWrite(PIN_FAN_RELAY, RELAY_ON); // Exhaust Fan: Spooling ON
    triggerBuzzerPattern(2);               // 2 Warning Alert Pulses
  } else if (alarmLevel == "SENSOR_FAULT") {
    digitalWrite(PIN_LED_GREEN, LOW);
    digitalWrite(PIN_LED_YELLOW, HIGH);
    digitalWrite(PIN_LED_RED, HIGH);       // Yellow + Red indicates hardware fault
    digitalWrite(PIN_FAN_RELAY, RELAY_OFF);
    triggerBuzzerPattern(2);
  } else {
    // SAFE: Local LEDs indicate normal status. No SAFE periodic buzzer chirp.
    digitalWrite(PIN_LED_GREEN, HIGH);
    digitalWrite(PIN_LED_YELLOW, LOW);
    digitalWrite(PIN_LED_RED, LOW);
    digitalWrite(PIN_FAN_RELAY, fanOn ? RELAY_ON : RELAY_OFF);
  }
}

// ======================================================================================
// NON-BLOCKING WI-FI RECONNECTION
// ======================================================================================
void checkWiFiConnection() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  unsigned long now = millis();
  if (now - lastWiFiRetryMillis >= WIFI_RECONNECT_INTERVAL_MS) {
    lastWiFiRetryMillis = now;
    Serial.println("[WIFI] Reconnecting in background...");
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}

// ======================================================================================
// DATA TRANSMISSION WITH RENDER COLD-START TIMEOUT & RETRY
// ======================================================================================
void sendTelemetry(int methane, int co, int toxic, float temp, float humidity, const String& alarmLevel, bool fanOn, bool sensorFault) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WIFI NOT CONNECTED] Skipping HTTP POST; local actuators remain operational.");
    return;
  }

  String endpointUrl;
  #if USE_HTTPS
    endpointUrl = String(RENDER_CLOUD_URL);
  #else
    endpointUrl = String("http://") + SERVER_HOST + ":" + String(SERVER_PORT) + SERVER_PATH;
  #endif

  HTTPClient http;
  bool beginSuccess = false;

  #if USE_HTTPS
    WiFiClientSecure secureClient;
    secureClient.setInsecure(); // Permits self-signed or wildcard certs on embedded nodes
    secureClient.setTimeout(8000); // 8s timeout accommodates Render cold starts
    beginSuccess = http.begin(secureClient, endpointUrl);
  #else
    WiFiClient plainClient;
    plainClient.setTimeout(8000); // 8s timeout accommodates Render cold starts
    beginSuccess = http.begin(plainClient, endpointUrl);
  #endif

  if (!beginSuccess) {
    Serial.printf("[HTTP ERROR] Failed to connect to %s\n", endpointUrl.c_str());
    return;
  }

  http.setTimeout(8000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", API_KEY);

  // Exact JSON Data Contract:
  // {node_id, zone, methane, co, toxic, temp, humidity, alarm_level, fan_on, uptime, sensor_fault}
  StaticJsonDocument<384> doc;
  doc["node_id"]      = NODE_ID;
  doc["zone"]         = ZONE_ID;
  doc["methane"]      = methane;
  doc["co"]           = co;
  doc["toxic"]        = toxic;
  doc["sensor_fault"] = sensorFault;

  if (sensorFault) {
    doc["temp"]     = nullptr;
    doc["humidity"] = nullptr;
  } else {
    doc["temp"]     = round(temp * 10.0) / 10.0;
    doc["humidity"] = round(humidity);
  }

  doc["alarm_level"] = alarmLevel;
  doc["fan_on"]      = fanOn;
  doc["uptime"]      = (unsigned long)(millis() / 1000);

  String payload;
  serializeJson(doc, payload);

  // Render cold start retry loop (up to 2 attempts)
  int httpCode = -1;
  for (int attempt = 1; attempt <= 2; attempt++) {
    httpCode = http.POST(payload);
    if (httpCode > 0) break;
    Serial.printf("[HTTP RETRY %d] Cold start wait... Error: %s\n", attempt, http.errorToString(httpCode).c_str());
    delay(1000);
  }

  if (httpCode > 0) {
    Serial.printf("[HTTP RESPONSE] Status: %d\n", httpCode);
  } else {
    Serial.printf("[HTTP ERROR] Failed after retries: %s\n", http.errorToString(httpCode).c_str());
  }

  http.end();
}

// ======================================================================================
// ARDUINO SETUP
// ======================================================================================
void setup() {
  Serial.begin(115200);
  delay(500);

  systemStartMillis = millis();

  Serial.println("\n========================================================");
  Serial.println("  SMART MINE SAFETY CONTROL CENTER - ESP32 FIRMWARE");
  Serial.println("  Node ID: " NODE_ID " | Zone: " ZONE_ID);
  Serial.println("========================================================");

  // Configure Actuator GPIOs
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_YELLOW, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_FAN_RELAY, OUTPUT);

  // Initial Safe Actuator States
  digitalWrite(PIN_LED_GREEN, HIGH);
  digitalWrite(PIN_LED_YELLOW, LOW);
  digitalWrite(PIN_LED_RED, LOW);
  digitalWrite(PIN_BUZZER, LOW);
  digitalWrite(PIN_FAN_RELAY, RELAY_OFF);

  // Initialize DHT11 sensor
  dht.begin();
  Serial.println("[SENSORS] DHT11 temperature & humidity initialized.");

  // Configure ADC attenuation (0 - 3.3V range)
  analogSetAttenuation(ADC_11db);
  Serial.println("[SENSORS] ADC configured (11dB attenuation, max 3.3V).");

  // Non-blocking initial Wi-Fi connection trigger
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("[WIFI] Connecting to SSID: ");
  Serial.println(WIFI_SSID);

  // Startup chirp
  triggerBuzzerPattern(1);
}

// ======================================================================================
// MAIN EXECUTION LOOP (NON-BLOCKING)
// ======================================================================================
void loop() {
  unsigned long now = millis();

  // 1. Maintain background Wi-Fi without blocking sensor execution
  checkWiFiConnection();

  // 2. Service non-blocking buzzer audio pulses
  updateBuzzerAsync();

  // 3. MQ Sensor 120-Second Warm-up & Baseline Calibration
  if (!warmupComplete) {
    if (now - systemStartMillis < MQ_WARMUP_MS) {
      calibrateCleanAirBaselines();
      // Blink Yellow LED to indicate warming up
      if ((now / 500) % 2 == 0) {
        digitalWrite(PIN_LED_YELLOW, HIGH);
      } else {
        digitalWrite(PIN_LED_YELLOW, LOW);
      }
      static unsigned long lastWarmupLog = 0;
      if (now - lastWarmupLog >= 10000) {
        lastWarmupLog = now;
        unsigned long remainingSec = (MQ_WARMUP_MS - (now - systemStartMillis)) / 1000;
        Serial.printf("[WARM-UP] Gas sensors warming up & calibrating clean-air baseline. %lu s remaining...\n", remainingSec);
      }
    } else {
      warmupComplete = true;
      digitalWrite(PIN_LED_YELLOW, LOW);
      digitalWrite(PIN_LED_GREEN, HIGH);
      Serial.printf("[CALIBRATION COMPLETE] Baselines: R0_MQ4=%.2f, R0_MQ7=%.2f, R0_MQ135=%.2f\n",
                    R0_MQ4, R0_MQ7, R0_MQ135);
    }
  }

  // 4. Periodic Telemetry Sampling & Transmission (Every 2 seconds)
  if (now - lastTelemetryMillis >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryMillis = now;

    // A. 10-Sample Averaging on Analog Gas Pins (via voltage dividers)
    int rawMQ4   = readAnalogAverage(PIN_MQ4, 10);
    int rawMQ7   = readAnalogAverage(PIN_MQ7, 10);
    int rawMQ135 = readAnalogAverage(PIN_MQ135, 10);

    // B. Calculate PPM using clean-air calibrated R0 baselines
    int methane = calculateMethanePpm(rawMQ4);
    int co      = calculateCoPpm(rawMQ7);
    int toxic   = calculateToxicPpm(rawMQ135);

    // C. Read Ambient Climate (DHT11) - Send sensor fault on error, no fake fallback
    float temp = dht.readTemperature();
    float hum  = dht.readHumidity();
    bool sensorFault = (isnan(temp) || isnan(hum));

    if (sensorFault) {
      Serial.println("[SENSOR FAULT] DHT11 failed to return valid climate data. Flagging fault.");
    }

    // D. Evaluate Local Safety Thresholds
    String alarmLevel = "SAFE";
    bool fanOn = false;

    if (sensorFault) {
      alarmLevel = "SENSOR_FAULT";
      fanOn = false;
    } else if (methane >= THRESHOLD_MQ4_DANGER || co >= THRESHOLD_MQ7_DANGER ||
               toxic >= THRESHOLD_MQ135_DANGER || temp >= THRESHOLD_TEMP_DANGER) {
      alarmLevel = "EVACUATE";
      fanOn = true;
    } else if (methane >= THRESHOLD_MQ4_WARN || co >= THRESHOLD_MQ7_WARN ||
               toxic >= THRESHOLD_MQ135_WARN || temp >= THRESHOLD_TEMP_WARN) {
      alarmLevel = "WARNING";
      fanOn = true;
    } else {
      alarmLevel = "SAFE";
      fanOn = false;
    }

    // E. Apply Local Actuators Immediately (Works 100% without Wi-Fi)
    applyLocalActuators(alarmLevel, fanOn);

    // F. Print to Serial Monitor
    if (sensorFault) {
      Serial.printf("[TELEMETRY] Node: %s | Zone: %s | CH4: %d ppm | CO: %d ppm | Toxic: %d ppm | FAULT: DHT11\n",
                    NODE_ID, ZONE_ID, methane, co, toxic);
    } else {
      Serial.printf("[TELEMETRY] Node: %s | Zone: %s | CH4: %d ppm | CO: %d ppm | Toxic: %d ppm | Temp: %.1fC | Hum: %.0f%% | Status: %s\n",
                    NODE_ID, ZONE_ID, methane, co, toxic, temp, hum, alarmLevel.c_str());
    }

    // G. Transmit Data Contract to Server
    sendTelemetry(methane, co, toxic, temp, hum, alarmLevel, fanOn, sensorFault);
  }
}
