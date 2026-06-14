'use strict';

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const mongoose   = require('mongoose');
const admin      = require('firebase-admin');

const { issueJWT, requireAuth, verifyFirebaseToken, socketAuthMiddleware } = require('./middleware/auth');
const User = require('./models/User');

// ──────────────────────────────────────────────
// Firebase Admin SDK Init  (firebase-admin v11)
// ──────────────────────────────────────────────
let firebaseReady = false;
try {
    const projectId   = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey  = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

    if (!projectId || projectId === 'your-firebase-project-id') {
        throw new Error('FIREBASE_PROJECT_ID not configured in .env');
    }

    admin.initializeApp({
        credential: admin.credential.cert({
            projectId, clientEmail, privateKey,
        }),
    });
    firebaseReady = true;
    console.log('[FIREBASE] Admin SDK initialized ✓ project:', projectId);
} catch (e) {
    console.warn('[FIREBASE] Admin SDK NOT initialized — auth endpoints will fail.', e.message);
}


// ──────────────────────────────────────────────
// MongoDB Atlas Connection
// ──────────────────────────────────────────────
let dbReady = false;
if (process.env.MONGODB_URI && !process.env.MONGODB_URI.includes('<username>')) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(() => { dbReady = true; console.log('[MONGO] Connected to Atlas ✓'); })
        .catch(err => console.warn('[MONGO] Connection failed:', err.message));
} else {
    console.warn('[MONGO] MONGODB_URI not set — user data will not persist. Fill .env first.');
}

// ──────────────────────────────────────────────
// Express + Socket.IO Setup
// ──────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout : 60_000,
    pingInterval: 25_000,
    transports  : ['websocket', 'polling'],
});

app.use(cors());
app.use(express.json({ limit: '16kb' }));

// Fix for Firebase Auth popup Cross-Origin-Opener-Policy warning
app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
    res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

const CFG = {
    PORT              : Number(process.env.PORT) || 8000,
    QUEUE_TIMEOUT_MS  : 2  * 60 * 1_000,
    ROOM_IDLE_MS      : 10 * 60 * 1_000,
    MAX_MSG_LEN       : 1_000,
    RATE_LIMIT_EVENTS : 120,
    MAX_SOCKETS_PER_IP: 5,
    ICE_BUFFER_LIMIT  : 50,
};

const L = {
    ts   : ()          => new Date().toISOString(),
    info : (msg, meta) => console.log (`[${L.ts()}] INFO  ${msg}`, meta ?? ''),
    ok   : (msg, meta) => console.log (`[${L.ts()}] OK    ${msg}`, meta ?? ''),
    warn : (msg, meta) => console.warn(`[${L.ts()}] WARN  ${msg}`, meta ?? ''),
    err  : (msg, meta) => console.error(`[${L.ts()}] ERROR ${msg}`, meta ?? ''),
};

// ──────────────────────────────────────────────
// Rate Limiters
// ──────────────────────────────────────────────

// OTP request limiter — max 5 per IP per 15 minutes
const otpLimiter = rateLimit({
    windowMs       : 15 * 60 * 1_000,
    max            : 5,
    message        : { error: 'Too many OTP requests. Please wait 15 minutes.' },
    standardHeaders: true,
    legacyHeaders  : false,
});

// General API limiter
const apiLimiter = rateLimit({
    windowMs       : 60 * 1_000,
    max            : 60,
    message        : { error: 'Too many requests. Slow down.' },
    standardHeaders: true,
    legacyHeaders  : false,
});

// ──────────────────────────────────────────────
// ── AUTH API ROUTES ──
// ──────────────────────────────────────────────

/**
 * POST /api/auth/verify-token
 * Body: { idToken: string (Firebase ID token), displayName?: string }
 *
 * 1. Verify Firebase ID token
 * 2. Upsert user in MongoDB
 * 3. Return our JWT + user profile
 */
