# Mobile Equipment Scanner

The Techpuls mobile app opens directly to an equipment scanner. It does not ask students to sign in
or configure a server address. It searches for the Techpuls system automatically on the local
network.

## Student workflow

1. Open the app and tap **Scan equipment QR**.
2. Scan the equipment label.
3. Enter a full name, program, and year.
4. Submit the form. The system saves the details with the equipment and submission time.
5. Staff can review records under **Equipment → Reports** in the desktop system.

New equipment labels contain a direct link to that equipment on the TechPulse system. Scanning the
label with the phone's regular camera opens the same equipment page and student form in a browser.
The in-app scanner reads the link and loads that equipment directly. Older labels with token-only
QR values continue to work in the app through automatic system discovery; reprint those labels from
the equipment QR page to make the phone camera open a system link. If camera scanning is unavailable,
the app provides a field for entering the QR value or link manually.

## Implementation

- Android uses the native Capacitor barcode scanner.
- Browser builds use the camera and BarcodeDetector when supported.
- The app discovers the server automatically and remembers the last reachable system.
- Public equipment scan endpoints validate active QR labels before returning equipment details or
  saving a submission.
- Scan submissions are stored in the community equipment database and appear in the staff Reports
  page.

## Build

From the pypondo-web folder, run npm run build to create the web app. The Android scripts also build
the web app before assembling the APK.
