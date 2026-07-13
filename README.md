# Webcam Publisher

**Turn a tablet, phone, or computer into a network camera—directly from its browser.**

Webcam Publisher sends a device's camera and optional microphone to a WHIP-compatible server. It works as a Home Assistant dashboard card or as a custom element on any web page. Point it at go2rtc to use the stream with Frigate, Home Assistant, or another compatible client.

The project is one dependency-free JavaScript file. It uses the browser's WebRTC support and WHIP, a standard protocol for sending WebRTC media to a server. You need a WHIP receiver; this guide uses go2rtc and Frigate, but you can provide the full URL of any compatible WHIP endpoint.

This is a **publisher**, not a viewer: it's a WHIP *ingest* client that makes a device *be* a camera. The usual camera card does the opposite — it *watches* an existing stream.

> **Just want to try it?** The [2-minute quickstart](examples/quickstart.md) runs entirely on localhost — no HTTPS, no certs, no reverse proxy.

---

## Features

- **Any compatible WHIP receiver** — by default, the card builds go2rtc's publish endpoint (`{base}/api/webrtc?dst={stream}`). You can instead enter a full WHIP endpoint URL and, if required, a bearer token.
- **Single active publisher per browser** — starting any stream stops/destroys every other session; you cannot publish two streams from one browser at once.
- **Automatic reconnection** — retries indefinitely with exponential backoff and jitter (1–20 seconds).
- **Stall detection** — reconnects if the browser reports no outbound media for 30 seconds.
- **Per-browser `localStorage` config** — everyday settings live in the card's gear panel, saved per browser under `webcam-publisher:settings`, not in the Lovelace config.
- **Headless autostart** — on load the Core reads `webcam-publisher:settings` directly; if `enabled` with a `stream`, it resumes publishing with no card UI visible (survives reboots).
- **Server templates** — pull the shared connection settings (`stream`, `go2rtc`, `whipUrl`, `iceServers`) from a URL; **Load template** prompts, prefilled with the server's default template location. Device ids, audio choices, and the bearer token stay kiosk-local.
- **Export / Import** — back up or restore the full settings as a JSON file.
- **Cooperative camera hand-off** — yields the physical camera to another card that needs it briefly (a call, intercom, push-to-talk) and reclaims it afterward. See [Cooperative camera hand-off](#cooperative-camera-hand-off).
- **Works as a card or a bare element** — a Home Assistant dashboard card (`type: custom:webcam-publisher`) or a standalone `<webcam-publisher>` element on any page.
- **Visual editor** — appears in the Home Assistant card picker and provides an editor for initial defaults.
- **HTTPS-aware** — warns on the card when not served from a secure context.
- **Releases the camera/mic when stopped** — clears the OS "camera in use" indicator whenever not publishing.

---

## How it works

The card captures local media and POSTs an SDP offer to the receiver's WHIP endpoint. With go2rtc (the WHIP ingest, shown below), go2rtc becomes the producer of the named stream; downstream consumers — Frigate, Home Assistant — pull it by the same stream key.

```
 ┌─────────────────────────┐    WHIP: POST /api/webrtc?dst=webcam         ┌──────────────┐
 │  Browser / kiosk tablet │  ──────────────────────────────────────────▶ │              │
 │  webcam-publisher       │        Content-Type: application/sdp          │    go2rtc    │
 │  getUserMedia() ─▶ SDP │  ◀──────── 201 + SDP answer + Location ─────  │ (stream:     │
 └─────────────────────────┘        DTLS/SRTP media over :8555             │  webcam)     │
                                                                           └──────┬───────┘
                                                     RTSP / WHEP / HLS / snapshot │
                                                                                  ▼
                                                                 ┌────────────────────────────┐
                                                                 │  Frigate (record/detect)    │
                                                                 │  Home Assistant camera      │
                                                                 │  any WebRTC/RTSP consumer   │
                                                                 └────────────────────────────┘
```

The exact WHIP handshake:

1. Build the endpoint URL. If a **WHIP endpoint URL** is set, that exact URL is used — any spec-compliant WHIP server. Otherwise the card builds go2rtc's convention: `{go2rtc}/api/webrtc?dst={stream}` (trailing slash on the base is trimmed).
2. Create an SDP offer, set it as the local description, and wait for ICE gathering to complete (**non-trickle**) — but always proceed after a 4s gather timeout with whatever candidates exist.
3. **POST** the offer SDP with `Content-Type: application/sdp` (10s timeout). If a bearer token is set, the request carries `Authorization: Bearer …`.
4. On `resp.ok`, read the answer via `resp.text()` and apply it as the remote description.
5. Store the teardown resource URL from the response `Location` header (resolved against the POST URL), and **DELETE** it on teardown (5s timeout, same `Authorization` header).

---

## Requirements

- **A secure browser context.** Serve the page or dashboard over HTTPS. Browsers also treat `localhost` as secure, which is useful for local testing. The card does not publish from an ordinary HTTP page.
- **go2rtc served over HTTPS.** That same secure-context rule means an HTTPS page can't POST to go2rtc's plain-HTTP `:1984` API, so go2rtc must serve HTTPS too. **Simplest: go2rtc's built-in TLS** — set `tls_listen` and point it at a cert/key ([`examples/go2rtc.yaml`](examples/go2rtc.yaml)); the browser just has to trust that cert (a real/Let's Encrypt cert, or import your own CA). A reverse proxy (Traefik/nginx) is a more advanced alternative that can auto-manage Let's Encrypt certs — see [`examples/secure-reverse-proxy.md`](examples/secure-reverse-proxy.md). (The WebRTC **media** on `:8555` stays peer-to-peer and is *not* proxied either way.)
- **A WHIP-capable receiver.** This guide recommends Frigate through go2rtc for recording and object detection. Frigate includes go2rtc, or you can run go2rtc separately. With go2rtc, predeclare the target stream, set `api.origin: "*"`, and make the WebRTC media port (`8555` TCP and UDP by default) reachable from the browser. For another WHIP server, enter its full endpoint in **WHIP endpoint URL**.
- **A modern browser or Android WebView** with WebRTC + `getUserMedia` support.

