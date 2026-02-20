import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getDatabase, ref, set, onChildAdded, remove, onDisconnect } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";

// ==========================================
// 1. 全域設定與常數 (Config & Constants)
// ==========================================
const CONFIG = {
    // TODO: 請填寫您的 Firebase 設定 (只需 Realtime Database 權限設定為公開或匿名存取)
    FIREBASE: {
        apiKey: "AIzaSyAmQF-LfpemJAiiXW0BnzvrGO2yTUQ4jcQ",
        authDomain: "manyp-c5976.firebaseapp.com",
        projectId: "manyp-c5976",
        storageBucket: "manyp-c5976.firebasestorage.app",
        messagingSenderId: "1011964043108",
        appId: "1:1011964043108:web:3576fd05f213d830402471",
    },
    RTC: {
        iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }]
    },
    HEARTBEAT_INTERVAL: 1000, // 1秒 Ping
    TIMEOUT_LIMIT: 5000       // 5秒無回應視為斷線
};

// ==========================================
// 2. 工具函式層 (Utils)
// ==========================================
class Utils {
    static genId() { return Math.random().toString(36).substring(2, 9); }
    static genRoomCode() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }
    static shuffle(array) {
        let arr = [...array];
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }
}

// ==========================================
// 3. Event Bus (事件系統)
// ==========================================
class EventBus {
    constructor() { this.events = {}; }
    on(event, listener) {
        if (!this.events[event]) this.events[event] = [];
        this.events[event].push(listener);
    }
    emit(event, payload = null) {
        if (this.events[event]) {
            this.events[event].forEach(listener => listener(payload));
        }
    }
}
const bus = new EventBus();

// ==========================================
// 4. 全域狀態管理 Store (Single Source of Truth)
// ==========================================
class Store {
    constructor() {
        this.state = {
            me: { id: Utils.genId(), name: '', isHost: false },
            room: { id: null, active: false, settings: { rounds: 3 } },
            players: {}, // { id: { name, isHost, online, lastPing } }
            game: {
                status: 'idle', // idle, playing, ended
                round: 0,
                turn: 0,
                stories: {}, // { storyId: [{author, text}] }
                assignments: {}, // { playerId: storyId }
                locks: {} // { playerId: text }
            }
        };

        // 狀態變更統一入口
        bus.on('STORE_MUTATE', ({ path, value }) => {
            let keys = path.split('.');
            let lastKey = keys.pop();
            let target = keys.reduce((obj, key) => obj[key], this.state);
            target[lastKey] = value;
            bus.emit('STORE_CHANGED', this.state);
        });

        bus.on('STORE_MERGE_PLAYERS', (newPlayers) => {
            this.state.players = { ...this.state.players, ...newPlayers };
            bus.emit('STORE_CHANGED', this.state);
        });
    }
    get() { return this.state; }
}
const store = new Store();

// ==========================================
// 5. WebRTC 連線管理層 (Mesh Topology)
// ==========================================
class WebRTCManager {
    constructor() {
        this.connections = {}; // { peerId: RTCPeerConnection }
        this.channels = {};    // { peerId: RTCDataChannel }

        // 監聽 Signaling 傳來的信令
        bus.on('SIG_OFFER_RECEIVED', async ({ peerId, offer }) => await this.handleOffer(peerId, offer));
        bus.on('SIG_ANSWER_RECEIVED', async ({ peerId, answer }) => await this.handleAnswer(peerId, answer));
        bus.on('SIG_ICE_RECEIVED', ({ peerId, candidate }) => this.handleIce(peerId, candidate));

        // 新玩家加入，發起連線
        bus.on('PEER_JOINED', (peerId) => this.createOffer(peerId));

        // 發送廣播訊息
        bus.on('RTC_BROADCAST', (msg) => this.broadcast(msg));

        // 心跳與超時檢測
        setInterval(() => this.checkHeartbeats(), CONFIG.HEARTBEAT_INTERVAL);
    }

    createPeer(peerId) {
        const pc = new RTCPeerConnection(CONFIG.RTC);
        this.connections[peerId] = pc;

        pc.onicecandidate = (e) => {
            if (e.candidate) bus.emit('SIG_SEND_ICE', { target: peerId, candidate: e.candidate });
        };

        pc.ondatachannel = (e) => this.setupChannel(peerId, e.channel);

        return pc;
    }

