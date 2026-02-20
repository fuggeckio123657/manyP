'use strict';

// ═══════════════════════════════════════════════════════════════════════
// LAYER 1 ─ Global Configuration & Constants
// ═══════════════════════════════════════════════════════════════════════

const CONFIG = {
  HEARTBEAT_INTERVAL : 2000,
  PEER_TIMEOUT       : 8000,
  MAX_PLAYERS        : 8,
  MIN_PLAYERS        : 2,
  SESSION_KEY        : 'story_relay_v3',
  DEFAULT_ROUNDS     : 2,
  DEFAULT_TURN_TIME  : 90,
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302'    },
    { urls: 'stun:stun1.l.google.com:19302'   },
    { urls: 'stun:stun.stunprotocol.org:3478' },
  ],
  FIREBASE: {
    apiKey           : 'AIzaSyBzzMXBgVXvUw2V8tRXw7sEFNQRg-zQEeY',
    authDomain       : 'manyp-a838a.firebaseapp.com',
    databaseURL      : 'https://manyp-a838a-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId        : 'manyp-a838a',
    storageBucket    : 'manyp-a838a.firebasestorage.app',
    messagingSenderId: '763662604590',
    appId            : '1:763662604590:web:e79e0f56e5fa31963a82bf',
  },
};

const MSG = {
  HB         : 'hb',
  HB_ACK     : 'hb_ack',
  GAME_STATE : 'game_state',
  ACTION     : 'action',
};

const ACTION = {
  LOCK        : 'lock',
  UNLOCK      : 'unlock',
  REVEAL_NEXT : 'reveal_next',
  RETURN_LOBBY: 'return_lobby',
};

const PHASE = {
  WAITING   : 'waiting',
  WRITING   : 'writing',
  REVEALING : 'revealing',
  FINISHED  : 'finished',
};

const EVT = {
  PLAYER_JOINED      : 'player:joined',
  PLAYER_LEFT        : 'player:left',
  PEER_CONNECTED     : 'peer:connected',
  PEER_DISCONNECTED  : 'peer:disconnected',
  GAME_STATE_UPDATED : 'game:state_updated',
  ACTION_RECEIVED    : 'action:received',
  ROOM_JOINED        : 'room:joined',
  TOAST              : 'ui:toast',
  RETURN_LOBBY       : 'ui:return_lobby',
  _ICE_CANDIDATE     : '_webrtc:ice',
};

// ═══════════════════════════════════════════════════════════════════════
// LAYER 2 ─ Utility Functions
// ═══════════════════════════════════════════════════════════════════════