> **Do not put HTTP auth on the ingest go2rtc's API when publishing cross-origin from a browser.** go2rtc's auth wraps CORS and does not bypass the `OPTIONS` preflight, so a credential-less preflight 401s and the publish fails. Enforce access at the reverse proxy or by network instead. (Servers that take an `Authorization: Bearer` header — MediaMTX, most cloud WHIP endpoints — can use the card's bearer token setting.)

---

## Usage

`webcam-publisher` is a standard custom element. Use it on any web page; the Home Assistant dashboard card uses the same element with Home Assistant's card hooks.

### In any web page

Load the module and drop in the element:

```html
<script
  type="module" 
  src="https://cdn.jsdelivr.net/gh/markfrancisonly/webcam-publisher@main/webcam-publisher.js">
</script>

<webcam-publisher
  go2rtc="https://go2rtc-server:1984"
  stream="webcam"
  ice='[{"urls":"stun:stun.l.google.com:19302"}]'>
</webcam-publisher>
```

To publish to any WHIP server instead of go2rtc, use `whip-url` (and `bearer-token` if it needs auth):

```html
<webcam-publisher whip-url="https://mediamtx-server:8889/webcam/whip" bearer-token="…" stream="webcam"></webcam-publisher>
```

Attributes seed the **first run only** (see the callout below); everyday config lives in the gear panel, saved per browser. Serve the page over **HTTPS** (or `http://localhost`) — browsers only allow camera/mic capture on a secure origin. A full runnable page is in [`examples/plain-html.html`](examples/plain-html.html).

### In Home Assistant (Lovelace card)

```yaml
type: custom:webcam-publisher
# Everything below is optional and is used only on the first run (see the note):
stream: webcam
go2rtc: https://go2rtc-server:1984
ice: '[{"urls":"stun:stun.l.google.com:19302"}]'
enabled: false
# To publish to a non-go2rtc WHIP server instead:
# whipUrl: https://mediamtx-server:8889/webcam/whip
# bearerToken: REPLACE_WITH_TOKEN
```

The card's `whipUrl` / `bearerToken` options are the same as the element's `whip-url` / `bearer-token` attributes. A fuller set of first-run examples — TURN, non-go2rtc WHIP, and the bare minimum — is in [`examples/home-assistant-card.yaml`](examples/home-assistant-card.yaml).

### The gear panel is where day-to-day config lives

Open the settings panel with the **gear** button. A **Server type** dropdown picks **go2rtc** (enter a base URL + stream) or **Generic WHIP** (enter a full endpoint URL + optional bearer token) — it shows only the fields for the chosen type. You also set the stream name, ICE servers, camera, and microphone here. **Import**, **Export**, and **Load template** appear in the Configuration section.

- **Enabled is a live test.** Toggling it starts/stops publishing immediately using the current unsaved form values, and it persists the Enabled flag *right away* so an always-on device auto-resumes after a reboot. The other edited fields still wait for Apply.
- **Apply** = Save: persists the whole form, starts or stops per `enabled`, and closes the panel.
- **Cancel** fully reverts (including undoing a live Enable test) and closes.
- **Load template** prompts for a URL, prefilled with a relative, same-origin default path (so it won't hit CORS) — see [server templates](examples/templates/README.md).

A status pill (idle / streaming / error) with a colored dot sits above; click it to toggle a scrollable log (capped at 200 lines). The log only appends when the message actually changes, so the 15s watchdog "streaming" renewal doesn't flood it.

> ### First-run defaults and saved browser settings
>
> The dashboard card options (`stream`, `go2rtc`, `whipUrl`, `bearerToken`, `ice`, `enabled`) and equivalent HTML attributes provide defaults only when the card first runs in a browser with no saved settings. After settings exist in `localStorage` (`webcam-publisher:settings`, `_initialized: true`), the card ignores those defaults.
>
> Everyday settings live **in the card itself** (the gear panel) and are **saved per browser**. To change a running kiosk's stream/URL/devices, edit them in the gear panel on that device — not in the dashboard YAML.

---

## Set up go2rtc (the WHIP ingest)

go2rtc is the **WHIP ingest** — the piece that actually accepts the browser's publish. It feeds the recommended receiver, **Frigate** (and Home Assistant), so configure it first: the Frigate config below builds on it. go2rtc isn't the only option — any WHIP-capable server works via the **WHIP endpoint URL** setting (e.g. MediaMTX: `https://mediamtx-server:8889/webcam/whip`).

See [`examples/go2rtc.yaml`](examples/go2rtc.yaml) for a full standalone config. The essentials:

```yaml
streams:
  # Empty source (YAML null) = receive-only. MUST be predeclared for dst= to work.
  webcam:

api:
  origin: "*"            # CORS. Only "*" is supported. Do NOT set api auth for browser publishing.
  tls_listen: ":1984"    # HTTPS (required for browser publishing; plain `listen` works on localhost only)
  tls_cert: "/config/cert.pem"
  tls_key:  "/config/key.pem"

webrtc:
  listen: ":8555"        # DTLS/SRTP media (TCP+UDP). MUST be directly reachable by the browser.
  candidates:
    - 10.0.0.10:8555     # advertise the go2rtc host's reachable LAN IP
```

Key points:

- **Predeclare the stream.** `POST /api/webrtc?dst=webcam` returns `404 StreamNotFound` if `webcam` doesn't already exist — `dst=` does not auto-create. The empty `webcam:` (YAML null) idiom is exactly the "browser as a camera" flow.
- **One endpoint.** go2rtc has a single `/api/webrtc` route: `dst=` publishes (WHIP), `src=` consumes (WHEP/JSON/raw SDP). There is no `/api/whip`.
- **Serve it over HTTPS.** `getUserMedia()` needs a secure context, so the `:1984` API must be HTTPS. Simplest is go2rtc's built-in `tls_listen` + a browser-trusted cert (shown in [`examples/go2rtc.yaml`](examples/go2rtc.yaml)); a reverse proxy is the more advanced option. WebRTC media on `:8555` is DTLS/SRTP peer-to-peer and is **not** proxied — publish/forward `8555/tcp` + `8555/udp` and point `webrtc.candidates` at the reachable IP.
- **Location header for DELETE.** go2rtc sets `Access-Control-Allow-Origin` but not `Access-Control-Expose-Headers`, so a cross-origin client can't read `Location` (needed for the teardown `DELETE`) unless the proxy adds `Access-Control-Expose-Headers: Location`. It's optional — go2rtc auto-removes the producer when the peer connection closes.

Reverse-proxy examples (Traefik + nginx) with the CORS/Location details are in [`examples/secure-reverse-proxy.md`](examples/secure-reverse-proxy.md).

---

## Configuration

### Dashboard card options — *initial defaults only*

| Option | Config key(s) | Attribute | Notes |
|---|---|---|---|
| Server type | `serverType` | `server-type` | `go2rtc` (base URL + stream) or `whip` (explicit endpoint). Picks which fields apply; a seeded `whipUrl` implies `whip`. |
| Stream name | `stream` | `stream` | Destination stream name; with go2rtc it becomes `?dst=`. |
| go2rtc base URL | `go2rtc` | `go2rtc` | Used when server type is `go2rtc`. Base URL; trailing slash trimmed. |
| WHIP endpoint URL | `whipUrl` | `whip-url` | Used when server type is `whip`. Full endpoint URL of any WHIP server. |
| Bearer token | `bearerToken` | `bearer-token` | Sent as `Authorization: Bearer …` on WHIP POST/DELETE. YAML/attribute only — not in the visual editor. |
| ICE servers | `ice` or `iceServers` | `ice` | JSON string of ICE servers. |
| Auto-enable | `enabled` (boolean) | `enabled` | Attribute is treated as `true` unless the string is `"false"`. |

All options are applied **only** on first run in a fresh browser (when `!_initialized`). `getConfigElement()` returns the editor; `getStubConfig()` returns `{}`; `getCardSize()` returns `6`.

### Per-browser `localStorage` fields (key: `webcam-publisher:settings`)

`iceServers` is stored as a JSON **string** and normalized to an array only at start time.

| Field | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | `false` | Master on/off; headless-autostarts and persists immediately on the live toggle. |
| `serverType` | string | `"go2rtc"` | `"go2rtc"` (base URL + stream) or `"whip"` (explicit endpoint URL); picks which URL the card publishes to and which gear fields show. |
| `go2rtc` | string | `"https://go2rtc-server:1984"` | go2rtc base URL (server type `go2rtc`); trailing slash trimmed when building the WHIP URL. |
| `stream` | string | `"webcam"` | Stream name; with go2rtc it is the `?dst=` destination, with an explicit WHIP URL it labels the session locally. |
| `whipUrl` | string | `""` | Full WHIP endpoint URL; used when `serverType` is `"whip"`. Applied by templates. |
| `bearerToken` | string | `""` | Optional; sent as `Authorization: Bearer …` on WHIP POST/DELETE. Kiosk-local — never applied by templates. |
| `iceServers` | string (JSON) | `'[{"urls":"stun:stun.l.google.com:19302"}]'` | Stored as a STRING; parsed to an array for `RTCPeerConnection`. |
| `deviceId` | string | `""` | Video input deviceId; kiosk-local, never overwritten by a template. |
| `micDeviceId` | string | `""` | Audio input deviceId; kiosk-local. |
| `audioEnabled` | boolean | `true` | Include microphone; kiosk-local. |

There is also an internal, non-user field `_initialized` (boolean, default `false`) that gates whether first-run defaults are applied. It is stripped from exported JSON.

Video/audio constraints are capability-aware and use `ideal` (not `exact`) — e.g. 1280×720@30, 16:9, mono 48kHz, with echo cancellation / noise suppression / auto gain control on — and default to the `environment`-facing camera when no device is chosen.

---

## Frigate + Home Assistant

**Frigate is the recommended receiver in this guide.** It can record the stream, run object detection, and expose the camera to Home Assistant. Frigate receives the WHIP stream through either its bundled go2rtc or a separate go2rtc server.

Browsers send VP8/VP9/H264 video + Opus audio. RTSP transport and Frigate's mp4 recording need **H264 (+ AAC)**, so normalize on the ingest go2rtc — it holds the raw WebRTC producer:

```yaml
streams:
  webcam:
  webcam_h264: ffmpeg:webcam#video=h264#audio=aac
```

Two ready-to-use Frigate configs: [`examples/frigate-external-go2rtc.yaml`](examples/frigate-external-go2rtc.yaml) — Frigate restreams from the dedicated ingest go2rtc (recommended when you already run go2rtc) — and [`examples/frigate.yaml`](examples/frigate.yaml) — Frigate's own embedded go2rtc receives the browser WHIP directly (no separate go2rtc).

To add the stream to Home Assistant, use **Settings → Devices & services → Add Integration → Generic Camera**. Set **Stream Source URL** to `rtsp://go2rtc-server:8554/webcam_h264` and **Still Image URL** to `http://go2rtc-server:1984/api/frame.jpeg?src=webcam_h264`.

For low-latency / two-way in Lovelace, the AlexxIT WebRTC card can point straight at go2rtc: `url: "webrtc:http://go2rtc-server:1984/api/webrtc?src=webcam"`. See [`examples/home-assistant-camera.yaml`](examples/home-assistant-camera.yaml) for both the camera-entity and low-latency-card options in full.

> **Can I use HA's own built-in go2rtc?** Not the bundled instance directly (it's localhost-only, no CORS/TLS, auto-managed) — but you can run one go2rtc and point HA at it, or just use Frigate's. See [`examples/home-assistant-go2rtc.md`](examples/home-assistant-go2rtc.md).

---

## Cooperative camera hand-off

This card is an **always-on holder** of the camera and mic. If another card needs the camera briefly — a call, intercom, doorbell talk-back, push-to-talk — it announces itself with two `window` events and this card releases the device, then resumes:

```js
// before getUserMedia — ask current holders to release the camera:
const claim = new CustomEvent("camera:claim", { detail: { id: "my-card", willRelease: false } });
window.dispatchEvent(claim);
if (claim.detail.willRelease) {
  // a holder is releasing; wait for the device to free (retry getUserMedia, ~0.8s on Android)
}

// when finished — let holders resume:
window.dispatchEvent(new CustomEvent("camera:release", { detail: { id: "my-card" } }));
```

Use a stable, unique `id` and reuse it for the matching release. Claims are **reference-counted**, so several acquirers can overlap — this card resumes only after the last one is released. There's no dependency on this card: if no holder is present the events are no-ops.

A drop-in helper — a one-shot `withCamera()` and a debounced `CameraCoordinator` for rapid back-to-back use — is in [`examples/camera-coordination.js`](examples/camera-coordination.js).

---

## Troubleshooting

- **Camera never starts / HTTPS warning.** `getUserMedia()` requires a secure context. Serve the page over HTTPS (or from `localhost`). The card shows *"Camera/mic usually require HTTPS; current: &lt;protocol&gt;"* when it isn't.
- **Publish fails at the preflight (CORS/auth) — go2rtc.** Set go2rtc `api.origin: "*"` and **do not** set `api.username/password` on the ingest server — auth wraps CORS and 401s the credential-less `OPTIONS` preflight. Enforce access at the proxy/network. If the teardown `DELETE` never fires cross-origin, add `Access-Control-Expose-Headers: Location` at the proxy.
- **`404 StreamNotFound` — go2rtc.** The `dst=` stream must be predeclared in go2rtc (`webcam:`); `dst=` does not auto-create.
- **Publish rejected by a non-go2rtc WHIP server.** Set **Server type** to *Generic WHIP*, enter the full **WHIP endpoint URL**, and add a **Bearer token** if the server requires auth. The server must accept the CORS preflight from your dashboard's origin.
- **Template fetch failed.** The card fetches exactly the URL you confirm in the prompt. A `404` just means no template file exists at that path (default: `<script directory>/webcam-publisher/<stream>.json`) — create one or type a different URL. Cross-origin URLs need CORS enabled on the serving host.
- **Device dropdowns show "Camera 1" / "Mic 1".** Labels only appear after permission is granted, because `enumerateDevices` runs without `getUserMedia` (no prompt before enable). The card notes *"Device labels will appear after you grant camera/mic permission on first Start."* A saved `deviceId`/`micDeviceId` is preserved — blank ids never overwrite the saved selection.
- **Can't publish two streams from one browser.** By design — starting any stream destroys all other sessions. One active publisher per browser.
- **Remote / NAT.** For a LAN kiosk use no STUN/TURN and set `webrtc.candidates: [10.0.0.10:8555]`. For remote publishing set `candidates: [stun:8555]` (or a static public IP + forward `8555` udp/tcp), and add TURN on both sides if either peer is behind symmetric NAT/CGNAT.
- **"Not connected" / stalls.** Reconnection is automatic and indefinite with exponential backoff + jitter. A `disconnected` state waits a 5s grace before reconnecting (usually transient); `failed`/`closed` reconnect immediately. The 15s watchdog reconnects on a 30s byte-stall. Reconnection is also re-kicked on tab `visibilitychange`, `online`, `devicechange`, and track `onended` — but only while running and not currently connected.
- **Android WebView quirks** are handled: `getUserMedia` is timeout-guarded (12s) because it can hang after sleep/wake; `devicechange` events are ignored while connected (some WebViews fire them on every wake); a truly-gone device is caught by the track `onended` handler.
- **Malformed ICE JSON** falls back to an empty array rather than throwing.

---

## Home Assistant setup

For a plain web page there is nothing to install — load the module as shown in [Usage](#in-any-web-page). The steps below are only for adding it to a Home Assistant dashboard.

### HACS (recommended)

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=markfrancisonly&repository=webcam-publisher&category=plugin)

<details>
<summary>Step-by-step HACS installation</summary>

1. Open **HACS** in your Home Assistant dashboard
2. Click the **⋮** menu (top right) → **Custom repositories**
3. Add this URL and set the category to **Dashboard**, then click **Add**:
   ```text
   https://github.com/markfrancisonly/webcam-publisher
   ```

</details>

### Home Assistant manual installation

1. Copy `webcam-publisher.js` into the HA config www folder: `/config/www/webcam-publisher.js` (create `www` if it doesn't exist; a restart is needed the first time `/config/www` is created so `/local/` starts being served).
2. Register it as a dashboard resource: **Settings → Dashboards → ⋮ → Resources → + Add resource**
   - URL: `/local/webcam-publisher.js`
   - Type: **JavaScript Module**

   (If the Resources menu is missing, enable **Advanced Mode** on your user profile, or you're in YAML mode — then add it under `lovelace: resources:` with `type: module`.)
3. Hard-refresh the browser (Ctrl/Cmd-Shift-R).
4. Use it: `type: custom:webcam-publisher`.
