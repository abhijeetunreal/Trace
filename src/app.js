/********************************************************************
 * TRACE // PRECISION GPS BLACKBOX — HYBRID RUST / TAURI ENGINE
 * Bridges frontend telemetry to Rust backend with graceful web fallback.
 ********************************************************************/

const STORAGE_KEY = 'trace_gps_sessions_v2';
const THEME_KEY = 'trace_gps_theme';

// Detect Tauri bridge
const hasTauri = () => typeof window !== 'undefined' && (Boolean(window.__TAURI__) || Boolean(window.__TAURI_INTERNALS__));

async function invokeTauri(command, args = {}) {
    if (hasTauri()) {
        try {
            if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function') {
                return await window.__TAURI__.core.invoke(command, args);
            }
            if (typeof window.__TAURI_INTERNALS__?.invoke === 'function') {
                return await window.__TAURI_INTERNALS__.invoke(command, args);
            }
        } catch (err) {
            console.warn(`[Tauri Invoke Error] ${command}:`, err);
        }
    }
    return null;
}

// Runtime State
let sourceMode = 'gps'; // 'gps' | 'sim'
let isRecording = false;
let watchId = null;
let simTimer = null;
let clockTimer = null;
let startTime = 0;

// Background Keep-Alive Handles
let wakeLockSentinel = null;
let audioCtx = null;
let silentOsc = null;

let activeSession = null;
let savedSessions = [];
let expandedSessionId = null;

// Map & Playback State
let activeMap = null;
let activeTileLayer = null;
let activePolylineLayers = [];
let activeScrubMarker = null;
let playbackInterval = null;
let currentScrubIdx = 0;
let currentColorMode = 'speed'; // 'speed' | 'alt'
let followMarkerOnPlay = true;

// Share Sheet State
let shareSessionId = null;
let selectedShareFormat = 'gpx';

window.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    await loadInitialSessions();

    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible' && isRecording) {
            await requestWakeLock();
        }
    });

    // Check Tauri engine info
    invokeTauri('cmd_get_app_info').then(info => {
        if (info) {
            console.log(`[Trace] Connected to ${info.engine} v${info.version}`);
        }
    });
});

/********************************************************************
 * CUPERTINO LIGHT / DARK APPEARANCE ENGINE
 ********************************************************************/
function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light') {
        document.documentElement.classList.remove('dark');
    } else {
        document.documentElement.classList.add('dark');
    }
}

function toggleTheme() {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light');
    updateMapTilesForTheme();
    const session = savedSessions.find(s => s.id === expandedSessionId);
    if (session) drawInlineSparkline(session, currentScrubIdx);
}

function getOpenFreeMapStyle() {
    const isDark = document.documentElement.classList.contains('dark');
    return isDark
        ? 'https://tiles.openfreemap.org/styles/dark'
        : 'https://tiles.openfreemap.org/styles/positron';
}

function createOpenFreeMapLayer() {
    if (typeof L.maplibreGL === 'function') {
        try {
            return L.maplibreGL({
                style: getOpenFreeMapStyle(),
                attribution: false
            });
        } catch (e) {
            console.warn('MapLibre GL initialization error, falling back to raster tiles:', e);
        }
    }
    return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19
    });
}

function updateMapTilesForTheme() {
    if (!activeMap || !activeTileLayer) return;
    if (typeof activeTileLayer.getMaplibreMap === 'function') {
        const glMap = activeTileLayer.getMaplibreMap();
        if (glMap) {
            glMap.setStyle(getOpenFreeMapStyle());
            return;
        }
    }
    activeMap.removeLayer(activeTileLayer);
    activeTileLayer = createOpenFreeMapLayer().addTo(activeMap);
}

/********************************************************************
 * BACKGROUND / SCREEN-OFF KEEP-ALIVE ENGINE
 ********************************************************************/
async function enableBackgroundKeepAlive() {
    await requestWakeLock();
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!audioCtx && AudioContextClass) {
            audioCtx = new AudioContextClass();
        }
        if (audioCtx) {
            if (audioCtx.state === 'suspended') await audioCtx.resume();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(1, audioCtx.currentTime);
            gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            silentOsc = osc;
        }
        const badge = document.getElementById('wakeBadge');
        if (badge) {
            badge.classList.remove('hidden');
            badge.classList.add('inline-flex');
        }
    } catch (e) {}
}

async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            wakeLockSentinel = await navigator.wakeLock.request('screen');
        } catch (err) {}
    }
}

function disableBackgroundKeepAlive() {
    if (wakeLockSentinel) {
        wakeLockSentinel.release().catch(() => {});
        wakeLockSentinel = null;
    }
    if (silentOsc) {
        try { silentOsc.stop(); silentOsc.disconnect(); } catch (e) {}
        silentOsc = null;
    }
    const badge = document.getElementById('wakeBadge');
    if (badge) {
        badge.classList.add('hidden');
        badge.classList.remove('inline-flex');
    }
}

/********************************************************************
 * GPS LOGGING & SIMULATOR ENGINE
 ********************************************************************/
function toggleSourceMode() {
    if (isRecording) {
        showToast('Stop recording before switching source');
        return;
    }
    sourceMode = sourceMode === 'gps' ? 'sim' : 'gps';
    document.getElementById('sourceLabel').textContent = sourceMode === 'gps' ? 'GPS' : 'SIM';
    showToast(sourceMode === 'gps' ? 'Hardware GPS Active' : 'Indoor Route Simulator Active');
}

