# Mobile System Discovery

The mobile scanner searches for the Techpuls system in the background. Students open directly to the
equipment scanner; there is no login or server connection setup screen.

## How discovery works

1. A browser build first checks the Techpuls system at its own origin.
2. The app checks the last reachable system saved on the device.
3. If needed, it searches nearby gateways and the local subnet for Techpuls servers.
4. When a system responds, the scanner uses it for equipment lookup and scan submissions.

Keep the phone on the same network as the system. Tap **Retry system search** if the server starts
after the app or becomes available later.

## Student workflow

1. Scan an equipment QR label.
2. Enter a full name, program, and year.
3. Submit the details. The system stores the scan with the equipment and submission time.
4. Staff review saved entries under **Equipment → Reports**.

## Troubleshooting

- Confirm the Techpuls server is running and reachable on the local network.
- Check that the phone and server are connected to the same Wi-Fi or local network.
- Confirm the server firewall allows its configured port.
- If camera access is unavailable, enter the QR value manually.
- If a QR code was deactivated, ask staff to print an active equipment label.

See CROSS_LAN_DISCOVERY.md for details about the gateway and subnet discovery implementation.