    setupChannel(peerId, channel) {
        this.channels[peerId] = channel;
        channel.onopen = () => bus.emit('RTC_PEER_CONNECTED', peerId);
        channel.onclose = () => bus.emit('RTC_PEER_DISCONNECTED', peerId);
        channel.onmessage = (e) => {
            const data = JSON.parse(e.data);
            if (data.type === 'ping') this.pong(peerId);
            else if (data.type === 'pong') bus.emit('RTC_PONG_RECEIVED', peerId);
            else bus.emit('RTC_MESSAGE', { peerId, data });
        };
    }

    async createOffer(peerId) {
        const pc = this.createPeer(peerId);
        const channel = pc.createDataChannel('game');
        this.setupChannel(peerId, channel);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        bus.emit('SIG_SEND_OFFER', { target: peerId, offer });
    }

    async handleOffer(peerId, offer) {
        const pc = this.createPeer(peerId);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        bus.emit('SIG_SEND_ANSWER', { target: peerId, answer });
    }

    async handleAnswer(peerId, answer) {
        await this.connections[peerId].setRemoteDescription(new RTCSessionDescription(answer));
    }

    handleIce(peerId, candidate) {
        if (this.connections[peerId]) {
            this.connections[peerId].addIceCandidate(new RTCIceCandidate(candidate));
        }
    }

    broadcast(message) {
        const raw = JSON.stringify(message);
        Object.values(this.channels).forEach(ch => {
            if (ch.readyState === 'open') ch.send(raw);
        });
    }

    pong(peerId) {
        if (this.channels[peerId]?.readyState === 'open') {
            this.channels[peerId].send(JSON.stringify({ type: 'pong' }));
        }
    }

    checkHeartbeats() {
        this.broadcast({ type: 'ping' });
        const now = Date.now();
        const players = store.get().players;
        Object.entries(players).forEach(([id, p]) => {
            if (id === store.get().me.id) return;
            if (p.online && now - p.lastPing > CONFIG.TIMEOUT_LIMIT) {
                bus.emit('RTC_PEER_TIMEOUT', id);
            }
        });
    }
}
new WebRTCManager();

// ==========================================
// 6. Signaling 通訊層 (Firebase 封裝)
// ==========================================
class SignalingLayer {
    constructor() {
        this.app = null;
        this.db = null;
        this.roomRef = null;

        bus.on('SIG_CONNECT', ({ roomId, me }) => this.connect(roomId, me));

        // 綁定發送信令事件
        bus.on('SIG_SEND_OFFER', (d) => this.sendSignal(d.target, 'offer', d.offer));
        bus.on('SIG_SEND_ANSWER', (d) => this.sendSignal(d.target, 'answer', d.answer));
        bus.on('SIG_SEND_ICE', (d) => this.sendSignal(d.target, 'ice', d.candidate));
    }

    connect(roomId, me) {
        if (!this.app) {
            this.app = initializeApp(CONFIG.FIREBASE);
            this.db = getDatabase(this.app);
        }

        const myId = me.id;
        const roomPath = `rooms/${roomId}`;

        // 註冊加入
        const meRef = ref(this.db, `${roomPath}/presence/${myId}`);
        set(meRef, { id: myId, name: me.name, ts: Date.now() });
        onDisconnect(meRef).remove();

        // 監聽其他玩家加入
        onChildAdded(ref(this.db, `${roomPath}/presence`), (snap) => {
            const val = snap.val();
            if (val.id !== myId) bus.emit('PEER_JOINED', val.id);
        });

        // 監聽專屬信令
        onChildAdded(ref(this.db, `${roomPath}/signals/${myId}`), (snap) => {
            const data = snap.val();
            if (data.type === 'offer') bus.emit('SIG_OFFER_RECEIVED', { peerId: data.from, offer: data.payload });
            if (data.type === 'answer') bus.emit('SIG_ANSWER_RECEIVED', { peerId: data.from, answer: data.payload });
            if (data.type === 'ice') bus.emit('SIG_ICE_RECEIVED', { peerId: data.from, candidate: data.payload });
            remove(snap.ref); // 讀後即焚
        });
    }

    sendSignal(target, type, payload) {
        const roomId = store.get().room.id;
        const myId = store.get().me.id;
        const signalRef = ref(this.db, `rooms/${roomId}/signals/${target}/${Utils.genId()}`);
        set(signalRef, { from: myId, type, payload });
    }
}
new SignalingLayer();

// ==========================================
// 7. 房間管理系統
// ==========================================
class RoomManager {
    constructor() {
        bus.on('CMD_CREATE_ROOM', (name) => this.createRoom(name));
        bus.on('CMD_JOIN_ROOM', ({ name, code }) => this.joinRoom(name, code));
        bus.on('CMD_LEAVE_ROOM', () => this.leaveRoom());
    }

