/**
 * SMART MINE SAFETY CONTROL CENTER - CORE ENGINE
 * AI-Based Mine Gas Leakage Detection and Smart Evacuation System
 * College Prototype Architecture
 */

(function () {
  'use strict';

  // ==========================================================================
  // 1. STATE & CONFIGURATION
  // ==========================================================================
  const State = {
    zone: 'M2',
    location: 'Mine Zone M2',
    methane: 420,       // MQ-4 (ppm)
    co: 18,             // MQ-7 (ppm)
    mq135: 110,         // MQ-135 (ppm)
    temperature: 27.4,  // DHT11 (°C)
    humidity: 58,       // DHT11 (% RH)
    status: 'SAFE',     // SAFE | WARNING | EMERGENCY
    dangerZone: null,   // null | 'M1' | 'M2' | 'M3'
    safeRoute: 'M2 -> M1 -> MAIN EXIT',
    soundMuted: false,
    viewMode: 'control-room', // 'control-room' | 'worker'
    pollingEnabled: false,
    apiEndpoint: 'http://localhost:5000/api/data',

    // Rolling history for sparkline charts (10 samples)
    history: {
      mq4: [390, 410, 420, 415, 430, 425, 418, 422, 420, 420],
      mq7: [16, 18, 17, 19, 18, 17, 18, 19, 18, 18],
      mq135: [105, 108, 112, 110, 115, 112, 108, 110, 110, 110],
      temp: [26.8, 27.0, 27.2, 27.1, 27.3, 27.4, 27.3, 27.5, 27.4, 27.4],
      hum: [56, 57, 58, 59, 58, 57, 58, 58, 58, 58]
    },

    // Workers Status Mock Data
    workers: [
      { id: 'W-01', name: 'Worker 01', zone: 'M1', role: 'Shift Lead', status: 'SAFE', evac: 'STATIONARY / WORKING', hr: 98 },
      { id: 'W-02', name: 'Worker 02', zone: 'M2', role: 'Excavator Operator', status: 'SAFE', evac: 'STATIONARY / WORKING', hr: 102 },
      { id: 'W-03', name: 'Worker 03', zone: 'M3', role: 'Ventilation Tech', status: 'SAFE', evac: 'STATIONARY / WORKING', hr: 88 }
    ],

    // Real-time Event Alerts
    alerts: [
      { type: 'green', title: 'SYSTEM NORMAL', time: '20:50:10', desc: 'Baseline atmospheric conditions validated across all sectors M1, M2, M3.' },
      { type: 'yellow', title: 'HIGH TEMPERATURE DETECTED', time: '20:48:22', desc: 'Thermal sensor DHT11 recorded 37.8°C transient spike in Zone M3.' },
      { type: 'red', title: 'GAS LEAK DETECTED IN M2', time: '20:45:00', desc: 'MQ-4 Methane gas detected at 1,820 PPM. Threshold breached.' },
      { type: 'red', title: 'EVACUATION REQUIRED', time: '20:45:02', desc: 'Smart route triggered: Workers diverted to Tunnel M1 ➔ MAIN EXIT.' },
      { type: 'red', title: 'RESCUE TEAM ALERTED', time: '20:45:05', desc: 'SMS alert dispatched to emergency mine rescue brigade via GSM.' },
      { type: 'red', title: 'AMBULANCE ALERTED', time: '20:45:07', desc: 'Medical emergency triage notified. Surface ambulance dispatched.' }
    ]
  };

  // Sensor Thresholds for Classification
  const THRESHOLDS = {
    mq4: { warn: 1000, danger: 2500, max: 5000 },
    mq7: { warn: 50, danger: 200, max: 1000 },
    mq135: { warn: 300, danger: 800, max: 2000 },
    temp: { warn: 35.0, danger: 45.0, max: 60 },
    hum: { lowWarn: 40, highWarn: 80 }
  };

  // ==========================================================================
  // 2. AUDIO SYNTHESIZER (WEB AUDIO API)
  // Hardware Piezo Buzzer & Alarm Simulator (No external audio files required)
  // ==========================================================================
  let audioCtx = null;

  function initAudio() {
    if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
  }

  function playBuzzerTone(freq = 880, duration = 0.12, type = 'square') {
    if (State.soundMuted) return;
    try {
      initAudio();
      if (!audioCtx) return;
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);

      gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.start();
      osc.stop(audioCtx.currentTime + duration);
    } catch (e) {
      console.warn('Audio play suppressed:', e);
    }
  }

  // Play hardware alert cadence: 1 beep (Safe), 2 beeps (Warning), 3 beeps (Danger)
  function triggerBuzzerCadence(status) {
    if (State.soundMuted) return;
    if (status === 'SAFE') {
      playBuzzerTone(900, 0.08, 'sine');
    } else if (status === 'WARNING') {
      playBuzzerTone(1050, 0.1, 'triangle');
      setTimeout(() => playBuzzerTone(1050, 0.1, 'triangle'), 180);
    } else if (status === 'EMERGENCY') {
      playBuzzerTone(1350, 0.14, 'square');
      setTimeout(() => playBuzzerTone(1350, 0.14, 'square'), 180);
      setTimeout(() => playBuzzerTone(1600, 0.22, 'sawtooth'), 360);
    }
  }

  // Optional Voice Emergency Annunciation
  function announceEmergencyVoice(text) {
    if (State.soundMuted || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.05;
      utterance.pitch = 1.0;
      window.speechSynthesis.speak(utterance);
    } catch (e) {
      console.warn('Speech synthesis error:', e);
    }
  }

  // ==========================================================================
  // 3. AI RISK EVALUATION & EVACUATION ROUTE CALCULATION
  // ==========================================================================
  function calculateSafetyState(data) {
    const ch4 = data.methane;
    const co = data.co;
    const aqi = data.mq135;
    const temp = data.temperature;

    // Component risks (0 to 100%)
    const riskCh4 = Math.min(100, Math.round((ch4 / THRESHOLDS.mq4.danger) * 100));
    const riskCo = Math.min(100, Math.round((co / THRESHOLDS.mq7.danger) * 100));
    const riskAqi = Math.min(100, Math.round((aqi / THRESHOLDS.mq135.danger) * 100));
    const riskTemp = Math.min(100, Math.round(Math.max(0, (temp - 20) / (THRESHOLDS.temp.danger - 20) * 100)));

    // Overall Composite Score (weighted AI index prioritizing extreme single gas breach)
    const compositeMax = Math.max(riskCh4, riskCo, riskAqi, riskTemp);
    const overallScore = Math.min(100, Math.round(compositeMax * 0.75 + (riskCh4 + riskCo + riskAqi + riskTemp) / 4 * 0.25));

    // Determine State
    let status = 'SAFE';
    let dangerZone = null;

    if (ch4 >= THRESHOLDS.mq4.danger || co >= THRESHOLDS.mq7.danger || aqi >= THRESHOLDS.mq135.danger || temp >= THRESHOLDS.temp.danger) {
      status = 'EMERGENCY';
      dangerZone = data.zone || 'M2';
    } else if (ch4 >= THRESHOLDS.mq4.warn || co >= THRESHOLDS.mq7.warn || aqi >= THRESHOLDS.mq135.warn || temp >= THRESHOLDS.temp.warn) {
      status = 'WARNING';
      dangerZone = data.zone || 'M2';
    } else {
      status = 'SAFE';
      dangerZone = null;
    }

    // Dynamic Smart Evacuation Route calculation
    // Constraint: "Do NOT route workers through a hazardous zone"
    let safeRoute = '';
    const currentZone = data.zone || 'M1';

    if (status === 'SAFE') {
      if (currentZone === 'M1') safeRoute = 'M1 ➔ MAIN EXIT';
      else if (currentZone === 'M2') safeRoute = 'M2 ➔ M1 ➔ MAIN EXIT';
      else if (currentZone === 'M3') safeRoute = 'M3 ➔ M2 ➔ M1 ➔ MAIN EXIT';
    } else {
      // Emergency or Warning condition
      if (dangerZone === 'M2') {
        if (currentZone === 'M2') {
          // Worker in hazard zone M2 must flee toward M1
          safeRoute = 'M2 ➔ M1 ➔ MAIN EXIT';
        } else if (currentZone === 'M3') {
          // Worker in deep mine M3 CANNOT pass through M2 hazard!
          // AI triggers the Auxiliary Air Escape Shaft!
          safeRoute = 'M3 ➔ AUXILIARY ESCAPE SHAFT ➔ MAIN EXIT';
        } else if (currentZone === 'M1') {
          safeRoute = 'M1 ➔ MAIN EXIT';
        }
      } else if (dangerZone === 'M1') {
        // Entry zone M1 is blocked!
        safeRoute = `${currentZone} ➔ AUXILIARY ESCAPE SHAFT ➔ MAIN EXIT`;
      } else if (dangerZone === 'M3') {
        // Deep mine M3 is hazard
        if (currentZone === 'M3') {
          safeRoute = 'M3 ➔ M2 ➔ M1 ➔ MAIN EXIT';
        } else if (currentZone === 'M2') {
          safeRoute = 'M2 ➔ M1 ➔ MAIN EXIT';
        } else {
          safeRoute = 'M1 ➔ MAIN EXIT';
        }
      } else {
        safeRoute = `${currentZone} ➔ M1 ➔ MAIN EXIT`;
      }
    }

    return {
      status,
      dangerZone,
      safeRoute,
      riskCh4,
      riskCo,
      riskAqi,
      riskTemp,
      overallScore
    };
  }

  // ==========================================================================
  // 4. DOM ELEMENTS CACHE
  // ==========================================================================
  const DOM = {
    body: document.body,
    emergencyBanner: document.getElementById('emergency-banner'),
    bannerTitle: document.getElementById('banner-title'),
    bannerDesc: document.getElementById('banner-desc'),
    bannerRouteHint: document.getElementById('banner-route-hint'),
    btnSilenceAlarm: document.getElementById('btn-silence-alarm'),

    // Header elements
    sysStatusDot: document.getElementById('sys-status-dot'),
    sysStatusText: document.getElementById('sys-status-text'),
    currentZoneVal: document.getElementById('current-zone-val'),
    mineLocationVal: document.getElementById('mine-location-val'),
    lastUpdatedClock: document.getElementById('last-updated-clock'),
    viewModeControl: document.getElementById('view-mode-control'),
    viewModeWorker: document.getElementById('view-mode-worker'),
    btnToggleSound: document.getElementById('btn-toggle-sound'),
    soundIconOn: document.getElementById('sound-icon-on'),
    soundIconOff: document.getElementById('sound-icon-off'),
    btnOpenSim: document.getElementById('btn-open-sim'),

    // Section 1: Live Safety Status
    safetyStatusCard: document.getElementById('safety-status-card'),
    shieldOuter: document.getElementById('shield-ring'),
    statusIcon: document.getElementById('status-icon'),
    statusBadgeText: document.getElementById('status-badge-text'),
    statusHeadline: document.getElementById('status-headline'),
    statusSubmessage: document.getElementById('status-submessage'),
    aiThreatScore: document.getElementById('ai-threat-score'),
    evacReadinessLabel: document.getElementById('evac-readiness-label'),
    activeResponseLabel: document.getElementById('active-response-label'),
    btnManualEvac: document.getElementById('btn-manual-evac'),
    btnResetNormal: document.getElementById('btn-reset-normal'),

    // Section 5: Evacuation Route
    routeCurrentZone: document.getElementById('route-current-zone'),
    routeDangerZone: document.getElementById('route-danger-zone'),
    routePathVisual: document.getElementById('route-path-visual'),
    guideHeadline: document.getElementById('guide-headline'),
    guideSubtext: document.getElementById('guide-subtext'),

    // Section 4: 2D Mine Tunnel Map
    mapStatusM1: document.getElementById('map-status-m1'),
    mapStatusM2: document.getElementById('map-status-m2'),
    mapStatusM3: document.getElementById('map-status-m3'),
    bulbM1: document.getElementById('bulb-m1'),
    bulbM2: document.getElementById('bulb-m2'),
    bulbM3: document.getElementById('bulb-m3'),
    zoneBoxM1: document.getElementById('zone-m1'),
    zoneBoxM2: document.getElementById('zone-m2'),
    zoneBoxM3: document.getElementById('zone-m3'),
    hazardPulseM2: document.getElementById('hazard-pulse-m2'),
    hazardPulseM3: document.getElementById('hazard-pulse-m3'),
    mapNetworkStatus: document.getElementById('map-network-status'),
    pinBgW2: document.getElementById('pin-bg-w2'),

    // Section 2: Sensor Monitoring
    valMq4: document.getElementById('val-mq4'),
    pillMq4: document.getElementById('pill-mq4'),
    cardMq4: document.getElementById('card-mq4'),
    sparklineMq4: document.getElementById('sparkline-mq4'),

    valMq7: document.getElementById('val-mq7'),
    pillMq7: document.getElementById('pill-mq7'),
    cardMq7: document.getElementById('card-mq7'),
    sparklineMq7: document.getElementById('sparkline-mq7'),

    valMq135: document.getElementById('val-mq135'),
    pillMq135: document.getElementById('pill-mq135'),
    cardMq135: document.getElementById('card-mq135'),
    sparklineMq135: document.getElementById('sparkline-mq135'),

    valTemp: document.getElementById('val-temp'),
    pillTemp: document.getElementById('pill-temp'),
    cardTemp: document.getElementById('card-temp'),
    sparklineTemp: document.getElementById('sparkline-temp'),

    valHum: document.getElementById('val-humidity'),
    pillHum: document.getElementById('pill-humidity'),
    cardHum: document.getElementById('card-humidity'),
    sparklineHum: document.getElementById('sparkline-humidity'),

    // Section 3: Risk Analysis
    riskCompositeTag: document.getElementById('risk-composite-tag'),
    overallRiskPercent: document.getElementById('overall-risk-percent'),
    overallRiskDesc: document.getElementById('overall-risk-desc'),
    overallRadialFill: document.getElementById('overall-radial-fill'),
    riskScoreCh4: document.getElementById('risk-score-ch4'),
    barRiskCh4: document.getElementById('bar-risk-ch4'),
    riskScoreCo: document.getElementById('risk-score-co'),
    barRiskCo: document.getElementById('bar-risk-co'),
    riskScoreAqi: document.getElementById('risk-score-aqi'),
    barRiskAqi: document.getElementById('bar-risk-aqi'),
    riskScoreTemp: document.getElementById('risk-score-temp'),
    barRiskTemp: document.getElementById('bar-risk-temp'),

    // Section 6: Workers Table
    w1SafetyBadge: document.getElementById('w1-safety-badge'),
    w1EvacBadge: document.getElementById('w1-evac-badge'),
    w2SafetyBadge: document.getElementById('w2-safety-badge'),
    w2EvacBadge: document.getElementById('w2-evac-badge'),
    w3SafetyBadge: document.getElementById('w3-safety-badge'),
    w3EvacBadge: document.getElementById('w3-evac-badge'),

    // Section 8: Emergency Response
    respStatePill: document.getElementById('resp-state-pill'),
    rcControlRoom: document.getElementById('rc-control-room'),
    rcStatusCr: document.getElementById('rc-status-cr'),
    rcRescue: document.getElementById('rc-rescue'),
    rcStatusRescue: document.getElementById('rc-status-rescue'),
    rcAmbulance: document.getElementById('rc-ambulance'),
    rcStatusAmbulance: document.getElementById('rc-status-ambulance'),
    rcVentilation: document.getElementById('rc-ventilation'),
    rcStatusFan: document.getElementById('rc-status-fan'),
    rcBuzzer: document.getElementById('rc-buzzer'),
    rcStatusBuzzer: document.getElementById('rc-status-buzzer'),
    rcStatusTargetZone: document.getElementById('rc-status-target-zone'),

    // Section 9: Hardware LEDs & Buzzer
    ledGreenBulb: document.getElementById('led-green-bulb'),
    ledGreenText: document.getElementById('led-green-text'),
    ledYellowBulb: document.getElementById('led-yellow-bulb'),
    ledYellowText: document.getElementById('led-yellow-text'),
    ledRedBulb: document.getElementById('led-red-bulb'),
    ledRedText: document.getElementById('led-red-text'),
    buzzerWaveRing: document.getElementById('buzzer-wave-ring'),
    buzzerCadenceLabel: document.getElementById('buzzer-cadence-label'),
    buzzerCadenceDesc: document.getElementById('buzzer-cadence-desc'),
    badgeCad1: document.getElementById('badge-cad-1'),
    badgeCad2: document.getElementById('badge-cad-2'),
    badgeCad3: document.getElementById('badge-cad-3'),
    fanSvg: document.getElementById('fan-svg-element'),
    fanStateTitle: document.getElementById('fan-state-title'),
    fanDutyCycle: document.getElementById('fan-duty-cycle'),

    // Section 7: Alert Feed
    alertFeed: document.getElementById('alert-feed'),
    alertCountPill: document.getElementById('alert-count-pill'),
    btnClearAlerts: document.getElementById('btn-clear-alerts'),

    // Simulator Modal
    simModal: document.getElementById('sim-modal'),
    btnCloseSim: document.getElementById('btn-close-sim'),
    btnCloseSimFooter: document.getElementById('btn-close-sim-footer'),
    scenNormal: document.getElementById('scen-normal'),
    scenWarning: document.getElementById('scen-warning'),
    scenEmergency: document.getElementById('scen-emergency'),
    scenToxic: document.getElementById('scen-toxic'),
    inputMq4: document.getElementById('input-range-mq4'),
    valSliderMq4: document.getElementById('slider-val-mq4'),
    inputMq7: document.getElementById('input-range-mq7'),
    valSliderMq7: document.getElementById('slider-val-mq7'),
    inputMq135: document.getElementById('input-range-mq135'),
    valSliderMq135: document.getElementById('slider-val-mq135'),
    inputTemp: document.getElementById('input-range-temp'),
    valSliderTemp: document.getElementById('slider-val-temp'),
    inputHum: document.getElementById('input-range-hum'),
    valSliderHum: document.getElementById('slider-val-hum'),
    selectActiveZone: document.getElementById('select-active-zone'),
    btnApplySliders: document.getElementById('btn-apply-slider-vals'),
    checkPolling: document.getElementById('check-enable-polling'),
    btnFetchOnce: document.getElementById('btn-fetch-once'),
    espEndpointInput: document.getElementById('esp32-endpoint'),

    // Open Source Modal & Export
    btnOpenOsModal: document.getElementById('btn-open-os-modal'),
    osModal: document.getElementById('os-modal'),
    btnCloseOs: document.getElementById('btn-close-os'),
    btnCloseOsFooter: document.getElementById('btn-close-os-footer'),
    btnFooterOsInfo: document.getElementById('btn-footer-os-info'),
    btnFooterExportJson: document.getElementById('btn-footer-export-json'),
    btnDownloadTelemetry: document.getElementById('btn-download-telemetry')
  };

  // ==========================================================================
  // 5. RENDERING & UI UPDATES
  // ==========================================================================

  // Generate SVG path for sparklines
  function renderSparkline(svgElement, dataArray, minVal, maxVal) {
    if (!svgElement || !dataArray || dataArray.length < 2) return;
    const width = 160;
    const height = 38;
    const range = (maxVal - minVal) || 1;
    const step = width / (dataArray.length - 1);

    const points = dataArray.map((val, idx) => {
      const x = Math.round(idx * step);
      const clamped = Math.max(minVal, Math.min(maxVal, val));
      const normalized = (clamped - minVal) / range;
      // Invert Y so highest value is near top
      const y = Math.round(height - normalized * (height - 8) - 4);
      return `${x},${y}`;
    });

    const pathString = 'M' + points.join(' L');
    const pathElem = svgElement.querySelector('.spark-path');
    if (pathElem) {
      pathElem.setAttribute('d', pathString);
    }
  }

  function updateSparklines() {
    renderSparkline(DOM.sparklineMq4, State.history.mq4, 100, 4000);
    renderSparkline(DOM.sparklineMq7, State.history.mq7, 0, 500);
    renderSparkline(DOM.sparklineMq135, State.history.mq135, 50, 1500);
    renderSparkline(DOM.sparklineTemp, State.history.temp, 15, 55);
    renderSparkline(DOM.sparklineHum, State.history.hum, 20, 100);
  }

  function formatTime(date = new Date()) {
    return date.toTimeString().split(' ')[0];
  }

  function addAlertItem(type, title, desc) {
    const time = formatTime();
    State.alerts.unshift({ type, title, time, desc });
    if (State.alerts.length > 25) State.alerts.pop();
    renderAlerts();
  }

  function renderAlerts() {
    if (!DOM.alertFeed) return;
    DOM.alertFeed.innerHTML = '';
    State.alerts.forEach(item => {
      const el = document.createElement('div');
      el.className = `alert-item alert-${item.type}`;
      const icon = item.type === 'green' ? '🟢' : item.type === 'yellow' ? '🟡' : '🔴';
      el.innerHTML = `
        <div class="alert-badge-dot">${icon}</div>
        <div class="alert-body">
          <div class="alert-row">
            <strong class="alert-msg">${item.title}</strong>
            <span class="alert-time">${item.time}</span>
          </div>
          <span class="alert-details">${item.desc}</span>
        </div>
      `;
      DOM.alertFeed.appendChild(el);
    });
    if (DOM.alertCountPill) {
      DOM.alertCountPill.textContent = `${State.alerts.length} EVENTS`;
    }
  }

  // Update visual route nodes
  function renderVisualRoute(routeString) {
    if (!DOM.routePathVisual) return;
    DOM.routePathVisual.innerHTML = '';
    // e.g. "M2 ➔ M1 ➔ MAIN EXIT" or "M2 -> M1 -> MAIN EXIT"
    const parts = routeString.split(/\s*->\s*|\s*➔\s*/);
    parts.forEach((node, idx) => {
      const nodeSpan = document.createElement('span');
      nodeSpan.className = 'route-node';
      if (idx === 0) {
        nodeSpan.classList.add('current');
      } else if (idx === parts.length - 1 || node.toUpperCase().includes('EXIT')) {
        nodeSpan.classList.add('exit-node');
      }
      nodeSpan.textContent = node.trim();
      DOM.routePathVisual.appendChild(nodeSpan);

      if (idx < parts.length - 1) {
        const arrowSpan = document.createElement('span');
        arrowSpan.className = 'route-arrow';
        arrowSpan.textContent = '➔';
        DOM.routePathVisual.appendChild(arrowSpan);
      }
    });
  }

  // Primary UI Synchronizer
  function renderUI() {
    const ai = calculateSafetyState(State);
    const oldStatus = State.status;
    State.status = ai.status;
    State.dangerZone = ai.dangerZone;
    State.safeRoute = ai.safeRoute;

    // Trigger audible cadence if status changed or alarming
    if (oldStatus !== State.status) {
      triggerBuzzerCadence(State.status);
      if (State.status === 'EMERGENCY') {
        announceEmergencyVoice(`Alert. Dangerous conditions detected in Zone ${State.zone}. Follow green exit indicators.`);
        addAlertItem('red', `EMERGENCY IN ${State.zone}`, `Critical threshold breached. Smart evacuation initiated.`);
      } else if (State.status === 'WARNING') {
        addAlertItem('yellow', `WARNING IN ${State.zone}`, `Abnormal gas/climate readings detected. Workers on standby.`);
      } else {
        addAlertItem('green', `NORMAL CONDITIONS RESTORED`, `All atmospheric parameters normalized.`);
      }
    }

    // 1. Body & Theme classes
    DOM.body.className = `theme-dark status-${State.status.toLowerCase()}`;
    DOM.body.setAttribute('data-view-mode', State.viewMode);

    // 2. Header Telemetry
    DOM.currentZoneVal.textContent = State.zone;
    DOM.mineLocationVal.textContent = State.location;
    DOM.lastUpdatedClock.textContent = formatTime();

    // 3. Top Emergency Banner
    if (State.status === 'EMERGENCY' || State.status === 'WARNING') {
      DOM.emergencyBanner.classList.remove('hidden');
      if (State.status === 'EMERGENCY') {
        DOM.bannerTitle.textContent = `CRITICAL HAZARD DETECTED IN ZONE ${State.zone}`;
        DOM.bannerDesc.textContent = `Dangerous gas/temperature condition detected. Immediate evacuation required.`;
      } else {
        DOM.bannerTitle.textContent = `ENVIRONMENTAL WARNING DETECTED`;
        DOM.bannerDesc.textContent = `Abnormal conditions in Zone ${State.zone}. Miners stay alert for evacuation beacons.`;
      }
      DOM.bannerRouteHint.textContent = `ROUTE: ${State.safeRoute}`;
    } else {
      DOM.emergencyBanner.classList.add('hidden');
    }

    // 4. Section 1: Live Safety Status
    if (State.status === 'SAFE') {
      DOM.statusIcon.textContent = '🛡️';
      DOM.statusBadgeText.textContent = 'SAFE';
      DOM.statusHeadline.textContent = 'SAFE';
      DOM.statusSubmessage.textContent = 'System operating normally. Atmospheric gas concentrations, airflow, and tunnel temperatures are within standard safety limits.';
      DOM.aiThreatScore.textContent = `${ai.overallScore}% (Nominal)`;
      DOM.evacReadinessLabel.textContent = 'STANDBY / CLEAR';
      DOM.activeResponseLabel.textContent = 'AUTOMATED SURVEILLANCE';
    } else if (State.status === 'WARNING') {
      DOM.statusIcon.textContent = '⚠️';
      DOM.statusBadgeText.textContent = 'WARNING';
      DOM.statusHeadline.textContent = 'WARNING';
      DOM.statusSubmessage.textContent = 'Abnormal environmental conditions detected. Workers should remain alert and prepare for potential evacuation.';
      DOM.aiThreatScore.textContent = `${ai.overallScore}% (Elevated)`;
      DOM.evacReadinessLabel.textContent = 'STAGE 1 EVAC READINESS';
      DOM.activeResponseLabel.textContent = 'HIGH VENTILATION SPOOL';
    } else {
      DOM.statusIcon.textContent = '🚨';
      DOM.statusBadgeText.textContent = 'EMERGENCY';
      DOM.statusHeadline.textContent = 'EMERGENCY';
      DOM.statusSubmessage.textContent = 'Dangerous gas/temperature condition detected! Immediate evacuation required! Follow lighted green indicators toward the main exit.';
      DOM.aiThreatScore.textContent = `${ai.overallScore}% (CRITICAL)`;
      DOM.evacReadinessLabel.textContent = 'IMMEDIATE EVACUATION ACTIVE';
      DOM.activeResponseLabel.textContent = 'ALL AUTOMATED RESPONSES FIRED';
    }

    // 5. Section 5: Smart Evacuation Route
    DOM.routeCurrentZone.textContent = State.zone;
    DOM.routeDangerZone.textContent = State.dangerZone ? `ZONE ${State.dangerZone} (HAZARDOUS)` : 'NONE (ALL CLEAR)';
    renderVisualRoute(State.safeRoute);

    if (State.status === 'EMERGENCY') {
      DOM.guideHeadline.textContent = `EMERGENCY EXTRACTION IN PROGRESS: EVACUATE ZONE ${State.zone}`;
      DOM.guideSubtext.textContent = `Follow the illuminated green beacon track. Avoid hazardous pockets. Route calculated: ${State.safeRoute}.`;
    } else if (State.status === 'WARNING') {
      DOM.guideHeadline.textContent = `PRE-EVACUATION ADVISORY`;
      DOM.guideSubtext.textContent = `Environmental parameters in Zone ${State.zone} deviate from nominal. Keep personal gas respirators at hand.`;
    } else {
      DOM.guideHeadline.textContent = `NORMAL CORRIDORS CLEAR`;
      DOM.guideSubtext.textContent = `All extraction pathways and tunnel shafts are clear. In case of localized alarm, proceed through the designated lighted corridors toward the surface exit portal.`;
    }

    // 6. Section 2: Sensor Monitoring Cards
    // MQ4
    DOM.valMq4.textContent = Math.round(State.methane);
    updateSensorPill(DOM.pillMq4, DOM.cardMq4, State.methane, THRESHOLDS.mq4.warn, THRESHOLDS.mq4.danger);

    // MQ7
    DOM.valMq7.textContent = Math.round(State.co);
    updateSensorPill(DOM.pillMq7, DOM.cardMq7, State.co, THRESHOLDS.mq7.warn, THRESHOLDS.mq7.danger);

    // MQ135
    DOM.valMq135.textContent = Math.round(State.mq135);
    updateSensorPill(DOM.pillMq135, DOM.cardMq135, State.mq135, THRESHOLDS.mq135.warn, THRESHOLDS.mq135.danger);

    // DHT11 Temp
    DOM.valTemp.textContent = State.temperature.toFixed(1);
    updateSensorPill(DOM.pillTemp, DOM.cardTemp, State.temperature, THRESHOLDS.temp.warn, THRESHOLDS.temp.danger);

    // DHT11 Humidity
    DOM.valHum.textContent = Math.round(State.humidity);
    const humBad = State.humidity < THRESHOLDS.hum.lowWarn || State.humidity > THRESHOLDS.hum.highWarn;
    DOM.pillHum.textContent = humBad ? 'ELEVATED' : 'NORMAL';
    DOM.pillHum.className = `sensor-status-pill ${humBad ? 'status-warn' : 'status-normal'}`;

    // Update Sparklines
    updateSparklines();

    // 7. Section 3: Risk Analysis
    DOM.overallRiskPercent.textContent = `${ai.overallScore}%`;
    // Radial gauge circumference is 2 * PI * 48 ≈ 301.6
    const circumference = 301.6;
    const offset = circumference - (ai.overallScore / 100) * circumference;
    DOM.overallRadialFill.style.strokeDashoffset = offset;

    if (State.status === 'EMERGENCY') {
      DOM.riskCompositeTag.textContent = 'RISK LEVEL: SEVERE (IV)';
      DOM.riskCompositeTag.style.color = 'var(--danger-red)';
      DOM.riskCompositeTag.style.borderColor = 'var(--danger-red)';
      DOM.overallRiskDesc.textContent = 'CRITICAL ATMOSPHERE';
      DOM.overallRadialFill.style.stroke = 'var(--danger-red)';
    } else if (State.status === 'WARNING') {
      DOM.riskCompositeTag.textContent = 'RISK LEVEL: ELEVATED (II)';
      DOM.riskCompositeTag.style.color = 'var(--warn-yellow)';
      DOM.riskCompositeTag.style.borderColor = 'var(--warn-yellow)';
      DOM.overallRiskDesc.textContent = 'ABNORMAL CONDITIONS';
      DOM.overallRadialFill.style.stroke = 'var(--warn-yellow)';
    } else {
      DOM.riskCompositeTag.textContent = 'RISK LEVEL: NOMINAL (I)';
      DOM.riskCompositeTag.style.color = 'var(--safe-green)';
      DOM.riskCompositeTag.style.borderColor = 'var(--safe-green)';
      DOM.overallRiskDesc.textContent = 'MINIMAL HAZARD';
      DOM.overallRadialFill.style.stroke = 'var(--safe-green)';
    }

    // Progress Bars
    updateProgressBar(DOM.barRiskCh4, DOM.riskScoreCh4, ai.riskCh4);
    updateProgressBar(DOM.barRiskCo, DOM.riskScoreCo, ai.riskCo);
    updateProgressBar(DOM.barRiskAqi, DOM.riskScoreAqi, ai.riskAqi);
    updateProgressBar(DOM.barRiskTemp, DOM.riskScoreTemp, ai.riskTemp);

    // 8. Section 4: 2D Mine Tunnel Map
    updateTunnelMap(ai);

    // 9. Section 6: Worker Safety Monitor Table
    updateWorkersTable(State.status, State.zone);

    // 10. Section 8: Emergency Response Protocol
    updateEmergencyResponse(State.status, State.dangerZone);

    // 11. Section 9: Buzzer and LED Hardware Status
    updateHardwareActuators(State.status);
  }

  function updateSensorPill(pillEl, cardEl, val, warnThresh, dangerThresh) {
    if (val >= dangerThresh) {
      pillEl.textContent = 'DANGER';
      pillEl.className = 'sensor-status-pill status-danger';
      cardEl.className = 'sensor-card card-danger';
    } else if (val >= warnThresh) {
      pillEl.textContent = 'WARNING';
      pillEl.className = 'sensor-status-pill status-warn';
      cardEl.className = 'sensor-card card-warn';
    } else {
      pillEl.textContent = 'NORMAL';
      pillEl.className = 'sensor-status-pill status-normal';
      cardEl.className = 'sensor-card';
    }
  }

  function updateProgressBar(barEl, textEl, pct) {
    barEl.style.width = `${pct}%`;
    textEl.textContent = `${pct}%`;
    barEl.classList.remove('level-warn', 'level-danger');
    if (pct >= 80) barEl.classList.add('level-danger');
    else if (pct >= 50) barEl.classList.add('level-warn');
  }

  function updateTunnelMap(ai) {
    const danger = State.dangerZone;

    // Reset zone classes
    ['M1', 'M2', 'M3'].forEach(z => {
      const g = document.getElementById(`zone-${z.toLowerCase()}`);
      if (g) g.classList.remove('zone-safe', 'zone-warning', 'zone-danger');
    });

    // M1
    if (danger === 'M1') {
      DOM.zoneBoxM1.classList.add(ai.status === 'EMERGENCY' ? 'zone-danger' : 'zone-warning');
      DOM.mapStatusM1.textContent = `STATUS: ${ai.status}`;
      DOM.mapStatusM1.setAttribute('fill', ai.status === 'EMERGENCY' ? '#ff1744' : '#ffb300');
      DOM.bulbM1.setAttribute('fill', ai.status === 'EMERGENCY' ? '#ff1744' : '#ffb300');
    } else {
      DOM.zoneBoxM1.classList.add('zone-safe');
      DOM.mapStatusM1.textContent = 'STATUS: SAFE';
      DOM.mapStatusM1.setAttribute('fill', '#00e676');
      DOM.bulbM1.setAttribute('fill', '#00e676');
    }

    // M2
    if (danger === 'M2') {
      DOM.zoneBoxM2.classList.add(ai.status === 'EMERGENCY' ? 'zone-danger' : 'zone-warning');
      DOM.mapStatusM2.textContent = `STATUS: ${ai.status}`;
      DOM.mapStatusM2.setAttribute('fill', ai.status === 'EMERGENCY' ? '#ff1744' : '#ffb300');
      DOM.bulbM2.setAttribute('fill', ai.status === 'EMERGENCY' ? '#ff1744' : '#ffb300');
      DOM.hazardPulseM2.classList.remove('hidden');
    } else {
      DOM.zoneBoxM2.classList.add('zone-safe');
      DOM.mapStatusM2.textContent = 'STATUS: SAFE';
      DOM.mapStatusM2.setAttribute('fill', '#00e676');
      DOM.bulbM2.setAttribute('fill', '#00e676');
      DOM.hazardPulseM2.classList.add('hidden');
    }

    // M3
    if (danger === 'M3') {
      DOM.zoneBoxM3.classList.add(ai.status === 'EMERGENCY' ? 'zone-danger' : 'zone-warning');
      DOM.mapStatusM3.textContent = `STATUS: ${ai.status}`;
      DOM.mapStatusM3.setAttribute('fill', ai.status === 'EMERGENCY' ? '#ff1744' : '#ffb300');
      DOM.bulbM3.setAttribute('fill', ai.status === 'EMERGENCY' ? '#ff1744' : '#ffb300');
      DOM.hazardPulseM3.classList.remove('hidden');
    } else {
      DOM.zoneBoxM3.classList.add('zone-safe');
      DOM.mapStatusM3.textContent = 'STATUS: SAFE';
      DOM.mapStatusM3.setAttribute('fill', '#00e676');
      DOM.bulbM3.setAttribute('fill', '#00e676');
      DOM.hazardPulseM3.classList.add('hidden');
    }

    // Tunnel corridors & Guidance
    if (ai.status === 'EMERGENCY') {
      DOM.mapNetworkStatus.textContent = `HAZARD ACTIVE IN ZONE ${danger} - EVACUATION ROUTE ILLUMINATED`;
      DOM.mapNetworkStatus.style.color = '#ff1744';
    } else if (ai.status === 'WARNING') {
      DOM.mapNetworkStatus.textContent = `ATTENTION: ANOMALY MONITORED IN ZONE ${danger}`;
      DOM.mapNetworkStatus.style.color = '#ffb300';
    } else {
      DOM.mapNetworkStatus.textContent = 'ALL PATHWAYS FUNCTIONAL';
      DOM.mapNetworkStatus.style.color = '#00e676';
    }
  }

  function updateWorkersTable(status, activeZone) {
    if (status === 'EMERGENCY') {
      // Worker 02 in M2 is evacuating
      DOM.w2SafetyBadge.textContent = 'WARNING';
      DOM.w2SafetyBadge.className = 'status-pill status-warning';
      DOM.w2EvacBadge.textContent = 'EVACUATING ➔ M1';
      DOM.w2EvacBadge.className = 'evac-pill evac-moving';

      if (DOM.pinBgW2) {
        DOM.pinBgW2.setAttribute('stroke', '#ff1744');
      }

      DOM.w3EvacBadge.textContent = 'STANDBY / ALERT';
      DOM.w3EvacBadge.className = 'evac-pill evac-alert';
    } else if (status === 'WARNING') {
      DOM.w2SafetyBadge.textContent = 'WARNING';
      DOM.w2SafetyBadge.className = 'status-pill status-warning';
      DOM.w2EvacBadge.textContent = 'ALERT STANDBY';
      DOM.w2EvacBadge.className = 'evac-pill evac-normal';
      if (DOM.pinBgW2) DOM.pinBgW2.setAttribute('stroke', '#ffb300');
    } else {
      DOM.w2SafetyBadge.textContent = 'SAFE';
      DOM.w2SafetyBadge.className = 'status-pill status-safe';
      DOM.w2EvacBadge.textContent = 'STATIONARY / WORKING';
      DOM.w2EvacBadge.className = 'evac-pill evac-normal';
      if (DOM.pinBgW2) DOM.pinBgW2.setAttribute('stroke', '#00e676');
    }
  }

  function updateEmergencyResponse(status, dangerZone) {
    if (status === 'EMERGENCY') {
      DOM.respStatePill.textContent = '🚨 CODE RED: DISPATCHED';
      DOM.respStatePill.className = 'resp-state-pill active-alarm';

      DOM.rcStatusCr.textContent = 'ALERT SENT (LIVE)';
      DOM.rcControlRoom.className = 'resp-card dispatched';

      DOM.rcStatusRescue.textContent = 'SMS ALERT SENT';
      DOM.rcRescue.className = 'resp-card dispatched';

      DOM.rcStatusAmbulance.textContent = 'SMS ALERT SENT';
      DOM.rcAmbulance.className = 'resp-card dispatched';

      DOM.rcStatusFan.textContent = 'ON (MAX 100% RPM)';
      DOM.rcVentilation.className = 'resp-card dispatched-safe';

      DOM.rcStatusBuzzer.textContent = 'ACTIVE (CONTINUOUS)';
      DOM.rcBuzzer.className = 'resp-card dispatched';

      DOM.rcStatusTargetZone.textContent = dangerZone ? `ZONE ${dangerZone}` : 'M2';
      DOM.rcStatusTargetZone.style.color = '#ff1744';
    } else if (status === 'WARNING') {
      DOM.respStatePill.textContent = '🟡 ELEVATED ADVISORY';
      DOM.respStatePill.className = 'resp-state-pill';

      DOM.rcStatusCr.textContent = 'OPERATOR NOTIFIED';
      DOM.rcControlRoom.className = 'resp-card';

      DOM.rcStatusRescue.textContent = 'STANDBY / QUEUED';
      DOM.rcRescue.className = 'resp-card';

      DOM.rcStatusAmbulance.textContent = 'STANDBY';
      DOM.rcAmbulance.className = 'resp-card';

      DOM.rcStatusFan.textContent = 'ON (SPOOLING 100%)';
      DOM.rcVentilation.className = 'resp-card dispatched-safe';

      DOM.rcStatusBuzzer.textContent = 'ACTIVE (2 ALERTS)';
      DOM.rcBuzzer.className = 'resp-card';

      DOM.rcStatusTargetZone.textContent = dangerZone ? `ZONE ${dangerZone}` : 'M2';
      DOM.rcStatusTargetZone.style.color = '#ffb300';
    } else {
      DOM.respStatePill.textContent = 'STANDBY';
      DOM.respStatePill.className = 'resp-state-pill';

      DOM.rcStatusCr.textContent = 'STANDBY MONITORING';
      DOM.rcControlRoom.className = 'resp-card';

      DOM.rcStatusRescue.textContent = 'STANDBY';
      DOM.rcRescue.className = 'resp-card';

      DOM.rcStatusAmbulance.textContent = 'STANDBY';
      DOM.rcAmbulance.className = 'resp-card';

      DOM.rcStatusFan.textContent = 'NORMAL (40% RPM)';
      DOM.rcVentilation.className = 'resp-card';

      DOM.rcStatusBuzzer.textContent = 'NORMAL CADENCE (1)';
      DOM.rcBuzzer.className = 'resp-card';

      DOM.rcStatusTargetZone.textContent = 'NONE (ALL CLEAR)';
      DOM.rcStatusTargetZone.style.color = 'var(--neon-cyan)';
    }
  }

  function updateHardwareActuators(status) {
    // 1. Tri-Color LEDs
    DOM.ledGreenBulb.classList.remove('active');
    DOM.ledYellowBulb.classList.remove('active');
    DOM.ledRedBulb.classList.remove('active');

    if (status === 'SAFE') {
      DOM.ledGreenBulb.classList.add('active');
      DOM.ledGreenText.textContent = 'SAFE (ACTIVE)';
      DOM.ledYellowText.textContent = 'WARNING (OFF)';
      DOM.ledRedText.textContent = 'DANGER (OFF)';
    } else if (status === 'WARNING') {
      DOM.ledYellowBulb.classList.add('active');
      DOM.ledGreenText.textContent = 'SAFE (OFF)';
      DOM.ledYellowText.textContent = 'WARNING (ACTIVE)';
      DOM.ledRedText.textContent = 'DANGER (OFF)';
    } else {
      DOM.ledRedBulb.classList.add('active');
      DOM.ledGreenText.textContent = 'SAFE (OFF)';
      DOM.ledYellowText.textContent = 'WARNING (OFF)';
      DOM.ledRedText.textContent = 'DANGER (ACTIVE)';
    }

    // 2. Piezo Buzzer
    DOM.badgeCad1.className = 'badge-cadence';
    DOM.badgeCad2.className = 'badge-cadence';
    DOM.badgeCad3.className = 'badge-cadence';
    DOM.buzzerWaveRing.classList.remove('buzzing');

    if (status === 'SAFE') {
      DOM.buzzerCadenceLabel.textContent = '1 ALERT PULSE (SAFE)';
      DOM.buzzerCadenceDesc.textContent = 'Microcontroller emits periodic single beep to confirm heartbeat and operational integrity.';
      DOM.badgeCad1.className = 'badge-cadence active';
    } else if (status === 'WARNING') {
      DOM.buzzerCadenceLabel.textContent = '2 ALERT PULSES (WARNING)';
      DOM.buzzerCadenceDesc.textContent = 'Double beep cadence active. Environmental anomaly requires personnel alertness.';
      DOM.badgeCad2.className = 'badge-cadence active-warn';
      DOM.buzzerWaveRing.classList.add('buzzing');
    } else {
      DOM.buzzerCadenceLabel.textContent = '3 ALERTS / CONTINUOUS (DANGER)';
      DOM.buzzerCadenceDesc.textContent = 'Continuous high-decibel alarm sounding across mine tunnel sector.';
      DOM.badgeCad3.className = 'badge-cadence active-danger';
      DOM.buzzerWaveRing.classList.add('buzzing');
    }

    // 3. Ventilation Fan
    if (status === 'SAFE') {
      DOM.fanStateTitle.textContent = 'VENTILATION: NORMAL';
      DOM.fanDutyCycle.textContent = 'Status: Baseline 40% RPM';
      DOM.fanDutyCycle.style.color = 'var(--safe-green)';
      DOM.fanSvg.classList.remove('fast');
    } else {
      DOM.fanStateTitle.textContent = 'VENTILATION: EMERGENCY PURGE';
      DOM.fanDutyCycle.textContent = 'Status: Forced 100% Full Spool';
      DOM.fanDutyCycle.style.color = '#ff1744';
      DOM.fanSvg.classList.add('fast');
    }
  }

  // ==========================================================================
  // 6. REAL-TIME DATA TICK & ESP32 POLLING ENGINE
  // ==========================================================================

  // Smooth random walk around current values to create realistic sensor jitter
  function tickSensorNoise() {
    if (State.pollingEnabled) return; // In real hardware mode, don't generate synthetic noise

    // Jitter depending on current status
    const jitter = (val, delta, min, max) => {
      const step = (Math.random() - 0.5) * delta;
      return Math.max(min, Math.min(max, val + step));
    };

    if (State.status === 'SAFE') {
      State.methane = jitter(State.methane, 14, 250, 600);
      State.co = jitter(State.co, 2, 8, 35);
      State.mq135 = jitter(State.mq135, 6, 80, 220);
      State.temperature = jitter(State.temperature, 0.2, 24, 31);
      State.humidity = jitter(State.humidity, 0.4, 48, 65);
    } else if (State.status === 'WARNING') {
      State.methane = jitter(State.methane, 35, 1100, 2100);
      State.co = jitter(State.co, 6, 60, 160);
      State.mq135 = jitter(State.mq135, 20, 350, 750);
      State.temperature = jitter(State.temperature, 0.3, 36, 42);
      State.humidity = jitter(State.humidity, 0.6, 60, 78);
    } else {
      // Emergency
      State.methane = jitter(State.methane, 50, 2600, 3900);
      State.co = jitter(State.co, 15, 220, 750);
      State.mq135 = jitter(State.mq135, 30, 850, 1800);
      State.temperature = jitter(State.temperature, 0.4, 46, 54);
      State.humidity = jitter(State.humidity, 0.8, 65, 88);
    }

    // Push into sparklines history (max 10 points)
    const pushHist = (arr, val) => {
      arr.push(val);
      if (arr.length > 10) arr.shift();
    };
    pushHist(State.history.mq4, State.methane);
    pushHist(State.history.mq7, State.co);
    pushHist(State.history.mq135, State.mq135);
    pushHist(State.history.temp, State.temperature);
    pushHist(State.history.hum, State.humidity);

    renderUI();
  }

  // Poll real or mock ESP32 REST Endpoint
  async function pollEsp32Data() {
    const url = State.apiEndpoint || 'http://localhost:5000/api/data';
    try {
      DOM.sysStatusDot.className = 'indicator-dot online';
      DOM.sysStatusText.textContent = 'SYNCING';

      const resp = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
      if (!resp.ok) throw new Error(`HTTP error ${resp.status}`);
      const data = await resp.json();

      // Expected payload format:
      // {
      //   "zone": "M2",
      //   "location": "Mine Zone M2",
      //   "methane": 1800,
      //   "co": 1200,
      //   "mq135": 1400,
      //   "temperature": 38,
      //   "humidity": 65,
      //   "status": "WARNING",
      //   "safeRoute": "M2 -> M1 -> MAIN EXIT"
      // }

      if (data.zone) State.zone = data.zone;
      if (data.location) State.location = data.location;
      if (data.methane !== undefined) State.methane = Number(data.methane);
      if (data.co !== undefined) State.co = Number(data.co);
      if (data.mq135 !== undefined) State.mq135 = Number(data.mq135);
      if (data.temperature !== undefined) State.temperature = Number(data.temperature);
      if (data.humidity !== undefined) State.humidity = Number(data.humidity);
      if (data.safeRoute) State.safeRoute = data.safeRoute;

      // Push history
      const pushHist = (arr, val) => {
        arr.push(val);
        if (arr.length > 10) arr.shift();
      };
      pushHist(State.history.mq4, State.methane);
      pushHist(State.history.mq7, State.co);
      pushHist(State.history.mq135, State.mq135);
      pushHist(State.history.temp, State.temperature);
      pushHist(State.history.hum, State.humidity);

      DOM.sysStatusDot.className = 'indicator-dot online';
      DOM.sysStatusText.textContent = 'ONLINE (ESP32)';
      renderUI();
    } catch (err) {
      console.warn('ESP32 REST poll warning:', err.message);
      DOM.sysStatusDot.className = 'indicator-dot offline';
      DOM.sysStatusText.textContent = 'OFFLINE';
    }
  }

  // ==========================================================================
  // 7. EVENT LISTENERS & DEMO CONTROLS
  // ==========================================================================
  function setupEventListeners() {
    // 1. Persona View Switcher
    DOM.viewModeControl.addEventListener('click', () => {
      State.viewMode = 'control-room';
      DOM.viewModeControl.classList.add('active');
      DOM.viewModeWorker.classList.remove('active');
      renderUI();
    });

    DOM.viewModeWorker.addEventListener('click', () => {
      State.viewMode = 'worker';
      DOM.viewModeWorker.classList.add('active');
      DOM.viewModeControl.classList.remove('active');
      renderUI();
    });

    // 2. Sound Siren Toggle
    DOM.btnToggleSound.addEventListener('click', () => {
      State.soundMuted = !State.soundMuted;
      DOM.soundIconOn.classList.toggle('hidden', State.soundMuted);
      DOM.soundIconOff.classList.toggle('hidden', !State.soundMuted);
      DOM.btnToggleSound.classList.toggle('muted', State.soundMuted);
      if (!State.soundMuted) {
        initAudio();
        playBuzzerTone(900, 0.1);
      }
    });

    DOM.btnSilenceAlarm.addEventListener('click', () => {
      State.soundMuted = true;
      DOM.soundIconOn.classList.add('hidden');
      DOM.soundIconOff.classList.remove('hidden');
      DOM.btnToggleSound.classList.add('muted');
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    });

    // 3. Manual Evacuation & Normal Reset Buttons
    DOM.btnManualEvac.addEventListener('click', () => {
      State.methane = 3200;
      State.co = 350;
      State.zone = 'M2';
      renderUI();
    });

    DOM.btnResetNormal.addEventListener('click', () => {
      State.methane = 420;
      State.co = 18;
      State.mq135 = 110;
      State.temperature = 27.4;
      State.humidity = 58;
      State.zone = 'M1';
      renderUI();
    });

    // 4. Modal Open/Close
    DOM.btnOpenSim.addEventListener('click', () => {
      syncSlidersToState();
      DOM.simModal.classList.remove('hidden');
    });

    const closeModal = () => DOM.simModal.classList.add('hidden');
    DOM.btnCloseSim.addEventListener('click', closeModal);
    DOM.btnCloseSimFooter.addEventListener('click', closeModal);
    DOM.simModal.addEventListener('click', (e) => {
      if (e.target === DOM.simModal) closeModal();
    });

    // 5. Preset Demo Scenarios
    DOM.scenNormal.addEventListener('click', () => {
      State.zone = 'M1';
      State.location = 'Mine Zone M1';
      State.methane = 420;
      State.co = 18;
      State.mq135 = 110;
      State.temperature = 27.4;
      State.humidity = 58;
      syncSlidersToState();
      renderUI();
      closeModal();
    });

    DOM.scenWarning.addEventListener('click', () => {
      State.zone = 'M2';
      State.location = 'Mine Zone M2';
      State.methane = 1800;
      State.co = 65;
      State.mq135 = 450;
      State.temperature = 38.0;
      State.humidity = 65;
      syncSlidersToState();
      renderUI();
      closeModal();
    });

    DOM.scenEmergency.addEventListener('click', () => {
      State.zone = 'M2';
      State.location = 'Mine Zone M2';
      State.methane = 2800;
      State.co = 95;
      State.mq135 = 920;
      State.temperature = 39.5;
      State.humidity = 70;
      syncSlidersToState();
      renderUI();
      closeModal();
    });

    DOM.scenToxic.addEventListener('click', () => {
      State.zone = 'M3';
      State.location = 'Mine Zone M3';
      State.methane = 1400;
      State.co = 650;
      State.mq135 = 1450;
      State.temperature = 47.0;
      State.humidity = 82;
      syncSlidersToState();
      renderUI();
      closeModal();
    });

    // 6. Sliders Synchronizer
    function syncSlidersToState() {
      DOM.inputMq4.value = Math.round(State.methane);
      DOM.valSliderMq4.textContent = Math.round(State.methane);

      DOM.inputMq7.value = Math.round(State.co);
      DOM.valSliderMq7.textContent = Math.round(State.co);

      DOM.inputMq135.value = Math.round(State.mq135);
      DOM.valSliderMq135.textContent = Math.round(State.mq135);

      DOM.inputTemp.value = State.temperature.toFixed(1);
      DOM.valSliderTemp.textContent = State.temperature.toFixed(1);

      DOM.inputHum.value = Math.round(State.humidity);
      DOM.valSliderHum.textContent = Math.round(State.humidity);

      DOM.selectActiveZone.value = State.zone;
    }

    DOM.inputMq4.addEventListener('input', (e) => DOM.valSliderMq4.textContent = e.target.value);
    DOM.inputMq7.addEventListener('input', (e) => DOM.valSliderMq7.textContent = e.target.value);
    DOM.inputMq135.addEventListener('input', (e) => DOM.valSliderMq135.textContent = e.target.value);
    DOM.inputTemp.addEventListener('input', (e) => DOM.valSliderTemp.textContent = e.target.value);
    DOM.inputHum.addEventListener('input', (e) => DOM.valSliderHum.textContent = e.target.value);

    DOM.btnApplySliders.addEventListener('click', () => {
      State.methane = Number(DOM.inputMq4.value);
      State.co = Number(DOM.inputMq7.value);
      State.mq135 = Number(DOM.inputMq135.value);
      State.temperature = Number(DOM.inputTemp.value);
      State.humidity = Number(DOM.inputHum.value);
      State.zone = DOM.selectActiveZone.value;
      State.location = `Mine Zone ${State.zone}`;
      renderUI();
      closeModal();
    });

    // 7. Polling Toggles
    DOM.checkPolling.addEventListener('change', (e) => {
      State.pollingEnabled = e.target.checked;
      State.apiEndpoint = DOM.espEndpointInput.value;
      if (State.pollingEnabled) {
        pollEsp32Data();
      }
    });

    DOM.btnFetchOnce.addEventListener('click', () => {
      State.apiEndpoint = DOM.espEndpointInput.value;
      pollEsp32Data();
    });

    // 8. Map Zone Click Inspect
    document.querySelectorAll('.map-zone').forEach(z => {
      z.addEventListener('click', () => {
        const zoneId = z.getAttribute('data-zone');
        if (zoneId && zoneId !== 'EXIT') {
          State.zone = zoneId;
          State.location = `Mine Zone ${zoneId}`;
          renderUI();
        }
      });
    });

    document.querySelectorAll('.btn-zone-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.btn-zone-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const selZone = btn.getAttribute('data-zone-select');
        if (selZone) {
          State.zone = selZone;
          State.location = `Mine Zone ${selZone}`;
          renderUI();
        }
      });
    });

    // 9. Clear Alert Log
    DOM.btnClearAlerts.addEventListener('click', () => {
      State.alerts = [];
      renderAlerts();
    });

    // 10. Open Source Info Modal & Telemetry JSON Export
    const openOsModal = () => DOM.osModal.classList.remove('hidden');
    const closeOsModal = () => DOM.osModal.classList.add('hidden');

    if (DOM.btnOpenOsModal) DOM.btnOpenOsModal.addEventListener('click', openOsModal);
    if (DOM.btnFooterOsInfo) DOM.btnFooterOsInfo.addEventListener('click', openOsModal);
    if (DOM.btnCloseOs) DOM.btnCloseOs.addEventListener('click', closeOsModal);
    if (DOM.btnCloseOsFooter) DOM.btnCloseOsFooter.addEventListener('click', closeOsModal);
    if (DOM.osModal) {
      DOM.osModal.addEventListener('click', (e) => {
        if (e.target === DOM.osModal) closeOsModal();
      });
    }

    function exportTelemetryJson() {
      const snapshot = {
        meta: {
          project: "AI-Based Mine Gas Leakage Detection and Smart Evacuation System",
          license: "MIT License",
          timestamp: new Date().toISOString(),
          version: "2.4.0"
        },
        telemetry: {
          zone: State.zone,
          location: State.location,
          methane_ppm: Math.round(State.methane),
          co_ppm: Math.round(State.co),
          mq135_aqi_ppm: Math.round(State.mq135),
          temperature_c: Number(State.temperature.toFixed(1)),
          humidity_percent: Math.round(State.humidity),
          status: State.status,
          dangerZone: State.dangerZone,
          safeRoute: State.safeRoute
        },
        workers: State.workers,
        recentEvents: State.alerts.slice(0, 10)
      };

      const jsonStr = JSON.stringify(snapshot, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const dlAnchor = document.createElement('a');
      dlAnchor.href = url;
      dlAnchor.download = `mine_safety_telemetry_${Date.now()}.json`;
      document.body.appendChild(dlAnchor);
      dlAnchor.click();
      document.body.removeChild(dlAnchor);
      URL.revokeObjectURL(url);
    }

    if (DOM.btnFooterExportJson) DOM.btnFooterExportJson.addEventListener('click', exportTelemetryJson);
    if (DOM.btnDownloadTelemetry) DOM.btnDownloadTelemetry.addEventListener('click', exportTelemetryJson);
  }

  // ==========================================================================
  // 8. INITIALIZATION
  // ==========================================================================
  function init() {
    setupEventListeners();
    renderAlerts();
    renderUI();

    // Regular interval: 1-second cadence for real-time sensor simulation or polling
    setInterval(() => {
      if (State.pollingEnabled) {
        pollEsp32Data();
      } else {
        tickSensorNoise();
      }
    }, 1200);

    // Periodic buzzer pulse cadence check (every 10 seconds for Safe heartbeat)
    setInterval(() => {
      if (State.status === 'SAFE') {
        triggerBuzzerCadence('SAFE');
      } else if (State.status === 'WARNING') {
        triggerBuzzerCadence('WARNING');
      } else if (State.status === 'EMERGENCY') {
        triggerBuzzerCadence('EMERGENCY');
      }
    }, 8000);
  }

  // Launch when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
