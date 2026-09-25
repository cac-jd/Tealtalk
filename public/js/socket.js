// WebSocket connection with exponential-backoff reconnect and heartbeat.

const PING_EVERY = 25000;
const PONG_TIMEOUT = 10000;
const MAX_BACKOFF = 30000;

export class Socket {
  /**
   * @param {object} opts
   * @param {() => string|null} opts.getToken
   * @param {(msg: object) => void} opts.onMessage
   * @param {(state: 'connecting'|'open'|'offline') => void} opts.onState
   * @param {() => void} opts.onOpen      called on every (re)connect
   * @param {() => void} opts.onAuthFail  server closed with 4401
   */
  constructor(opts) {
    this.opts = opts;
    this.ws = null;
    this.attempt = 0;
    this.stopped = true;
    this.retryTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
    this.state = 'offline';

    this.handleOnline = () => this.reconnectNow();
    this.handleOffline = () => {
      this.setState('offline');
      if (this.ws) this.ws.close();
    };
    this.handleVisible = () => {
      if (document.visibilityState === 'visible') {
        if (!this.ws || this.ws.readyState > WebSocket.OPEN) this.reconnectNow();
        else this.ping(); // verify a possibly half-dead socket after resuming
      }
    };
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);
    document.addEventListener('visibilitychange', this.handleVisible);
    this.connect();
  }

  stop() {
    this.stopped = true;
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
    document.removeEventListener('visibilitychange', this.handleVisible);
    clearTimeout(this.retryTimer);
    this.clearHeartbeat();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onclose = null;
      ws.close();
    }
    this.setState('offline');
  }

  get isOpen() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  send(obj) {
    if (!this.isOpen) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.opts.onState(state);
  }

  connect() {
    if (this.stopped) return;
    const token = this.opts.getToken();
    if (!token) return;
    clearTimeout(this.retryTimer);
    this.setState(navigator.onLine === false ? 'offline' : 'connecting');

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.setState('open');
      this.startHeartbeat();
      this.opts.onOpen();
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'pong') {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
        return;
      }
      this.opts.onMessage(msg);
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearHeartbeat();
      if (event.code === 4401) {
        this.stop();
        this.opts.onAuthFail();
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      /* onclose follows */
    };
  }

  scheduleReconnect() {
    if (this.stopped) return;
    this.setState(navigator.onLine === false ? 'offline' : 'connecting');
    const base = Math.min(MAX_BACKOFF, 1000 * 2 ** this.attempt);
    const delay = base / 2 + Math.random() * (base / 2); // jitter
    this.attempt = Math.min(this.attempt + 1, 10);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  reconnectNow() {
    if (this.stopped) return;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.attempt = 0;
    this.connect();
  }

  startHeartbeat() {
    this.clearHeartbeat();
    this.pingTimer = setInterval(() => this.ping(), PING_EVERY);
  }

  ping() {
    if (!this.isOpen || this.pongTimer) return;
    this.send({ type: 'ping' });
    const ws = this.ws;
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      // No pong: the connection is dead even if the browser hasn't noticed.
      // Don't wait for a closing handshake that will never come.
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearHeartbeat();
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      this.scheduleReconnect();
    }, PONG_TIMEOUT);
  }

  clearHeartbeat() {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }
}