function createSessionObject(customName) {
    const now = new Date();
    const timeTag = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return {
        id: 'trc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name: customName || `Trace • ${timeTag}`,
        createdAt: now.toISOString(),
        points: [],
        stats: {
            distanceKm: 0,
            maxSpeedKmh: 0,
            avgSpeedKmh: 0,
            elevationGainM: 0,
            minAltM: null,
            maxAltM: null,
            durationMs: 0
        }
    };
}

async function toggleRecording() {
    if (!isRecording) {
        await startRecording();
    } else {
        await stopRecording();
    }
}

async function startRecording() {
    stopPlayback();
    activeSession = createSessionObject();
    isRecording = true;
    startTime = Date.now();

    await enableBackgroundKeepAlive();

    const btn = document.getElementById('masterRecordBtn');
    btn.className = 'w-full mt-5 py-4 rounded-2xl font-semibold text-sm tracking-tight transition-all flex items-center justify-center gap-2.5 bg-ios-red text-white shadow-md shadow-ios-red/25 active:scale-[0.98]';
    document.getElementById('recordDot').className = 'w-2.5 h-2.5 rounded-xs bg-white rec-dot';
    document.getElementById('recordBtnLabel').textContent = 'Stop & Save Trace';
    document.getElementById('statusDot').className = 'w-2.5 h-2.5 rounded-full bg-ios-red rec-dot shadow-[0_0_8px_#FF3B30]';
    document.getElementById('hudStatusText').textContent = sourceMode === 'gps' ? 'Acquiring GPS Signal…' : 'Simulating Telemetry…';

    updateLiveHUD();

    clockTimer = setInterval(() => {
        const elapsed = Date.now() - startTime;
        if (activeSession) activeSession.stats.durationMs = elapsed;
        document.getElementById('liveTimer').textContent = formatDuration(elapsed);
    }, 100);

    if (sourceMode === 'gps') {
        if (!navigator.geolocation) {
            showToast('GPS unavailable — switched to Simulator');
            sourceMode = 'sim';
            document.getElementById('sourceLabel').textContent = 'SIM';
            startSimStream();
            return;
        }
        watchId = navigator.geolocation.watchPosition(
            onGPSFrame,
            (err) => {
                document.getElementById('hudStatusText').textContent = 'Low GPS Signal';
                showToast(`GPS: ${err.message}`);
            },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 }
        );
    } else {
        startSimStream();
    }
}

async function stopRecording() {
    isRecording = false;
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    if (simTimer !== null) {
        clearInterval(simTimer);
        simTimer = null;
    }
    if (clockTimer !== null) {
        clearInterval(clockTimer);
        clockTimer = null;
    }

    disableBackgroundKeepAlive();

    const btn = document.getElementById('masterRecordBtn');
    btn.className = 'w-full mt-5 py-4 rounded-2xl font-semibold text-sm tracking-tight transition-all flex items-center justify-center gap-2.5 bg-ios-green text-white shadow-md shadow-ios-green/20 active:scale-[0.98]';
    document.getElementById('recordDot').className = 'w-2.5 h-2.5 rounded-full bg-white';
    document.getElementById('recordBtnLabel').textContent = 'Start Trace';
    document.getElementById('statusDot').className = 'w-2.5 h-2.5 rounded-full bg-ios-green shadow-[0_0_8px_#34C759]';
    document.getElementById('hudStatusText').textContent = 'Ready to Record';

    if (activeSession && activeSession.points.length > 1) {
        savedSessions.unshift(activeSession);
        await persistSessionToStorage(activeSession);
        expandedSessionId = activeSession.id;
        renderAccordion();
        showToast(`Saved ${activeSession.points.length} GPS points in Rust`);
    } else {
        showToast('Trace discarded (too short)');
    }
}

function onGPSFrame(pos) {
    const c = pos.coords;
    document.getElementById('hudStatusText').textContent = 'Recording High-Accuracy GPS';
    recordPoint({
        lat: c.latitude,
        lon: c.longitude,
        alt: c.altitude !== null ? c.altitude : 0,
        speedMs: c.speed,
        acc: c.accuracy || 4,
        ts: pos.timestamp || Date.now()
    });
}

let simStep = 0;
let sLat = 46.5286, sLon = 10.4531, sAlt = 2150;
function startSimStream() {
    simStep = 0;
    sLat = 46.5286 + (Math.random() - 0.5) * 0.004;
    sLon = 10.4531 + (Math.random() - 0.5) * 0.004;
    sAlt = 2150;

    simTimer = setInterval(() => {
        simStep += 0.15;
        const speedMs = 13 + Math.sin(simStep * 0.6) * 7 + Math.cos(simStep * 1.4) * 3.5;
        const heading = simStep * 0.38 + Math.sin(simStep * 0.25) * 0.8;
        const dt = 0.7;

        sLat += (Math.cos(heading) * speedMs * dt) / 111320;
        sLon += (Math.sin(heading) * speedMs * dt) / (111320 * Math.cos(sLat * Math.PI / 180));
        sAlt += Math.sin(simStep * 0.3) * 1.8;

        recordPoint({
            lat: sLat,
            lon: sLon,
            alt: sAlt,
            speedMs: Math.max(1, speedMs),
            acc: +(2.0 + Math.random() * 1.2).toFixed(1),
            ts: Date.now()
        });
    }, 700);
}

