/**
 * auth.js — SpeakTogether Firebase Phone OTP Authentication
 * Handles: OTP send, OTP verify, JWT storage, session management
 */

// ─────────────────────────────────────────────
// Firebase config (filled from .env values via
// server-side injection or manually set here)
// Replace these with your Firebase project values
// from: Firebase Console → Project Settings → General → Your apps
// ─────────────────────────────────────────────
const FIREBASE_CONFIG = {
    apiKey           : 'AIzaSyD6ajoEa7QpChtW4N9NwAmGU8Vlv_VhrsY',
    authDomain       : 'englishpartners-ebd4b.firebaseapp.com',
    projectId        : 'englishpartners-ebd4b',
    storageBucket    : 'englishpartners-ebd4b.firebasestorage.app',
    messagingSenderId: '799422675503',
    appId            : '1:799422675503:web:446b6244e454188af564da',
    measurementId    : 'G-5H2ZD7FZGF',
};

const JWT_KEY      = 'st_jwt';
const USER_KEY     = 'st_user';
const RECAPTCHA_ID = 'st-recaptcha-container';

let firebaseApp        = null;
let firebaseAuth       = null;
let confirmationResult = null;
let recaptchaVerifier  = null;

// ─────────────────────────────────────────────
// Init Firebase (lazy)
// ─────────────────────────────────────────────
async function _initFirebase() {
    if (firebaseAuth) return;
    const { initializeApp }                  = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
    const { getAuth, RecaptchaVerifier, signInWithPhoneNumber, GoogleAuthProvider, signInWithPopup } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
    firebaseApp  = initializeApp(FIREBASE_CONFIG);
    firebaseAuth = getAuth(firebaseApp);
    firebaseAuth.languageCode = 'en';
    window._fbSignIn    = signInWithPhoneNumber;
    window._fbRecap     = RecaptchaVerifier;
    window._fbGoogleProvider = GoogleAuthProvider;
    window._fbSignInPopup    = signInWithPopup;
}

// ─────────────────────────────────────────────
// Setup invisible reCAPTCHA (run once per modal open)
// ─────────────────────────────────────────────
async function _setupRecaptcha() {
    await _initFirebase();
    if (recaptchaVerifier) {
        try { recaptchaVerifier.clear(); } catch (_) {}
        recaptchaVerifier = null;
    }
    // Firebase v10+ signature: RecaptchaVerifier(auth, container, parameters)
    recaptchaVerifier = new window._fbRecap(firebaseAuth, RECAPTCHA_ID, {
        size    : 'invisible',
        callback: () => {},
    });
    await recaptchaVerifier.render();
}

// ─────────────────────────────────────────────
// Send OTP to phone number (E.164 format)
// e.g. +919876543210
// ─────────────────────────────────────────────
async function sendOTP(phoneE164) {
    // ── TEST BYPASS ──
    // If the user types a string of 1s (e.g., 11111111) we trigger the bypass
    if (phoneE164.includes('111111') || phoneE164 === '+911111111111') {
        confirmationResult = { mock: true, phone: phoneE164 };
        return confirmationResult;
    }

    await _setupRecaptcha();
    confirmationResult = await window._fbSignIn(firebaseAuth, phoneE164, recaptchaVerifier);
    return confirmationResult;
}