const Utils = {
  genId      : ()      => Math.random().toString(36).slice(2, 11),
  genRoomCode: ()      => Math.random().toString(36).slice(2, 8).toUpperCase(),
  clamp      : (n,a,b) => Math.max(a, Math.min(b, n)),
  deepClone  : (o)     => JSON.parse(JSON.stringify(o)),

  shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  avatarColor(name) {
    const palette = [
      '#c9a84c','#4ac0a0','#9b85e8','#e07050',
      '#60b0e8','#d4807a','#80c870','#c080c8',
    ];
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
    return palette[h % palette.length];
  },

  escapeHtml(s = '') {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  /**
   * Given stories array and a step number, compute how many segments
   * have been revealed for each story.
   * Returns array of arrays (revealed segments per story).
   */
  computeReveal(stories, step) {
    const result = [];
    let rem = step;
    for (const story of stories) {
      const n = Math.min(rem, story.length);
      result.push(story.slice(0, n));
      rem -= n;
      if (rem <= 0) {
        // Pad remaining stories with empty arrays
        while (result.length < stories.length) result.push([]);
        break;
      }
    }
    while (result.length < stories.length) result.push([]);
    return result;
  },

  /** Index of the story currently being revealed (has partial content). */
  activeRevealStory(stories, step) {
    let rem = step;
    for (let i = 0; i < stories.length; i++) {
      if (rem < stories[i].length) return i;
      rem -= stories[i].length;
    }
    return stories.length - 1;
  },

  maxRevealSteps: (stories) => stories.reduce((s, st) => s + st.length, 0),
};

// ═══════════════════════════════════════════════════════════════════════
// LAYER 3 ─ Event Bus
// ═══════════════════════════════════════════════════════════════════════

class EventBus {
  constructor() { this._m = {}; }

  on(event, cb) {
    (this._m[event] ??= new Set()).add(cb);
    return () => this._m[event]?.delete(cb);
  }

  once(event, cb) {
    const off = this.on(event, d => { cb(d); off(); });
  }

  emit(event, data) {
    this._m[event]?.forEach(cb => {
      try { cb(data); }
      catch(e) { console.error(`[EventBus] ${event}:`, e); }
    });
  }
}

const bus = new EventBus();

// ═══════════════════════════════════════════════════════════════════════
// LAYER 4 ─ Global State Store  (single source of truth)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Round definition: 1 round = every player has written on every story once.
 * With N players, that means N sequential "turns" per round.
 *
 * game.currentTurn   : absolute turn counter (1-based)
 * game.turnsPerRound : N (number of players when game started)
 * game.totalTurns    : turnsPerRound * totalRounds
 *
 * Displayed round = ceil(currentTurn / turnsPerRound)
 * Displayed turn within round = ((currentTurn - 1) % turnsPerRound) + 1
 */
const INIT_GAME = () => ({
  phase        : PHASE.WAITING,
  currentTurn  : 0,
  totalTurns   : 0,
  turnsPerRound: 0,
  totalRounds  : CONFIG.DEFAULT_ROUNDS,
  mode         : 'round',
  turnTime     : CONFIG.DEFAULT_TURN_TIME,
  timeLeft     : 0,
  assignments  : {},   // { playerId: storyIndex }
  stories      : [],   // [ [{authorId, authorName, text}] ]
  locked       : {},   // { playerId: true }
  submissions  : {},   // { playerId: text }
  reveal       : { step: 0 },
});

class Store {
  constructor(init) {
    this._state = Utils.deepClone(init);
    this._subs  = new Set();
  }

  get()      { return this._state; }

  set(partial) {
    this._state = { ...this._state, ...partial };
    this._notify();
  }

  setGame(partial) {
    this._state = { ...this._state, game: { ...this._state.game, ...partial } };
    this._notify();
  }

  subscribe(fn)  { this._subs.add(fn);     return () => this._subs.delete(fn); }
  _notify()      { this._subs.forEach(fn => { try { fn(this._state); } catch(_){} }); }
}

const store = new Store({
  myId      : null,
  myName    : '',
  roomCode  : '',
  isHost    : false,
  hostId    : null,
  players   : {},
  settings  : { mode: 'round', rounds: CONFIG.DEFAULT_ROUNDS, turnTime: CONFIG.DEFAULT_TURN_TIME },
  game      : INIT_GAME(),
});

// ═══════════════════════════════════════════════════════════════════════
// LAYER 5 ─ WebRTC Connection Manager
// ═══════════════════════════════════════════════════════════════════════

class WebRTCManager {
  constructor() {
    this._pcs      = new Map();
    this._channels = new Map();
    this._heartbeat= new Map();
    this._lastSeen = new Map();
    this._iceQueue = new Map();
  }

  async createOffer(peerId) {
    const pc      = this._newPC(peerId);
    const channel = pc.createDataChannel('relay', { ordered: true });
    this._wire(peerId, channel);
    const offer   = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return offer;
  }

  async handleOffer(peerId, sdp) {
    const pc = this._newPC(peerId);
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await this._flushIceQueue(peerId, pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return answer;
  }

  async handleAnswer(peerId, sdp) {
    const pc = this._pcs.get(peerId);
    if (!pc) return;
    await pc.setRemoteDescription({ type: 'answer', sdp });
  }

  async addICE(peerId, candidate) {
    const pc = this._pcs.get(peerId);
    if (pc?.remoteDescription) {
      try { await pc.addIceCandidate(candidate); } catch(_){}
    } else {
      if (!this._iceQueue.has(peerId)) this._iceQueue.set(peerId, []);
      this._iceQueue.get(peerId).push(candidate);
    }
  }

  sendTo(peerId, msg) {
    const ch = this._channels.get(peerId);
    if (ch?.readyState === 'open') { ch.send(JSON.stringify(msg)); return true; }
    return false;
  }

  broadcast(msg) {
    const raw = JSON.stringify(msg);
    this._channels.forEach(ch => { if (ch.readyState === 'open') ch.send(raw); });
  }

  getConnectedPeerIds() {
    return [...this._channels.keys()].filter(id => this._channels.get(id)?.readyState === 'open');
  }

  closeAll() {
    this._heartbeat.forEach(clearInterval);
    this._heartbeat.clear();
    this._pcs.forEach(pc => pc.close());
    this._pcs.clear();
    this._channels.clear();
    this._lastSeen.clear();
    this._iceQueue.clear();
  }

  /* ── private ── */
  _newPC(peerId) {
    if (this._pcs.has(peerId)) this._pcs.get(peerId).close();
    const pc = new RTCPeerConnection({ iceServers: CONFIG.ICE_SERVERS });
    this._pcs.set(peerId, pc);
    this._iceQueue.set(peerId, []);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) bus.emit(EVT._ICE_CANDIDATE, { peerId, candidate });
    };

    pc.ondatachannel = ({ channel }) => this._wire(peerId, channel);

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        bus.emit(EVT.PEER_CONNECTED, { peerId });
        this._startHB(peerId);
      } else if (['disconnected', 'failed', 'closed'].includes(s)) {
        this._drop(peerId);
      }
    };
    return pc;
  }

  _wire(peerId, ch) {
    ch.onopen    = () => this._channels.set(peerId, ch);
    ch.onmessage = ({ data }) => { try { this._route(peerId, JSON.parse(data)); } catch(_){} };
    ch.onclose   = () => this._channels.delete(peerId);
  }

  _route(peerId, msg) {
    if (msg.type === MSG.HB)         { this.sendTo(peerId, { type: MSG.HB_ACK }); return; }
    if (msg.type === MSG.HB_ACK)     { this._lastSeen.set(peerId, Date.now()); return; }
    if (msg.type === MSG.GAME_STATE) { bus.emit(EVT.GAME_STATE_UPDATED, { from: peerId, state: msg.payload }); return; }
    if (msg.type === MSG.ACTION)     { bus.emit(EVT.ACTION_RECEIVED,    { from: peerId, action: msg.payload }); }
  }

  _startHB(peerId) {
    this._lastSeen.set(peerId, Date.now());
    const t = setInterval(() => {
      if (Date.now() - (this._lastSeen.get(peerId) || 0) > CONFIG.PEER_TIMEOUT) {
        this._drop(peerId); return;
      }
      this.sendTo(peerId, { type: MSG.HB });
    }, CONFIG.HEARTBEAT_INTERVAL);
    this._heartbeat.set(peerId, t);
  }

  _drop(peerId) {
    clearInterval(this._heartbeat.get(peerId));
    this._heartbeat.delete(peerId);
    this._pcs.get(peerId)?.close();
    this._pcs.delete(peerId);
    this._channels.delete(peerId);
    this._lastSeen.delete(peerId);
    bus.emit(EVT.PEER_DISCONNECTED, { peerId });
  }

  async _flushIceQueue(peerId, pc) {
    for (const c of (this._iceQueue.get(peerId) || []))
      try { await pc.addIceCandidate(c); } catch(_){}
    this._iceQueue.set(peerId, []);
  }
}

const webrtc = new WebRTCManager();

// ═══════════════════════════════════════════════════════════════════════
// LAYER 6 ─ Signaling Communication Layer  (Firebase Realtime Database)
// ═══════════════════════════════════════════════════════════════════════

class SignalingLayer {
  constructor() {
    this._db      = null;
    this._cleanup = [];
    this._iceIdx  = new Map();
  }

  init() {
    if (!firebase.apps.length) firebase.initializeApp(CONFIG.FIREBASE);
    this._db = firebase.database();
  }