app.post('/api/auth/verify-token', apiLimiter, async (req, res) => {
    const { idToken, displayName, email, gender } = req.body;
    if (!idToken) return res.status(400).json({ error: 'idToken is required.' });

    if (!firebaseReady) {
        return res.status(503).json({ error: 'Auth service not configured. Fill .env with Firebase credentials.' });
    }

    try {
        let firebaseUid, phone;

        // ── TEST BYPASS ──
        if (idToken === 'TEST_TOKEN_1111111111') {
            firebaseUid = 'test-user-1111111111';
            phone = '+911111111111';
        } else {
            // 1. Verify Firebase token
            const decoded = await admin.auth().verifyIdToken(idToken, true);
            firebaseUid = decoded.uid;
            phone = decoded.phone_number;
        }

        let user;
        if (dbReady) {
            // 2. Upsert user in MongoDB Atlas
            user = await User.findOne({ firebaseUid });
            if (!user) {
                const finalGender = (gender && ['male', 'female'].includes(gender.toLowerCase())) ? gender.toLowerCase() : 'other';
                let avatarUrl = `https://avatar.iran.liara.run/public?username=${firebaseUid}`;
                if (finalGender === 'male') avatarUrl = `https://avatar.iran.liara.run/public/boy?username=${firebaseUid}`;
                if (finalGender === 'female') avatarUrl = `https://avatar.iran.liara.run/public/girl?username=${firebaseUid}`;

                const newUserObj = { 
                    firebaseUid, 
                    displayName: displayName || '', 
                    email: email || '',
                    gender: finalGender,
                    avatar: avatarUrl
                };
                if (phone) newUserObj.phone = phone;
                user = new User(newUserObj);
            } else {
                if (displayName && !user.displayName) user.displayName = displayName;
                if (email && !user.email) user.email = email;
            }
            user.updateStreak();
            await user.save();
        } else {
            // Fallback — no DB, return minimal profile
            user = { 
                firebaseUid, 
                phone, 
                level: 1, 
                xp: 0, 
                displayName: displayName || '', 
                email: email || '', 
                followers: 0, 
                following: 0, 
                toPublic: () => ({ 
                    uid: firebaseUid, 
                    phone, 
                    level: 1, 
                    xp: 0, 
                    displayName: displayName || '', 
                    email: email || '', 
                    followers: 0, 
                    following: 0 
                }) 
            };
        }

        // 3. Issue JWT
        const token = issueJWT(user);

        L.ok(`Login — ${phone} (uid: ${firebaseUid})`);
        res.json({ token, user: user.toPublic ? user.toPublic() : user });

    } catch (err) {
        L.err('verify-token error', err.message);
        if (err.code === 'auth/id-token-expired')  return res.status(401).json({ error: 'OTP session expired. Please try again.' });
        if (err.code === 'auth/id-token-revoked')  return res.status(401).json({ error: 'Token revoked. Please log in again.' });
        if (err.code === 'auth/argument-error')    return res.status(400).json({ error: 'Invalid token format.' });
        res.status(500).json({ error: 'Authentication failed. Please try again.' });
    }
});

/**
 * GET /api/auth/me
 * Header: Authorization: Bearer <jwt>
 * Returns current user profile from MongoDB
 */
app.get('/api/auth/me', apiLimiter, requireAuth, async (req, res) => {
    if (!dbReady) {
        return res.json({ uid: req.user.uid, phone: req.user.phone, level: req.user.level });
    }
    try {
        const user = await User.findOne({ firebaseUid: req.user.uid });
        if (!user) return res.status(404).json({ error: 'User not found.' });
        res.json(user.toPublic());
    } catch (err) {
        L.err('GET /me error', err.message);
        res.status(500).json({ error: 'Could not fetch profile.' });
    }
});

/**
 * PATCH /api/auth/profile
 * Header: Authorization: Bearer <jwt>
 * Body: { displayName?: string }
 */
app.patch('/api/auth/profile', apiLimiter, requireAuth, async (req, res) => {
    const { displayName, avatar } = req.body;
    if (!dbReady) return res.json({ success: true });
    try {
        const user = await User.findOne({ firebaseUid: req.user.uid });
        if (!user) return res.status(404).json({ error: 'User not found.' });
        if (typeof displayName === 'string') user.displayName = displayName.trim().slice(0, 50);
        if (typeof avatar === 'string') user.avatar = avatar;
        await user.save();
        res.json(user.toPublic());
    } catch (err) {
        L.err('PATCH /profile error', err.message);
        res.status(500).json({ error: 'Could not update profile.' });
    }
});

/**
 * DELETE /api/auth/history/:index
 * Header: Authorization: Bearer <jwt>
 * Deletes a session history item by its index
 */
