// breathlink.js
// Desktop side of Air Brass: owns the phone-pairing session and the breath
// stream. One BreathLink = one QR session.
//
// Transport (negotiated automatically, both carry the same versioned frames):
//   1. Supabase Realtime channel `breath:<sessionId>` — signaling + relay
//      fallback. Works everywhere; ~cloud round-trip latency.
//   2. WebRTC DataChannel (unordered, no retransmits — fresh frames beat late
//      ones) — desktop offers as soon as the phone says hello; usually goes
//      p2p over the local WiFi for the lowest latency. If it never opens, the
//      relay keeps working and nobody notices.
//
// Frame schema (phone → desktop): { v:1, type:'breath', b:0..1, t:ms }
// Later phone sensors (tilt etc.) are new `type`s — nothing here changes.
//
// Events: on('breath', b) — normalized 0..1
//         on('status', s) — 'waiting' | 'connected' | 'lost' | 'expired'
// The QR/session expires after ttlMs if no phone ever connected; a connected
// session lives until stop().

'use strict';

// Dedupes/validates incoming frames across the relay↔RTC switchover (both
// paths can briefly deliver; timestamps decide) and tracks staleness for the
// lost-phone watchdog. Pure logic — exported for the Node tests.
class FrameGate {
  constructor() { this.lastT = -Infinity; this.lastAt = 0; }
  // → normalized breath value, or null if the frame is invalid/out-of-date.
  accept(p, nowMs) {
    if (!p || p.type !== 'breath' || typeof p.b !== 'number' || !isFinite(p.b)) return null;
    if (typeof p.t === 'number') {
      if (p.t <= this.lastT) return null;
      this.lastT = p.t;
    }
    this.lastAt = nowMs;
    return Math.max(0, Math.min(1, p.b));
  }
  stale(nowMs, maxAgeMs) { return this.lastAt > 0 && nowMs - this.lastAt > maxAgeMs; }
}

class BreathLink {
  constructor({ supabase, ttlMs = 5 * 60 * 1000 }) {
    this.supabase = supabase;
    this.ttlMs = ttlMs;
    this.handlers = new Map();
    this.channel = null;
    this.pc = null;
    this.gate = new FrameGate();
    this.status = 'idle';
    this.connectedOnce = false;
    this.sessionId = null;
    this.expiresAt = 0;
    this._timers = [];
  }

  on(ev, cb) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, []);
    this.handlers.get(ev).push(cb);
    return this;
  }
  _emit(ev, arg) { for (const cb of this.handlers.get(ev) || []) cb(arg); }
  _setStatus(s) { if (this.status !== s) { this.status = s; this._emit('status', s); } }

  // Start a session. Returns { sessionId, url, expiresAt } for the QR modal.
  async start() {
    this.stop();
    this.sessionId = crypto.randomUUID();
    this.expiresAt = Date.now() + this.ttlMs;
    this.gate = new FrameGate();
    this.connectedOnce = false;

    this.channel = this.supabase.channel(`breath:${this.sessionId}`, {
      config: { broadcast: { self: false, ack: false } },
    });
    this.channel.on('broadcast', { event: 'msg' }, ({ payload }) => this._onMessage(payload));
    await new Promise((resolve, reject) => {
      this.channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') resolve();
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(status));
      });
    });
    this._setStatus('waiting');

    // QR expiry: only matters while nothing has connected yet.
    this._timers.push(setTimeout(() => {
      if (!this.connectedOnce) { this._setStatus('expired'); this._teardown(); }
    }, this.ttlMs));

    // Lost-phone watchdog: no frame for 3s → 'lost' (app glides to neutral);
    // recovery is implicit — the next accepted frame flips back to connected.
    this._timers.push(setInterval(() => {
      if (this.status === 'connected' && this.gate.stale(Date.now(), 3000)) {
        this._setStatus('lost');
      }
    }, 1000));

    return {
      sessionId: this.sessionId,
      url: `${location.origin}/breath.html#s=${this.sessionId}`,
      expiresAt: this.expiresAt,
    };
  }

  _onMessage(p) {
    if (!p || !p.type) return;
    if (p.type === 'breath') {
      const b = this.gate.accept(p, Date.now());
      if (b === null) return;
      this.connectedOnce = true;
      if (this.status !== 'connected') this._setStatus('connected');
      this._emit('breath', b);
    } else if (p.type === 'hello') {
      this.connectedOnce = true;
      this._setStatus('connected');
      this._startRtc(); // relay already works; try to upgrade to p2p
    } else if (p.type === 'bye') {
      this._setStatus('lost');
    } else if (p.type === 'rtc-answer') {
      this.pc?.setRemoteDescription(p.sdp).catch(() => {});
    } else if (p.type === 'rtc-ice') {
      this.pc?.addIceCandidate(p.candidate).catch(() => {});
    }
  }

  _send(payload) {
    this.channel?.send({ type: 'broadcast', event: 'msg', payload }).catch?.(() => {});
  }

  async _startRtc() {
    if (typeof RTCPeerConnection === 'undefined') return; // relay-only env
    this._closeRtc(); // phone reloaded → renegotiate from scratch
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      this.pc = pc;
      const dc = pc.createDataChannel('breath', { ordered: false, maxRetransmits: 0 });
      dc.onmessage = (e) => {
        let p; try { p = JSON.parse(e.data); } catch (_) { return; }
        this._onMessage(p);
      };
      pc.onicecandidate = (e) => { if (e.candidate) this._send({ type: 'rtc-ice', candidate: e.candidate }); };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this._send({ type: 'rtc-offer', sdp: pc.localDescription });
    } catch (err) {
      console.warn('[breathlink] RTC setup failed, staying on relay', err);
      this._closeRtc();
    }
  }

  _closeRtc() {
    if (this.pc) { try { this.pc.close(); } catch (_) {} this.pc = null; }
  }

  _teardown() {
    for (const t of this._timers) { clearTimeout(t); clearInterval(t); }
    this._timers = [];
    this._closeRtc();
    if (this.channel) {
      try { this.supabase.removeChannel(this.channel); } catch (_) {}
      this.channel = null;
    }
  }

  stop() {
    this._teardown();
    if (this.status !== 'idle') { this.status = 'idle'; }
    this.sessionId = null;
  }
}

if (typeof module !== 'undefined') module.exports = { BreathLink, FrameGate };