  ref(path) { return this._db.ref(path); }

  async createRoom(code, hostId, hostName) {
    await this.ref(`rooms/${code}/info`).set({ host: hostId, status: 'waiting', createdAt: Date.now() });
    await this.ref(`rooms/${code}/players/${hostId}`).set({ name: hostName, joinedAt: Date.now() });
    this.ref(`rooms/${code}/players/${hostId}`).onDisconnect().remove();
  }

  async roomExists(code) { return (await this.ref(`rooms/${code}/info`).get()).exists(); }
  async getPlayers(code) { return (await this.ref(`rooms/${code}/players`).get()).val() || {}; }
  async getHostId(code)  { return (await this.ref(`rooms/${code}/info/host`).get()).val(); }
  async setHostId(code, hostId) { await this.ref(`rooms/${code}/info/host`).set(hostId); }

  async addPlayer(code, pid, name) {
    await this.ref(`rooms/${code}/players/${pid}`).set({ name, joinedAt: Date.now() });
    this.ref(`rooms/${code}/players/${pid}`).onDisconnect().remove();
  }

  async removePlayer(code, pid) {
    await Promise.all([
      this.ref(`rooms/${code}/players/${pid}`).remove(),
      this.ref(`rooms/${code}/offers/${pid}`).remove(),
      this.ref(`rooms/${code}/answers/${pid}`).remove(),
      this.ref(`rooms/${code}/ice/${pid}`).remove(),
    ]);
  }

  watchPlayers(code, onJoin, onLeave) {
    const r    = this.ref(`rooms/${code}/players`);
    const hAdd = r.on('child_added',   s => onJoin(s.key, s.val()));
    const hRem = r.on('child_removed', s => onLeave(s.key));
    this._cleanup.push(() => { r.off('child_added', hAdd); r.off('child_removed', hRem); });
  }

  async publishOffer(code, toId, fromId, sdp) {
    await this.ref(`rooms/${code}/offers/${toId}/${fromId}`).set({ sdp, ts: Date.now() });
  }

  async publishAnswer(code, toId, fromId, sdp) {
    await this.ref(`rooms/${code}/answers/${toId}/${fromId}`).set({ sdp, ts: Date.now() });
  }

  watchOffersFor(code, myId, onOffer) {
    const r = this.ref(`rooms/${code}/offers/${myId}`);
    const h = r.on('child_added', s => { const { sdp } = s.val(); onOffer(s.key, sdp); s.ref.remove(); });
    this._cleanup.push(() => r.off('child_added', h));
  }

  watchAnswersFor(code, myId, onAnswer) {
    const r = this.ref(`rooms/${code}/answers/${myId}`);
    const h = r.on('child_added', s => { const { sdp } = s.val(); onAnswer(s.key, sdp); s.ref.remove(); });
    this._cleanup.push(() => r.off('child_added', h));
  }

  async publishICE(code, toId, fromId, candidate) {
    const key = `${toId}_${fromId}`;
    const idx = this._iceIdx.get(key) || 0;
    this._iceIdx.set(key, idx + 1);
    await this.ref(`rooms/${code}/ice/${toId}/${fromId}/${idx}`).set({
      candidate    : candidate.candidate,
      sdpMid       : candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
    });
  }

  watchICEFor(code, myId, onCandidate) {
    const r      = this.ref(`rooms/${code}/ice/${myId}`);
    const hOuter = r.on('child_added', snap => {
      const fromId = snap.key;
      const inner  = this.ref(`rooms/${code}/ice/${myId}/${fromId}`);
      inner.on('child_added', cs => {
        const d = cs.val();
        onCandidate(fromId, { candidate: d.candidate, sdpMid: d.sdpMid, sdpMLineIndex: d.sdpMLineIndex });
        cs.ref.remove();
      });
    });
    this._cleanup.push(() => r.off('child_added', hOuter));
  }

  teardown() { this._cleanup.forEach(fn => fn()); this._cleanup = []; }
}

const signaling = new SignalingLayer();

// ═══════════════════════════════════════════════════════════════════════
// LAYER 7 ─ Room Management System
// ═══════════════════════════════════════════════════════════════════════

class RoomManager {

  async createRoom(playerName) {
    const myId     = Utils.genId();
    const roomCode = Utils.genRoomCode();
    store.set({ myId, myName: playerName, roomCode, isHost: true, hostId: myId });
    await signaling.createRoom(roomCode, myId, playerName);
    this._setupListeners(roomCode, myId);
    bus.emit(EVT.ROOM_JOINED, { roomCode, isHost: true });
    return roomCode;
  }

  async joinRoom(rawCode, playerName) {
    const roomCode = rawCode.trim().toUpperCase();
    if (!(await signaling.roomExists(roomCode)))
      throw new Error('找不到此房間，請確認代碼是否正確');

    const existing = await signaling.getPlayers(roomCode);
    if (Object.keys(existing).length >= CONFIG.MAX_PLAYERS)
      throw new Error('房間已達人數上限');

    const myId   = Utils.genId();
    const hostId = await signaling.getHostId(roomCode);

    store.set({ myId, myName: playerName, roomCode, isHost: false, hostId });
    await signaling.addPlayer(roomCode, myId, playerName);
    this._setupListeners(roomCode, myId);

    for (const peerId of Object.keys(existing)) {
      try {
        const offer = await webrtc.createOffer(peerId);
        await signaling.publishOffer(roomCode, peerId, myId, offer.sdp);
      } catch(e) { console.warn(`offer→${peerId}:`, e); }
    }

    bus.emit(EVT.ROOM_JOINED, { roomCode, isHost: false });
    return roomCode;
  }

  /**
   * Soft return to lobby — keep WebRTC connections alive.
   * Host resets game state and broadcasts. Non-host just navigates.
   */
  returnToLobby() {
    const { isHost } = store.get();
    store.set({ game: INIT_GAME() });
    if (isHost) {
      gameEngine.broadcastState();
    }
    bus.emit(EVT.RETURN_LOBBY);
  }