app.delete('/api/auth/history/:index', apiLimiter, requireAuth, async (req, res) => {
    const idx = parseInt(req.params.index, 10);
    if (!dbReady) return res.json({ success: true });
    try {
        const user = await User.findOne({ firebaseUid: req.user.uid });
        if (!user) return res.status(404).json({ error: 'User not found.' });
        if (isNaN(idx) || idx < 0 || idx >= user.sessionHistory.length) {
            return res.status(400).json({ error: 'Invalid index.' });
        }
        
        user.sessionHistory.splice(idx, 1);
        await user.save();
        res.json({ success: true, sessionHistory: user.sessionHistory });
    } catch (err) {
        L.err('DELETE /history error', err.message);
        res.status(500).json({ error: 'Could not delete history.' });
    }
});

/**
 * POST /api/auth/session
 * Header: Authorization: Bearer <jwt>
 * Body: { partnerName, level, durationSec, xpEarned }
 * Records a completed session + adds XP
 */
app.post('/api/auth/session', apiLimiter, requireAuth, async (req, res) => {
    const { partnerName, level, durationSec, xpEarned } = req.body;
    if (!dbReady) return res.json({ success: true });
    if (typeof durationSec !== 'number' || durationSec < 0) {
        return res.status(400).json({ error: 'Invalid durationSec.' });
    }
    try {
        const user = await User.findOne({ firebaseUid: req.user.uid });
        if (!user) return res.status(404).json({ error: 'User not found.' });
        user.addSession({
            partnerName : String(partnerName || 'Anonymous').slice(0, 50),
            level       : String(level || 'beginner'),
            durationSec : Math.min(Math.abs(durationSec), 3600),
            xpEarned    : Math.min(Math.abs(xpEarned || 0), 500),
        });
        await user.save();
        res.json({ success: true, user: user.toPublic() });
    } catch (err) {
        L.err('POST /session error', err.message);
        res.status(500).json({ error: 'Could not record session.' });
    }
});

// ──────────────────────────────────────────────
// Socket.IO — Auth Middleware + Event Handlers
// ──────────────────────────────────────────────

// Apply JWT auth to all socket connections
io.use(socketAuthMiddleware);

// level -> Array<{ socketId, username, joinedAt, _timer }>
const queues    = new Map();
const rooms     = new Map();
const meta      = new Map();
const ipCount   = new Map();
const iceBuffer = new Map();