    createRoom(name) {
        const code = Utils.genRoomCode();
        bus.emit('STORE_MUTATE', { path: 'me.name', value: name });
        bus.emit('STORE_MUTATE', { path: 'me.isHost', value: true });
        this.enter(code);
    }

    joinRoom(name, code) {
        bus.emit('STORE_MUTATE', { path: 'me.name', value: name });
        bus.emit('STORE_MUTATE', { path: 'me.isHost', value: false });
        this.enter(code.toUpperCase());
    }

    enter(code) {
        bus.emit('STORE_MUTATE', { path: 'room.id', value: code });
        bus.emit('STORE_MUTATE', { path: 'room.active', value: true });

        // 初始化本地玩家狀態
        const state = store.get();
        bus.emit('STORE_MUTATE', {
            path: `players.${state.me.id}`,
            value: { name: state.me.name, isHost: state.me.isHost, online: true, lastPing: Date.now() }
        });

        // 觸發連線
        bus.emit('SIG_CONNECT', { roomId: code, me: state.me });

        // UI 切換
        bus.emit('UI_SWITCH_VIEW', 'room');
    }

    leaveRoom() {
        location.reload(); // 簡單暴力的清理方式
    }
}
new RoomManager();

// ==========================================
// 8. 玩家同步系統
// ==========================================
class PlayerSync {
    constructor() {
        bus.on('RTC_PEER_CONNECTED', (peerId) => this.syncState());

        bus.on('RTC_PONG_RECEIVED', (peerId) => {
            const p = store.get().players[peerId];
            if (p) bus.emit('STORE_MUTATE', { path: `players.${peerId}.lastPing`, value: Date.now() });
        });

        bus.on('RTC_PEER_TIMEOUT', (peerId) => {
            bus.emit('STORE_MUTATE', { path: `players.${peerId}.online`, value: false });
        });

        bus.on('RTC_MESSAGE', ({ peerId, data }) => {
            if (data.type === 'SYNC_STATE') {
                // 如果我是剛加入，接收房主的全域狀態
                bus.emit('STORE_MERGE_PLAYERS', data.players);
                if (data.gameStatus !== 'idle') {
                    bus.emit('STORE_MUTATE', { path: 'game', value: data.game });
                    bus.emit('UI_SWITCH_VIEW', 'game');
                }
            }
        });

        // 房主負責廣播最新狀態給所有人
        bus.on('STORE_CHANGED', () => {
            if (store.get().me.isHost) this.syncState();
        });
    }

    syncState() {
        const s = store.get();
        bus.emit('RTC_BROADCAST', {
            type: 'SYNC_STATE',
            players: s.players,
            gameStatus: s.game.status,
            game: s.game
        });
    }
}
new PlayerSync();

// ==========================================
// 9. 遊戲引擎核心
// ==========================================
class GameEngine {
    constructor() {
        bus.on('CMD_START_GAME', (settings) => this.startGame(settings));

        // 只有房主處理核心邏輯推演
        bus.on('RTC_MESSAGE', ({ peerId, data }) => {
            if (!store.get().me.isHost) return;
            if (data.type === 'ACTION_LOCK') this.handlePlayerLock(peerId, data.text);
        });

        bus.on('ACTION_LOCK_LOCAL', (text) => {
            if (store.get().me.isHost) this.handlePlayerLock(store.get().me.id, text);
            else bus.emit('RTC_BROADCAST', { type: 'ACTION_LOCK', text });
        });
    }

    startGame(settings) {
        if (!store.get().me.isHost) return;

        bus.emit('STORE_MUTATE', { path: 'room.settings', value: settings });
        bus.emit('STORE_MUTATE', { path: 'game.status', value: 'playing' });
        bus.emit('STORE_MUTATE', { path: 'game.round', value: 1 });
        bus.emit('STORE_MUTATE', { path: 'game.turn', value: 1 });

        // 初始化故事容器
        const players = Object.keys(store.get().players).filter(id => store.get().players[id].online);
        let stories = {};
        players.forEach(id => { stories[`s_${id}`] = []; });
        bus.emit('STORE_MUTATE', { path: 'game.stories', value: stories });

        this.assignStories();
        bus.emit('UI_SWITCH_VIEW', 'game');
    }

    assignStories() {
        // 分配任務給玩家 (錯位排列)
        const players = Object.keys(store.get().players).filter(id => store.get().players[id].online);
        const stories = Object.keys(store.get().game.stories);

        // 簡單偏移演算法：回合數為偏移量
        const offset = store.get().game.turn - 1;
        let assignments = {};

        players.forEach((p, idx) => {
            const targetStoryIdx = (idx + offset) % stories.length;
            assignments[p] = stories[targetStoryIdx];
        });

        bus.emit('STORE_MUTATE', { path: 'game.assignments', value: assignments });
        bus.emit('STORE_MUTATE', { path: 'game.locks', value: {} }); // 清空鎖定
    }

