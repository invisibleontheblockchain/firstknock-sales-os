# How to Install the App on Your iPhone

This guide explains how to install the "FirstKnock Sales OS" app directly onto your iPhone for testing.

## Prerequisites
1.  **Your iPhone**
2.  **A USB Cable** (to connect iPhone to Mac)
3.  **The Mac Computer** with the code on it

---

## Step 1: Trust Your Device
1.  Plug your iPhone into the Mac using the USB cable.
2.  Unlock your iPhone.
3.  If a popup asks **"Trust This Computer?"**, tap **Trust** and enter your passcode.

## Step 2: Enable Developer Mode (One-Time Setup)
*If you have testing apps before, skip this. If this is your first time:*

1.  On your iPhone, go to **Settings** -> **Privacy & Security**.
2.  Scroll to the very bottom.
3.  Tap **Developer Mode**.
4.  Turn it **ON**.
5.  Your phone will restart. After it restarts, unlock it and tap **"Turn On"** in the popup confirmation.

## Step 3: Open the Installer (Xcode)
1.  On the Mac, open the folder for the project.
2.  Double-click the file named **`App.xcodeproj`** (Usually inside `ios/App/`).
    *   *Or ask the developer to run `npx cap open ios` for you.*
3.  Xcode will open. This is the Apple tool used to build apps.
4.  Look at the very top center of the Xcode window. You will see a "Play" button (Triangle) and a device list.
5.  Click the device list and select **Your iPhone Name**.

## Step 4: Install & Run
1.  Click the **Play Button (▶️)** at the top-left of Xcode.
2.  Wait a moment. The Mac will "Build" the app and install it on your phone.
3.  **Important:** The app might install but not open immediately.
4.  Look at your iPhone screen. If you see an "Untrusted Developer" popup:
    *   Go to **Settings** -> **General** -> **VPN & Device Management**.
    *   Tap the "Apple Development..." text.
    *   Tap **"Trust [Your Email]"**.
5.  Go back to your home screen and tap the **FirstKnock** app icon.

**You are now ready to test!** 🚀