  /**
   * Hard leave — disconnect everything, go home.
   */
  async hardLeave() {
    const { roomCode, myId } = store.get();
    webrtc.closeAll();
    signaling.teardown();
    try { await signaling.removePlayer(roomCode, myId); } catch(_){}
    store.set({
      myId: null, myName: '', roomCode: '', isHost: false, hostId: null,
      players: {}, game: INIT_GAME(),
    });
  }

  _setupListeners(roomCode, myId) {
    signaling.watchOffersFor(roomCode, myId, async (fromId, sdp) => {
      try {
        const answer = await webrtc.handleOffer(fromId, sdp);
        await signaling.publishAnswer(roomCode, fromId, myId, answer.sdp);
      } catch(e) { console.warn(`answer→${fromId}:`, e); }
    });

    signaling.watchAnswersFor(roomCode, myId, async (fromId, sdp) => {
      try { await webrtc.handleAnswer(fromId, sdp); }
      catch(e) { console.warn(`setAnswer from ${fromId}:`, e); }
    });

    signaling.watchICEFor(roomCode, myId, async (fromId, candidate) => {
      try { await webrtc.addICE(fromId, candidate); } catch(_){}
    });

    bus.on(EVT._ICE_CANDIDATE, async ({ peerId, candidate }) => {
      try { await signaling.publishICE(roomCode, peerId, myId, candidate); } catch(_){}
    });

    signaling.watchPlayers(
      roomCode,
      (pid, pData) => bus.emit(EVT.PLAYER_JOINED, { id: pid, name: pData.name }),
      (pid)         => bus.emit(EVT.PLAYER_LEFT,   { id: pid }),
    );
  }
}

const roomManager = new RoomManager();

// ═══════════════════════════════════════════════════════════════════════
// LAYER 8 ─ Player Synchronization System
// ═══════════════════════════════════════════════════════════════════════

class PlayerSync {
  constructor() {
    bus.on(EVT.PLAYER_JOINED,     d => this._onJoin(d));
    bus.on(EVT.PLAYER_LEFT,       d => this._onLeave(d));
    bus.on(EVT.PEER_CONNECTED,    d => this._onPeerUp(d));
    bus.on(EVT.PEER_DISCONNECTED, d => this._onPeerDown(d));
  }

  _onJoin({ id, name }) {
    const { players, myId, myName, hostId } = store.get();
    store.set({
      players: {
        ...players,
        [id]: {
          name  : id === myId ? myName : name,
          status: 'connected',
          isHost: id === hostId,
        },
      },
    });
    if (id !== myId) bus.emit(EVT.TOAST, { msg: `${name} 加入了房間`, type: 'info' });
  }

  _onLeave({ id }) {
    const { players, hostId } = store.get();
    const name = players[id]?.name || id;
    const upd  = { ...players };
    delete upd[id];
    store.set({ players: upd });
    bus.emit(EVT.TOAST, { msg: `${name} 離開了房間`, type: 'info' });

    // ── FIX 1: Host migration ─────────────────────────────
    if (id === hostId) this._electNewHost();
  }

  _onPeerUp({ peerId }) {
    const { players } = store.get();
    if (players[peerId]) {
      store.set({ players: { ...players, [peerId]: { ...players[peerId], status: 'connected' } } });
    }
    const { isHost } = store.get();
    if (isHost) setTimeout(() => gameEngine.broadcastState(), 600);
  }

  _onPeerDown({ peerId }) {
    const { players } = store.get();
    if (players[peerId]) {
      store.set({ players: { ...players, [peerId]: { ...players[peerId], status: 'disconnected' } } });
    }
    const { isHost } = store.get();
    if (isHost) storyRelay.checkAllLocked();
  }

  /**
   * FIX 1 — Host migration.
   * When host leaves, all peers run the same deterministic algorithm:
   * sort remaining player IDs alphabetically, first one becomes new host.
   * Since all peers receive the same Firebase child_removed event,
   * they all compute the same result.
   */
  _electNewHost() {
    const { players, myId, roomCode } = store.get();
    const remaining = Object.keys(players).sort();
    if (remaining.length === 0) return;

    const newHostId = remaining[0];

    // Update player isHost flags
    const updatedPlayers = {};
    for (const [id, p] of Object.entries(players))
      updatedPlayers[id] = { ...p, isHost: id === newHostId };

    store.set({ hostId: newHostId, players: updatedPlayers });

    if (myId === newHostId) {
      store.set({ isHost: true });
      bus.emit(EVT.TOAST, { msg: '👑 你已成為新的主持人！', type: 'success' });

      // Update Firebase so new joiners know who the host is
      try { signaling.ref(`rooms/${roomCode}/info/host`).set(newHostId); } catch(_){}

      // Resume host duties
      const { game } = store.get();
      if (game.phase === PHASE.WRITING) {
        setTimeout(() => {
          storyRelay.checkAllLocked();
          gameEngine.broadcastState();
        }, 500);
      } else if (game.phase !== PHASE.WAITING) {
        setTimeout(() => gameEngine.broadcastState(), 500);
      }
    }
  }
}

const playerSync = new PlayerSync();

// ═══════════════════════════════════════════════════════════════════════
// LAYER 9 ─ Game Engine Core
// ═══════════════════════════════════════════════════════════════════════

class GameEngine {
  constructor() {
    this._hostTimer = null;
    bus.on(EVT.GAME_STATE_UPDATED, d => this._onStateRecv(d));
    bus.on(EVT.ACTION_RECEIVED,    d => this._onAction(d));
  }

  _onStateRecv({ from, state }) {
    const { hostId } = store.get();
    if (from !== hostId) return;

    // ── FIX 4: Guard against invalid / WAITING state ──────
    if (!state || !state.phase) return;

    store.setGame(state);
  }

  _onAction({ from, action }) {
    const { isHost } = store.get();
    if (!isHost) return;
    if (action.type === ACTION.LOCK)         storyRelay.handleLock(from, action.text);
    if (action.type === ACTION.UNLOCK)       storyRelay.handleUnlock(from);
    if (action.type === ACTION.REVEAL_NEXT)  storyRelay.revealNext();
    if (action.type === ACTION.RETURN_LOBBY) roomManager.returnToLobby();
  }

