# Using Home Assistant's built-in go2rtc

Home Assistant 2024.11+ bundles **go2rtc** (it replaced RTSPtoWebRTC and powers WebRTC
playback for camera entities). Natural question: can the browser publish straight into
*that* go2rtc?

**Short answer: not the bundled instance directly.** By default HA's go2rtc:

- listens on **`127.0.0.1:1984`** (localhost inside HA) — a browser on a tablet or phone
  can't reach it;
- has **no CORS** (`api.origin`) and **no TLS** — a WHIP publish from an HTTPS dashboard is
  blocked (see [Requirements](../README.md#requirements));
- is **auto-managed** — you can't easily predeclare an empty `webcam:` receive stream for
  WHIP ingest.

So a browser publisher needs a go2rtc **you** control. Two clean options:

## Option A — one shared go2rtc, and point HA at it

Run a standalone go2rtc ([`go2rtc.yaml`](go2rtc.yaml)) that the browser can reach (CORS `*`,
TLS, `:8555` open). Then tell HA to use **that same instance** instead of its bundled one,
so HA's own camera WebRTC and your publisher share a single go2rtc:

```yaml
# configuration.yaml
# NOTE: confirm the exact key(s) against your HA version's "go2rtc" integration docs —
# HA has been evolving this. The intent is "use my external go2rtc, not the bundled one."
go2rtc:
  url: "https://go2rtc-server:1984"
```

## Option B — use Frigate's go2rtc (usually simplest)

If you run Frigate, it already bundles a go2rtc that's exposed on your network. Publish
straight into it ([`frigate.yaml`](frigate.yaml)); Frigate records + detects, and HA sees it
through the Frigate integration. Fewest moving parts, and Frigate is the recommended
receiver anyway.

## Then surface it as an HA camera

Either way, add the published stream as a camera **entity** so it shows on dashboards, drives
automations, and can be sent in notifications — see
[`home-assistant-camera.yaml`](home-assistant-camera.yaml).
