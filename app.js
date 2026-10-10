/**
 * SMART MINE SAFETY CONTROL CENTER - CORE CLIENT ENGINE
 * AI-Based Mine Gas Leakage Detection and Smart Evacuation System
 * Fail-Safe SCADA Dashboard & Worker HUD Platform
 */

(function () {
  'use strict';

  // ==========================================================================
  // 1. STATE & CONFIGURATION
  // ==========================================================================
  const State = {
    // Active Node Telemetry (Ingested from Server)
    node_id: 'ESP32_M1',
    zone: 'M1',
    location: 'Mine Zone M1',
    methane: 420,       // MQ-4 (ppm)
    co: 18,             // MQ-7 (ppm)
    toxic: 110,         // MQ-135 (ppm)
    temp: 27.4,         // DHT11 (°C)
    humidity: 58,       // DHT11 (% RH)
    alarm_level: 'SAFE',// SAFE | WARNING | EVACUATE | SENSOR_FAULT
    fan_on: false,
    uptime: 0,
    serverRiskScore: 0.0,
    riskComponents: {},

    // Status: SAFE | WARNING | EVACUATE | SENSOR_FAULT | UNKNOWN | OFFLINE
    status: 'UNKNOWN',  // Fail-safe default: UNKNOWN until valid server telemetry arrives
    dangerZone: null,   // null | 'M1' | 'M2' | 'M3'
    contaminatedZones: [],
    safeRoute: 'NO DATA - SENSOR OFFLINE', // Fail-safe default
    routes: {},
    zones: {},

    // System Modes: 'LIVE' | 'DEMO' (LIVE is primary default)
    mode: 'LIVE',
    pollingEnabled: true,
    apiEndpoint: '/api/esp32/data',
    historyEndpoint: '/api/esp32/history',

    // Edge Node Registry & Heartbeat Tracking
    esp32Online: false,
    esp32LastSeenSec: null,
    esp32LastSeenTimestamp: null,
    esp32TriggerSensor: 'No Sensor Connected',
    esp32RiskLevel: 'UNKNOWN',
    activeNodesCount: 0,
    nodes: {},

    // Audio & UX State
    soundMuted: true, // Requires explicit user click to activate sound
    audioContextUnlocked: false,
    silenceUntil: 0,  // 2-minute snooze timestamp
    lastAudibleStatus: 'UNKNOWN',
    viewMode: 'control-room', // 'control-room' | 'worker'
    activeTab: 'overview',

    // Rolling History for Trend Sparklines (10 samples)
    history: {
      mq4: [420],
      mq7: [18],
      toxic: [110],
      temp: [27.4],
      hum: [58]
    },
    lastPushedTimestamp: null,

    // Workers Status Tracking Table
    workers: [
      { id: 'W-01', name: 'Worker 01', zone: 'M1', role: 'Shift Lead', status: 'SAFE', evac: 'STATIONARY / WORKING', hr: 98 },
      { id: 'W-02', name: 'Worker 02', zone: 'M2', role: 'Excavator Operator', status: 'SAFE', evac: 'STATIONARY / WORKING', hr: 102 },
      { id: 'W-03', name: 'Worker 03', zone: 'M3', role: 'Ventilation Tech', status: 'SAFE', evac: 'STATIONARY / WORKING', hr: 88 }
    ],

    // Real-Time Incident Log (Fake seeded alerts eliminated)
    alerts: []
  };

  // Canonical Shared Threshold Table (Demo values for laboratory prototype)
  const THRESHOLDS = {
    methane: { warn: 1000, danger: 2500 },
    co:      { warn: 50,   danger: 200 },
    toxic:   { warn: 300,  danger: 800 },
    temp:    { warn: 35.0, danger: 45.0 },
    hum:     { lowWarn: 40, highWarn: 80 }
  };

  // Mine Tunnel Evacuation Routing Graph:
  // M1: [M2, EXIT]
  // M2: [M1, M3, AUX]
  // M3: [M2, AUX]
  // AUX: [EXIT]
  const MINE_GRAPH = {
    'M1': ['M2', 'EXIT'],
    'M2': ['M1', 'M3', 'AUX'],
    'M3': ['M2', 'AUX'],
    'AUX': ['EXIT']
  };

  const DISPLAY_MAP = {
    'M1': 'M1',
    'M2': 'M2',
    'M3': 'M3',
    'AUX': 'AUXILIARY ESCAPE SHAFT',
    'EXIT': 'MAIN EXIT'
  };

  // Hazard Escalation Severity Hierarchy (used to re-arm 2-min snooze on escalation)
  const SEVERITY_ORDER = {
    'UNKNOWN': 0,
    'OFFLINE': 0,
    'SAFE': 1,
    'WARNING': 2,
    'SENSOR_FAULT': 2,
    'EVACUATE': 3,
    'EMERGENCY': 3
  };

  // ==========================================================================
  // 2. BFS TUNNEL ROUTING ALGORITHM
  // ==========================================================================
  function bfsFindRoute(workerZone, hazardZones) {
    if (workerZone === 'EXIT') return 'MAIN EXIT';
    const queue = [[workerZone]];
    const visited = new Set([workerZone]);

    while (queue.length > 0) {
      const path = queue.shift();
      const current = path[path.length - 1];

      if (current === 'EXIT') {
        return path.map(n => DISPLAY_MAP[n] || n).join(' ➔ ');
      }

      const neighbors = MINE_GRAPH[current] || [];
      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        if (neighbor !== 'EXIT' && hazardZones.includes(neighbor)) continue;

        visited.add(neighbor);
        queue.push([...path, neighbor]);
      }
    }

    return 'NO SAFE ROUTE';
  }

  // ==========================================================================
  // 3. AUDIO SYNTHESIZER (WEB AUDIO API)
  // Compliant with browser autoplay policies: activates only after user click
  // ==========================================================================
  let audioCtx = null;

  function initAudio() {
    if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  function playBuzzerTone(freq = 880, duration = 0.12, type = 'square') {
    if (State.soundMuted) return;
    try {
      initAudio();
      if (!audioCtx || audioCtx.state === 'suspended') return;

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);

      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.start();
      osc.stop(audioCtx.currentTime + duration);
    } catch (e) {
      console.warn('Audio tone suppressed:', e);
    }
  }

  // Unified Cadence: 2 beeps (Warning), 3 beeps (Evacuate / Emergency)
  function triggerBuzzerCadence(status) {
    if (State.soundMuted) return;
    if (status === 'WARNING' || status === 'SENSOR_FAULT') {
      playBuzzerTone(1050, 0.1, 'triangle');
      setTimeout(() => playBuzzerTone(1050, 0.1, 'triangle'), 180);
    } else if (status === 'EVACUATE' || status === 'EMERGENCY') {
      playBuzzerTone(1350, 0.14, 'square');
      setTimeout(() => playBuzzerTone(1350, 0.14, 'square'), 180);
      setTimeout(() => playBuzzerTone(1600, 0.22, 'sawtooth'), 360);
    }
  }

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
    esp32HeaderDot: document.getElementById('esp32-header-dot'),
    esp32HeaderStatusText: document.getElementById('esp32-header-status-text'),
    currentZoneVal: document.getElementById('current-zone-val'),
    mineLocationVal: document.getElementById('mine-location-val'),
    lastUpdatedClock: document.getElementById('last-updated-clock'),
    viewModeControl: document.getElementById('view-mode-control'),
    viewModeWorker: document.getElementById('view-mode-worker'),
    btnToggleSound: document.getElementById('btn-toggle-sound'),
    soundIconOn: document.getElementById('sound-icon-on'),
    soundIconOff: document.getElementById('sound-icon-off'),
    btnUnlockAudio: document.getElementById('btn-unlock-audio'),
    audioUnlockIcon: document.getElementById('audio-unlock-icon'),
    audioUnlockLabel: document.getElementById('audio-unlock-label'),

    // Persistent System Status Bar
    statusBarMode: document.getElementById('status-bar-mode'),
    statusBarAge: document.getElementById('status-bar-age'),
    statusBarNode: document.getElementById('status-bar-node'),
    statusBarNodesCount: document.getElementById('status-bar-nodes-count'),
    statusBarRisk: document.getElementById('status-bar-risk'),

    // 4 Tabs Navigation
    tabBtns: document.querySelectorAll('.tab-nav-btn'),
    tabPanels: {
      'overview': document.getElementById('tab-panel-overview'),
      'map-route': document.getElementById('tab-panel-map-route'),
      'trends': document.getElementById('tab-panel-trends'),
      'alerts': document.getElementById('tab-panel-alerts')
    },
    tabBadgeAlerts: document.getElementById('tab-badge-alerts'),

    // Mobile Worker HUD Banner
    workerHudBanner: document.getElementById('worker-hud-banner'),
    hudArrow: document.getElementById('hud-arrow'),
    hudStatus: document.getElementById('hud-status'),
    hudExitPath: document.getElementById('hud-exit-path'),
    hudZone: document.getElementById('hud-zone'),

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

    // Section 2: Sensor Monitoring Cards
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

    // Section 8: Emergency Response Protocol
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

    // Section 10: ESP32 Device Status & Section 11: History
    esp32LiveBadge: document.getElementById('esp32-live-badge'),
    esp32CardDeviceId: document.getElementById('esp32-card-device-id'),
    esp32CardZone: document.getElementById('esp32-card-zone'),
    esp32CardLocation: document.getElementById('esp32-card-location'),
    esp32CardLastSeen: document.getElementById('esp32-card-last-seen'),
    esp32CardLastSeenAgo: document.getElementById('esp32-card-last-seen-ago'),
    esp32CardStatusText: document.getElementById('esp32-card-status-text'),
    esp32CardRiskLevel: document.getElementById('esp32-card-risk-level'),
    esp32CardTriggerSensor: document.getElementById('esp32-card-trigger-sensor'),
    historyTbody: document.getElementById('history-tbody'),
    historyCountLabel: document.getElementById('history-count-label'),

    // Section 7: Alert Feed
    alertFeed: document.getElementById('alert-feed'),
    alertCountPill: document.getElementById('alert-count-pill'),
    btnClearAlerts: document.getElementById('btn-clear-alerts'),

    // Developer & Demo Drawer
    btnToggleDevDrawer: document.getElementById('btn-toggle-dev-drawer'),
    devDrawerPanel: document.getElementById('dev-drawer-panel'),
    devDrawerBackdrop: document.getElementById('dev-drawer-backdrop'),
    btnCloseDevDrawer: document.getElementById('btn-close-dev-drawer'),
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

  function renderSparkline(svgElement, dataArray, minVal, maxVal) {
    if (!svgElement || !dataArray || dataArray.length < 2) return;
    const width = 160;
    const height = 38;
    const range = (maxVal - minVal) || 1;
    const step = width / (dataArray.length - 1);

    const points = dataArray.map((val, idx) => {
      const clamped = Math.max(minVal, Math.min(maxVal, val));
      const normalized = (clamped - minVal) / range;
      const y = Math.round(height - normalized * (height - 8) - 4);
      return `${Math.round(idx * step)},${y}`;
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
    renderSparkline(DOM.sparklineMq135, State.history.toxic, 50, 1500);
    renderSparkline(DOM.sparklineTemp, State.history.temp, 15, 55);
    renderSparkline(DOM.sparklineHum, State.history.hum, 20, 100);
  }

  function formatTime(date = new Date()) {
    return date.toTimeString().split(' ')[0];
  }

  function addAlertItem(type, title, desc) {
    const time = formatTime();
    State.alerts.unshift({ type, title, time, desc });
    if (State.alerts.length > 30) State.alerts.pop();
    renderAlerts();
  }

  // Safe DOM building: Zero innerHTML for server-provided strings
  function renderAlerts() {
    if (!DOM.alertFeed) return;
    DOM.alertFeed.replaceChildren();

    State.alerts.forEach(item => {
      const el = document.createElement('div');
      el.className = `alert-item alert-${item.type}`;
      const icon = item.type === 'green' ? '🟢' : (item.type === 'yellow' ? '🟡' : '🔴');

      const badgeDot = document.createElement('div');
      badgeDot.className = 'alert-badge-dot';
      badgeDot.textContent = icon;

      const alertBody = document.createElement('div');
      alertBody.className = 'alert-body';

      const alertRow = document.createElement('div');
      alertRow.className = 'alert-row';

      const strongMsg = document.createElement('strong');
      strongMsg.className = 'alert-msg';
      strongMsg.textContent = String(item.title || '');

      const spanTime = document.createElement('span');
      spanTime.className = 'alert-time';
      spanTime.textContent = String(item.time || '');

      alertRow.appendChild(strongMsg);
      alertRow.appendChild(spanTime);

      const spanDetails = document.createElement('span');
      spanDetails.className = 'alert-details';
      spanDetails.textContent = String(item.desc || '');

      alertBody.appendChild(alertRow);
      alertBody.appendChild(spanDetails);

      el.appendChild(badgeDot);
      el.appendChild(alertBody);

      DOM.alertFeed.appendChild(el);
    });

    if (DOM.alertCountPill) {
      DOM.alertCountPill.textContent = `${State.alerts.length} EVENTS`;
    }
    if (DOM.tabBadgeAlerts) {
      DOM.tabBadgeAlerts.textContent = State.alerts.length;
    }
  }

  function renderVisualRoute(routeString) {
    if (!DOM.routePathVisual) return;
    DOM.routePathVisual.replaceChildren();

    const parts = (routeString || 'NO SAFE ROUTE').split(/\s*->\s*|\s*➔\s*/);
    parts.forEach((node, idx) => {
      const nodeSpan = document.createElement('span');
      nodeSpan.className = 'route-node';
      const cleanNode = node.trim();

      if (idx === 0) {
        nodeSpan.classList.add('current');
      } else if (idx === parts.length - 1 || cleanNode.toUpperCase().includes('EXIT')) {
        nodeSpan.classList.add('exit-node');
      }
      nodeSpan.textContent = cleanNode;
      DOM.routePathVisual.appendChild(nodeSpan);

      if (idx < parts.length - 1) {
        const arrowSpan = document.createElement('span');
        arrowSpan.className = 'route-arrow';
        arrowSpan.textContent = '➔';
        DOM.routePathVisual.appendChild(arrowSpan);
      }
    });
  }

  // ==========================================================================
  // FAIL-SAFE PRIMARY UI SYNCHRONIZER
  // ==========================================================================
  function renderUI() {
    const isOffline = (!State.esp32Online || State.esp32LastSeenSec === null || State.esp32LastSeenSec > 10);

    // FAIL-SAFE RULE: If offline, fetch failed, or data > 10s old:
    // Grey out UI, show 'NO DATA - SENSOR OFFLINE', status UNKNOWN, never SAFE!
    if (isOffline && State.mode !== 'DEMO') {
      State.esp32Online = false;
      State.status = 'UNKNOWN'; // Never show SAFE
      State.safeRoute = 'NO DATA - SENSOR OFFLINE';
      State.dangerZone = null;
      DOM.body.classList.add('sensor-offline-greyed');
    } else {
      DOM.body.classList.remove('sensor-offline-greyed');
    }

    // Audible Escalation Check & Snooze Handling
    const prevRank = SEVERITY_ORDER[State.lastAudibleStatus] || 0;
    const currentRank = SEVERITY_ORDER[State.status] || 0;

    if (currentRank > prevRank && currentRank >= 2) {
      // Escalated to WARNING or EVACUATE! Re-arm snooze immediately
      if (State.silenceUntil > 0) {
        State.silenceUntil = 0;
        if (DOM.btnSilenceAlarm) DOM.btnSilenceAlarm.textContent = 'Silence Siren';
        addAlertItem('yellow', 'SNOOZE OVERRIDDEN: ESCALATION', 'Hazard level escalated. Audible alarm re-armed automatically.');
      }
      if (State.audioContextUnlocked) {
        State.soundMuted = false;
        if (DOM.soundIconOn) DOM.soundIconOn.classList.remove('hidden');
        if (DOM.soundIconOff) DOM.soundIconOff.classList.add('hidden');
        if (DOM.btnToggleSound) DOM.btnToggleSound.classList.remove('muted');
      }
      triggerBuzzerCadence(State.status);
      if (State.status === 'EVACUATE') {
        announceEmergencyVoice(`Critical hazard in Zone ${State.zone}. Immediate evacuation required.`);
        addAlertItem('red', `EVACUATION IN ZONE ${State.zone}`, `Critical threshold breached. Evacuate via ${State.safeRoute}.`);
      } else if (State.status === 'WARNING') {
        addAlertItem('yellow', `WARNING IN ZONE ${State.zone}`, `Environmental parameters elevated.`);
      }
    } else if (State.status === 'SAFE' && State.lastAudibleStatus !== 'SAFE') {
      addAlertItem('green', 'ATMOSPHERE NOMINAL', 'Sensors reporting safe atmospheric conditions.');
    }

    State.lastAudibleStatus = State.status;

    // 1. Body & Theme classes
    DOM.body.className = `theme-dark status-${State.status.toLowerCase()}${isOffline && State.mode !== 'DEMO' ? ' sensor-offline-greyed' : ''}`;
    DOM.body.setAttribute('data-view-mode', State.viewMode);

    // 2. Header Telemetry
    if (DOM.currentZoneVal) DOM.currentZoneVal.textContent = State.zone;
    if (DOM.mineLocationVal) DOM.mineLocationVal.textContent = State.location;
    if (DOM.lastUpdatedClock) DOM.lastUpdatedClock.textContent = formatTime();

    if (DOM.esp32HeaderDot && DOM.esp32HeaderStatusText) {
      DOM.esp32HeaderDot.className = `indicator-dot ${State.esp32Online ? 'online' : 'offline'}`;
      DOM.esp32HeaderStatusText.textContent = State.esp32Online ? 'ONLINE' : 'OFFLINE';
    }

    // 3. Persistent System Status Bar
    if (DOM.statusBarMode) {
      if (State.mode === 'DEMO') {
        DOM.statusBarMode.className = 'mode-badge mode-demo';
        DOM.statusBarMode.textContent = '● DEMO MODE';
      } else if (State.esp32Online) {
        DOM.statusBarMode.className = 'mode-badge mode-live';
        DOM.statusBarMode.textContent = '● LIVE ESP32';
      } else {
        DOM.statusBarMode.className = 'mode-badge mode-offline';
        DOM.statusBarMode.textContent = '● SENSOR OFFLINE';
      }
    }

    if (DOM.statusBarAge) {
      if (State.esp32Online && State.esp32LastSeenSec !== null) {
        DOM.statusBarAge.textContent = `${State.esp32LastSeenSec}s ago`;
        DOM.statusBarAge.className = `age-indicator ${State.esp32LastSeenSec > 7 ? 'stale' : ''}`;
      } else {
        DOM.statusBarAge.textContent = 'No signal (>10s)';
        DOM.statusBarAge.className = 'age-indicator stale';
      }
    }

    if (DOM.statusBarNode) {
      DOM.statusBarNode.textContent = `${State.node_id} (Zone ${State.zone})`;
    }

    if (DOM.statusBarNodesCount) {
      const count = State.activeNodesCount || (State.esp32Online ? 1 : 0);
      DOM.statusBarNodesCount.textContent = `${count} Node${count === 1 ? '' : 's'} Online`;
    }

    if (DOM.statusBarRisk) {
      if (!State.esp32Online && State.mode !== 'DEMO') {
        DOM.statusBarRisk.textContent = 'UNVERIFIED';
        DOM.statusBarRisk.style.color = '#ff9100';
      } else {
        DOM.statusBarRisk.textContent = `${Math.round(State.serverRiskScore)}% (${State.esp32RiskLevel})`;
        DOM.statusBarRisk.style.color = State.status === 'EVACUATE' ? 'var(--danger-red)' :
                                       (State.status === 'WARNING' ? 'var(--warn-yellow)' : 'var(--safe-green)');
      }
    }

    // 4. Mobile Worker HUD
    if (DOM.workerHudBanner) {
      if (State.status === 'UNKNOWN' || State.status === 'OFFLINE') {
        if (DOM.hudArrow) DOM.hudArrow.textContent = '⚠️';
        if (DOM.hudStatus) DOM.hudStatus.textContent = 'NO DATA - OFFLINE';
        if (DOM.hudExitPath) DOM.hudExitPath.textContent = 'ATMOSPHERE UNVERIFIED';
        if (DOM.hudZone) DOM.hudZone.textContent = `ZONE ${State.zone}`;
      } else if (State.status === 'EVACUATE') {
        if (DOM.hudArrow) DOM.hudArrow.textContent = '➔';
        if (DOM.hudStatus) DOM.hudStatus.textContent = 'EVACUATE NOW';
        if (DOM.hudExitPath) DOM.hudExitPath.textContent = State.safeRoute;
        if (DOM.hudZone) DOM.hudZone.textContent = `ZONE ${State.zone}`;
      } else if (State.status === 'WARNING') {
        if (DOM.hudArrow) DOM.hudArrow.textContent = '➔';
        if (DOM.hudStatus) DOM.hudStatus.textContent = 'STANDBY WARNING';
        if (DOM.hudExitPath) DOM.hudExitPath.textContent = State.safeRoute;
        if (DOM.hudZone) DOM.hudZone.textContent = `ZONE ${State.zone}`;
      } else if (State.status === 'SENSOR_FAULT') {
        if (DOM.hudArrow) DOM.hudArrow.textContent = '⚠️';
        if (DOM.hudStatus) DOM.hudStatus.textContent = 'SENSOR FAULT';
        if (DOM.hudExitPath) DOM.hudExitPath.textContent = State.safeRoute;
        if (DOM.hudZone) DOM.hudZone.textContent = `ZONE ${State.zone}`;
      } else {
        if (DOM.hudArrow) DOM.hudArrow.textContent = '✔';
        if (DOM.hudStatus) DOM.hudStatus.textContent = 'CORRIDOR SAFE';
        if (DOM.hudExitPath) DOM.hudExitPath.textContent = State.safeRoute;
        if (DOM.hudZone) DOM.hudZone.textContent = `ZONE ${State.zone}`;
      }
    }

    // 5. Emergency Broadcast Banner
    if (State.status === 'EVACUATE' || State.status === 'WARNING') {
      DOM.emergencyBanner.classList.remove('hidden');
      if (State.status === 'EVACUATE') {
        DOM.bannerTitle.textContent = `CRITICAL EVACUATION IN ZONE ${State.zone}`;
        DOM.bannerDesc.textContent = `Dangerous gas or thermal conditions detected. Immediate evacuation ordered.`;
      } else {
        DOM.bannerTitle.textContent = `ENVIRONMENTAL WARNING ADVISORY`;
        DOM.bannerDesc.textContent = `Abnormal conditions in Zone ${State.zone}. Prepare respirators and monitor exit vectors.`;
      }
      DOM.bannerRouteHint.textContent = `ROUTE: ${State.safeRoute}`;
    } else {
      DOM.emergencyBanner.classList.add('hidden');
    }

    // 6. Section 1: Live Safety Status Shield
    if (State.status === 'UNKNOWN' || State.status === 'OFFLINE') {
      DOM.statusIcon.textContent = '⚠️';
      DOM.statusBadgeText.textContent = 'OFFLINE';
      DOM.statusHeadline.textContent = 'NO DATA - SENSOR OFFLINE';
      DOM.statusSubmessage.textContent = 'Telemetry stream interrupted for >10 seconds. Atmospheric safety is unconfirmed. Proceed with extreme caution!';
      DOM.aiThreatScore.textContent = 'UNVERIFIED';
      DOM.evacReadinessLabel.textContent = 'HAZARD UNCONFIRMED';
      DOM.activeResponseLabel.textContent = 'TELEMETRY DISCONNECTED';
    } else if (State.status === 'SAFE') {
      DOM.statusIcon.textContent = '🛡️';
      DOM.statusBadgeText.textContent = 'SAFE';
      DOM.statusHeadline.textContent = 'SAFE';
      DOM.statusSubmessage.textContent = 'Atmospheric gas concentrations, airflow, and tunnel temperatures are within normal limits.';
      DOM.aiThreatScore.textContent = `${Math.round(State.serverRiskScore)}% (Nominal)`;
      DOM.evacReadinessLabel.textContent = 'STANDBY / CLEAR';
      DOM.activeResponseLabel.textContent = 'AUTOMATED SURVEILLANCE';
    } else if (State.status === 'WARNING') {
      DOM.statusIcon.textContent = '⚠️';
      DOM.statusBadgeText.textContent = 'WARNING';
      DOM.statusHeadline.textContent = 'WARNING';
      DOM.statusSubmessage.textContent = 'Abnormal environmental conditions detected. Workers must remain alert and prepare for evacuation.';
      DOM.aiThreatScore.textContent = `${Math.round(State.serverRiskScore)}% (Elevated)`;
      DOM.evacReadinessLabel.textContent = 'STAGE 1 EVAC READINESS';
      DOM.activeResponseLabel.textContent = 'HIGH VENTILATION SPOOL';
    } else if (State.status === 'SENSOR_FAULT') {
      DOM.statusIcon.textContent = '⚠️';
      DOM.statusBadgeText.textContent = 'FAULT';
      DOM.statusHeadline.textContent = 'HARDWARE SENSOR FAULT';
      DOM.statusSubmessage.textContent = 'Telemetry packet indicates sensor disconnected or hardware read error. Inspect node.';
      DOM.aiThreatScore.textContent = 'HARDWARE ERROR';
      DOM.evacReadinessLabel.textContent = 'MAINTENANCE REQUIRED';
      DOM.activeResponseLabel.textContent = 'FAIL-SAFE ENGAGED';
    } else {
      DOM.statusIcon.textContent = '🚨';
      DOM.statusBadgeText.textContent = 'EVACUATE';
      DOM.statusHeadline.textContent = 'EVACUATE';
      DOM.statusSubmessage.textContent = 'Dangerous gas/temperature condition detected! Immediate evacuation required! Follow illuminated beacons.';
      DOM.aiThreatScore.textContent = `${Math.round(State.serverRiskScore)}% (CRITICAL)`;
      DOM.evacReadinessLabel.textContent = 'IMMEDIATE EVACUATION ACTIVE';
      DOM.activeResponseLabel.textContent = 'ALL AUTOMATED RESPONSES FIRED';
    }

    // 7. Section 5: Smart Evacuation Route
    DOM.routeCurrentZone.textContent = State.zone;
    DOM.routeDangerZone.textContent = State.dangerZone ? `ZONE ${State.dangerZone} (HAZARDOUS)` :
                                      (State.status === 'UNKNOWN' || State.status === 'OFFLINE' ? 'UNVERIFIED (OFFLINE)' : 'NONE (ALL CLEAR)');
    renderVisualRoute(State.safeRoute);

    if (State.status === 'UNKNOWN' || State.status === 'OFFLINE') {
      DOM.guideHeadline.textContent = `TELEMETRY SIGNAL LOST`;
      DOM.guideSubtext.textContent = `Sensor nodes are offline (>10s). Do not enter unmonitored shafts without portable detection equipment.`;
    } else if (State.status === 'EVACUATE') {
      DOM.guideHeadline.textContent = `EMERGENCY EXTRACTION IN PROGRESS: EVACUATE ZONE ${State.zone}`;
      DOM.guideSubtext.textContent = `Follow the illuminated beacon track. Bypass contaminated zones. Route: ${State.safeRoute}.`;
    } else if (State.status === 'WARNING') {
      DOM.guideHeadline.textContent = `PRE-EVACUATION ADVISORY`;
      DOM.guideSubtext.textContent = `Environmental parameters in Zone ${State.zone} deviate from nominal. Keep gas respirators at hand.`;
    } else {
      DOM.guideHeadline.textContent = `NORMAL CORRIDORS CLEAR`;
      DOM.guideSubtext.textContent = `All extraction pathways and tunnel shafts are clear. Proceed along standard lighted corridors.`;
    }

    // 8. Section 2: Sensor Monitoring Cards
    DOM.valMq4.textContent = Math.round(State.methane);
    updateSensorPill(DOM.pillMq4, DOM.cardMq4, State.methane, THRESHOLDS.methane.warn, THRESHOLDS.methane.danger);

    DOM.valMq7.textContent = Math.round(State.co);
    updateSensorPill(DOM.pillMq7, DOM.cardMq7, State.co, THRESHOLDS.co.warn, THRESHOLDS.co.danger);

    DOM.valMq135.textContent = Math.round(State.toxic);
    updateSensorPill(DOM.pillMq135, DOM.cardMq135, State.toxic, THRESHOLDS.toxic.warn, THRESHOLDS.toxic.danger);

    if (State.temp !== null && !isNaN(State.temp)) {
      DOM.valTemp.textContent = Number(State.temp).toFixed(1);
      updateSensorPill(DOM.pillTemp, DOM.cardTemp, State.temp, THRESHOLDS.temp.warn, THRESHOLDS.temp.danger);
    } else {
      DOM.valTemp.textContent = '--';
      DOM.pillTemp.textContent = 'FAULT';
      DOM.pillTemp.className = 'sensor-status-pill status-warn';
      DOM.cardTemp.className = 'sensor-card card-warn';
    }

    if (State.humidity !== null && !isNaN(State.humidity)) {
      DOM.valHum.textContent = Math.round(State.humidity);
      const humBad = State.humidity < THRESHOLDS.hum.lowWarn || State.humidity > THRESHOLDS.hum.highWarn;
      DOM.pillHum.textContent = humBad ? 'ELEVATED' : 'NORMAL';
      DOM.pillHum.className = `sensor-status-pill ${humBad ? 'status-warn' : 'status-normal'}`;
    } else {
      DOM.valHum.textContent = '--';
      DOM.pillHum.textContent = 'FAULT';
      DOM.pillHum.className = 'sensor-status-pill status-warn';
    }

    // 9. Section 3: Authoritative Risk Analysis
    const riskScore = Math.round(State.serverRiskScore);
    DOM.overallRiskPercent.textContent = `${riskScore}%`;
    const circumference = 301.6;
    const offset = circumference - (riskScore / 100) * circumference;
    DOM.overallRadialFill.style.strokeDashoffset = offset;

    if (State.status === 'EVACUATE') {
      DOM.riskCompositeTag.textContent = 'RISK LEVEL: SEVERE (IV)';
      DOM.riskCompositeTag.style.color = 'var(--danger-red)';
      DOM.overallRiskDesc.textContent = 'CRITICAL ATMOSPHERE';
      DOM.overallRadialFill.style.stroke = 'var(--danger-red)';
    } else if (State.status === 'WARNING') {
      DOM.riskCompositeTag.textContent = 'RISK LEVEL: ELEVATED (II)';
      DOM.riskCompositeTag.style.color = 'var(--warn-yellow)';
      DOM.overallRiskDesc.textContent = 'ABNORMAL CONDITIONS';
      DOM.overallRadialFill.style.stroke = 'var(--warn-yellow)';
    } else if (State.status === 'UNKNOWN' || State.status === 'OFFLINE') {
      DOM.riskCompositeTag.textContent = 'RISK LEVEL: UNVERIFIED';
      DOM.riskCompositeTag.style.color = '#ff9100';
      DOM.overallRiskDesc.textContent = 'OFFLINE SIGNAL';
      DOM.overallRadialFill.style.stroke = '#ff9100';
    } else {
      DOM.riskCompositeTag.textContent = 'RISK LEVEL: NOMINAL (I)';
      DOM.riskCompositeTag.style.color = 'var(--safe-green)';
      DOM.overallRiskDesc.textContent = 'MINIMAL HAZARD';
      DOM.overallRadialFill.style.stroke = 'var(--safe-green)';
    }

    // Component Risk Ratios
    const comp = State.riskComponents || {};
    const riskCh4 = comp.methane !== undefined ? comp.methane : Math.min(100, Math.round((State.methane / THRESHOLDS.methane.danger) * 100));
    const riskCo = comp.co !== undefined ? comp.co : Math.min(100, Math.round((State.co / THRESHOLDS.co.danger) * 100));
    const riskToxic = comp.toxic !== undefined ? comp.toxic : Math.min(100, Math.round((State.toxic / THRESHOLDS.toxic.danger) * 100));
    const riskTemp = comp.temp !== undefined ? comp.temp : (State.temp ? Math.min(100, Math.round(Math.max(0, (State.temp - 20) / (THRESHOLDS.temp.danger - 20) * 100))) : 0);

    updateProgressBar(DOM.barRiskCh4, DOM.riskScoreCh4, riskCh4);
    updateProgressBar(DOM.barRiskCo, DOM.riskScoreCo, riskCo);
    updateProgressBar(DOM.barRiskAqi, DOM.riskScoreAqi, riskToxic);
    updateProgressBar(DOM.barRiskTemp, DOM.riskScoreTemp, riskTemp);

    // 10. Map, Workers, Emergency Response, Actuators & Device Status
    updateTunnelMap(State.status, State.dangerZone, State.contaminatedZones);
    updateWorkersTable(State.status, State.zone);
    updateEmergencyResponse(State.status, State.dangerZone);
    updateHardwareActuators(State.status, State.fan_on);
    updateEsp32Card();
  }

  function updateEsp32Card() {
    if (DOM.esp32LiveBadge) {
      DOM.esp32LiveBadge.className = `status-pill ${State.esp32Online ? 'status-safe' : 'status-danger'}`;
      DOM.esp32LiveBadge.textContent = State.esp32Online ? '🟢 ONLINE' : '🔴 OFFLINE';
    }
    if (DOM.esp32CardDeviceId) DOM.esp32CardDeviceId.textContent = State.node_id || 'ESP32_M1';
    if (DOM.esp32CardZone) DOM.esp32CardZone.textContent = State.zone || 'M1';
    if (DOM.esp32CardLocation) DOM.esp32CardLocation.textContent = State.location || `Mine Zone ${State.zone}`;
    if (DOM.esp32CardLastSeen) DOM.esp32CardLastSeen.textContent = State.esp32LastSeenTimestamp || 'No data yet';
    if (DOM.esp32CardLastSeenAgo) {
      DOM.esp32CardLastSeenAgo.textContent = State.esp32Online
        ? (State.esp32LastSeenSec !== null ? `${State.esp32LastSeenSec}s ago` : 'Active stream')
        : 'Waiting for ESP32 telemetry packet (>10s)...';
    }
    if (DOM.esp32CardStatusText) {
      DOM.esp32CardStatusText.textContent = State.esp32Online ? 'ONLINE (STREAMING)' : 'OFFLINE (NO DATA)';
      DOM.esp32CardStatusText.style.color = State.esp32Online ? 'var(--safe-green)' : '#ff9100';
    }
    if (DOM.esp32CardRiskLevel) {
      const risk = (State.esp32RiskLevel || 'UNKNOWN').toUpperCase();
      DOM.esp32CardRiskLevel.textContent = risk;
      DOM.esp32CardRiskLevel.className = `esp-box-val badge-risk-${risk.toLowerCase()}`;
    }
    if (DOM.esp32CardTriggerSensor) {
      const trigger = State.esp32TriggerSensor || 'None (All Nominal)';
      DOM.esp32CardTriggerSensor.textContent = trigger;
      DOM.esp32CardTriggerSensor.style.color = (trigger !== 'None (All Nominal)' && trigger !== 'No Sensor Connected')
        ? 'var(--danger-red)'
        : 'var(--safe-green)';
    }
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

  function updateTunnelMap(status, danger, contaminated) {
    ['M1', 'M2', 'M3'].forEach(z => {
      const g = document.getElementById(`zone-${z.toLowerCase()}`);
      if (g) g.classList.remove('zone-safe', 'zone-warning', 'zone-danger');
    });

    const isEvac = (status === 'EVACUATE' || status === 'EMERGENCY');
    const isWarn = (status === 'WARNING');
    const hazardList = contaminated && contaminated.length > 0 ? contaminated : (danger ? [danger] : []);

    // Zone M1
    if (hazardList.includes('M1')) {
      DOM.zoneBoxM1.classList.add(isEvac ? 'zone-danger' : 'zone-warning');
      DOM.mapStatusM1.textContent = `STATUS: ${isEvac ? 'EVACUATE' : 'WARNING'}`;
      DOM.mapStatusM1.setAttribute('fill', isEvac ? '#ff1744' : '#ffb300');
      DOM.bulbM1.setAttribute('fill', isEvac ? '#ff1744' : '#ffb300');
    } else {
      DOM.zoneBoxM1.classList.add('zone-safe');
      DOM.mapStatusM1.textContent = 'STATUS: SAFE';
      DOM.mapStatusM1.setAttribute('fill', '#00e676');
      DOM.bulbM1.setAttribute('fill', '#00e676');
    }

    // Zone M2
    if (hazardList.includes('M2')) {
      DOM.zoneBoxM2.classList.add(isEvac ? 'zone-danger' : 'zone-warning');
      DOM.mapStatusM2.textContent = `STATUS: ${isEvac ? 'EVACUATE' : 'WARNING'}`;
      DOM.mapStatusM2.setAttribute('fill', isEvac ? '#ff1744' : '#ffb300');
      DOM.bulbM2.setAttribute('fill', isEvac ? '#ff1744' : '#ffb300');
      DOM.hazardPulseM2.classList.remove('hidden');
    } else {
      DOM.zoneBoxM2.classList.add('zone-safe');
      DOM.mapStatusM2.textContent = 'STATUS: SAFE';
      DOM.mapStatusM2.setAttribute('fill', '#00e676');
      DOM.bulbM2.setAttribute('fill', '#00e676');
      DOM.hazardPulseM2.classList.add('hidden');
    }

    // Zone M3
    if (hazardList.includes('M3')) {
      DOM.zoneBoxM3.classList.add(isEvac ? 'zone-danger' : 'zone-warning');
      DOM.mapStatusM3.textContent = `STATUS: ${isEvac ? 'EVACUATE' : 'WARNING'}`;
      DOM.mapStatusM3.setAttribute('fill', isEvac ? '#ff1744' : '#ffb300');
      DOM.bulbM3.setAttribute('fill', isEvac ? '#ff1744' : '#ffb300');
      DOM.hazardPulseM3.classList.remove('hidden');
    } else {
      DOM.zoneBoxM3.classList.add('zone-safe');
      DOM.mapStatusM3.textContent = 'STATUS: SAFE';
      DOM.mapStatusM3.setAttribute('fill', '#00e676');
      DOM.bulbM3.setAttribute('fill', '#00e676');
      DOM.hazardPulseM3.classList.add('hidden');
    }

    if (isEvac) {
      DOM.mapNetworkStatus.textContent = `HAZARD ACTIVE IN ${hazardList.join(', ')} - EVACUATION ROUTE ILLUMINATED`;
      DOM.mapNetworkStatus.style.color = '#ff1744';
    } else if (isWarn) {
      DOM.mapNetworkStatus.textContent = `ANOMALY MONITORED IN ${hazardList.join(', ')}`;
      DOM.mapNetworkStatus.style.color = '#ffb300';
    } else if (status === 'UNKNOWN' || status === 'OFFLINE') {
      DOM.mapNetworkStatus.textContent = 'TELEMETRY OFFLINE - CORRIDORS UNVERIFIED';
      DOM.mapNetworkStatus.style.color = '#ff9100';
    } else {
      DOM.mapNetworkStatus.textContent = 'ALL PATHWAYS FUNCTIONAL';
      DOM.mapNetworkStatus.style.color = '#00e676';
    }
  }

  function updateWorkersTable(status, activeZone) {
    const hazardList = State.contaminatedZones && State.contaminatedZones.length > 0
      ? State.contaminatedZones
      : (State.dangerZone ? [State.dangerZone] : []);

    const isEvac = (status === 'EVACUATE' || status === 'EMERGENCY');
    const isWarn = (status === 'WARNING');

    // Worker 1 (in M1)
    const w1Route = (State.routes && State.routes['M1']) ? State.routes['M1'] : bfsFindRoute('M1', hazardList);
    if (hazardList.includes('M1')) {
      DOM.w1SafetyBadge.textContent = isEvac ? 'EVACUATE' : 'WARNING';
      DOM.w1SafetyBadge.className = `status-pill ${isEvac ? 'status-danger' : 'status-warning'}`;
      DOM.w1EvacBadge.textContent = `ROUTE: ${w1Route}`;
      DOM.w1EvacBadge.className = 'evac-pill evac-moving';
    } else {
      DOM.w1SafetyBadge.textContent = 'SAFE';
      DOM.w1SafetyBadge.className = 'status-pill status-safe';
      DOM.w1EvacBadge.textContent = 'STATIONARY / WORKING';
      DOM.w1EvacBadge.className = 'evac-pill evac-normal';
    }

    // Worker 2 (in M2)
    const w2Route = (State.routes && State.routes['M2']) ? State.routes['M2'] : bfsFindRoute('M2', hazardList);
    if (hazardList.includes('M2')) {
      DOM.w2SafetyBadge.textContent = isEvac ? 'EVACUATE' : 'WARNING';
      DOM.w2SafetyBadge.className = `status-pill ${isEvac ? 'status-danger' : 'status-warning'}`;
      DOM.w2EvacBadge.textContent = `ROUTE: ${w2Route}`;
      DOM.w2EvacBadge.className = 'evac-pill evac-moving';
      if (DOM.pinBgW2) DOM.pinBgW2.setAttribute('stroke', isEvac ? '#ff1744' : '#ffb300');
    } else {
      DOM.w2SafetyBadge.textContent = 'SAFE';
      DOM.w2SafetyBadge.className = 'status-pill status-safe';
      DOM.w2EvacBadge.textContent = 'STATIONARY / WORKING';
      DOM.w2EvacBadge.className = 'evac-pill evac-normal';
      if (DOM.pinBgW2) DOM.pinBgW2.setAttribute('stroke', '#00e676');
    }

    // Worker 3 (in M3)
    const w3Route = (State.routes && State.routes['M3']) ? State.routes['M3'] : bfsFindRoute('M3', hazardList);
    if (hazardList.includes('M3')) {
      DOM.w3SafetyBadge.textContent = isEvac ? 'EVACUATE' : 'WARNING';
      DOM.w3SafetyBadge.className = `status-pill ${isEvac ? 'status-danger' : 'status-warning'}`;
      DOM.w3EvacBadge.textContent = `ROUTE: ${w3Route}`;
      DOM.w3EvacBadge.className = 'evac-pill evac-moving';
    } else {
      DOM.w3SafetyBadge.textContent = 'SAFE';
      DOM.w3SafetyBadge.className = 'status-pill status-safe';
      DOM.w3EvacBadge.textContent = 'STATIONARY / WORKING';
      DOM.w3EvacBadge.className = 'evac-pill evac-normal';
    }
  }

  function updateEmergencyResponse(status, dangerZone) {
    if (status === 'EVACUATE' || status === 'EMERGENCY') {
      DOM.respStatePill.textContent = '🚨 CODE RED: DISPATCHED';
      DOM.respStatePill.className = 'resp-state-pill active-alarm';

      DOM.rcStatusCr.textContent = 'ALERT SENT (LIVE)';
      DOM.rcControlRoom.className = 'resp-card dispatched';

      DOM.rcStatusRescue.textContent = 'SMS ALERT SENT [SIMULATED]';
      DOM.rcRescue.className = 'resp-card dispatched';

      DOM.rcStatusAmbulance.textContent = 'SMS ALERT SENT [SIMULATED]';
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

      DOM.rcStatusBuzzer.textContent = 'ACTIVE (2 PULSES)';
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

      DOM.rcStatusBuzzer.textContent = 'NORMAL CADENCE (OFF)';
      DOM.rcBuzzer.className = 'resp-card';

      DOM.rcStatusTargetZone.textContent = 'NONE (ALL CLEAR)';
      DOM.rcStatusTargetZone.style.color = 'var(--neon-cyan)';
    }
  }

  function updateHardwareActuators(status, fanOn) {
    DOM.ledGreenBulb.classList.remove('active');
    DOM.ledYellowBulb.classList.remove('active');
    DOM.ledRedBulb.classList.remove('active');

    if (status === 'SAFE') {
      DOM.ledGreenBulb.classList.add('active');
      DOM.ledGreenText.textContent = 'SAFE (ACTIVE)';
      DOM.ledYellowText.textContent = 'WARNING (OFF)';
      DOM.ledRedText.textContent = 'EVACUATE (OFF)';
    } else if (status === 'WARNING') {
      DOM.ledYellowBulb.classList.add('active');
      DOM.ledGreenText.textContent = 'SAFE (OFF)';
      DOM.ledYellowText.textContent = 'WARNING (ACTIVE)';
      DOM.ledRedText.textContent = 'EVACUATE (OFF)';
    } else if (status === 'EVACUATE' || status === 'EMERGENCY') {
      DOM.ledRedBulb.classList.add('active');
      DOM.ledGreenText.textContent = 'SAFE (OFF)';
      DOM.ledYellowText.textContent = 'WARNING (OFF)';
      DOM.ledRedText.textContent = 'EVACUATE (ACTIVE)';
    } else {
      // SENSOR_FAULT / OFFLINE / UNKNOWN
      DOM.ledGreenText.textContent = 'SAFE (OFF)';
      DOM.ledYellowText.textContent = 'WARNING (OFF)';
      DOM.ledRedText.textContent = 'EVACUATE (OFF)';
    }

    DOM.badgeCad1.className = 'badge-cadence';
    DOM.badgeCad2.className = 'badge-cadence';
    DOM.badgeCad3.className = 'badge-cadence';
    DOM.buzzerWaveRing.classList.remove('buzzing');

    if (status === 'SAFE') {
      DOM.buzzerCadenceLabel.textContent = 'AUDIO SILENT (SAFE)';
      DOM.buzzerCadenceDesc.textContent = 'System normal. Periodic chirp stopped per ergonomic safety guidelines.';
      DOM.badgeCad1.className = 'badge-cadence active';
    } else if (status === 'WARNING') {
      DOM.buzzerCadenceLabel.textContent = '2 ALERT PULSES (WARNING)';
      DOM.buzzerCadenceDesc.textContent = 'Double beep cadence active. Environmental anomaly requires personnel alertness.';
      DOM.badgeCad2.className = 'badge-cadence active-warn';
      DOM.buzzerWaveRing.classList.add('buzzing');
    } else if (status === 'EVACUATE' || status === 'EMERGENCY') {
      DOM.buzzerCadenceLabel.textContent = '3 PULSES / CONTINUOUS (EVACUATE)';
      DOM.buzzerCadenceDesc.textContent = 'Continuous high-decibel alarm sounding across mine tunnel sector.';
      DOM.badgeCad3.className = 'badge-cadence active-danger';
      DOM.buzzerWaveRing.classList.add('buzzing');
    } else {
      DOM.buzzerCadenceLabel.textContent = 'AUDIO SILENT (SENSOR OFFLINE)';
      DOM.buzzerCadenceDesc.textContent = 'Telemetry feed silent. Microcontroller operates local fallback buzzer.';
    }

    if (fanOn || status === 'EVACUATE' || status === 'WARNING') {
      DOM.fanStateTitle.textContent = 'VENTILATION: EMERGENCY PURGE';
      DOM.fanDutyCycle.textContent = 'Status: Forced 100% Full Spool';
      DOM.fanDutyCycle.style.color = '#ff1744';
      DOM.fanSvg.classList.add('fast');
    } else {
      DOM.fanStateTitle.textContent = 'VENTILATION: NORMAL';
      DOM.fanDutyCycle.textContent = 'Status: Baseline 40% RPM';
      DOM.fanDutyCycle.style.color = 'var(--safe-green)';
      DOM.fanSvg.classList.remove('fast');
    }
  }

  // ==========================================================================
  // 6. REAL-TIME TELEMETRY POLLING & FAIL-SAFE ENGINE
  // ==========================================================================
  let isPolling = false;
  let lastLoggedTrigger = null;

  async function pollEsp32Data() {
    if (!State.pollingEnabled || isPolling) return;
    isPolling = true;

    const url = State.apiEndpoint || '/api/esp32/data';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s fetch timeout

    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      State.esp32Online = Boolean(data.online);
      State.activeNodesCount = data.active_nodes_count || (data.online ? 1 : 0);
      State.nodes = data.nodes || {};

      if (data.online) {
        State.mode = 'LIVE';
        State.node_id = data.node_id || 'ESP32_M1';
        State.zone = data.zone || 'M1';
        State.location = data.location || `Mine Zone ${State.zone}`;

        // Ingest Data Contract fields from server authority
        State.methane = Number(data.methane !== null && data.methane !== undefined ? data.methane : 0);
        State.co = Number(data.co !== null && data.co !== undefined ? data.co : 0);
        State.toxic = Number(data.toxic !== null && data.toxic !== undefined ? data.toxic : 0);
        State.temp = data.temp !== null && data.temp !== undefined ? Number(data.temp) : null;
        State.humidity = data.humidity !== null && data.humidity !== undefined ? Number(data.humidity) : null;
        State.alarm_level = String(data.alarm_level || data.status || 'SAFE').toUpperCase();
        State.fan_on = Boolean(data.fan_on);
        State.uptime = Number(data.uptime || 0);

        // Server-Authoritative Status & Risk Score (NEVER recomputed by client)
        State.serverRiskScore = Number(data.risk_score || 0);
        State.esp32RiskLevel = data.risk_level || 'LOW';
        State.status = data.status || 'SAFE';
        State.safeRoute = data.safeRoute || 'M1 ➔ MAIN EXIT';
        State.routes = data.routes || {};
        State.zones = data.zones || {};
        State.contaminatedZones = data.contaminated_zones || data.hazard_zones || [];
        State.esp32TriggerSensor = data.trigger_sensor || 'None (All Nominal)';
        State.esp32LastSeenSec = data.last_seen_seconds_ago !== undefined ? data.last_seen_seconds_ago : 0;
        State.esp32LastSeenTimestamp = data.last_seen_timestamp || 'Active';
        State.riskComponents = data.risk_components || {};

        // Find primary danger zone from contaminated list
        State.dangerZone = State.contaminatedZones.length > 0 ? State.contaminatedZones[0] : null;

        // Trigger notifications
        if (data.trigger_sensor && data.trigger_sensor !== 'None (All Nominal)' && data.trigger_sensor !== lastLoggedTrigger) {
          lastLoggedTrigger = data.trigger_sensor;
          addAlertItem(data.status === 'EVACUATE' ? 'red' : 'yellow',
                       `ALERT: ${data.trigger_sensor}`,
                       `Zone ${State.zone} threshold breached. Dispatched via ${State.node_id}.`);
        } else if (data.trigger_sensor === 'None (All Nominal)' && lastLoggedTrigger !== null) {
          lastLoggedTrigger = null;
        }

        // Push sparkline points ONLY when last_seen timestamp advances
        if (data.last_seen_timestamp && data.last_seen_timestamp !== State.lastPushedTimestamp) {
          State.lastPushedTimestamp = data.last_seen_timestamp;
          const pushHist = (arr, val) => {
            arr.push(val);
            if (arr.length > 10) arr.shift();
          };
          pushHist(State.history.mq4, State.methane);
          pushHist(State.history.mq7, State.co);
          pushHist(State.history.toxic, State.toxic);
          if (State.temp !== null) pushHist(State.history.temp, State.temp);
          if (State.humidity !== null) pushHist(State.history.hum, State.humidity);
        }

        updateSparklines();

        DOM.sysStatusDot.className = 'indicator-dot online';
        DOM.sysStatusText.textContent = 'ONLINE (LIVE)';
      } else {
        // FAIL-SAFE: NODE IS OFFLINE (>10s)
        State.esp32Online = false;
        State.status = 'UNKNOWN'; // Never show SAFE
        State.safeRoute = 'NO DATA - SENSOR OFFLINE';
        State.esp32LastSeenSec = data.last_seen_seconds_ago || 15;
        State.esp32LastSeenTimestamp = data.last_seen_timestamp || 'No recent signal';
        State.esp32TriggerSensor = 'NO DATA - SENSOR OFFLINE';

        DOM.sysStatusDot.className = 'indicator-dot offline';
        DOM.sysStatusText.textContent = 'OFFLINE (>10s)';
      }

      renderUI();
    } catch (err) {
      clearTimeout(timeoutId);
      console.warn('Telemetry poll error:', err.message);
      // FAIL-SAFE: On fetch failure or timeout, grey out and show UNKNOWN
      State.esp32Online = false;
      State.status = 'UNKNOWN'; // Never show SAFE
      State.safeRoute = 'NO DATA - SENSOR OFFLINE';
      State.esp32TriggerSensor = 'NO DATA - SENSOR OFFLINE';
      DOM.sysStatusDot.className = 'indicator-dot offline';
      DOM.sysStatusText.textContent = 'CONNECTION ERROR';
      renderUI();
    } finally {
      isPolling = false;
    }
  }

  // Fetch recent history from SQLite database (Safe DOM construction, zero innerHTML)
  async function fetchSensorHistory() {
    const url = State.historyEndpoint || '/api/esp32/history';
    try {
      const resp = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data.history || !DOM.historyTbody) return;

      DOM.historyTbody.replaceChildren();

      if (data.history.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 10;
        td.style.textAlign = 'center';
        td.style.color = 'var(--text-subtle)';
        td.style.padding = '18px';
        td.textContent = 'Waiting for live telemetry packets...';
        tr.appendChild(td);
        DOM.historyTbody.appendChild(tr);
        if (DOM.historyCountLabel) DOM.historyCountLabel.textContent = '0 READINGS';
        return;
      }

      data.history.forEach(item => {
        const tr = document.createElement('tr');
        const st = String(item.status || 'SAFE').toLowerCase();
        const statusClass = `status-pill status-${st === 'emergency' || st === 'evacuate' ? 'danger' : (st === 'warning' ? 'warning' : 'safe')}`;

        const tdTime = document.createElement('td');
        tdTime.className = 'mono';
        tdTime.style.fontSize = '0.76rem';
        tdTime.textContent = String(item.timestamp || '');

        const tdNode = document.createElement('td');
        const spanNode = document.createElement('span');
        spanNode.className = 'worker-tag';
        spanNode.textContent = String(item.node_id || item.device_id || 'ESP32');
        tdNode.appendChild(spanNode);

        const tdZone = document.createElement('td');
        const spanZone = document.createElement('span');
        spanZone.className = 'zone-pill pill-cyan';
        spanZone.textContent = String(item.zone || 'M1');
        tdZone.appendChild(spanZone);

        const tdMq4 = document.createElement('td');
        tdMq4.className = 'mono font-bold';
        tdMq4.textContent = `${Math.round(item.methane || item.mq4 || 0)} ppm`;

        const tdMq7 = document.createElement('td');
        tdMq7.className = 'mono font-bold';
        tdMq7.textContent = `${Math.round(item.co || item.mq7 || 0)} ppm`;

        const tdMq135 = document.createElement('td');
        tdMq135.className = 'mono font-bold';
        tdMq135.textContent = `${Math.round(item.toxic || item.mq135 || 0)} ppm`;

        const tdTemp = document.createElement('td');
        tdTemp.className = 'mono';
        tdTemp.textContent = item.temp !== null && item.temp !== undefined ? `${Number(item.temp).toFixed(1)} °C` : 'FAULT';

        const tdHum = document.createElement('td');
        tdHum.className = 'mono';
        tdHum.textContent = item.humidity !== null && item.humidity !== undefined ? `${Math.round(item.humidity)} %` : 'FAULT';

        const tdRisk = document.createElement('td');
        tdRisk.className = 'mono font-bold';
        tdRisk.textContent = `${Math.round(item.risk_score || 0)}%`;

        const tdStatus = document.createElement('td');
        const spanStatus = document.createElement('span');
        spanStatus.className = statusClass;
        spanStatus.textContent = String(item.status || 'SAFE');
        tdStatus.appendChild(spanStatus);

        tr.appendChild(tdTime);
        tr.appendChild(tdNode);
        tr.appendChild(tdZone);
        tr.appendChild(tdMq4);
        tr.appendChild(tdMq7);
        tr.appendChild(tdMq135);
        tr.appendChild(tdTemp);
        tr.appendChild(tdHum);
        tr.appendChild(tdRisk);
        tr.appendChild(tdStatus);

        DOM.historyTbody.appendChild(tr);
      });

      if (DOM.historyCountLabel) {
        DOM.historyCountLabel.textContent = `${data.history.length} READINGS`;
      }
    } catch (err) {
      console.warn('History fetch error:', err.message);
    }
  }

  // ==========================================================================
  // 7. EVENT LISTENERS & DRAWER CONTROLS
  // ==========================================================================
  function setupEventListeners() {
    // 1. Browser Autoplay Audio Unlock
    if (DOM.btnUnlockAudio) {
      DOM.btnUnlockAudio.addEventListener('click', () => {
        initAudio();
        State.audioContextUnlocked = true;
        State.soundMuted = false;
        playBuzzerTone(900, 0.12, 'sine');
        DOM.btnUnlockAudio.classList.add('audio-unlocked');
        DOM.audioUnlockLabel.textContent = 'Sound Enabled';
        DOM.soundIconOn.classList.remove('hidden');
        DOM.soundIconOff.classList.add('hidden');
        DOM.btnToggleSound.classList.remove('muted');
        addAlertItem('green', 'AUDIO SUBSYSTEM UNLOCKED', 'Web Audio API initialized with browser autoplay approval.');
      });
    }

    // 2. Tab Navigation
    DOM.tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-tab');
        if (!targetTab) return;

        DOM.tabBtns.forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');

        Object.keys(DOM.tabPanels).forEach(key => {
          const panel = DOM.tabPanels[key];
          if (panel) {
            if (key === targetTab) {
              panel.classList.remove('hidden');
            } else {
              panel.classList.add('hidden');
            }
          }
        });

        State.activeTab = targetTab;
      });
    });

    // 3. Persona Switcher
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

    // 4. Sound Siren Mute Toggle
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

    // 5. Silence Button: 2-Minute Snooze that re-arms on escalation
    if (DOM.btnSilenceAlarm) {
      DOM.btnSilenceAlarm.addEventListener('click', () => {
        State.silenceUntil = Date.now() + 120000; // 2 minutes
        State.soundMuted = true;
        DOM.soundIconOn.classList.add('hidden');
        DOM.soundIconOff.classList.remove('hidden');
        DOM.btnToggleSound.classList.add('muted');
        DOM.btnSilenceAlarm.textContent = 'Snoozed (2m)';
        if (window.speechSynthesis) window.speechSynthesis.cancel();
        addAlertItem('yellow', 'AUDIBLE ALARM SNOOZED', 'Siren snoozed for 2 minutes. Will re-arm immediately if hazard level escalates.');
      });
    }

    // 6. Manual Overrides
    DOM.btnManualEvac.addEventListener('click', () => {
      State.mode = 'DEMO';
      State.methane = 3200;
      State.co = 350;
      State.zone = 'M2';
      State.status = 'EVACUATE';
      State.dangerZone = 'M2';
      State.contaminatedZones = ['M2'];
      State.safeRoute = bfsFindRoute(State.zone, ['M2']);
      renderUI();
    });

    DOM.btnResetNormal.addEventListener('click', () => {
      State.mode = 'DEMO';
      State.methane = 420;
      State.co = 18;
      State.toxic = 110;
      State.temp = 27.4;
      State.humidity = 58;
      State.zone = 'M1';
      State.status = 'SAFE';
      State.dangerZone = null;
      State.contaminatedZones = [];
      State.safeRoute = bfsFindRoute('M1', []);
      renderUI();
    });

    // 7. Developer Drawer Controls
    const openDevDrawer = () => {
      syncSlidersToState();
      DOM.devDrawerPanel.classList.add('open');
      DOM.devDrawerBackdrop.classList.add('open');
    };

    const closeDevDrawer = () => {
      DOM.devDrawerPanel.classList.remove('open');
      DOM.devDrawerBackdrop.classList.remove('open');
    };

    if (DOM.btnToggleDevDrawer) DOM.btnToggleDevDrawer.addEventListener('click', openDevDrawer);
    if (DOM.btnCloseDevDrawer) DOM.btnCloseDevDrawer.addEventListener('click', closeDevDrawer);
    if (DOM.devDrawerBackdrop) DOM.devDrawerBackdrop.addEventListener('click', closeDevDrawer);

    // 8. Demo Preset Scenarios (Clearly labeled DEMO mode)
    const applyPreset = (presetName, m, c, tox, t, h, z, status) => {
      State.mode = 'DEMO';
      State.methane = m;
      State.co = c;
      State.toxic = tox;
      State.temp = t;
      State.humidity = h;
      State.zone = z;
      State.location = `Mine Zone ${z}`;
      State.status = status;
      State.dangerZone = (status === 'EVACUATE' || status === 'WARNING') ? z : null;
      State.contaminatedZones = State.dangerZone ? [State.dangerZone] : [];
      State.safeRoute = bfsFindRoute(z, State.contaminatedZones);
      syncSlidersToState();
      renderUI();
      closeDevDrawer();
      addAlertItem(status === 'EVACUATE' ? 'red' : (status === 'WARNING' ? 'yellow' : 'green'),
                   `DEMO SCENARIO: ${presetName}`, `Simulated laboratory preset applied.`);
    };

    DOM.scenNormal.addEventListener('click', () => applyPreset('NORMAL / SAFE', 420, 18, 110, 27.4, 58, 'M1', 'SAFE'));
    DOM.scenWarning.addEventListener('click', () => applyPreset('WARNING CONDITION', 1800, 65, 450, 38.0, 65, 'M2', 'WARNING'));
    DOM.scenEmergency.addEventListener('click', () => applyPreset('CRITICAL METHANE LEAK', 2900, 95, 920, 39.5, 70, 'M2', 'EVACUATE'));
    DOM.scenToxic.addEventListener('click', () => applyPreset('TOXIC CO EMERGENCY', 650, 350, 1450, 47.0, 82, 'M3', 'EVACUATE'));

    // 9. Sliders Synchronizer
    function syncSlidersToState() {
      DOM.inputMq4.value = Math.round(State.methane);
      DOM.valSliderMq4.textContent = Math.round(State.methane);

      DOM.inputMq7.value = Math.round(State.co);
      DOM.valSliderMq7.textContent = Math.round(State.co);

      DOM.inputMq135.value = Math.round(State.toxic);
      DOM.valSliderMq135.textContent = Math.round(State.toxic);

      DOM.inputTemp.value = State.temp ? Number(State.temp).toFixed(1) : 25;
      DOM.valSliderTemp.textContent = State.temp ? Number(State.temp).toFixed(1) : 25;

      DOM.inputHum.value = State.humidity ? Math.round(State.humidity) : 50;
      DOM.valSliderHum.textContent = State.humidity ? Math.round(State.humidity) : 50;

      DOM.selectActiveZone.value = State.zone;
    }

    DOM.inputMq4.addEventListener('input', (e) => DOM.valSliderMq4.textContent = e.target.value);
    DOM.inputMq7.addEventListener('input', (e) => DOM.valSliderMq7.textContent = e.target.value);
    DOM.inputMq135.addEventListener('input', (e) => DOM.valSliderMq135.textContent = e.target.value);
    DOM.inputTemp.addEventListener('input', (e) => DOM.valSliderTemp.textContent = e.target.value);
    DOM.inputHum.addEventListener('input', (e) => DOM.valSliderHum.textContent = e.target.value);

    DOM.btnApplySliders.addEventListener('click', () => {
      State.mode = 'DEMO';
      State.methane = Number(DOM.inputMq4.value);
      State.co = Number(DOM.inputMq7.value);
      State.toxic = Number(DOM.inputMq135.value);
      State.temp = Number(DOM.inputTemp.value);
      State.humidity = Number(DOM.inputHum.value);
      State.zone = DOM.selectActiveZone.value;
      State.location = `Mine Zone ${State.zone}`;

      // Local demo evaluation
      let st = 'SAFE';
      if (State.methane >= THRESHOLDS.methane.danger || State.co >= THRESHOLDS.co.danger ||
          State.toxic >= THRESHOLDS.toxic.danger || State.temp >= THRESHOLDS.temp.danger) {
        st = 'EVACUATE';
      } else if (State.methane >= THRESHOLDS.methane.warn || State.co >= THRESHOLDS.co.warn ||
                 State.toxic >= THRESHOLDS.toxic.warn || State.temp >= THRESHOLDS.temp.warn) {
        st = 'WARNING';
      }
      State.status = st;
      State.dangerZone = st !== 'SAFE' ? State.zone : null;
      State.contaminatedZones = State.dangerZone ? [State.dangerZone] : [];
      State.safeRoute = bfsFindRoute(State.zone, State.contaminatedZones);
      renderUI();
      closeDevDrawer();
    });

    // 10. Polling Toggles
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

    // 11. Map Zone Filter Buttons
    document.querySelectorAll('.btn-zone-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.btn-zone-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const selZone = btn.getAttribute('data-zone-select');
        if (selZone) {
          State.zone = selZone;
          State.location = `Mine Zone ${selZone}`;
          // Update route for selected zone
          if (State.routes && State.routes[selZone]) {
            State.safeRoute = State.routes[selZone];
          } else {
            State.safeRoute = bfsFindRoute(selZone, State.contaminatedZones);
          }
          renderUI();
        }
      });
    });

    // 12. Clear Alerts
    DOM.btnClearAlerts.addEventListener('click', () => {
      State.alerts = [];
      renderAlerts();
    });

    // 13. Open Source Modal & JSON Export
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
          project: "Smart Mine Safety Control Center",
          license: "MIT License",
          timestamp: new Date().toISOString(),
          version: "3.0.0",
          disclaimer: "Educational prototype. Demo values only. Not intrinsically-safe certified equipment."
        },
        telemetry: {
          node_id: State.node_id,
          zone: State.zone,
          location: State.location,
          methane_ppm: Math.round(State.methane),
          co_ppm: Math.round(State.co),
          toxic_ppm: Math.round(State.toxic),
          temp_c: State.temp !== null ? Number(State.temp.toFixed(1)) : null,
          humidity_percent: State.humidity !== null ? Math.round(State.humidity) : null,
          status: State.status,
          dangerZone: State.dangerZone,
          safeRoute: State.safeRoute,
          risk_score: State.serverRiskScore
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
  // 8. PROTOCOL DETECTION (file:// Detection)
  // ==========================================================================
  function checkProtocol() {
    if (window.location.protocol === 'file:') {
      const banner = document.createElement('div');
      banner.id = 'file-protocol-warning';
      banner.className = 'file-protocol-warning';
      banner.style.cssText = 'background: #b91c1c; color: #fff; padding: 14px 20px; font-weight: 700; text-align: center; border-bottom: 2px solid #ef4444; z-index: 999999; font-size: 0.95rem; line-height: 1.4;';
      banner.textContent = '⚠️ OPEN VIA SERVER: Dashboard is currently loaded via file:// protocol. Local browser security blocks REST API requests. Please run "python esp32_mock_server.py 5000" and navigate to http://localhost:5000/ to access live telemetry and avoid offline fail-safe.';
      document.body.prepend(banner);
    }
  }

  // ==========================================================================
  // 9. INITIALIZATION & TIMERS
  // ==========================================================================
  function init() {
    checkProtocol();
    setupEventListeners();
    renderAlerts();
    renderUI();

    // Default to LIVE mode: Immediate fetch
    pollEsp32Data();
    fetchSensorHistory();

    // High-frequency polling (every 2.0 seconds) to match firmware transmission rate
    setInterval(() => {
      pollEsp32Data();
    }, 2000);

    // Heartbeat second-counter for update age and snooze countdown
    setInterval(() => {
      if (State.esp32LastSeenSec !== null && State.esp32Online) {
        State.esp32LastSeenSec += 1;
        if (State.esp32LastSeenSec > 10 && State.mode !== 'DEMO') {
          // Exceeded fail-safe 10s offline threshold!
          State.esp32Online = false;
          State.status = 'UNKNOWN'; // Never show SAFE
          State.safeRoute = 'NO DATA - SENSOR OFFLINE';
        }
        renderUI();
      }

      // Snooze timer countdown check
      if (State.silenceUntil > 0) {
        if (Date.now() >= State.silenceUntil) {
          State.silenceUntil = 0;
          if (DOM.btnSilenceAlarm) DOM.btnSilenceAlarm.textContent = 'Silence Siren';
          // Re-arm sound if still hazardous
          if (State.audioContextUnlocked && (State.status === 'WARNING' || State.status === 'EVACUATE')) {
            State.soundMuted = false;
            if (DOM.soundIconOn) DOM.soundIconOn.classList.remove('hidden');
            if (DOM.soundIconOff) DOM.soundIconOff.classList.add('hidden');
            if (DOM.btnToggleSound) DOM.btnToggleSound.classList.remove('muted');
          }
        }
      }
    }, 1000);

    // History refresh from SQLite (every 5 seconds)
    setInterval(() => {
      if (State.pollingEnabled) {
        fetchSensorHistory();
      }
    }, 5000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
