# 🛰️ TRACE — Precision Mobile GPS Telemetry Blackbox in Rust

[![Rust Workspace CI](https://github.com/abhij/Trace/actions/workflows/ci.yml/badge.svg)](https://github.com/abhij/Trace/actions/workflows/ci.yml)
[![Build Android APK & Release](https://github.com/abhij/Trace/actions/workflows/build-and-release.yml/badge.svg)](https://github.com/abhij/Trace/actions/workflows/build-and-release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Tauri](https://img.shields.io/badge/Tauri-v2%20Mobile-orange.svg)](https://tauri.app/)

A high-precision, offline-first mobile GPS telemetry blackbox and vector route visualizer built with **Rust 2021** and **Tauri v2 Mobile**.

Designed with an Apple Watch Ultra & Cupertino design aesthetic, featuring 10Hz sub-meter geodesy, dynamic speed & gradient elevation scrubbers, OpenFreeMap vector cartography, and universal export to GPX 1.1, GeoJSON, and CSV.

---

## 📱 Product Showcase & Landing Page

Trace includes a dedicated product & download landing page located in [`landing_page/index.html`](landing_page/index.html):
- Interactive live telemetry simulator
- Direct links to download release APKs
- Feature breakdowns and technical specification sheets
- Step-by-step Android sideloading walkthrough

---

## ✨ Features

- **🦀 Pure Rust Telemetry Engine**:
  - Sub-meter geodesy calculated with high-precision haversine trigonometry ($R = 6,371.0\text{ km}$).
  - Real-time velocity smoothing, elevation gain accumulators, and gradient math (clamped to realistic slope limits).
  - In-memory thread-safe state cache with atomic disk persistence.
- **🗺️ OpenFreeMap Vector Cartography**:
  - 60fps hardware-accelerated vector map playback powered by MapLibre GL.
  - Apple Dark and Positron vector tile themes with zero API keys or rate limits.
- **📍 Tactile Scrubber & Pulsing Beacon**:
  - Synchronized location puck that glides across the map with an Apple Maps sonar halo.
  - Interactive canvas sparkline showing speed curve and elevation fill with real-time coordinate and timestamp readouts.
- **📦 Military & Alpine Grade Exporter**:
  - **GPX 1.1** tracks with `<trkpt>`, elevation `<ele>`, ISO-8601 `<time>`, and `<extensions><speed><grade></extensions>`.
  - **GeoJSON** RFC 7946 LineStrings with telemetry properties.
  - Tabular **CSV** data.
  - Direct native sharing to WhatsApp, Telegram, Mail, AirDrop, and device storage.
- **🔋 Screen-Off Keep-Alive**:
  - Web Audio oscillator and WakeLock API sentinel prevent Android from sleeping or throttling GNSS polling in the background.
- **🛡️ 100% Private & Offline**:
  - Zero analytics, zero ad SDKs, zero cloud lock-in. Your location data never leaves your device.

---

## 🏗️ Project Architecture

```
Trace/
├── .github/
│   └── workflows/
│       ├── build-and-release.yml   # Builds Android APK, signs, and publishes to GitHub Releases
│       └── ci.yml                  # Runs Rust workspace tests & verification
├── landing_page/
│   └── index.html                  # Product & APK download landing page
├── src/                            # Frontend UI
│   ├── index.html                  # Mobile telemetry interface
│   ├── style.css                   # Cupertino styles, scrubber slider, sonar puck
│   └── app.js                      # Bridge between UI and Tauri Rust commands
├── src-tauri/                      # Rust Core & Tauri v2 Backend
│   ├── Cargo.toml                  # Rust dependencies
│   ├── tauri.conf.json             # Tauri configuration (bundle ID, permissions, Android config)
│   ├── build.rs                    # Tauri build script
│   ├── icons/                      # App icon set (ICO, PNGs)
│   ├── capabilities/
│   │   └── default.json            # Security permissions for commands
│   ├── gen/android/                # Generated Android Studio Gradle project
│   │   └── app/src/main/
│   │       └── AndroidManifest.xml # Fine/Coarse GPS, Foreground Service permissions
│   └── src/
│       ├── main.rs                 # Application entry point
│       ├── lib.rs                  # Library entry & Tauri handler registration
│       ├── models.rs               # GpsPoint, Session, SessionStats, ExportFormat
│       ├── telemetry.rs            # Haversine geodesy, velocity, gradient calculations
│       ├── export.rs               # GPX 1.1, GeoJSON, CSV formatting
│       ├── storage.rs              # Disk persistence & caching
│       ├── simulator.rs            # Alpine Stelvio route generator
│       └── commands.rs             # Tauri command bridge to frontend
├── package.json                    # Scripts and Tauri CLI runner
├── Cargo.toml                      # Workspace definition
└── README.md
```

---

## 🚀 Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (1.78+)
- [Node.js](https://nodejs.org/) (20+) & npm
- [Android Studio / Android SDK & NDK](https://developer.android.com/studio) (for local APK building)

### Run Unit Tests (Rust)

All telemetry calculations, haversine algorithms, session persistence, and export formatters have thorough Rust unit tests:

```bash
cargo test --workspace
```

### Run Locally on Desktop

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev
```

### Build Android APK Locally

```bash
# Initialize Android project (first time)
npx @tauri-apps/cli android init

# Build release APK
npx @tauri-apps/cli android build --apk
```

---

## 🤖 GitHub Actions Workflow: Auto Build & Release APK

The workflow `.github/workflows/build-and-release.yml` automatically builds the Android APK and publishes it to the GitHub Releases page.

### How to trigger a release:

1. **Via Git Tag**:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
2. **Via Manual Trigger**:
   - Go to your repository's **Actions** tab on GitHub.
   - Select **Build Android APK & Release**.
   - Click **Run workflow**, input version number (e.g. `1.0.0`), and run.

The workflow will:
1. Compile the Rust core and run all workspace tests.
2. Build the Android APK using Android SDK & NDK.
3. Sign the APK with a release keystore.
4. Generate `SHA256SUMS.txt` checksums.
5. Create a GitHub Release with formatted release notes.
6. Attach `trace-v{VERSION}-universal.apk`, `trace-v{VERSION}-arm64-v8a.apk`, and `SHA256SUMS.txt`.

---

## 📥 Installing the APK on Android

1. Download `trace-v1.0.0-universal.apk` from the [Releases](https://github.com/abhij/Trace/releases) page or product page.
2. Open the downloaded file in your Android device's file manager or notification bar.
3. If prompted by Android, tap **Settings** and allow **Install unknown apps**.
4. Tap **Install**, open TRACE, and grant **Location** permissions.

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
