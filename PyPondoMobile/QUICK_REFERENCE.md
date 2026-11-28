# Quick Reference: Mobile Equipment Scanner

## Student flow

1. Open the app while connected to the same network as the Techpuls system.
2. Tap **Scan equipment QR** and scan the label.
3. Enter your full name, program, and year.
4. Tap **Submit details**. The app confirms when the record is saved.

The app searches for the system in the background. Students do not need an account or server address.
New equipment labels open a direct link to that item on the system. A phone's built-in camera opens
the equipment page in a browser; the app's scanner loads the linked item directly. Older token-only
labels still work in the app through background system discovery. Reprint them from the equipment QR
page if they should open a system link with the phone camera.

## Staff records

In the desktop system, open **Equipment → Reports** and review **Mobile equipment scan records**.
Each entry includes the student details, equipment, and submission time.

## Troubleshooting

- **System not found:** Make sure the Techpuls server is running and the phone is on the same
  network. Tap **Retry system search**.
- **QR not recognized:** Check that the label is an active Techpuls equipment QR code or link.
- **Camera unavailable:** Allow camera access or expand the manual QR entry section.
- **Save failed:** Confirm the system is online, then retry the submission.

## Build

From the pypondo-web folder, run npm run build. Use build_android.bat or build_android.ps1 to
assemble the APK.