  /**
   * FIX 2 — Correct round definition.
   * totalTurns = turnsPerRound × totalRounds
   * turnsPerRound = number of players (so everyone touches every story once per round)
   */
  startGame(settings) {
    const { players } = store.get();
    const pids         = Object.keys(players);
    const N            = pids.length;
    const shuffled     = Utils.shuffle([...pids]);
    const stories      = shuffled.map(() => []);
    const assignments  = {};
    shuffled.forEach((pid, i) => { assignments[pid] = i; });

    const g = {
      phase        : PHASE.WRITING,
      currentTurn  : 1,
      totalTurns   : N * settings.rounds,
      turnsPerRound: N,
      totalRounds  : settings.rounds,
      mode         : settings.mode,
      turnTime     : settings.turnTime,
      timeLeft     : settings.mode === 'time' ? settings.turnTime : 0,
      assignments,
      stories,
      locked       : {},
      submissions  : {},
      reveal       : { step: 0 },
    };

    store.setGame(g);
    this.broadcastState();
    if (settings.mode === 'time') this._startTimer(settings.turnTime);
  }

  _startTimer(seconds) {
    clearInterval(this._hostTimer);
    let t = seconds;
    this._hostTimer = setInterval(() => {
      t -= 1;
      store.setGame({ timeLeft: t });
      this.broadcastState();
      if (t <= 0) { clearInterval(this._hostTimer); this._hostTimer = null; storyRelay.advance(); }
    }, 1000);
  }

  stopTimer() { clearInterval(this._hostTimer); this._hostTimer = null; }

  broadcastState() {
    const { isHost, game } = store.get();
    if (!isHost) return;
    webrtc.broadcast({ type: MSG.GAME_STATE, payload: game });
  }

  sendAction(action) {
    const { isHost, myId, hostId } = store.get();
    if (isHost) {
      bus.emit(EVT.ACTION_RECEIVED, { from: myId, action });
    } else {
      if (!webrtc.sendTo(hostId, { type: MSG.ACTION, payload: action }))
        bus.emit(EVT.TOAST, { msg: '尚未連接到主持人，請稍候', type: 'error' });
    }
  }
}

const gameEngine = new GameEngine();

// ═══════════════════════════════════════════════════════════════════════
// LAYER 10 ─ Story Relay Game Logic
// ═══════════════════════════════════════════════════════════════════════

class StoryRelay {
  constructor() { this._advTimer = null; }

  handleLock(playerId, text) {
    if (!text?.trim()) return;
    const { game } = store.get();
    store.setGame({
      submissions: { ...game.submissions, [playerId]: text.trim() },
      locked     : { ...game.locked,      [playerId]: true          },
    });
    gameEngine.broadcastState();
    this.checkAllLocked();
  }

  handleUnlock(playerId) {
    const { game } = store.get();
    const newLocked = { ...game.locked };
    delete newLocked[playerId];
    store.setGame({ locked: newLocked });
    gameEngine.broadcastState();
  }

  checkAllLocked() {
    const { game, players } = store.get();
    if (game.phase !== PHASE.WRITING) return;

    const active = Object.entries(players)
      .filter(([, p]) => p.status !== 'disconnected')
      .map(([id]) => id);

    const allLocked = active.length > 0 && active.every(pid => game.locked[pid]);
    if (allLocked) {
      clearTimeout(this._advTimer);
      this._advTimer = setTimeout(() => this.advance(), 900);
    }
  }

  /**
   * FIX 2 — Advance one "turn". When we reach totalTurns, go to REVEALING.
   */
  advance() {
    gameEngine.stopTimer();
    const { game, players } = store.get();

    // Commit current submissions into their assigned stories
    const stories = Utils.deepClone(game.stories);
    for (const [pid, text] of Object.entries(game.submissions)) {
      const idx = game.assignments[pid];
      if (idx !== undefined && text) {
        stories[idx].push({
          authorId  : pid,
          authorName: players[pid]?.name || '???',
          text,
        });
      }
    }

    const nextTurn = game.currentTurn + 1;

    if (nextTurn > game.totalTurns) {
      // All turns complete → enter reveal phase
      store.setGame({ phase: PHASE.REVEALING, stories, locked: {}, submissions: {}, reveal: { step: 0 } });
      gameEngine.broadcastState();
      return;
    }

    // Rotate: each player moves to the next story (cyclic)
    const pids           = Object.keys(game.assignments);
    const storyCount     = stories.length;
    const newAssignments = {};
    pids.forEach(pid => { newAssignments[pid] = (game.assignments[pid] + 1) % storyCount; });

    store.setGame({
      phase       : PHASE.WRITING,
      currentTurn : nextTurn,
      stories,
      assignments : newAssignments,
      locked      : {},
      submissions : {},
      timeLeft    : game.mode === 'time' ? game.turnTime : 0,
    });
    gameEngine.broadcastState();
    if (game.mode === 'time') gameEngine._startTimer(game.turnTime);
  }

  /**
   * FIX 5 — Host-controlled dramatic story reveal.
   * Each call advances reveal.step by 1, exposing one more segment.
   */
  revealNext() {
    const { game } = store.get();
    if (game.phase !== PHASE.REVEALING) return;
    const maxSteps = Utils.maxRevealSteps(game.stories);
    const newStep  = Math.min((game.reveal?.step || 0) + 1, maxSteps);
    store.setGame({ reveal: { step: newStep } });
    gameEngine.broadcastState();

    if (newStep >= maxSteps) {
      // Small delay then auto-transition to FINISHED for the full view
      setTimeout(() => {
        store.setGame({ phase: PHASE.FINISHED });
        gameEngine.broadcastState();
      }, 1400);
    }
  }

  getContext(playerId) {
    const { game } = store.get();
    const idx   = game.assignments?.[playerId];
    if (idx === undefined) return null;
    const story = game.stories?.[idx];
    return story?.length ? story[story.length - 1] : null;
  }
}