async function recordPoint(raw) {
    if (!activeSession) return;

    const pts = activeSession.points;
    const prev = pts.length > 0 ? pts[pts.length - 1] : null;

    // Delegate calculation to Rust when running in Tauri
    if (hasTauri()) {
        try {
            const sumSpeeds = pts.reduce((a, b) => a + b.speed, 0);
            const res = await invokeTauri('cmd_process_point', {
                prevPt: prev,
                raw: raw,
                stats: activeSession.stats,
                count: pts.length,
                sumSpeeds: sumSpeeds
            });
            if (res && res[0] && res[1]) {
                const pt = res[0];
                activeSession.stats = res[1];
                pts.push(pt);
                updateLiveHUD(pt);
                return;
            }
        } catch (e) {
            console.warn('Rust point calculation fallback:', e);
        }
    }

    // Client-side fallback calculation
    let dKm = 0;
    let spdKmh = raw.speedMs !== null && raw.speedMs !== undefined ? raw.speedMs * 3.6 : 0;
    let grade = 0;

    if (prev) {
        dKm = haversineKm(prev.lat, prev.lon, raw.lat, raw.lon);
        const dtSec = Math.max(0.1, (raw.ts - prev.ts) / 1000);
        if (raw.speedMs === null || raw.speedMs === undefined) {
            spdKmh = dKm / (dtSec / 3600);
        }
        const altDiff = raw.alt - prev.alt;
        if (altDiff > 0) activeSession.stats.elevationGainM += altDiff;
        if (dKm > 0.002) {
            grade = Math.max(-40, Math.min(40, (altDiff / (dKm * 1000)) * 100));
        }
    }

    const totalDist = (prev ? prev.distKm : 0) + dKm;
    const pt = {
        lat: +raw.lat.toFixed(6),
        lon: +raw.lon.toFixed(6),
        alt: +raw.alt.toFixed(1),
        speed: +spdKmh.toFixed(1),
        acc: +raw.acc.toFixed(1),
        grade: +grade.toFixed(1),
        ts: raw.ts,
        distKm: +totalDist.toFixed(4)
    };

    pts.push(pt);

    const st = activeSession.stats;
    st.distanceKm = totalDist;
    if (pt.speed > st.maxSpeedKmh) st.maxSpeedKmh = pt.speed;
    if (st.minAltM === null || pt.alt < st.minAltM) st.minAltM = pt.alt;
    if (st.maxAltM === null || pt.alt > st.maxAltM) st.maxAltM = pt.alt;
    st.avgSpeedKmh = +(pts.reduce((a, b) => a + b.speed, 0) / pts.length).toFixed(1);

    updateLiveHUD(pt);
}

function updateLiveHUD(pt = null) {
    const st = activeSession ? activeSession.stats : { distanceKm: 0, durationMs: 0 };
    const count = activeSession ? activeSession.points.length : 0;

    document.getElementById('liveSpeed').textContent = pt ? pt.speed.toFixed(1) : '0.0';
    document.getElementById('liveAlt').textContent = pt ? `${pt.alt.toFixed(0)} m` : '-- m';
    document.getElementById('liveDist').textContent = `${st.distanceKm.toFixed(2)} km`;
    document.getElementById('livePts').textContent = count;
    document.getElementById('hudAccuracy').textContent = pt ? `GPS ±${pt.acc}m` : 'GPS ±--m';
}

/********************************************************************
 * STORAGE ENGINE (RUST + LOCAL STORAGE BACKED)
 ********************************************************************/
async function loadInitialSessions() {
    let loadedFromRust = false;
    if (hasTauri()) {
        try {
            const list = await invokeTauri('cmd_load_sessions');
            if (Array.isArray(list) && list.length > 0) {
                savedSessions = list;
                loadedFromRust = true;
            }
        } catch (e) {
            console.warn('Rust load_sessions fallback:', e);
        }
    }

    if (!loadedFromRust) {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            savedSessions = raw ? JSON.parse(raw) : [];
        } catch (e) {
            savedSessions = [];
        }
    }

    if (savedSessions.length === 0) {
        await generateDemoTrackAction(true);
    } else {
        expandedSessionId = savedSessions[0].id;
        renderAccordion();
    }
}

async function persistSessionToStorage(session) {
    if (hasTauri()) {
        try {
            await invokeTauri('cmd_save_session', { session });
        } catch (e) {
            console.warn('Rust save_session fallback:', e);
        }
    }
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(savedSessions));
    } catch (e) {}
}

async function deleteSessionAction(id, e) {
    if (e) e.stopPropagation();
    stopPlayback();

    if (hasTauri()) {
        try {
            await invokeTauri('cmd_delete_session', { id });
        } catch (e) {}
    }

    savedSessions = savedSessions.filter(s => s.id !== id);
    if (expandedSessionId === id) {
        expandedSessionId = savedSessions.length > 0 ? savedSessions[0].id : null;
    }
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(savedSessions));
    } catch (e) {}

    renderAccordion();
    showToast('Trace deleted');
}

function toggleExpandSession(id) {
    stopPlayback();
    if (expandedSessionId === id) {
        expandedSessionId = null;
    } else {
        expandedSessionId = id;
        currentScrubIdx = 0;
    }
    renderAccordion();
}

/********************************************************************
 * ACCORDION & VISUALIZATION RENDERER
 ********************************************************************/
