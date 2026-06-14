// ── SpeakTogether Session JS ──

const TOPICS = [
  "Describe your dream job and why it appeals to you.",
  "Talk about your favorite movie and what makes it special.",
  "Tell your partner about your city — what's it like to live there?",
  "Describe your daily routine from morning to night.",
  "What are your future goals? Where do you see yourself in 5 years?",
  "Describe your favorite hobby and how you got into it.",
  "What motivates you to keep going when things get tough?"
];

const DAILY_LIMIT_SECONDS = 300; // 5 minutes
const WARNING_AT = 180;          // 3 min (2 min remaining)

// Video unlocks only at Advanced level
const VIDEO_LEVELS = ['Advanced'];

// ── State ──
const socket = io({ auth: { token: localStorage.getItem('st_jwt') || '' } });
let localStream, peerConnection, currentRoom;
let username = sessionStorage.getItem('st_username') || '';
let currentLevel = sessionStorage.getItem('st_level') || '';
const initialDash = JSON.parse(localStorage.getItem('st_dashboard') || '{}');
const currentUser = JSON.parse(localStorage.getItem('st_user') || '{}');
let userAvatar = currentUser.avatar || initialDash.avatar || `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(username)}`;

let micMuted = false, camOff = false, msgCount = 0;
let sessionSeconds = 0, sessionInterval = null;
let currentTopic = '';
let isVideoEnabled = VIDEO_LEVELS.includes(currentLevel);

// ── Dashboard / XP Storage ──
function getDashboard() {
  const d = JSON.parse(localStorage.getItem('st_dashboard') || '{}');
  const today = new Date().toDateString();
  if (d.lastDate !== today) { d.dailyUsed = 0; d.lastDate = today; }
  return {
    totalSeconds: d.totalSeconds ?? 0,
    sessions: d.sessions ?? 0,
    streak: d.streak ?? 0,
    longestStreak: d.longestStreak ?? 0,
    dailyUsed: d.dailyUsed ?? 0,
    lastDate: d.lastDate ?? today,
    lastSessionDate: d.lastSessionDate ?? '',
    xp: d.xp ?? 0,
    userLevel: d.userLevel ?? 1,
    email: d.email ?? 'student@gmail.com',
    followers: d.followers ?? 142,
    following: d.following ?? 95,
    callHistory: d.callHistory ?? [],
    authenticated: d.authenticated ?? false
  };
}

function saveDashboard(d) { localStorage.setItem('st_dashboard', JSON.stringify(d)); }

function updateStreak(d) {
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  if (d.lastSessionDate === today) return;
  if (d.lastSessionDate === yesterday) d.streak++;
  else d.streak = 1;
  d.lastSessionDate = today;
}

// XP system: 10 XP per session, 1 XP per 30s of practice
function getLevelFromXP(xp) {
  let lvl = 1;
  while (xp >= 100 * lvl * (lvl + 1) / 2) {
    lvl++;
  }
  return lvl;
}

function addXP(d, sessionSecs) {
  const xpEarned = 10 + Math.floor(sessionSecs / 30);
  d.xp += xpEarned;
  const newLevel = getLevelFromXP(d.xp);
  if (newLevel > d.userLevel) {
    d.userLevel = newLevel;
    return { leveledUp: true, xpEarned, newLevel };
  }
  return { leveledUp: false, xpEarned, newLevel: d.userLevel };
}

function getXPForNextLevel(d) {
  const currentLvl = getLevelFromXP(d.xp);
  const cumulativeCurrent = 100 * (currentLvl - 1) * currentLvl / 2;
  const xpProgress = d.xp - cumulativeCurrent;
  const xpNeeded = 100 * currentLvl;
  return { current: xpProgress, needed: xpNeeded, total: d.xp, level: currentLvl };
}