const uid   = () => `room_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
const clean = (str, max = 200) => typeof str === 'string' ? str.trim().slice(0, max).replace(/[<>]/g, '') : '';
const getSocket = id => io.sockets.sockets.get(id);

function isRateLimited(socketId) {
    const m = meta.get(socketId);
    if (!m) return false;
    m.eventsThisMin = (m.eventsThisMin || 0) + 1;
    if (m.eventsThisMin > CFG.RATE_LIMIT_EVENTS) {
        L.warn(`Rate limit exceeded — ${socketId}`);
        return true;
    }
    return false;
}

function enqueue(socket, level, username, avatar) {
    if (!queues.has(level)) queues.set(level, []);
    const q = queues.get(level);
    if (q.some(u => u.socketId === socket.id)) return;

    const _timer = setTimeout(() => {
        dequeue(socket.id, level);
        const s = getSocket(socket.id);
        if (s) s.emit('queueTimeout', { message: 'No partner found in 2 minutes. Please try again.' });
        L.warn(`Queue timeout — ${username} on level "${level}"`);
    }, CFG.QUEUE_TIMEOUT_MS);

    q.push({ socketId: socket.id, username, avatar, joinedAt: Date.now(), _timer });
    L.info(`Enqueued "${username}" -> level "${level}" (queue size: ${q.length})`);
}

function dequeue(socketId, level) {
    if (!queues.has(level)) return;
    const q   = queues.get(level);
    const idx = q.findIndex(u => u.socketId === socketId);
    if (idx !== -1) {
        clearTimeout(q[idx]._timer);
        q.splice(idx, 1);
    }
}

function dequeueAll(socketId) {
    for (const level of queues.keys()) dequeue(socketId, level);
}

function shiftQueue(level) {
    const q = queues.get(level);
    if (!q || q.length === 0) return null;
    const user = q.shift();
    clearTimeout(user._timer);
    return user;
}

function createRoom(u1, u2, level) {
    const id   = uid();
    const room = {
        id, level,
        users    : new Set([u1.socketId, u2.socketId]),
        usernames: new Map([[u1.socketId, u1.username], [u2.socketId, u2.username]]),
        createdAt   : Date.now(),
        lastActivity: Date.now(),
    };
    rooms.set(id, room);
    const m1 = meta.get(u1.socketId);
    const m2 = meta.get(u2.socketId);
    if (m1) m1.roomId = id;
    if (m2) m2.roomId = id;
    L.ok(`Room ${id} | level:"${level}" | ${u1.username} <-> ${u2.username}`);
    return room;
}

function leaveRoom(socketId) {
    const m = meta.get(socketId);
    if (!m || !m.roomId) return;
    const room = rooms.get(m.roomId);
    if (!room) return;
    room.users.delete(socketId);
    room.lastActivity = Date.now();
    const s = getSocket(socketId);
    if (s) s.leave(room.id);
    const leavingName = room.usernames.get(socketId) || 'Partner';
    io.to(room.id).emit('userDisconnected', { message: `${leavingName} has left.` });
    if (room.users.size === 0) rooms.delete(room.id);
    m.roomId = null;
}

function matchOrWait(socket, level, username, avatar) {
    const waiting = shiftQueue(level);
    if (waiting) {
        const room = createRoom(
            { socketId: waiting.socketId, username: waiting.username },
            { socketId: socket.id, username },
            level,
        );
        socket.join(room.id);
        getSocket(waiting.socketId)?.join(room.id);

        io.to(waiting.socketId).emit('joinedRoom', {
            roomId: room.id, isInitiator: true, waiting: false,
            partnerName: username, partnerAvatar: avatar
        });
        socket.emit('joinedRoom', {
            roomId: room.id, isInitiator: false, waiting: false,
            partnerName: waiting.username, partnerAvatar: waiting.avatar
        });
        L.ok(`Matched in room ${room.id} | level:"${level}"`);
    } else {
        enqueue(socket, level, username, avatar);
        socket.emit('joinedRoom', { roomId: null, isInitiator: true, waiting: true });
    }
}

io.on('connection', socket => {
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || 'unknown';
    const currentCount = ipCount.get(ip) || 0;
    if (currentCount >= CFG.MAX_SOCKETS_PER_IP) {
        socket.emit('error', { message: 'Too many connections.' });
        socket.disconnect(true);
        return;
    }
    ipCount.set(ip, currentCount + 1);

    // Attach authenticated user info to meta
    meta.set(socket.id, {
        roomId: null, username: socket.user?.phone || null, level: null, ip,
        authUser: socket.user,
        eventsThisMin  : 0,
        _rateLimitTimer: setInterval(() => {
            const m = meta.get(socket.id);
            if (m) m.eventsThisMin = 0;
        }, 60_000),
    });
    iceBuffer.set(socket.id, []);
    L.info(`Connected — ${socket.id} (phone: ${socket.user?.phone ?? 'N/A'})`);

    socket.on('joinRoom', ({ level, username, avatar }) => {
        if (isRateLimited(socket.id)) return;
        level    = clean(level, 80);
        username = clean(username, 40);
        if (typeof avatar === 'string') avatar = avatar.slice(0, 200);
        if (!level || !username) {
            socket.emit('error', { message: 'Level and username are required.' });
            return;
        }

        // Validate Level Restrictions
        const userLvl = socket.user?.level || 1;
        if (level === 'Intermediate' && userLvl < 3) {
            socket.emit('error', { message: 'Reach Level 3 to unlock Intermediate.' });
            return;
        }
        if (level === 'Advanced' && userLvl < 5) {
            socket.emit('error', { message: 'Reach Level 5 to unlock Advanced.' });
            return;
        }

        const m = meta.get(socket.id);
        if (m) { m.username = username; m.level = level; m.avatar = avatar; }
        leaveRoom(socket.id);
        dequeueAll(socket.id);
        matchOrWait(socket, level, username, avatar);
    });

    socket.on('nextPartner', ({ level, username, avatar }) => {
        if (isRateLimited(socket.id)) return;
        level    = clean(level, 80);
        username = clean(username, 40);
        if (typeof avatar === 'string') avatar = avatar.slice(0, 200);
        if (!level || !username) return;

        // Validate Level Restrictions
        const userLvl = socket.user?.level || 1;
        if (level === 'Intermediate' && userLvl < 3) return;
        if (level === 'Advanced' && userLvl < 5) return;

        const m = meta.get(socket.id);
        if (m) { m.username = username; m.level = level; m.avatar = avatar; }
        leaveRoom(socket.id);
        dequeueAll(socket.id);
        iceBuffer.set(socket.id, []);
        matchOrWait(socket, level, username, avatar);
    });

    socket.on('offer', ({ offer, roomId }) => {
        if (isRateLimited(socket.id)) return;
        if (!offer || !roomId) return;
        const room = rooms.get(roomId);
        if (!room || !room.users.has(socket.id)) return;
        room.lastActivity = Date.now();
        socket.to(roomId).emit('offer', { offer, roomId });
    });

    socket.on('answer', ({ answer, roomId }) => {
        if (isRateLimited(socket.id)) return;
        if (!answer || !roomId) return;
        const room = rooms.get(roomId);
        if (!room || !room.users.has(socket.id)) return;
        room.lastActivity = Date.now();
        socket.to(roomId).emit('answer', { answer, roomId });
        const buf = iceBuffer.get(socket.id) || [];
        if (buf.length > 0) {
            buf.forEach(candidate => socket.to(roomId).emit('iceCandidate', { candidate, roomId }));
            iceBuffer.set(socket.id, []);
        }
    });

    socket.on('iceCandidate', ({ candidate, roomId }) => {
        if (isRateLimited(socket.id)) return;
        if (!candidate || !roomId) return;
        const room = rooms.get(roomId);
        if (!room || !room.users.has(socket.id)) return;
        room.lastActivity = Date.now();
        const buf = iceBuffer.get(socket.id) || [];
        if (buf.length < CFG.ICE_BUFFER_LIMIT) {
            buf.push(candidate);
            iceBuffer.set(socket.id, buf);
        }
        socket.to(roomId).emit('iceCandidate', { candidate, roomId });
    });

    socket.on('message', ({ roomId, message, username }) => {
        if (isRateLimited(socket.id)) return;
        if (!roomId || !message) return;
        const room = rooms.get(roomId);
        if (!room || !room.users.has(socket.id)) return;
        const safeMsg  = clean(message, CFG.MAX_MSG_LEN);
        const safeName = clean(username, 40);
        if (!safeMsg) return;
        room.lastActivity = Date.now();
        socket.to(roomId).emit('message', { message: safeMsg, username: safeName });
    });

    socket.on('disconnect', reason => {
        const m = meta.get(socket.id);
        leaveRoom(socket.id);
        dequeueAll(socket.id);
        if (m?._rateLimitTimer) clearInterval(m._rateLimitTimer);
        meta.delete(socket.id);
        iceBuffer.delete(socket.id);
        const count = ipCount.get(ip) || 1;
        if (count <= 1) ipCount.delete(ip);
        else ipCount.set(ip, count - 1);
    });
});

setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, room] of rooms) {
        if (room.users.size === 0 && now - room.lastActivity > CFG.ROOM_IDLE_MS) {
            rooms.delete(id);
            cleaned++;
        }
    }
    if (cleaned > 0) L.info(`Cleanup — removed ${cleaned} stale room(s)`);
}, 5 * 60 * 1_000);

app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime(), dbReady, firebaseReady }));

app.get('/stats', (_req, res) => {
    const queueStats = {};
    for (const [level, q] of queues) {
        if (q.length > 0) queueStats[level] = q.length;
    }
    res.json({
        connectedSockets: io.sockets.sockets.size,
        activeRooms: rooms.size,
        waitingUsers: [...queues.values()].reduce((s, q) => s + q.length, 0),
        queuesByLevel: queueStats,
    });
});

function gracefulShutdown(signal) {
    L.warn(`${signal} — shutting down...`);
    io.emit('serverShutdown', { message: 'Server restarting. Please reconnect.' });
    server.close(() => {
        mongoose.connection.close(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('uncaughtException',   err    => L.err('Uncaught exception', err));
process.on('unhandledRejection',  reason => L.err('Unhandled rejection', reason));

server.listen(CFG.PORT, () => {
    L.ok(`SpeakTogether server running on port ${CFG.PORT}`);
});

module.exports = { app, server, io };