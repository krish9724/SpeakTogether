'use strict';

const jwt         = require('jsonwebtoken');
const admin       = require('firebase-admin');

const JWT_SECRET  = process.env.JWT_SECRET || 'changeme_in_production';
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN || '7d';

// ─────────────────────────────────────────────
// Issue a signed JWT for a user
// ─────────────────────────────────────────────
function issueJWT(user) {
    return jwt.sign(
        {
            uid   : user.firebaseUid,
            phone : user.phone,
            level : user.level,
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES, algorithm: 'HS256' }
    );
}

// ─────────────────────────────────────────────
// Express REST middleware — verifies JWT from
// Authorization: Bearer <token>  header
// ─────────────────────────────────────────────
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
    }
    const token = authHeader.slice(7);
    try {
        const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
        req.user = decoded;         // { uid, phone, level, iat, exp }
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Session expired. Please log in again.' });
        }
        return res.status(401).json({ error: 'Invalid token.' });
    }
}

// ─────────────────────────────────────────────
// Verify a Firebase ID token (from client SDK)
// Returns decoded token payload or throws
// ─────────────────────────────────────────────
async function verifyFirebaseToken(idToken) {
    // checkRevoked: true — ensures token wasn't revoked
    const decoded = await admin.auth().verifyIdToken(idToken, true);
    return decoded;   // { uid, phone_number, firebase: {...}, ... }
}

// ─────────────────────────────────────────────
// Socket.IO middleware — verifies JWT from
// handshake.auth.token
// ─────────────────────────────────────────────
function socketAuthMiddleware(socket, next) {
    const token = socket.handshake.auth?.token;
    if (!token) {
        return next(new Error('AUTH_REQUIRED'));
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
        socket.user = decoded;
        next();
    } catch {
        next(new Error('AUTH_INVALID'));
    }
}

module.exports = { issueJWT, requireAuth, verifyFirebaseToken, socketAuthMiddleware };