// ── DOM ──
const loaderOverlay = document.getElementById('loaderOverlay');
const loaderText = document.getElementById('loaderText');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const messagesEl = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const nextBtn = document.getElementById('nextBtn');
const partnerNameEl = document.getElementById('partnerName');
const msgCountEl = document.getElementById('msgCount');
const timerPill = document.getElementById('timerPill');
const sessionTimerEl = document.getElementById('sessionTimer');
const topicDisplay = document.getElementById('topicDisplay');
const levelDisplay = document.getElementById('levelDisplay');
const warningToast = document.getElementById('warningToast');

// ── ICE ──
const iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// ── Init ──
(function init() {
  if (!username || !currentLevel) { window.location.href = 'a.html'; return; }
  levelDisplay.textContent = currentLevel;
  currentTopic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
  topicDisplay.textContent = currentTopic;

  // Setup mode badge
  const modeBadge = document.getElementById('modeBadge');
  if (modeBadge) {
    if (isVideoEnabled) {
      modeBadge.innerHTML = '<i class="fas fa-video"></i> Video Mode';
      modeBadge.classList.add('video-mode');
    } else {
      modeBadge.innerHTML = '<i class="fas fa-headphones"></i> Voice Only';
      modeBadge.classList.add('voice-mode');
    }
  }

  // Hide camera button for voice-only users
  const camBtn = document.getElementById('camBtn');
  if (!isVideoEnabled && camBtn) {
    camBtn.style.display = 'none';
  }

  // Show voice-only banner and apply layout classes
  if (!isVideoEnabled) {
    const banner = document.getElementById('voiceBanner');
    if (banner) banner.classList.remove('hidden');

    document.querySelector('.video-panel').classList.add('voice-layout');
    document.querySelector('.local-wrap').classList.add('voice-only');
    document.querySelector('.remote-wrap').classList.add('voice-only');

    const localAvatarImg = document.getElementById('localAvatarImg');
    if (localAvatarImg) {
      localAvatarImg.src = userAvatar;
    }
  }

  // Removed dailyUsed limit blocking to allow unlimited practice sessions
  startSession();
})();

async function startSession() {
  try {
    // Voice-only for Beginner/Intermediate: request audio only
    const constraints = isVideoEnabled
      ? { video: true, audio: true }
      : { video: false, audio: true };

    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    localVideo.srcObject = localStream;

    loaderOverlay.classList.remove('hidden');
    loaderText.textContent = 'Finding a practice partner at your level...';
    if (!isVideoEnabled) document.querySelector('.video-panel').classList.add('waiting');
    nextBtn.style.display = 'flex';
    socket.emit('joinRoom', { level: currentLevel, username, avatar: userAvatar });
  } catch (err) {
    loaderText.textContent = '⚠️ Microphone access denied. Check permissions.';
  }
}

// ── Timer ──
function startTimer() {
  if (sessionInterval) return;
  const dash = getDashboard();
  sessionSeconds = 0;
  sessionInterval = setInterval(() => {
    sessionSeconds++;
    dash.dailyUsed++;
    saveDashboard(dash);
    const totalUsed = dash.dailyUsed;
    const mm = String(Math.floor(sessionSeconds / 60)).padStart(2, '0');
    const ss = String(sessionSeconds % 60).padStart(2, '0');
    sessionTimerEl.textContent = `${mm}:${ss}`;

    timerPill.classList.remove('warning', 'critical');
    if (totalUsed >= WARNING_AT && totalUsed < DAILY_LIMIT_SECONDS) {
      timerPill.classList.add('warning');
      if (totalUsed === WARNING_AT) {
        showToast('⏰ You have 2 minutes remaining in today\'s free practice.', 'warn');
      }
    }

    // Let session continue past limit without forcing cutoff
    /*
    if (totalUsed >= DAILY_LIMIT_SECONDS) {
      clearInterval(sessionInterval); sessionInterval = null;
      endSessionDueToLimit();
    }
    */
  }, 1000);
}

