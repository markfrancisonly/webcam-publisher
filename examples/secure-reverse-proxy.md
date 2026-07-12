# HTTPS + CORS in front of go2rtc (for browser WHIP publishing)

> **Why this is needed:** browsers only allow camera capture over HTTPS, and an HTTPS page cannot POST to go2rtc's plain-HTTP `:1984` API — so without TLS in front of go2rtc, publishing from the browser simply fails.

`getUserMedia()` requires a secure context, so the go2rtc **signaling API**
(`:1984`) must be served over HTTPS. Put a reverse proxy in front of it (or use
go2rtc's native `tls_listen`).

## The one caveat that trips everyone up

**Only the go2rtc HTTP API (`:1984`) is proxied.** The actual WebRTC **media**
travels DTLS/SRTP over `webrtc.listen` (`:8555`, **both TCP and UDP**) directly
between the browser and go2rtc, using the addresses advertised in
`webrtc.candidates`. That media path is peer-to-peer and is **NOT** carried by
Traefik/nginx.

So you must ALSO:

- Publish/forward `8555/tcp` **and** `8555/udp` on the go2rtc host so the
  browser can reach it directly.
- Point `webrtc.candidates` at an IP the browser can actually reach
  (LAN IP for kiosks, public IP for remote — see `examples/go2rtc.yaml`).

Proxying `:1984` alone will complete signaling but the media will never flow.

## CORS: expose the `Location` header

go2rtc's `api.origin: "*"` already sends `Access-Control-Allow-Origin: *`, but it
does **not** send `Access-Control-Expose-Headers`. Cross-origin, the browser then
cannot read the `Location: webrtc?id=<id>` header from the 201 response, so it
cannot issue the `DELETE /api/webrtc?id=<id>` teardown.

This is **optional** — go2rtc auto-removes the producer when the peer connection
closes — but if you want clean explicit teardown, expose the header at the proxy.
Do **not** re-add `Access-Control-Allow-Origin` at the proxy; go2rtc already sends
it and a duplicate value makes browsers reject the response.

Also **keep the go2rtc API unauthenticated** for browser publishing. go2rtc's
auth wraps CORS and does not bypass the `OPTIONS` preflight, so a credential-less
preflight would 401 before any CORS header is written. Enforce access control at
the proxy (allow-list / mTLS / IP rules) or at the network layer instead.

---

## Traefik (labels on the standalone go2rtc container)

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.go2rtc.rule=Host(`go2rtc-server`)"
  - "traefik.http.routers.go2rtc.entrypoints=websecure"
  - "traefik.http.routers.go2rtc.tls=true"
  - "traefik.http.routers.go2rtc.tls.certresolver=le"
  # Signaling/API only. WebRTC media does NOT pass through here.
  - "traefik.http.services.go2rtc.loadbalancer.server.port=1984"
  # Expose ONLY the Location header (go2rtc already sends ACAO:* itself --
  # re-adding it here would duplicate the header and the browser would error).
  - "traefik.http.middlewares.go2rtc-cors.headers.accessControlExposeHeaders=Location"
  - "traefik.http.routers.go2rtc.middlewares=go2rtc-cors"
```

Remember: `8555/tcp` + `8555/udp` still have to be reachable directly (publish
them on the host / forward them at the firewall); Traefik does not touch them.

---

## nginx (server block)

```nginx
server {
    listen 443 ssl http2;
    server_name go2rtc-server;

    ssl_certificate     /etc/ssl/go2rtc.crt;
    ssl_certificate_key /etc/ssl/go2rtc.key;

    location / {
        proxy_pass http://127.0.0.1:1984;        # signaling / API only
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;   # for the WS candidate API
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;

        # go2rtc already sets Access-Control-Allow-Origin:* via api.origin:"*".
        # It omits Expose-Headers, which a cross-origin WHIP client needs to
        # read Location for the DELETE teardown. Do NOT also add ACAO here.
        add_header Access-Control-Expose-Headers "Location" always;
    }
}
```

WebRTC media (UDP + TCP `8555`) is peer-to-peer to go2rtc's `webrtc.listen`
using the advertised candidates and **must not** be proxied. Open `8555/udp` +
`8555/tcp` directly.
