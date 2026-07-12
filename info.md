# Webcam Publisher

**Turn a tablet, phone, or computer into a network camera—directly from its browser.**

Webcam Publisher is a Home Assistant dashboard card and standalone custom element. It sends the device's camera and optional microphone to a WHIP-compatible server. The project is one dependency-free JavaScript file. Use it with Frigate through [go2rtc](https://github.com/AlexxIT/go2rtc), or provide any compatible WHIP endpoint. Settings are saved separately in each browser.

**Requirements:** the page must be served over **HTTPS** (or `localhost`) for the browser to grant camera/microphone access, and you need a reachable WHIP receiver — a go2rtc endpoint (e.g. `https://go2rtc-server:1984`) or any WHIP server via the card's WHIP endpoint URL setting.

Add it to a dashboard with `type: custom:webcam-publisher`. See the [README](https://github.com/markfrancisonly/webcam-publisher#readme) for full setup and configuration.