function stopTimer() {
  if (sessionInterval) { clearInterval(sessionInterval); sessionInterval = null; }
  const dash = getDashboard();
  
  // Log call history before editing statistics
  const partnerNameText = partnerNameEl ? partnerNameEl.textContent : 'Partner';
  if (partnerNameText && partnerNameText !== 'Partner' && sessionSeconds > 0) {
    const historyItem = {
      partnerName: partnerNameText,
      duration: sessionSeconds,
      date: new Date().toLocaleDateString(),
      level: currentLevel,
      followed: false
    };
    if (!dash.callHistory) dash.callHistory = [];
    const exists = dash.callHistory.some(h => h.partnerName === partnerNameText && h.duration === sessionSeconds);
    if (!exists) {
      dash.callHistory.unshift(historyItem);
      if (dash.callHistory.length > 20) dash.callHistory.pop();
    }
  }

  if (sessionSeconds > 0) {
    dash.totalSeconds += sessionSeconds;
    dash.sessions++;
    updateStreak(dash);
    const xpResult = addXP(dash, sessionSeconds);
    saveDashboard(dash);
    return xpResult;
  }
  return { leveledUp: false, xpEarned: 0, newLevel: dash.userLevel };
}

function endSessionDueToLimit() {
  const xpResult = stopTimer();
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (remoteVideo.srcObject) { remoteVideo.srcObject.getTracks().forEach(t => t.stop()); remoteVideo.srcObject = null; }
  socket.emit('nextPartner', { level: currentLevel, username, avatar: userAvatar });
  showExpiredModal();
}

// ── Toast ──
function showToast(msg, type) {
  warningToast.textContent = msg;
  warningToast.className = 'toast show ' + type;
  setTimeout(() => { warningToast.className = 'toast'; }, 5000);
}

// ── Modals ──
function showExpiredModal() { document.getElementById('expiredModal').classList.remove('hidden'); }
function showReport() { document.getElementById('reportModal').classList.remove('hidden'); }
function hideReport() { document.getElementById('reportModal').classList.add('hidden'); }
function submitReport() {
  hideReport();
  showToast('Report submitted. Thank you.', 'warn');
}
function showFeedback() {
  const dash = getDashboard();
  const xpInfo = getXPForNextLevel(dash);
  const mm = String(Math.floor(sessionSeconds / 60)).padStart(2, '0');
  const ss = String(sessionSeconds % 60).padStart(2, '0');
  document.getElementById('fbTime').textContent = `${mm}:${ss}`;
  document.getElementById('fbTotal').textContent = dash.sessions;
  document.getElementById('fbStreak').textContent = dash.streak;
  
  // Update XP bar if exists
  const xpBar = document.getElementById('fbXPBar');
  const xpText = document.getElementById('fbXPText');
  const lvlText = document.getElementById('fbLevel');
  if (xpBar) xpBar.style.width = `${xpInfo.current}%`;
  if (xpText) xpText.textContent = `${xpInfo.current}/100 XP`;
  if (lvlText) lvlText.textContent = `Level ${xpInfo.level}`;

  // Reset Follow Partner Button state
  const partnerNameText = partnerNameEl ? partnerNameEl.textContent : 'Partner';
  const followText = document.getElementById('followText');
  const followIcon = document.getElementById('followIcon');
  const followBtn = document.getElementById('fbFollowBtn');
  if (followText) followText.textContent = `Follow ${partnerNameText}`;
  if (followIcon) followIcon.className = 'fas fa-user-plus';
  if (followBtn) {
    followBtn.style.background = 'var(--bg)';
    followBtn.style.color = 'var(--text)';
    followBtn.style.borderColor = 'var(--border)';
    followBtn.disabled = false;
  }

  document.getElementById('feedbackModal').classList.remove('hidden');
}