function renderAccordion() {
    if (activeMap) {
        activeMap.remove();
        activeMap = null;
        activeTileLayer = null;
        activeScrubMarker = null;
    }

    const container = document.getElementById('tracesAccordion');
    document.getElementById('savedCount').textContent = savedSessions.length;

    if (savedSessions.length === 0) {
        container.innerHTML = `
            <div class="text-center py-12 bg-white dark:bg-ios-darkCard border border-black/5 dark:border-white/10 rounded-[28px] text-xs font-medium text-zinc-400">
                No recorded traces yet. Tap "Start Trace" or "+ Sample Route".
            </div>`;
        return;
    }

    container.innerHTML = savedSessions.map(s => {
        const isOpen = s.id === expandedSessionId;
        const dateLabel = new Date(s.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' });
        const maxIdx = Math.max(0, s.points.length - 1);

        return `
        <div class="rounded-[28px] border transition-all overflow-hidden ${
            isOpen 
            ? 'bg-white dark:bg-ios-darkCard border-black/[0.08] dark:border-white/[0.12] shadow-[0_12px_36px_rgb(0,0,0,0.08)] dark:shadow-2xl' 
            : 'bg-white/80 dark:bg-ios-darkCard/70 border-black/[0.04] dark:border-white/[0.06]'
        }">
            <!-- Card Summary Header -->
            <div onclick="toggleExpandSession('${s.id}')" class="p-4 flex items-center justify-between cursor-pointer select-none">
                <div class="min-w-0">
                    <div class="flex items-center gap-2">
                        <span class="w-2 h-2 rounded-full ${isOpen ? 'bg-ios-blue' : 'bg-zinc-300 dark:bg-zinc-600'}"></span>
                        <span class="font-semibold text-sm text-zinc-900 dark:text-white truncate">${escapeHtml(s.name)}</span>
                        <span class="text-xs text-zinc-400 dark:text-zinc-500">${dateLabel}</span>
                    </div>
                    <div class="flex items-center gap-2.5 mt-1 text-xs font-medium text-zinc-500 dark:text-zinc-400 pl-4 tabular-nums">
                        <span class="text-zinc-800 dark:text-zinc-200 font-semibold">${s.stats.distanceKm.toFixed(2)} km</span>
                        <span>•</span>
                        <span>Max ${s.stats.maxSpeedKmh.toFixed(0)} km/h</span>
                        <span>•</span>
                        <span class="text-ios-blue">+${Math.round(s.stats.elevationGainM)} m</span>
                    </div>
                </div>

                <div class="flex items-center gap-1">
                    <button onclick="openShareSheet('${s.id}', event)" class="p-2 rounded-full text-ios-blue hover:bg-ios-blue/10 transition" title="Share & Export">
                        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                        </svg>
                    </button>
                    <button onclick="deleteSessionAction('${s.id}', event)" class="p-2 rounded-full text-zinc-400 hover:text-ios-red transition" title="Delete">
                        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                    </button>
                </div>
            </div>

            ${isOpen ? `
            <!-- Inline Expanded Visualizer -->
            <div class="px-4 pb-4 pt-1 border-t border-zinc-100 dark:border-white/[0.06] space-y-3">
                
                <!-- Map Viewport with Live Location Beacon -->
                <div class="relative w-full h-64 rounded-2xl overflow-hidden border border-black/5 dark:border-white/10">
                    <div id="inlineMap" class="w-full h-full z-10"></div>
                    
                    <!-- Top-Left Segmented Pill: Speed vs Altitude Color -->
                    <div class="absolute top-2.5 left-2.5 z-[400] flex bg-white/90 dark:bg-zinc-900/90 backdrop-blur-md p-0.5 rounded-xl border border-black/5 dark:border-white/10 text-[11px] font-semibold shadow-sm">
                        <button id="btnColorSpeed" onclick="switchColorMode('speed')" class="px-2.5 py-1 rounded-lg ${currentColorMode === 'speed' ? 'bg-ios-blue text-white' : 'text-zinc-500'}">
                            Speed
                        </button>
                        <button id="btnColorAlt" onclick="switchColorMode('alt')" class="px-2.5 py-1 rounded-lg ${currentColorMode === 'alt' ? 'bg-ios-blue text-white' : 'text-zinc-500'}">
                            Altitude
                        </button>
                    </div>

                    <!-- Top-Right Controls: Follow Lock & Fit Route -->
                    <div class="absolute top-2.5 right-2.5 z-[400] flex items-center gap-1.5">
                        <button id="btnFollowToggle" onclick="toggleFollowMode()" class="px-2.5 py-1 rounded-xl bg-white/90 dark:bg-zinc-900/90 backdrop-blur-md border border-black/5 dark:border-white/10 text-[11px] font-semibold ${followMarkerOnPlay ? 'text-ios-blue' : 'text-zinc-400'} shadow-sm active:scale-95">
                            Follow: ${followMarkerOnPlay ? 'ON' : 'OFF'}
                        </button>
                        <button onclick="fitActiveTrack()" class="p-1.5 rounded-xl bg-white/90 dark:bg-zinc-900/90 backdrop-blur-md border border-black/5 dark:border-white/10 text-zinc-700 dark:text-zinc-200 shadow-sm active:scale-95" title="Fit Full Route">
                            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                            </svg>
                        </button>
                    </div>

                    <!-- Bottom Floating Live Coordinates Pill -->
                    <div class="absolute bottom-2.5 left-2.5 right-2.5 z-[400] pointer-events-none flex items-center justify-between px-3 py-1.5 rounded-xl bg-white/90 dark:bg-zinc-900/90 backdrop-blur-md border border-black/5 dark:border-white/10 text-[11px] font-mono shadow-sm">
                        <span id="scrubCoords" class="text-zinc-700 dark:text-zinc-200 font-semibold">--.-----, --.-----</span>
                        <span id="scrubTimestamp" class="text-zinc-400">--:--:--</span>
                    </div>
                </div>

                <!-- Synchronized Telemetry Scrubber Card -->
                <div class="bg-[#F2F2F7]/90 dark:bg-ios-darkElevated/60 rounded-2xl p-3.5 space-y-2.5">
                    <!-- Live Point Metrics at Current Scrub Position -->
                    <div class="flex items-center justify-between text-xs font-semibold tabular-nums">
                        <div class="flex items-center gap-2.5">
                            <span id="scrubSpeed" class="text-ios-green text-sm font-bold">0.0 km/h</span>
                            <span class="text-zinc-300 dark:text-zinc-600">|</span>
                            <span id="scrubAlt" class="text-ios-blue">0 m</span>
                            <span class="text-zinc-300 dark:text-zinc-600">|</span>
                            <span id="scrubGrade" class="text-zinc-500">0%</span>
                        </div>
                        <span id="scrubDist" class="text-zinc-500 dark:text-zinc-400">0.00 km</span>
                    </div>

                    <!-- Interactive Elevation + Speed Sparkline -->
                    <div class="relative w-full h-14 rounded-xl bg-white dark:bg-black/40 overflow-hidden cursor-pointer border border-black/[0.03] dark:border-white/[0.05]" onclick="handleCanvasTap(event)">
                        <canvas id="inlineSparkline" class="w-full h-full block"></canvas>
                    </div>

                    <!-- Play / Pause & Apple Slider -->
                    <div class="flex items-center gap-3 pt-1">
                        <button id="playBtn" onclick="togglePlayback()" class="w-9 h-9 rounded-full bg-ios-blue text-white flex items-center justify-center flex-shrink-0 active:scale-90 transition shadow-sm">
                            <svg id="playIcon" class="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M8 5v14l11-7z"/>
                            </svg>
                        </button>
                        <input id="timelineSlider" type="range" min="0" max="${maxIdx}" value="0" 
                               oninput="onSliderScrub(this.value)" 
                               class="apple-slider flex-1" />
                        <span id="scrubIndexLabel" class="text-[11px] font-mono text-zinc-400 w-12 text-right tabular-nums">1/${s.points.length}</span>
                    </div>
                </div>

                <!-- Unified Share & Quick Export Row -->
                <div class="flex items-center gap-2 pt-0.5">
                    <button onclick="openShareSheet('${s.id}', event)" class="flex-1 py-3 rounded-2xl bg-ios-blue text-white font-semibold text-xs flex items-center justify-center gap-2 shadow-sm active:scale-[0.98] transition">
                        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                        </svg>
                        <span>Share / Export (.GPX, WhatsApp, Telegram)</span>
                    </button>
                </div>
            </div>
            ` : ''}
        </div>`;
    }).join('');

    if (expandedSessionId) {
        const session = savedSessions.find(s => s.id === expandedSessionId);
        if (session && session.points.length > 0) {
            setTimeout(() => {
                mountInlineVisualizer(session);
            }, 40);
        }
    }
}

/********************************************************************
 * INLINE MAP & HIGH-VISIBILITY PLAYBACK LOCATION TRACKER
 ********************************************************************/
function mountInlineVisualizer(session) {
    const mapEl = document.getElementById('inlineMap');
    if (!mapEl) return;

    activeMap = L.map('inlineMap', {
        zoomControl: false,
        attributionControl: false
    });

    activeTileLayer = createOpenFreeMapLayer().addTo(activeMap);

    drawTrackSegments(session);
    fitActiveTrack();
    setScrubPosition(0, false);
}

function drawTrackSegments(session) {
    if (!activeMap) return;
    activePolylineLayers.forEach(l => activeMap.removeLayer(l));
    activePolylineLayers = [];

    const pts = session.points;
    if (pts.length < 2) return;

    const maxS = Math.max(10, session.stats.maxSpeedKmh);
    const minA = session.stats.minAltM ?? 0;
    const spanA = Math.max(5, (session.stats.maxAltM ?? 100) - minA);

    for (let i = 1; i < pts.length; i++) {
        const p1 = pts[i - 1];
        const p2 = pts[i];
        const ratio = currentColorMode === 'speed'
            ? Math.min(1, Math.max(0, p2.speed / maxS))
            : Math.min(1, Math.max(0, (p2.alt - minA) / spanA));
        const hue = (1 - ratio) * 210; // Apple Blue -> Green -> Orange/Red
        const seg = L.polyline([[p1.lat, p1.lon], [p2.lat, p2.lon]], {
            color: `hsl(${hue}, 90%, 52%)`,
            weight: 4.5,
            lineCap: 'round'
        }).addTo(activeMap);
        activePolylineLayers.push(seg);
    }

    // Start & Finish Pins
    const startPt = pts[0];
    const endPt = pts[pts.length - 1];
    const startMarker = L.circleMarker([startPt.lat, startPt.lon], {
        radius: 5,
        fillColor: '#34C759',
        color: '#FFFFFF',
        weight: 2,
        fillOpacity: 1
    }).addTo(activeMap);
    const endMarker = L.circleMarker([endPt.lat, endPt.lon], {
        radius: 5,
        fillColor: '#FF3B30',
        color: '#FFFFFF',
        weight: 2,
        fillOpacity: 1
    }).addTo(activeMap);
    activePolylineLayers.push(startMarker, endMarker);
}

function toggleFollowMode() {
    followMarkerOnPlay = !followMarkerOnPlay;
    const btn = document.getElementById('btnFollowToggle');
    if (btn) {
        btn.textContent = `Follow: ${followMarkerOnPlay ? 'ON' : 'OFF'}`;
        btn.className = `px-2.5 py-1 rounded-xl bg-white/90 dark:bg-zinc-900/90 backdrop-blur-md border border-black/5 dark:border-white/10 text-[11px] font-semibold ${followMarkerOnPlay ? 'text-ios-blue' : 'text-zinc-400'} shadow-sm active:scale-95`;
    }
}

function switchColorMode(mode) {
    currentColorMode = mode;
    const session = savedSessions.find(s => s.id === expandedSessionId);
    if (!session) return;

    const btnSpd = document.getElementById('btnColorSpeed');
    const btnAlt = document.getElementById('btnColorAlt');
    if (btnSpd && btnAlt) {
        btnSpd.className = `px-2.5 py-1 rounded-lg ${mode === 'speed' ? 'bg-ios-blue text-white' : 'text-zinc-500'}`;
        btnAlt.className = `px-2.5 py-1 rounded-lg ${mode === 'alt' ? 'bg-ios-blue text-white' : 'text-zinc-500'}`;
    }
    drawTrackSegments(session);
}

function fitActiveTrack() {
    const session = savedSessions.find(s => s.id === expandedSessionId);
    if (!activeMap || !session || session.points.length === 0) return;
    const bounds = L.latLngBounds(session.points.map(p => [p.lat, p.lon]));
    activeMap.fitBounds(bounds, { padding: [28, 28], maxZoom: 17 });
}

function onSliderScrub(val) {
    stopPlayback();
    setScrubPosition(parseInt(val, 10), true);
}

function handleCanvasTap(e) {
    const session = savedSessions.find(s => s.id === expandedSessionId);
    if (!session) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const idx = Math.floor(ratio * (session.points.length - 1));
    stopPlayback();
    setScrubPosition(idx, true);
}

function setScrubPosition(idx, panMap = false) {
    const session = savedSessions.find(s => s.id === expandedSessionId);
    if (!session || session.points.length === 0) return;

    currentScrubIdx = Math.max(0, Math.min(session.points.length - 1, idx));
    const pt = session.points[currentScrubIdx];

    const slider = document.getElementById('timelineSlider');
    if (slider) slider.value = currentScrubIdx;

    const spdEl = document.getElementById('scrubSpeed');
    const altEl = document.getElementById('scrubAlt');
    const grdEl = document.getElementById('scrubGrade');
    const dstEl = document.getElementById('scrubDist');
    const idxEl = document.getElementById('scrubIndexLabel');
    const crdEl = document.getElementById('scrubCoords');
    const timEl = document.getElementById('scrubTimestamp');

    if (spdEl) spdEl.textContent = `${pt.speed.toFixed(1)} km/h`;
    if (altEl) altEl.textContent = `${pt.alt.toFixed(0)} m`;
    if (grdEl) grdEl.textContent = `${pt.grade > 0 ? '+' : ''}${pt.grade}%`;
    if (dstEl) dstEl.textContent = `${pt.distKm.toFixed(2)} km`;
    if (idxEl) idxEl.textContent = `${currentScrubIdx + 1}/${session.points.length}`;
    if (crdEl) crdEl.textContent = `${pt.lat.toFixed(5)}, ${pt.lon.toFixed(5)}`;
    if (timEl) timEl.textContent = new Date(pt.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    if (activeMap) {
        const latLng = [pt.lat, pt.lon];
        if (!activeScrubMarker) {
            const puckIcon = L.divIcon({
                className: 'apple-location-puck',
                html: `
                    <div style="position:relative;width:28px;height:28px;display:flex;align-items:center;justify-content:center;">
                        <div class="puck-halo" style="position:absolute;width:28px;height:28px;border-radius:9999px;background:rgba(0,122,255,0.45);"></div>
                        <div style="position:relative;width:16px;height:16px;border-radius:9999px;background:#007AFF;border:3px solid #FFFFFF;box-shadow:0 2px 8px rgba(0,0,0,0.45);"></div>
                    </div>
                `,
                iconSize: [28, 28],
                iconAnchor: [14, 14]
            });
            activeScrubMarker = L.marker(latLng, { icon: puckIcon, zIndexOffset: 2000 }).addTo(activeMap);
        } else {
            activeScrubMarker.setLatLng(latLng);
        }

        if (panMap && followMarkerOnPlay) {
            activeMap.panTo(latLng, { animate: true, duration: 0.2 });
        }
    }

    drawInlineSparkline(session, currentScrubIdx);
}

function drawInlineSparkline(session, activeIdx) {
    const canvas = document.getElementById('inlineSparkline');
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    const pts = session.points;
    if (pts.length < 2) return;

    const minA = session.stats.minAltM ?? 0;
    const maxA = Math.max(minA + 5, session.stats.maxAltM ?? 100);
    const maxS = Math.max(10, session.stats.maxSpeedKmh * 1.08);
    const pad = 6;
    const plotH = h - pad * 2;

    // Elevation Fill (Apple Blue)
    ctx.beginPath();
    pts.forEach((p, i) => {
        const x = (i / (pts.length - 1)) * w;
        const y = pad + plotH - ((p.alt - minA) / (maxA - minA)) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 122, 255, 0.14)';
    ctx.fill();

    // Speed Curve (Apple Green)
    ctx.beginPath();
    pts.forEach((p, i) => {
        const x = (i / (pts.length - 1)) * w;
        const y = pad + plotH - (p.speed / maxS) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#34C759';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Current Scrub Playhead Line + Dot
    const scrubX = (activeIdx / (pts.length - 1)) * w;
    const activePt = pts[activeIdx];
    const activeY = pad + plotH - (activePt.speed / maxS) * plotH;

    ctx.strokeStyle = '#007AFF';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(scrubX, 0);
    ctx.lineTo(scrubX, h);
    ctx.stroke();

    ctx.fillStyle = '#007AFF';
    ctx.beginPath();
    ctx.arc(scrubX, activeY, 3.5, 0, Math.PI * 2);
    ctx.fill();
}

function togglePlayback() {
    if (playbackInterval) {
        stopPlayback();
        return;
    }
    const session = savedSessions.find(s => s.id === expandedSessionId);
    if (!session || session.points.length < 2) return;

    if (currentScrubIdx >= session.points.length - 1) {
        currentScrubIdx = 0;
    }

    const playIcon = document.getElementById('playIcon');
    if (playIcon) {
        playIcon.innerHTML = `<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>`;
        playIcon.classList.remove('ml-0.5');
    }

    playbackInterval = setInterval(() => {
        if (currentScrubIdx < session.points.length - 1) {
            setScrubPosition(currentScrubIdx + 1, true);
        } else {
            stopPlayback();
        }
    }, 110);
}

function stopPlayback() {
    if (playbackInterval) {
        clearInterval(playbackInterval);
        playbackInterval = null;
    }
    const playIcon = document.getElementById('playIcon');
    if (playIcon) {
        playIcon.innerHTML = `<path d="M8 5v14l11-7z"/>`;
        playIcon.classList.add('ml-0.5');
    }
}

/********************************************************************
 * MULTI-PLATFORM SHARE SHEET & TELEMETRY EXPORTER
 * Supports Native File Share (WhatsApp/Telegram/AirDrop), Social Links,
 * Mail, Clipboard Summary, and Direct Download.
 ********************************************************************/
function openShareSheet(id, e) {
    if (e) e.stopPropagation();
    shareSessionId = id;
    const s = savedSessions.find(x => x.id === id);
    if (!s) return;

    document.getElementById('shareSheetTitle').textContent = s.name;
    document.getElementById('shareSheetSubtitle').textContent =
        `${s.stats.distanceKm.toFixed(2)} km • Max ${s.stats.maxSpeedKmh.toFixed(1)} km/h • ${s.points.length} GPS pts`;

    selectShareFormat(selectedShareFormat);
    const backdrop = document.getElementById('shareSheetBackdrop');
    backdrop.classList.remove('hidden');
    backdrop.classList.add('flex');
}

function closeShareSheet() {
    const backdrop = document.getElementById('shareSheetBackdrop');
    backdrop.classList.add('hidden');
    backdrop.classList.remove('flex');
}

function selectShareFormat(fmt) {
    selectedShareFormat = fmt;
    ['gpx', 'geojson', 'csv'].forEach(f => {
        const btn = document.getElementById('fmtBtn_' + f);
        if (!btn) return;
        if (f === fmt) {
            btn.className = 'py-2 rounded-xl bg-white dark:bg-ios-darkCard text-zinc-900 dark:text-white shadow-xs transition';
        } else {
            btn.className = 'py-2 rounded-xl text-zinc-500 dark:text-zinc-400 transition';
        }
    });
}

async function buildTelemetryPayload(session, fmt) {
    if (hasTauri()) {
        try {
            const res = await invokeTauri('cmd_export_session', { session, format: fmt });
            if (res && res.body) {
                return { body: res.body, mime: res.mimeType, filename: res.filename };
            }
        } catch (e) {
            console.warn('Rust export fallback:', e);
        }
    }

    const slug = session.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    let body = '', mime = 'text/plain', ext = fmt;

    if (fmt === 'gpx') {
        mime = 'application/gpx+xml';
        const ptsXml = session.points.map(p => `      <trkpt lat="${p.lat}" lon="${p.lon}">
        <ele>${p.alt}</ele>
        <time>${new Date(p.ts).toISOString()}</time>
        <extensions><speed>${(p.speed / 3.6).toFixed(2)}</speed><grade>${p.grade}</grade></extensions>
      </trkpt>`).join('\n');

        body = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Trace Precision GPS Telemetry" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${escapeHtml(session.name)}</name>
    <trkseg>
${ptsXml}
    </trkseg>
  </trk>
</gpx>`;
    } else if (fmt === 'geojson') {
        mime = 'application/geo+json';
        body = JSON.stringify({
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                properties: {
                    name: session.name,
                    stats: session.stats,
                    speedsKmh: session.points.map(p => p.speed),
                    timestamps: session.points.map(p => p.ts)
                },
                geometry: {
                    type: 'LineString',
                    coordinates: session.points.map(p => [p.lon, p.lat, p.alt])
                }
            }]
        }, null, 2);
    } else if (fmt === 'csv') {
        mime = 'text/csv';
        const hdr = 'iso_time,latitude,longitude,altitude_m,speed_kmh,distance_km,grade_pct,accuracy_m';
        const rows = session.points.map(p => `${new Date(p.ts).toISOString()},${p.lat},${p.lon},${p.alt},${p.speed},${p.distKm},${p.grade},${p.acc}`);
        body = [hdr, ...rows].join('\n');
    }

    return { body, mime, filename: `${slug}.${ext}` };
}

function buildShareSummaryText(session) {
    const start = session.points[0];
    const end = session.points[session.points.length - 1];
    const mapsUrl = `https://www.google.com/maps/dir/${start.lat},${start.lon}/${end.lat},${end.lon}`;
    return [
        `📍 ${session.name} — GPS Telemetry (Trace in Rust)`,
        `• Distance: ${session.stats.distanceKm.toFixed(2)} km`,
        `• Max Speed: ${session.stats.maxSpeedKmh.toFixed(1)} km/h (Avg ${session.stats.avgSpeedKmh} km/h)`,
        `• Elevation Gain: +${Math.round(session.stats.elevationGainM)} m`,
        `• Samples: ${session.points.length} pts`,
        `🗺️ Route Map: ${mapsUrl}`
    ].join('\n');
}

async function triggerNativeFileShare() {
    const s = savedSessions.find(x => x.id === shareSessionId);
    if (!s) return;

    const payload = await buildTelemetryPayload(s, selectedShareFormat);
    const summary = buildShareSummaryText(s);
    const file = new File([payload.body], payload.filename, { type: payload.mime });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({
                title: s.name,
                text: summary,
                files: [file]
            });
            showToast(`Shared ${payload.filename}`);
            closeShareSheet();
            return;
        } catch (err) {
            if (err.name === 'AbortError') return;
        }
    }

    if (navigator.share) {
        try {
            await navigator.share({
                title: s.name,
                text: summary
            });
            await downloadSelectedFormat();
            return;
        } catch (err) {
            if (err.name === 'AbortError') return;
        }
    }

    await downloadSelectedFormat();
}

async function shareToPlatform(platform) {
    const s = savedSessions.find(x => x.id === shareSessionId);
    if (!s) return;

    const summary = buildShareSummaryText(s);
    const encoded = encodeURIComponent(summary);

    await downloadSelectedFormat(true);

    if (platform === 'whatsapp') {
        window.open(`https://wa.me/?text=${encoded}`, '_blank');
        showToast('Opening WhatsApp + downloaded file');
    } else if (platform === 'telegram') {
        window.open(`https://t.me/share/url?url=${encodeURIComponent('https://maps.google.com')}&text=${encoded}`, '_blank');
        showToast('Opening Telegram + downloaded file');
    } else if (platform === 'email') {
        window.location.href = `mailto:?subject=${encodeURIComponent(s.name + ' - GPS Telemetry')}&body=${encoded}`;
        showToast('Opening Mail + downloaded file');
    } else if (platform === 'copy') {
        copyTextFallback(summary);
        showToast('Telemetry summary copied');
    }
    closeShareSheet();
}

async function downloadSelectedFormat(silent = false) {
    const s = savedSessions.find(x => x.id === shareSessionId);
    if (!s) return;
    const payload = await buildTelemetryPayload(s, selectedShareFormat);

    // Save to disk via Rust backend if running inside Tauri
    if (hasTauri()) {
        try {
            const savedPath = await invokeTauri('cmd_save_export_file', {
                filename: payload.filename,
                content: payload.body
            });
            if (savedPath && !silent) {
                showToast(`Saved to ${payload.filename}`);
                closeShareSheet();
                return;
            }
        } catch (e) {}
    }

    // Browser Blob download
    const blob = new Blob([payload.body], { type: payload.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = payload.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    if (!silent) {
        showToast(`Saved ${payload.filename}`);
        closeShareSheet();
    }
}

function copyTextFallback(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
}

/********************************************************************
 * SAMPLE ROUTE GENERATOR & HELPERS
 ********************************************************************/
async function generateDemoTrackAction(silent = false) {
    if (hasTauri()) {
        try {
            const s = await invokeTauri('cmd_generate_demo_track', { customName: 'Stelvio Alpine Pass' });
            if (s && s.points) {
                savedSessions.unshift(s);
                await persistSessionToStorage(s);
                expandedSessionId = s.id;
                renderAccordion();
                if (!silent) showToast('Sample route added via Rust');
                return;
            }
        } catch (e) {
            console.warn('Rust demo track fallback:', e);
        }
    }

    const s = createSessionObject('Stelvio Alpine Pass');
    let lat = 46.5286, lon = 10.4531, alt = 2165, dist = 0;
    const t0 = Date.now() - 150000;

    for (let i = 0; i < 95; i++) {
        const t = i * 0.14;
        const spd = +(42 + Math.sin(t * 0.7) * 25 + Math.cos(t * 1.4) * 10).toFixed(1);
        const hdg = (t * 26 + Math.sin(t * 0.5) * 50) * Math.PI / 180;
        const stepKm = (spd / 3600) * 1.4;
        const prevAlt = alt;

        lat += (Math.cos(hdg) * stepKm) / 111.32;
        lon += (Math.sin(hdg) * stepKm) / (111.32 * Math.cos(lat * Math.PI / 180));
        alt += Math.sin(t * 0.35) * 2.2 + 0.45;
        dist += stepKm;

        const dAlt = alt - prevAlt;
        if (dAlt > 0) s.stats.elevationGainM += dAlt;

        s.points.push({
            lat: +lat.toFixed(6),
            lon: +lon.toFixed(6),
            alt: +alt.toFixed(1),
            speed: spd,
            acc: 2.4,
            grade: +((dAlt / (stepKm * 1000)) * 100).toFixed(1),
            ts: t0 + i * 1400,
            distKm: +dist.toFixed(4)
        });
    }

    const spds = s.points.map(p => p.speed);
    const alts = s.points.map(p => p.alt);
    s.stats.distanceKm = dist;
    s.stats.maxSpeedKmh = Math.max(...spds);
    s.stats.avgSpeedKmh = +(spds.reduce((a, b) => a + b, 0) / spds.length).toFixed(1);
    s.stats.minAltM = Math.min(...alts);
    s.stats.maxAltM = Math.max(...alts);
    s.stats.durationMs = 95 * 1400;

    savedSessions.unshift(s);
    await persistSessionToStorage(s);
    expandedSessionId = s.id;
    renderAccordion();
    if (!silent) showToast('Sample route added');
}

function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDuration(ms) {
    const tenths = Math.floor(ms / 100) % 10;
    const totalSec = Math.floor(ms / 1000);
    const sec = totalSec % 60;
    const min = Math.floor(totalSec / 60);
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${tenths}`;
}

function escapeHtml(str) {
    return String(str).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

let toastTimeout = null;
function showToast(msg) {
    const t = document.getElementById('toast');
    if (!t) return;
    document.getElementById('toastMsg').textContent = msg;
    t.classList.remove('translate-y-20', 'opacity-0');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        t.classList.add('translate-y-20', 'opacity-0');
    }, 2600);
}