const storyRelay = new StoryRelay();

// ═══════════════════════════════════════════════════════════════════════
// LAYER 11 ─ UI Controller
// ═══════════════════════════════════════════════════════════════════════

class UIController {
  constructor() {
    this._screen        = 'home';
    this._toastTimer    = null;
    this._lastTurn      = 0;       // detect turn change for input reset
    this._prevGamePhase = PHASE.WAITING;

    store.subscribe(s => this._sync(s));
    bus.on(EVT.TOAST,       d => this.toast(d.msg, d.type));
    bus.on(EVT.RETURN_LOBBY, () => this.show('room'));
    bus.on(EVT.ROOM_JOINED, d => { this._setRoomCode(d.roomCode); this.show('room'); });

    // ── FIX 3 & 4: Careful auto-navigation between screens ──
    bus.on(EVT.GAME_STATE_UPDATED, ({ state }) => {
      if (!state?.phase) return;

      // Start game: only navigate to game when transitioning from WAITING → WRITING
      if (this._prevGamePhase === PHASE.WAITING &&
          state.phase === PHASE.WRITING         &&
          this._screen === 'room') {
        this.show('game');
      }

      // Host reset: return to lobby
      if (state.phase === PHASE.WAITING && this._screen === 'game') {
        this.show('room');
      }

      this._prevGamePhase = state.phase;
    });
  }

  /* ── Public ── */
  init() {
    this._bindHome();
    this._bindRoom();
    this._bindGame();
    this.show('home');
  }

  show(name) {
    document.querySelectorAll('.screen').forEach(el => {
      el.classList.add('hidden'); el.classList.remove('active');
    });
    const el = document.getElementById(`screen-${name}`);
    if (el) { el.classList.remove('hidden'); el.classList.add('active'); }
    this._screen = name;
  }