function followPartner() {
  const partnerNameText = partnerNameEl ? partnerNameEl.textContent : 'Partner';
  if (!partnerNameText || partnerNameText === 'Partner') return;
  const dash = getDashboard();
  
  // Find last entry for this partner and mark followed
  if (dash.callHistory) {
    const record = dash.callHistory.find(h => h.partnerName === partnerNameText);
    if (record) {
      if (record.followed) return;
      record.followed = true;
    }
  }
  
  dash.following++;
  saveDashboard(dash);

  const followText = document.getElementById('followText');
  const followIcon = document.getElementById('followIcon');
  const followBtn = document.getElementById('fbFollowBtn');
  
  if (followText) followText.textContent = `Following ${partnerNameText} ✓`;
  if (followIcon) followIcon.className = 'fas fa-user-check';
  if (followBtn) {
    followBtn.style.background = 'rgba(32, 201, 151, 0.1)';
    followBtn.style.color = 'var(--accent)';
    followBtn.style.borderColor = 'rgba(32, 201, 151, 0.2)';
    followBtn.disabled = true;
  }
}
function closeFeedback() {
  document.getElementById('feedbackModal').classList.add('hidden');
  currentTopic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
  topicDisplay.textContent = currentTopic;
  nextPartner();
}

// ── Controls ──
function toggleMute() {
  if (!localStream) return;
  micMuted = !micMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !micMuted);
  document.getElementById('muteBtn').classList.toggle('active', micMuted);
  document.getElementById('muteIcon').className = micMuted ? 'fas fa-microphone-slash' : 'fas fa-microphone';
}

function toggleCamera() {
  if (!isVideoEnabled || !localStream) return;
  camOff = !camOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !camOff);
  document.getElementById('camBtn').classList.toggle('active', camOff);
  document.getElementById('camIcon').className = camOff ? 'fas fa-video-slash' : 'fas fa-video';
}

function endCall() {
  stopTimer();
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (remoteVideo.srcObject) { remoteVideo.srcObject.getTracks().forEach(t => t.stop()); remoteVideo.srcObject = null; }
  showFeedback();
}

function nextPartner() {
  stopTimer();
  loaderOverlay.classList.remove('hidden');
  loaderText.textContent = 'Finding a new practice partner...';
  messagesEl.innerHTML = ''; msgCount = 0; msgCountEl.textContent = '0';
  sysMsg('— New session —');
  sessionSeconds = 0; sessionTimerEl.textContent = '00:00';
  timerPill.classList.remove('warning', 'critical');

  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  remoteVideo.srcObject = null;

  currentTopic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
  topicDisplay.textContent = currentTopic;

  if (!isVideoEnabled) document.querySelector('.video-panel').classList.add('waiting');

  socket.emit('nextPartner', { level: currentLevel, username, avatar: userAvatar });

  const constraints = isVideoEnabled
    ? { video: true, audio: true }
    : { video: false, audio: true };

  navigator.mediaDevices.getUserMedia(constraints).then(stream => {
    localStream = stream;
    localVideo.srcObject = stream;
    stream.getAudioTracks().forEach(t => t.enabled = !micMuted);
    if (isVideoEnabled) stream.getVideoTracks().forEach(t => t.enabled = !camOff);
  }).catch(() => {});
}

function sysMsg(text) {
  const d = document.createElement('div');
  d.className = 'msg system'; d.textContent = text;
  messagesEl.appendChild(d); messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ── Socket Events ──
socket.on('joinedRoom', async ({ roomId, isInitiator, waiting, partnerName, partnerAvatar }) => {
  currentRoom = roomId;
  if (partnerName) {
    partnerNameEl.textContent = partnerName;
    const partnerAvatarName = document.getElementById('partnerAvatarName');
    if (partnerAvatarName) partnerAvatarName.textContent = partnerName;
    
    const partnerAvatarImg = document.getElementById('partnerAvatarImg');
    if (partnerAvatarImg) {
      partnerAvatarImg.src = partnerAvatar || `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(partnerName)}&backgroundColor=b6e3f4,c0aede,d1d4f9,ffdfbf,ffd5dc`;
    }
  }

  if (waiting || (isInitiator && !roomId)) {
    loaderOverlay.classList.remove('hidden');
    loaderText.textContent = 'Waiting for a partner at your level...';
    if (!isVideoEnabled) document.querySelector('.video-panel').classList.add('waiting');
  } else {
    loaderText.textContent = 'Connecting...';
    if (!isVideoEnabled) document.querySelector('.video-panel').classList.remove('waiting');
  }

  if (isInitiator && !waiting && roomId) {
    try {
      await createPC();
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit('offer', { offer, roomId });
    } catch (e) { loaderText.textContent = 'Connection error.'; }
  }
});

socket.on('offer', async ({ offer, roomId }) => {
  if (roomId !== currentRoom) return;
  try {
    const pc = await createPC();
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { answer, roomId });
  } catch (e) {}
});

