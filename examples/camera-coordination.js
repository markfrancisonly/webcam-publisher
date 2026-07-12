// camera-coordination.js — reference "acquirer" for the Webcam Publisher cooperative camera protocol.
//
// Webcam Publisher is an always-on holder: while enabled it publishes the browser's camera and
// microphone continuously. If your card needs the camera for a while (a call, intercom, doorbell
// talk-back, push-to-talk), announce it so the holder releases the device, then release it back so
// the holder resumes.
//
// Protocol — two window events:
//   camera:claim   {detail: {id, willRelease}}  Dispatch before getUserMedia. Holders release the
//                                               device and set detail.willRelease = true synchronously.
//   camera:release {detail: {id}}               Dispatch when done. Holders reference-count claims by
//                                               id and resume after the last one is released.
//
// Use a stable, unique id per acquirer and reuse it for the matching release. There is no dependency
// on Webcam Publisher: if no holder is present, the events are simply no-ops (and getUserMedia still
// works — the claim just has no one to wait on).
//
// This file uses ES module exports. To use it in a non-module script, drop the `export` keywords and
// paste the functions into your IIFE.

// --- Bare protocol -----------------------------------------------------------------------------

// Ask cooperating holders to release the camera. Resolves once it is safe to call getUserMedia:
// immediately if no holder is releasing, or after a short wait for the device to actually free.
export function claimCamera(id, { releaseWaitMs = 800 } = {}) {
  const ev = new CustomEvent("camera:claim", { detail: { id, willRelease: false } });
  window.dispatchEvent(ev); // handlers run synchronously and may set detail.willRelease
  // A holder said it is releasing; wait out the device-release latency (Android is slow). For extra
  // robustness, retry getUserMedia on NotReadableError instead of a fixed wait.
  return ev.detail.willRelease ? new Promise((r) => setTimeout(r, releaseWaitMs)) : Promise.resolve();
}

// Tell holders you are done with the camera so they can resume. Pass the same id you claimed with.
export function releaseCamera(id) {
  window.dispatchEvent(new CustomEvent("camera:release", { detail: { id } }));
}

// --- One-shot helper: claim → use → release ----------------------------------------------------

// Acquire the camera, run `use(stream)`, then stop the tracks and release — even if `use` throws.
export async function withCamera(id, constraints, use) {
  await claimCamera(id); // holders step aside
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    return await use(stream);
  } finally {
    try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
    releaseCamera(id); // holders resume
  }
}

// --- Coordinator: one claim across back-to-back use --------------------------------------------
//
// If your feature turns on and off rapidly (for example successive calls), hold ONE claim for the
// whole active period and debounce the release, so the holder stays down until you are truly idle
// instead of thrashing the device. acquire() is idempotent and cancels a pending release.

export class CameraCoordinator {
  constructor(id, { releaseWaitMs = 800, idleReleaseMs = 1500 } = {}) {
    this.id = id;
    this.releaseWaitMs = releaseWaitMs;
    this.idleReleaseMs = idleReleaseMs;
    this._claimed = false;
    this._timer = null;
  }

  // Claim the camera (idempotent) and wait for the device to free. Cancels any pending release.
  async acquire() {
    clearTimeout(this._timer);
    this._timer = null;
    if (this._claimed) return;
    this._claimed = true;
    await claimCamera(this.id, { releaseWaitMs: this.releaseWaitMs });
  }

  // Schedule a release; a new acquire() before it fires keeps the holder down (no thrash).
  scheduleRelease() {
    if (!this._claimed) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._release(), this.idleReleaseMs);
  }

  _release() {
    clearTimeout(this._timer);
    this._timer = null;
    if (!this._claimed) return;
    this._claimed = false;
    releaseCamera(this.id);
  }
}

// --- Example usage -----------------------------------------------------------------------------
//
//   import { withCamera, CameraCoordinator } from "./camera-coordination.js";
//
//   // One-shot: grab the camera, use it, hand it back.
//   await withCamera("intercom", { video: true, audio: true }, async (stream) => {
//     myVideoEl.srcObject = stream;
//     await talkUntilDone();
//   });
//
//   // Back-to-back (e.g. a call feature): one claim for the whole active period.
//   const coord = new CameraCoordinator("my-call-card");
//   async function startCall() {
//     await coord.acquire();
//     const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
//     // ... run the call ...
//   }
//   function endCall() {
//     // stop your tracks first, then:
//     coord.scheduleRelease(); // a new startCall() before the debounce keeps the holder down
//   }