  toast(msg, type = 'info') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className   = `toast ${type}`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.add('hidden'), 3400);
  }

  overlay(msg) {
    document.getElementById('overlay-msg').textContent = msg;
    document.getElementById('overlay').classList.remove('hidden');
  }

  hideOverlay() { document.getElementById('overlay').classList.add('hidden'); }

  /* ── Store sync ─────────────────────────────────────── */
  _sync(s) {
    if (this._screen === 'room') {
      this._renderPlayers(s.players, s.myId, s.hostId);
      this._renderRoomControls(s);
    }
    if (this._screen === 'game') {
      // ── FIX 4: Never render game screen for WAITING phase ──
      if (!s.game || s.game.phase === PHASE.WAITING || !s.game.phase) return;
      this._renderGame(s);
    }
  }

  /* ── Room ───────────────────────────────────────────── */
  _setRoomCode(code) { document.getElementById('display-room-code').textContent = code; }

  _renderPlayers(players, myId, hostId) {
    const list = document.getElementById('players-list');
    const cnt  = document.getElementById('player-count');
    const n    = Object.keys(players).length;
    cnt.textContent = `${n} / ${CONFIG.MAX_PLAYERS}`;
    list.innerHTML  = Object.entries(players).map(([id, p]) => {
      const color  = Utils.avatarColor(p.name);
      const isMe   = id === myId;
      const isHost = id === hostId;
      const disc   = p.status === 'disconnected';
      return `
        <li class="player-item ${isHost ? 'is-host' : ''}">
          <div class="player-avatar" style="background:${color}">${p.name[0]}</div>
          <span class="player-name">${Utils.escapeHtml(p.name)}</span>
          <div class="player-badges">
            ${isHost ? `<span class="p-badge p-badge-host">👑 主持人</span>` : ''}
            ${isMe   ? `<span class="p-badge p-badge-you">你</span>`         : ''}
            <span class="p-badge ${disc ? 'p-badge-disc' : 'p-badge-conn'}">${disc ? '離線' : '在線'}</span>
          </div>
        </li>`;
    }).join('');
  }

  _renderRoomControls(s) {
    document.getElementById('settings-panel').classList.toggle('hidden', !s.isHost);
    document.getElementById('waiting-panel').classList.toggle('hidden',   s.isHost);
    if (s.isHost) {
      const mode = s.settings?.mode || 'round';
      document.querySelectorAll('input[name="game-mode"]').forEach(r => { r.checked = r.value === mode; });
      document.getElementById('time-setting').classList.toggle('hidden', mode !== 'time');
    }
  }

  /* ── Game ───────────────────────────────────────────── */
  _renderGame(s) {
    const { game, players, myId, isHost } = s;
    if (!game || !game.phase || game.phase === PHASE.WAITING) return;

    // Phase visibility
    document.getElementById('phase-writing').classList.toggle('hidden',   game.phase !== PHASE.WRITING);
    document.getElementById('phase-revealing').classList.toggle('hidden', game.phase !== PHASE.REVEALING);
    document.getElementById('phase-finished').classList.toggle('hidden',  game.phase !== PHASE.FINISHED);

    // Header
    this._renderGameHeader(game, players);

    if (game.phase === PHASE.WRITING)   this._renderWriting(game, myId);
    if (game.phase === PHASE.REVEALING) this._renderRevealing(game, players, isHost);
    if (game.phase === PHASE.FINISHED)  this._renderFinished(game, players);

    // Reset textarea when a new turn begins
    if (game.currentTurn !== this._lastTurn && game.phase === PHASE.WRITING) {
      this._lastTurn = game.currentTurn;
      const inp  = document.getElementById('story-input');
      inp.value  = '';
      inp.disabled = false;
      document.getElementById('char-count').textContent = '0 / 500';
      document.getElementById('btn-lock').classList.remove('hidden');
      document.getElementById('btn-unlock').classList.add('hidden');
      document.getElementById('waiting-locked').classList.add('hidden');
    }
  }

  _renderGameHeader(game, players) {
    const { turnsPerRound, currentTurn, totalRounds, totalTurns } = game;

    // ── FIX 4: Guard against division by zero (turn 0) ──
    if (!turnsPerRound || !currentTurn) return;

    const currentRound   = Math.ceil(currentTurn / turnsPerRound);
    const turnWithin     = ((currentTurn - 1) % turnsPerRound) + 1;

    const roundLabel  = document.getElementById('game-round-label');
    const turnLabel   = document.getElementById('game-turn-label');
    const phaseBadge  = document.getElementById('game-phase-badge');
    const lockCount   = document.getElementById('lock-count');
    const headerLock  = document.getElementById('header-lock-info');
    const timerEl     = document.getElementById('game-timer');

    if (game.phase === PHASE.WRITING) {
      roundLabel.textContent  = `第 ${currentRound} / ${totalRounds} 回合`;
      turnLabel.textContent   = `第 ${turnWithin} / ${turnsPerRound} 輪`;
      phaseBadge.textContent  = '寫作中';
      phaseBadge.className    = 'phase-badge writing';

      const lockedN   = Object.keys(game.locked || {}).length;
      const totalN    = Object.keys(players).length;
      lockCount.textContent = `已鎖定 ${lockedN} / ${totalN}`;
      headerLock.classList.remove('hidden');

      if (game.mode === 'time') {
        timerEl.classList.remove('hidden');
        document.getElementById('timer-value').textContent = game.timeLeft;
        timerEl.classList.toggle('urgent', game.timeLeft <= 10);
      } else {
        timerEl.classList.add('hidden');
      }

    } else if (game.phase === PHASE.REVEALING) {
      const maxSteps = Utils.maxRevealSteps(game.stories);
      const step     = game.reveal?.step || 0;
      roundLabel.textContent  = '🎭 故事揭示時刻';
      turnLabel.textContent   = '';
      phaseBadge.textContent  = '揭示中';
      phaseBadge.className    = 'phase-badge revealing';
      lockCount.textContent   = `已揭示 ${step} / ${maxSteps} 段`;
      timerEl.classList.add('hidden');

    } else if (game.phase === PHASE.FINISHED) {
      roundLabel.textContent  = '🎉 遊戲結束';
      turnLabel.textContent   = '';
      phaseBadge.textContent  = '完結';
      phaseBadge.className    = 'phase-badge finished';
      headerLock.classList.add('hidden');
      timerEl.classList.add('hidden');
    }
  }

  _renderWriting(game, myId) {
    const ctx       = storyRelay.getContext(myId);
    const ctxEl     = document.getElementById('story-context-text');
    const inp       = document.getElementById('story-input');
    const waitEl    = document.getElementById('waiting-locked');
    const lockBtn   = document.getElementById('btn-lock');
    const unlockBtn = document.getElementById('btn-unlock');
    const isLocked  = !!game.locked?.[myId];

    if (ctx) {
      ctxEl.innerHTML = `<strong>${Utils.escapeHtml(ctx.authorName)}</strong> 寫道：\n\n${Utils.escapeHtml(ctx.text)}`;
      ctxEl.classList.add('has-content');
    } else {
      ctxEl.innerHTML = `<span class="context-placeholder">（故事的開端，由你來書寫！）</span>`;
      ctxEl.classList.remove('has-content');
    }

    inp.disabled = isLocked;
    lockBtn.classList.toggle('hidden',   isLocked);
    unlockBtn.classList.toggle('hidden', !isLocked);
    waitEl.classList.toggle('hidden',    !isLocked);
  }

  /**
   * FIX 5 — Dramatic story reveal rendering.
   */
  _renderRevealing(game, players, isHost) {
    const step     = game.reveal?.step || 0;
    const stories  = game.stories || [];
    const maxSteps = Utils.maxRevealSteps(stories);
    const isDone   = step >= maxSteps;

    // Progress bar
    document.getElementById('reveal-progress-fill').style.width =
      maxSteps > 0 ? `${(step / maxSteps) * 100}%` : '0%';

    // Controls
    document.getElementById('btn-reveal-next').classList.toggle('hidden',    !isHost || isDone);
    document.getElementById('reveal-watching-text').classList.toggle('hidden', isHost || isDone);
    document.getElementById('btn-reveal-done').classList.toggle('hidden',    !isDone);

    const subtitle = document.getElementById('reveal-subtitle');
    if (isDone) {
      subtitle.textContent = '所有故事已完整揭示！';
    } else {
      const active = Utils.activeRevealStory(stories, step);
      subtitle.textContent = step === 0
        ? '主持人將逐段揭示眾人合力創作的故事'
        : `正在揭示故事 ${active + 1}…`;
    }

    // Compute revealed segments per story
    const revealedPerStory = Utils.computeReveal(stories, step);

    // Active story index
    const activeStoryIdx = isDone ? -1 : Utils.activeRevealStory(stories, step);

    const cont = document.getElementById('reveal-stories-container');
    cont.innerHTML = stories.map((story, si) => {
      const revealed  = revealedPerStory[si];
      const isActive  = si === activeStoryIdx;
      const isUnrev   = revealed.length === 0;

      const segsHtml  = isUnrev
        ? `<div class="reveal-seg-empty">尚未揭示</div>`
        : revealed.map((seg, i) => {
            const isNew = (i === revealed.length - 1) && isActive;
            return `
              <div class="reveal-seg ${isNew ? 'reveal-seg-new' : ''}">
                <div class="reveal-seg-author">
                  第 ${i + 1} 段 &nbsp;
                  <span class="reveal-seg-author-name">${Utils.escapeHtml(seg.authorName)}</span>
                </div>
                <div class="reveal-seg-text">${Utils.escapeHtml(seg.text)}</div>
              </div>`;
          }).join('');

      return `
        <div class="reveal-story-card ${isActive ? 'active' : ''} ${isUnrev ? 'unrevealed' : ''}">
          <div class="reveal-story-header">
            <span class="reveal-story-num">📖 故事 ${si + 1}</span>
            <span class="reveal-seg-count">${revealed.length} / ${story.length} 段</span>
          </div>
          <div class="reveal-segs">${segsHtml}</div>
        </div>`;
    }).join('');
  }

  _renderFinished(game, players) {
    const cont = document.getElementById('final-stories');
    cont.innerHTML = game.stories.map((story, si) => {
      const segs = story.length === 0
        ? `<p style="color:var(--txt2);padding:16px 20px;font-style:italic">（這個故事沒有任何內容）</p>`
        : story.map((seg, i) => `
            <div class="story-seg">
              <div class="story-seg-author">
                第 ${i + 1} 段
                <span class="story-seg-round">回合 ${Math.ceil((i + 1) / game.turnsPerRound) || i + 1}</span>
                ${Utils.escapeHtml(seg.authorName)}
              </div>
              <div class="story-seg-text">${Utils.escapeHtml(seg.text)}</div>
            </div>`).join('');
      return `
        <div class="story-card">
          <div class="story-card-header">📖 故事 ${si + 1}</div>
          <div class="story-card-body">${segs}</div>
        </div>`;
    }).join('');
  }

  /* ── Bindings ───────────────────────────────────────── */
  _bindHome() {
    const go = async (join) => {
      const name = document.getElementById('input-name').value.trim();
      if (!name) return this._err('home-error', '請先輸入暱稱');

      if (join) {
        const code = document.getElementById('input-room-code').value.trim();
        if (!code) return this._err('home-error', '請輸入房間代碼');
        try {
          this.overlay('加入房間中…');
          await roomManager.joinRoom(code, name);
          this.hideOverlay();
        } catch(e) {
          this.hideOverlay();
          this._err('home-error', `加入失敗：${e.message}`);
        }
      } else {
        try {
          this.overlay('建立房間中…');
          await roomManager.createRoom(name);
          this.hideOverlay();
        } catch(e) {
          this.hideOverlay();
          this._err('home-error', `建立失敗：${e.message}`);
        }
      }
    };

    document.getElementById('btn-create-room').addEventListener('click', () => go(false));
    document.getElementById('btn-join-room').addEventListener('click',   () => go(true));
    document.getElementById('input-room-code').addEventListener('keydown', e => { if (e.key === 'Enter') go(true); });
    document.getElementById('input-name').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        document.getElementById('input-room-code').value.trim() ? go(true) : go(false);
      }
    });
  }

  _bindRoom() {
    document.getElementById('btn-copy-code').addEventListener('click', () => {
      const code = document.getElementById('display-room-code').textContent;
      navigator.clipboard?.writeText(code)
        .then(() => this.toast('房間代碼已複製！', 'success'))
        .catch(() => this.toast(`代碼：${code}`, 'info'));
    });

    document.getElementById('btn-leave-room').addEventListener('click', async () => {
      await roomManager.hardLeave();
      this.show('home');
    });

    document.getElementById('btn-start-game').addEventListener('click', () => {
      const { players } = store.get();
      const n = Object.keys(players).length;
      if (n < CONFIG.MIN_PLAYERS)
        return this._err('room-error', `至少需要 ${CONFIG.MIN_PLAYERS} 名玩家才能開始`);

      const mode     = document.querySelector('input[name="game-mode"]:checked')?.value || 'round';
      const rounds   = Utils.clamp(parseInt(document.getElementById('input-rounds').value)    || 2, 1, 10);
      const turnTime = Utils.clamp(parseInt(document.getElementById('input-turn-time').value) || 90, 15, 300);

      store.set({ settings: { mode, rounds, turnTime } });
      gameEngine.startGame({ mode, rounds, turnTime });
      this._prevGamePhase = PHASE.WAITING; // reset so transition fires
      this.show('game');
    });

    document.querySelectorAll('input[name="game-mode"]').forEach(r => {
      r.addEventListener('change', e => {
        store.set({ settings: { ...store.get().settings, mode: e.target.value } });
        document.getElementById('time-setting').classList.toggle('hidden', e.target.value !== 'time');
      });
    });
  }

  _bindGame() {
    const inp       = document.getElementById('story-input');
    const charCount = document.getElementById('char-count');

    inp.addEventListener('input', () => { charCount.textContent = `${inp.value.length} / 500`; });

    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        document.getElementById('btn-lock').click();
      }
    });

    document.getElementById('btn-lock').addEventListener('click', () => {
      const text = inp.value.trim();
      if (!text) return this.toast('請先輸入故事內容再鎖定', 'error');
      gameEngine.sendAction({ type: ACTION.LOCK, text });
    });

    document.getElementById('btn-unlock').addEventListener('click', () => {
      gameEngine.sendAction({ type: ACTION.UNLOCK });
    });

    // ── FIX 5: Reveal next button ──────────────────────
    document.getElementById('btn-reveal-next').addEventListener('click', () => {
      gameEngine.sendAction({ type: ACTION.REVEAL_NEXT });
    });

    // After all revealed → show finished view
    document.getElementById('btn-reveal-done').addEventListener('click', () => {
      const { isHost } = store.get();
      if (isHost) {
        store.setGame({ phase: PHASE.FINISHED });
        gameEngine.broadcastState();
      } else {
        store.setGame({ phase: PHASE.FINISHED });
      }
    });

    // ── FIX 3: Return to lobby WITHOUT disconnecting ───
    document.getElementById('btn-back-to-lobby').addEventListener('click', () => {
      roomManager.returnToLobby();
    });
  }

  _err(elId, msg) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 5000);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// LAYER 12 ─ App Bootstrap
// ═══════════════════════════════════════════════════════════════════════

class App {
  constructor() { this._ui = new UIController(); }

  async init() {
    try {
      signaling.init();
    } catch(e) {
      console.error('Firebase init error:', e);
      return;
    }

    this._ui.init();

    // Graceful cleanup on unload
    window.addEventListener('beforeunload', () => {
      const { roomCode, myId } = store.get();
      if (roomCode && myId) {
        try { signaling.ref(`rooms/${roomCode}/players/${myId}`).remove(); } catch(_){}
      }
    });

    console.log('%c📖 故事接龍 已啟動', 'color:#c9a84c;font-weight:bold;font-size:14px');
  }
}

document.addEventListener('DOMContentLoaded', () => new App().init());