socket.on('answer', async ({ answer, roomId }) => {
  if (roomId !== currentRoom || !peerConnection) return;
  try { await peerConnection.setRemoteDescription(new RTCSessionDescription(answer)); } catch (e) {}
});

socket.on('iceCandidate', async ({ candidate, roomId }) => {
  if (roomId !== currentRoom || !peerConnection) return;
  try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
});

socket.on('userDisconnected', () => {
  stopTimer();
  sysMsg('— Partner left the session —');
  if (remoteVideo.srcObject) { remoteVideo.srcObject.getTracks().forEach(t => t.stop()); remoteVideo.srcObject = null; }
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  loaderOverlay.classList.remove('hidden');
  loaderText.textContent = 'Partner left. Click Next Partner to continue.';
  if (!isVideoEnabled) document.querySelector('.video-panel').classList.add('waiting');
});


socket.on('queueTimeout', ({ message }) => {
  sysMsg('⏱ ' + message);
  loaderText.textContent = message;
});

// ── Peer Connection ──
async function createPC() {
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  peerConnection = new RTCPeerConnection(iceServers);

  if (!localStream) {
    const constraints = isVideoEnabled
      ? { video: true, audio: true }
      : { video: false, audio: true };
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    localVideo.srcObject = localStream;
  }
  localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));

  peerConnection.ontrack = e => {
    if (e.streams?.[0]) {
      remoteVideo.srcObject = e.streams[0];
      loaderOverlay.classList.add('hidden');
      sysMsg('— Connected! Topic: ' + currentTopic + ' —');
      startTimer();
    }
  };

  peerConnection.onicecandidate = e => {
    if (e.candidate) socket.emit('iceCandidate', { candidate: e.candidate, roomId: currentRoom });
  };

  peerConnection.oniceconnectionstatechange = () => {
    const state = peerConnection?.iceConnectionState;
    if (state === 'connected') loaderOverlay.classList.add('hidden');
    if (state === 'disconnected' || state === 'failed') {
      loaderOverlay.classList.remove('hidden');
      loaderText.textContent = 'Connection lost...';
    }
  };
  return peerConnection;
}

// ── Chat ──
function sendMessage() {
  const msg = messageInput.value.trim();
  if (!msg || !currentRoom) return;
  socket.emit('message', { roomId: currentRoom, message: msg, username });
  addMessage(msg, true);
  messageInput.value = ''; messageInput.style.height = 'auto';
}

socket.on('message', ({ message, username: from }) => addMessage(message, false, from));

function addMessage(msg, isSent, from = '') {
  msgCount++; msgCountEl.textContent = msgCount;
  const d = document.createElement('div');
  d.className = `msg ${isSent ? 'sent' : 'received'}`;
  const s = document.createElement('div');
  s.className = 'sender'; s.textContent = isSent ? 'You' : from;
  const t = document.createElement('div'); t.textContent = msg;
  d.appendChild(s); d.appendChild(t);
  messagesEl.appendChild(d); messagesEl.scrollTop = messagesEl.scrollHeight;
}

messageInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 100) + 'px';
});

window.onbeforeunload = () => {
  localStream?.getTracks().forEach(t => t.stop());
  peerConnection?.close();
};