// ─────────────────────────────────────────────
// Verify OTP code entered by user
// Returns { token, user } on success
// ─────────────────────────────────────────────
async function verifyOTP(code, displayName, email, gender = 'other') {
    if (!confirmationResult) throw new Error('No OTP session. Please request OTP first.');
    
    let idToken;
    if (confirmationResult.mock) {
        if (code !== '123456') throw new Error('Incorrect mock OTP. Use 123456.');
        idToken = 'TEST_TOKEN_1111111111';
    } else {
        const credential = await confirmationResult.confirm(code);
        idToken = await credential.user.getIdToken();
    }

    // Exchange Firebase token for our JWT
    const res = await fetch('/api/auth/verify-token', {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({ idToken, displayName, email, gender }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Server authentication failed.');
    }
    const data = await res.json();

    // Persist JWT + user
    localStorage.setItem(JWT_KEY,  data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));

    return data;
}

// ─────────────────────────────────────────────
// Check if current user is authenticated
// ─────────────────────────────────────────────
function isAuthenticated() {
    const token = localStorage.getItem(JWT_KEY);
    if (!token) return false;
    try {
        // Decode JWT payload (no crypto verify — just check expiry client-side)
        const payload = JSON.parse(atob(token.split('.')[1]));
        return payload.exp * 1000 > Date.now();
    } catch {
        return false;
    }
}

// ─────────────────────────────────────────────
// Get stored user profile
// ─────────────────────────────────────────────
function getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY)) || null; }
    catch { return null; }
}

// ─────────────────────────────────────────────
// Get stored JWT token
// ─────────────────────────────────────────────
function getToken() {
    return localStorage.getItem(JWT_KEY) || null;
}

// ─────────────────────────────────────────────
// Sign out
// ─────────────────────────────────────────────
async function signOut() {
    localStorage.removeItem(JWT_KEY);
    localStorage.removeItem(USER_KEY);
    if (firebaseAuth) {
        try { await firebaseAuth.signOut(); } catch (_) {}
    }
}

// ─────────────────────────────────────────────
// Refresh user profile from server
// ─────────────────────────────────────────────
async function refreshProfile() {
    const token = getToken();
    if (!token) return null;
    const res = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    return user;
}

// ─────────────────────────────────────────────
// Record a completed session to backend
// ─────────────────────────────────────────────
async function recordSession({ partnerName, level, durationSec, xpEarned }) {
    const token = getToken();
    if (!token) return;
    try {
        await fetch('/api/auth/session', {
            method : 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body   : JSON.stringify({ partnerName, level, durationSec, xpEarned }),
        });
    } catch (_) {}
}

// ─────────────────────────────────────────────
// Delete a session from history
// ─────────────────────────────────────────────
async function deleteCallHistory(index) {
    const token = getToken();
    if (!token) return false;
    try {
        const res = await fetch(`/api/auth/history/${index}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) return false;
        const data = await res.json();
        if (data.success) {
            // Update local user state
            const user = getUser();
            if (user) {
                user.sessionHistory = data.sessionHistory;
                localStorage.setItem(USER_KEY, JSON.stringify(user));
            }
            return true;
        }
        return false;
    } catch (_) {
        return false;
    }
}

// ─────────────────────────────────────────────
// Auth guard — call on protected pages
// Redirects to / if not authenticated
// ─────────────────────────────────────────────
function requireAuth(redirectUrl = '/') {
    if (!isAuthenticated()) {
        sessionStorage.setItem('st_redirect', window.location.href);
        window.location.href = redirectUrl;
        return false;
    }
    return true;
}

// ─────────────────────────────────────────────
// Google Sign-In via Firebase OAuth popup
// Returns { token, user } on success
// ─────────────────────────────────────────────
async function signInWithGoogle(gender = 'other') {
    await _initFirebase();
    const provider = new window._fbGoogleProvider();
    provider.addScope('email');
    provider.addScope('profile');
    provider.setCustomParameters({
        prompt: 'select_account'
    });
    const credential  = await window._fbSignInPopup(firebaseAuth, provider);
    const idToken     = await credential.user.getIdToken();
    const displayName = credential.user.displayName || '';
    const email       = credential.user.email || '';

    const res = await fetch('/api/auth/verify-token', {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({ idToken, displayName, email, gender }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Google sign-in failed on server.');
    }
    const data = await res.json();
    localStorage.setItem(JWT_KEY,  data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    return data;
}

// Expose globally
window.SpeakAuth = {
    sendOTP, verifyOTP, signInWithGoogle, isAuthenticated, getUser,
    getToken, signOut, refreshProfile, recordSession, deleteCallHistory, requireAuth,
};