    handlePlayerLock(peerId, text) {
        const s = store.get();
        let locks = { ...s.game.locks };
        locks[peerId] = text;
        bus.emit('STORE_MUTATE', { path: 'game.locks', value: locks });

        // 檢查是否所有人都鎖定了
        const onlinePlayers = Object.keys(s.players).filter(id => s.players[id].online);
        if (Object.keys(locks).length === onlinePlayers.length) {
            this.advanceTurn();
        }
    }

    advanceTurn() {
        const s = store.get();
        const locks = s.game.locks;
        const assigns = s.game.assignments;
        let stories = JSON.parse(JSON.stringify(s.game.stories));

        // 將內容寫入對應的故事線
        Object.entries(locks).forEach(([pId, text]) => {
            const sId = assigns[pId];
            stories[sId].push({ author: s.players[pId].name, text });
        });

        bus.emit('STORE_MUTATE', { path: 'game.stories', value: stories });

        const totalTurnsNeeded = Object.keys(s.players).filter(id => s.players[id].online).length;
        let nextTurn = s.game.turn + 1;
        let nextRound = s.game.round;

        if (nextTurn > totalTurnsNeeded) {
            nextTurn = 1;
            nextRound++;
        }

        if (nextRound > s.room.settings.rounds) {
            // 遊戲結束
            bus.emit('STORE_MUTATE', { path: 'game.status', value: 'ended' });
        } else {
            // 推進下一回合
            bus.emit('STORE_MUTATE', { path: 'game.turn', value: nextTurn });
            bus.emit('STORE_MUTATE', { path: 'game.round', value: nextRound });
            this.assignStories();
        }
    }
}
new GameEngine();

// ==========================================
// 10. 故事接龍遊戲邏輯 (Client UI Helper)
// ==========================================
// 這層負責解譯 Store 資料給 UI 控制器
class StoryLogic {
    constructor() {
        bus.on('STORE_CHANGED', (state) => {
            if (state.game.status === 'playing') this.computeLocalView(state);
            if (state.game.status === 'ended') this.showFinalStories(state);
        });
    }

    computeLocalView(state) {
        const myId = state.me.id;
        const myStoryId = state.game.assignments[myId];
        if (!myStoryId) return;

        const history = state.game.stories[myStoryId] || [];
        const html = history.map(h => `<strong>${h.author}:</strong> ${h.text}`).join('<br><br>');

        const onlineCount = Object.values(state.players).filter(p => p.online).length;
        const lockCount = Object.keys(state.game.locks).length;

        bus.emit('UI_RENDER_GAME', {
            round: state.game.round,
            totalRounds: state.room.settings.rounds,
            historyHtml: html,
            locks: lockCount,
            total: onlineCount,
            isLocked: !!state.game.locks[myId]
        });
    }

    showFinalStories(state) {
        const stories = state.game.stories;
        let finalHtml = '<h2>遊戲結束！完整故事：</h2>';
        Object.values(stories).forEach((story, idx) => {
            finalHtml += `<div class="story-content" style="margin-bottom:15px">`;
            finalHtml += `<strong>故事 ${idx + 1}</strong><br>`;
            finalHtml += story.map(h => `${h.text} <i>(${h.author})</i>`).join(' ');
            finalHtml += `</div>`;
        });
        bus.emit('UI_RENDER_END', finalHtml);
    }
}
new StoryLogic();

// ==========================================
// 11. UI 控制器
// ==========================================
class UIController {
    constructor() {
        this.bindDOM();
        this.bindEvents();
    }

    bindDOM() {
        this.els = {
            views: document.querySelectorAll('.view'),
            inputName: document.getElementById('input-nickname'),
            inputCode: document.getElementById('input-room-code'),
            btnCreate: document.getElementById('btn-create-room'),
            btnJoin: document.getElementById('btn-join-room'),
            homeMsg: document.getElementById('home-msg'),

            dispCode: document.getElementById('display-room-code'),
            btnLeave: document.getElementById('btn-leave-room'),
            playerList: document.getElementById('player-list'),
            playerCount: document.getElementById('player-count'),
            hostPanel: document.getElementById('host-panel'),
            btnStart: document.getElementById('btn-start-game'),
            setRounds: document.getElementById('setting-rounds'),

            dispRound: document.getElementById('display-round'),
            dispTotalRound: document.getElementById('display-total-rounds'),
            storyHistory: document.getElementById('story-history'),
            inputStory: document.getElementById('input-story'),
            btnLock: document.getElementById('btn-lock-story'),
            btnUnlock: document.getElementById('btn-unlock-story'),
            dispLockCnt: document.getElementById('display-lock-count'),
            dispTotalCnt: document.getElementById('display-total-players'),
            historyContainer: document.getElementById('story-history-container')
        };
    }

