'use strict';

const mongoose = require('mongoose');

const sessionHistorySchema = new mongoose.Schema({
    partnerName : { type: String, default: 'Anonymous' },
    level       : { type: String, default: 'beginner' },
    durationSec : { type: Number, default: 0 },
    xpEarned    : { type: Number, default: 0 },
    sessionAt   : { type: Date,   default: Date.now },
}, { _id: false });

const userSchema = new mongoose.Schema({
    // Firebase UID — primary identifier
    firebaseUid : { type: String, required: true, unique: true, index: true },

    // Phone number in E.164 format e.g. +919876543210
    phone       : { type: String, required: false, unique: true, sparse: true, trim: true },

    // Optional/Alternative Email (Gmail)
    email       : { type: String, default: '', trim: true },

    // Display name (editable by user)
    displayName : { type: String, default: '', trim: true, maxlength: 50 },

    // Profile photo avatar (Base64 data or image URL)
    avatar      : { type: String, default: '' },

    // Gamification
    level           : { type: Number, default: 1, min: 1 },
    xp              : { type: Number, default: 0, min: 0 },
    currentStreak   : { type: Number, default: 0, min: 0 },
    longestStreak   : { type: Number, default: 0, min: 0 },
    totalSessionsSec: { type: Number, default: 0, min: 0 },
    sessionCount    : { type: Number, default: 0, min: 0 },

    // Social
    followers   : { type: Number, default: 0 },
    following   : { type: Number, default: 0 },

    // Session history (last 20 sessions)
    sessionHistory: {
        type    : [sessionHistorySchema],
        default : [],
        validate: { validator: v => v.length <= 20, message: 'Max 20 sessions stored' },
    },

    // Streak tracking
    lastActiveDate  : { type: Date, default: null },
    lastLogin       : { type: Date, default: Date.now },
    createdAt       : { type: Date, default: Date.now },

}, { versionKey: false });

userSchema.methods.addXP = function (amount) {
    this.xp += amount;
    // WePlay level up math:
    // Level L requires 100 * L * (L - 1) / 2 cumulative XP.
    // e.g. Level 1 needs 100 XP to get to Level 2.
    // Level 2 needs 200 XP to get to Level 3.
    let currentLevel = 1;
    while (this.xp >= 100 * currentLevel * (currentLevel + 1) / 2) {
        currentLevel++;
    }
    this.level = currentLevel;
};

// ── Update streak on login ──
userSchema.methods.updateStreak = function () {
    const now   = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    if (!this.lastActiveDate) {
        this.currentStreak = 1;
    } else {
        const last     = new Date(this.lastActiveDate);
        const lastDay  = new Date(last.getFullYear(), last.getMonth(), last.getDate());
        const diffDays = Math.round((today - lastDay) / 86_400_000);
        if (diffDays === 1)      this.currentStreak += 1;
        else if (diffDays > 1)   this.currentStreak  = 1;
        // diffDays === 0 → same day, no change
    }
    if (this.currentStreak > this.longestStreak) this.longestStreak = this.currentStreak;
    this.lastActiveDate = now;
    this.lastLogin      = now;
};

// ── Add session to history (keep last 20) ──
userSchema.methods.addSession = function ({ partnerName, level, durationSec, xpEarned }) {
    this.sessionHistory.unshift({ partnerName, level, durationSec, xpEarned, sessionAt: new Date() });
    if (this.sessionHistory.length > 20) this.sessionHistory.pop();
    this.totalSessionsSec += durationSec;
    this.sessionCount     += 1;
    this.addXP(xpEarned);
};

// ── Safe public profile (no internal fields) ──
userSchema.methods.toPublic = function () {
    return {
        uid            : this.firebaseUid,
        phone          : this.phone,
        email          : this.email,
        displayName    : this.displayName,
        avatar         : this.avatar,
        level          : this.level,
        xp             : this.xp,
        currentStreak  : this.currentStreak,
        longestStreak  : this.longestStreak,
        totalSessionsSec: this.totalSessionsSec,
        sessionCount   : this.sessionCount,
        followers      : this.followers,
        following      : this.following,
        sessionHistory : this.sessionHistory,
        createdAt      : this.createdAt,
    };
};

module.exports = mongoose.model('User', userSchema);
