# Quickstart: publish a webcam locally

Everything below runs on **localhost**, which browsers treat as a **secure context** — so
`getUserMedia()` works over plain HTTP and you need **no certs, no HTTPS, no reverse proxy** to try
it. (Publishing from *another* device — a wall tablet on your LAN — does need HTTPS; the simplest
way is go2rtc's built-in TLS, shown in [`go2rtc.yaml`](go2rtc.yaml). See [Going past
localhost](#going-past-localhost).)

## 1 · Run go2rtc

Save this as `go2rtc.yaml`:

```yaml
streams:
  webcam:                                             # empty = receive the browser's WHIP publish
  webcam_h264: ffmpeg:webcam#video=h264#audio=aac     # transcode for Frigate or RTSP (optional)
api:
  listen: ":1984"                                     # plain HTTP is fine on localhost (secure context)
  origin: "*"                                         # let the browser page POST cross-origin
webrtc:
  listen: ":8555"                                     # WebRTC media (TCP + UDP)
  candidates:
    - 127.0.0.1:8555                                  # localhost — reachable by the browser
```

Start it with the API and media ports published to the host:

```bash
docker run --rm \
  -p 1984:1984 \
  -p 8555:8555/tcp \
  -p 8555:8555/udp \
  -v "$PWD/go2rtc.yaml:/config/go2rtc.yaml:ro" \
  alexxit/go2rtc
```

## 2 · Serve the publisher page

Next to `webcam-publisher.js`, save this as `index.html`:

```html
<!doctype html>
<meta charset="utf-8">
<script type="module" src="webcam-publisher.js"></script>
<webcam-publisher go2rtc="http://127.0.0.1:1984" stream="webcam"></webcam-publisher>
```

Serve it over `http://localhost` (a secure context — `file://` will not work):

```bash
python3 -m http.server 8080     # then open http://localhost:8080
```

## 3 · Publish

Open the gear panel, choose your camera, and turn on **Enabled**. The status pill turns green. Confirm go2rtc
sees it at <http://127.0.0.1:1984>: the `webcam` stream now has a producer. That's the whole loop,
no TLS.

---

## Feed it into Frigate (the recommended receiver)

Frigate bundles go2rtc, so you can publish **straight into a reference Frigate install** and get
recording, object detection, and a Home Assistant camera—without a separate go2rtc server:

1. Add [`frigate.yaml`](frigate.yaml) to your Frigate config. For a local test set its
   `webrtc.candidates` to `127.0.0.1:8555` and drop the `tls_*` lines (localhost needs no cert).
2. Point the card at Frigate's own go2rtc: `go2rtc="http://127.0.0.1:1984"`
   From another device, use `https://<frigate-host>:1984` with a browser-trusted certificate.
3. Publish. Frigate records the `webcam` stream and runs detection on it.

Already running the standalone go2rtc from step 1? Keep it and use
[`frigate-external-go2rtc.yaml`](frigate-external-go2rtc.yaml) instead — Frigate pulls the normalized
`webcam_h264` from it.

## Going past localhost

The moment the browser isn't on `localhost`, both the page **and** go2rtc need HTTPS. Simplest is
go2rtc's built-in TLS — set `tls_listen` and point it at a browser-trusted cert, shown in
[`go2rtc.yaml`](go2rtc.yaml) and [`frigate.yaml`](frigate.yaml). A reverse proxy is the more
advanced alternative: [`secure-reverse-proxy.md`](secure-reverse-proxy.md).