    bindEvents() {
        // DOM 觸發事件 -> 發送到 Event Bus
        this.els.btnCreate.onclick = () => {
            const name = this.els.inputName.value.trim();
            if (!name) return this.els.homeMsg.innerText = "請輸入暱稱";
            bus.emit('CMD_CREATE_ROOM', name);
        };

        this.els.btnJoin.onclick = () => {
            const name = this.els.inputName.value.trim();
            const code = this.els.inputCode.value.trim();
            if (!name || code.length < 6) return this.els.homeMsg.innerText = "暱稱或代碼無效";
            bus.emit('CMD_JOIN_ROOM', { name, code });
        };

        this.els.btnLeave.onclick = () => bus.emit('CMD_LEAVE_ROOM');

        this.els.btnStart.onclick = () => {
            bus.emit('CMD_START_GAME', { rounds: parseInt(this.els.setRounds.value) });
        };

        this.els.btnLock.onclick = () => {
            const text = this.els.inputStory.value.trim();
            if (!text) return;
            this.els.inputStory.disabled = true;
            this.els.btnLock.classList.add('hidden');
            this.els.btnUnlock.classList.remove('hidden');
            bus.emit('ACTION_LOCK_LOCAL', text);
        };

        this.els.btnUnlock.onclick = () => {
            this.els.inputStory.disabled = false;
            this.els.btnLock.classList.remove('hidden');
            this.els.btnUnlock.classList.add('hidden');
            // 這裡簡單實現解鎖：直接發送空字串或特定訊號撤回 (考量篇幅，暫以重新開放 UI 為主)
        };

        // 監聽 Event Bus -> 更新 DOM
        bus.on('UI_SWITCH_VIEW', (viewId) => {
            this.els.views.forEach(v => v.classList.remove('active'));
            document.getElementById(`view-${viewId}`).classList.add('active');
        });

        bus.on('STORE_CHANGED', (state) => this.renderRoom(state));

        bus.on('UI_RENDER_GAME', (data) => {
            this.els.dispRound.innerText = data.round;
            this.els.dispTotalRound.innerText = data.totalRounds;
            this.els.storyHistory.innerHTML = data.historyHtml || '<i>(你是第一棒，直接開始寫吧！)</i>';
            this.els.dispLockCnt.innerText = data.locks;
            this.els.dispTotalCnt.innerText = data.total;

            // 換回合時重置輸入框
            if (!data.isLocked && this.els.inputStory.disabled) {
                this.els.inputStory.value = '';
                this.els.inputStory.disabled = false;
                this.els.btnLock.classList.remove('hidden');
                this.els.btnUnlock.classList.add('hidden');
            }
        });

        bus.on('UI_RENDER_END', (html) => {
            this.els.historyContainer.innerHTML = html;
            this.els.inputStory.parentElement.classList.add('hidden');
            document.getElementById('game-status').innerText = "遊戲結束";
        });
    }

    renderRoom(state) {
        if (!state.room.active) return;
        this.els.dispCode.innerText = state.room.id;
        this.els.hostPanel.style.display = state.me.isHost ? 'block' : 'none';

        // 渲染玩家列表
        const players = Object.values(state.players);
        this.els.playerCount.innerText = `(${players.filter(p => p.online).length}/8)`;
        this.els.playerList.innerHTML = players.map(p => `
      <li class="${p.online ? '' : 'offline'}">
        <span>${p.name} ${p.isHost ? '<span class="host-badge">房主</span>' : ''}</span>
        <span>${p.online ? '🟢' : '🔴'}</span>
      </li>
    `).join('');
    }
}

// ==========================================
// 12. App 初始化啟動
// ==========================================
class App {
    constructor() {
        new UIController();

        // 檢查 Session 恢復機制 (簡單實作)
        const savedId = localStorage.getItem('story_relay_id');
        if (savedId) {
            // 若要實作斷線重連，可在此讀取 localStorage 並觸發恢復流程
        }
        localStorage.setItem('story_relay_id', store.get().me.id);

        console.log("App Initialized. Strict Event-Driven Architecture Active.");
    }
}

// 啟動應用程式
window.onload = () => new App();