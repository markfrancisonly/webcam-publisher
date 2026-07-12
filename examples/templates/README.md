# Server templates

The **Load template** button pulls a per-stream config file from a URL, so a fleet of kiosks can be centrally seeded without editing each one's gear panel.

- Clicking **Load template** prompts for a URL, prefilled with the default location as a **relative, same-origin path**: `<script directory>/webcam-publisher/<stream>.json`, derived from wherever `webcam-publisher.js` was loaded (falls back to a page-relative `./webcam-publisher/`, so no host root like HA's `/local/` is baked in). A relative path stays on the dashboard's own origin, so it never trips a CORS preflight. You can still type any reachable URL — but a cross-origin one needs CORS enabled on that server.
- The card fetches **exactly** the confirmed URL — no alternate candidates are tried. A cache-busting `t` timestamp is appended and the fetch uses `cache: "no-store"`, so edits take effect immediately (8s fetch timeout).
- A template applies **ONLY** the four shared connection keys: `stream`, `go2rtc`, `whipUrl`, and `iceServers` (still a JSON **string**). Device ids, `enabled`, audio choices, and `bearerToken` are kiosk-local and are **never** overwritten by a template.
- **Import** reads a selected `.json` and applies the full config, merging only the known keys (`enabled, go2rtc, stream, whipUrl, bearerToken, iceServers, deviceId, micDeviceId, audioEnabled`).
- **Export** downloads the full current settings as `<stream>.json` (default `webcam.json`), stripping `_initialized` and normalizing `iceServers` to a string.

[`webcam.json`](webcam.json) in this folder is a ready-to-edit example. To add a TURN server (for kiosks that publish across NAT/CGNAT), extend `iceServers` — it is a JSON **string**:

```json
{
  "stream": "webcam",
  "go2rtc": "https://go2rtc-server:1984",
  "whipUrl": "",
  "iceServers": "[{\"urls\":\"stun:stun.l.google.com:19302\"},{\"urls\":\"turn:turn.example.com:3478\",\"username\":\"USER\",\"credential\":\"PASS\"}]"
}
```
