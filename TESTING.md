# FirstKnock Sales OS - Testing Guide

This guide describes how to clone, setup, build, and test the FirstKnock Sales OS iOS application.

## Prerequisites

- **Mac Computer** (Required for iOS development)
- **Xcode 15+** (Install from App Store)
- **Node.js 18+** (Download from nodejs.org)
- **Git**

## 1. Setup

### Clone the Repository
```bash
git clone <repository_url>
cd firstknock-sales-os
```

### Install Dependencies
```bash
npm install
```

### Configure Environment
Create a file named `.env` in the root directory and add the following configuration (needed to connect to the backend):

```bash
VITE_BASE44_APP_ID=cbef744a8545c389ef439ea6
VITE_BASE44_APP_BASE_URL=https://my-to-do-list-81bfaad7.base44.app
```

### Initialize iOS Project
```bash
npx cap sync ios
```

## 2. Build and Run

1.  **Build the Web Assets:**
    ```bash
    npm run build
    ```

2.  **Sync to iOS:**
    ```bash
    npx cap sync ios
    ```

3.  **Open in Xcode:**
    ```bash
    npx cap open ios
    ```

4.  **Run on Device/Simulator:**
    - In Xcode, select your Team in `Signing & Capabilities` (if testing on physical device).
    - Select your target device (iPhone Simulator or connected iPhone).
    - Press **Play (Cmd+R)** to build and run.

## 3. What to Test

### A. Offline Mode (New Feature)
1.  Launch the app.
2.  Go to **Home (Map)**.
3.  **Upload Data:** Upload the provided JSON file (`tricounty_sold_properties_cleaned.json`).
    - *Note:* This saves the data to your device's local storage.
4.  **Go Offline:** Turn off WiFi/Data on your device.
5.  **Restart App:** Kill the app and reopen it.
6.  **Verify:** The map pins should still appear instantly (loaded from local storage).

### B. Apple Maps Navigation
1.  Tap on any property pin on the map.
2.  Click **"Navigate"** or **"GO"**.
3.  **Verify:** It should open the **Apple Maps** app (not Google Maps in browser).
4.  Go to **Routes** tab -> Select a Route.
5.  Click **"START ROUTE IN APPLE MAPS"**.
6.  **Verify:** It navigates to the first stop in Apple Maps.

### C. Lists & Sync
1.  Create a "Saved Route" from the Map view.
2.  Go to **My Routes** tab.
3.  **Verify:** The new route appears immediately in the list.

### D. UI / Safe Areas
1.  Open a Route Checklist.
2.  **Verify:** The "Close" (X) button and Title are visible and not cut off by the iPhone notch or rounded corners.

## Troubleshooting

- **"Untrusted Developer":** If running on a physical device, go to iPhone Settings -> General -> VPN & Device Management -> Trust your developer certificate.
- **Build Failed (Signing):** Ensure a valid Team is selected in Xcode -> Signing & Capabilities.
