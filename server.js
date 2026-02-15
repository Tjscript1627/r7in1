const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { QUESTIONS, ROOM_NAMES, TOPIC_ICONS } = require('./questions');
const analytics = require('./analytics');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 30000,
  pingInterval: 10000,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Game Config ────────────────────────────────────────────────
const ROUNDS = 7;
const TIME_PER_QUESTION = 10;
const OPTION_REVEAL_DELAY = 1200;
const BASE_POINTS = 100;
const MAX_SPEED_BONUS = 100;
const FINAL_MULTIPLIER = 2;
const POST_REVEAL_DELAY = 1800;
const ROOM_TIMEOUT = 27000; // 27s before offering bot fallback

// Bot difficulty configs
const BOT_PROFILES = {
  rookie: { name: 'The Rookie', accuracy: 0.40, minTime: 2500, maxTime: 8000, emoji: '🐣' },
  contender: { name: 'The Contender', accuracy: 0.65, minTime: 1500, maxTime: 6500, emoji: '🥊' },
  beast: { name: 'The Beast', accuracy: 0.88, minTime: 800, maxTime: 3500, emoji: '🔥' },
};

// ─── Room Storage ───────────────────────────────────────────────
const rooms = new Map();

// ─── API: Topics ────────────────────────────────────────────────
app.get('/api/topics', (req, res) => {
  const topics = Object.keys(QUESTIONS).map(t => ({
    name: t,
    icon: TOPIC_ICONS[t] || '🎯',
    questionCount: QUESTIONS[t].length,
  }));
  res.json(topics);
});

// ─── API: Create room (multiplayer) ─────────────────────────────
app.get('/api/create-room/:topic', (req, res) => {
  const topic = decodeURIComponent(req.params.topic);
  if (!QUESTIONS[topic]) return res.status(400).json({ error: 'Invalid topic' });

  const roomId = generateRoomId();
  const roomName = pickRoomName(topic);
  const questions = selectQuestions(QUESTIONS[topic]);

  rooms.set(roomId, {
    id: roomId, name: roomName, topic, questions,
    players: [], state: 'waiting',
    currentRound: 0, answers: {}, scores: [0, 0],
    roundHistory: [], timerStart: null, timers: {},
    isBot: false, botProfile: null, createdAt: Date.now(),
  });

  analytics.logEvent('room_created', { roomId, topic, roomName, mode: 'multiplayer' });
  res.json({ roomId, roomName, topic, icon: TOPIC_ICONS[topic] || '🎯' });
});

// ─── API: Room info ─────────────────────────────────────────────
app.get('/api/room/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    roomId: room.id, roomName: room.name, topic: room.topic,
    icon: TOPIC_ICONS[room.topic] || '🎯',
    playerCount: room.players.length, state: room.state,
  });
});

// ─── API: Survey ────────────────────────────────────────────────
app.post('/api/survey', (req, res) => {
  const { topics, freeText, playerName } = req.body;
  analytics.logSurvey({ topics, freeText, playerName });
  res.json({ ok: true });
});

// ─── API: Admin Dashboard ───────────────────────────────────────
app.get('/api/admin/stats', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  res.json(analytics.getStats(days));
});

app.get('/api/admin/surveys', (req, res) => {
  res.json(analytics.getSurveyStats());
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─── SPA Catch-all ──────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Socket.IO ──────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;
  let playerIndex = -1;
  let playerName = 'Player';

  socket.on('join-room', ({ roomId, name }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error', { message: 'Room not found or expired' });
    if (room.players.length >= 2) return socket.emit('error', { message: 'Room is full', topic: room.topic, icon: TOPIC_ICONS[room.topic] || '🎯' });
    if (room.state !== 'waiting') return socket.emit('error', { message: 'Game already started', topic: room.topic, icon: TOPIC_ICONS[room.topic] || '🎯' });

    playerName = (name || 'Player').substring(0, 20);
    playerIndex = room.players.length;
    currentRoom = roomId;
    room.players.push({ id: socket.id, name: playerName, index: playerIndex });
    socket.join(roomId);

    analytics.logEvent('room_joined', { roomId, playerName, playerIndex, topic: room.topic });

    io.to(roomId).emit('room-update', {
      players: room.players.map(p => ({ name: p.name, index: p.index })),
      roomName: room.name, topic: room.topic, icon: TOPIC_ICONS[room.topic] || '🎯',
    });

    if (room.players.length === 2) {
      clearTimeout(room.timers.waitTimeout);
      io.to(roomId).emit('room-ready');
    } else {
      // Start timeout for bot fallback
      room.timers.waitTimeout = setTimeout(() => {
        if (room.players.length < 2 && room.state === 'waiting') {
          io.to(roomId).emit('waiting-timeout');
          analytics.logEvent('room_timeout_to_bot', { roomId, topic: room.topic, playerName });
        }
      }, ROOM_TIMEOUT);
    }
  });

  socket.on('start-bot-game', ({ topic, difficulty, name, roomId: existingRoomId }) => {
    playerName = (name || 'Player').substring(0, 20);
    const botProfile = BOT_PROFILES[difficulty] || BOT_PROFILES.contender;
    let room;

    if (existingRoomId && rooms.has(existingRoomId)) {
      room = rooms.get(existingRoomId);
    } else {
      const topicName = topic ? decodeURIComponent(topic) : null;
      if (!topicName || !QUESTIONS[topicName]) return socket.emit('error', { message: 'Invalid topic' });
      const roomId = generateRoomId();
      room = {
        id: roomId, name: pickRoomName(topicName), topic: topicName,
        questions: selectQuestions(QUESTIONS[topicName]),
        players: [{ id: socket.id, name: playerName, index: 0 }],
        state: 'waiting', currentRound: 0, answers: {}, scores: [0, 0],
        roundHistory: [], timerStart: null, timers: {},
        isBot: true, botProfile, createdAt: Date.now(),
      };
      rooms.set(roomId, room);
      socket.join(roomId);
      currentRoom = roomId;
      playerIndex = 0;

      analytics.logEvent('room_created', { roomId, topic: topicName, mode: 'bot', difficulty });
    }

    room.isBot = true;
    room.botProfile = botProfile;
    if (room.players.length < 2) {
      room.players.push({ id: 'bot', name: botProfile.name, index: 1, isBot: true });
    }

    analytics.logEvent('game_started_bot', {
      roomId: room.id, topic: room.topic, playerName, difficulty, botName: botProfile.name,
    });

    io.to(room.id).emit('room-update', {
      players: room.players.map(p => ({ name: p.name, index: p.index })),
      roomName: room.name, topic: room.topic, icon: TOPIC_ICONS[room.topic] || '🎯',
    });

    room.state = 'countdown';
    io.to(room.id).emit('game-countdown');
    setTimeout(() => {
      room.state = 'playing';
      room.currentRound = 0;
      room.answers = {};
      startRound(room);
    }, 3500);
  });

  socket.on('start-game', () => {
    const room = rooms.get(currentRoom);
    if (!room || room.players.length < 2 || room.state !== 'waiting') return;

    room.state = 'countdown';
    analytics.logEvent('game_started', { roomId: room.id, topic: room.topic, players: room.players.map(p => p.name) });
    io.to(currentRoom).emit('game-countdown');

    setTimeout(() => {
      room.state = 'playing';
      room.currentRound = 0;
      room.answers = {};
      startRound(room);
    }, 3500);
  });

  socket.on('submit-answer', ({ answerIndex }) => {
    const room = rooms.get(currentRoom);
    if (!room || room.state !== 'playing') return;
    if (room.answers[playerIndex] !== undefined) return;

    const elapsed = (Date.now() - room.timerStart) / 1000;
    const timeTaken = Math.max(0, Math.min(TIME_PER_QUESTION, elapsed));
    const q = room.questions[room.currentRound];
    const correct = answerIndex === q.answer;

    room.answers[playerIndex] = { answerIndex, timeTaken };

    analytics.logEvent('answer_submitted', {
      roomId: room.id, topic: room.topic, playerName,
      question: q.q, answerIndex, correct,
      timeTaken: Math.round(timeTaken * 10) / 10,
      difficulty: q.difficulty, round: room.currentRound + 1,
    });

    socket.to(currentRoom).emit('opponent-answered');

    if (Object.keys(room.answers).length === 2) {
      clearTimeout(room.timers.questionTimeout);
      resolveRound(room);
    }
  });

  socket.on('request-rematch', ({ topic } = {}) => {
    const room = rooms.get(currentRoom);
    if (!room) return;

    const newTopic = topic && QUESTIONS[topic] ? topic : room.topic;
    room.topic = newTopic;
    room.name = pickRoomName(newTopic);
    room.questions = selectQuestions(QUESTIONS[newTopic]);
    room.state = 'waiting';
    room.currentRound = 0;
    room.answers = {};
    room.scores = [0, 0];
    room.roundHistory = [];
    clearAllTimers(room);

    analytics.logEvent('rematch_requested', { roomId: room.id, topic: newTopic, playerName });

    io.to(currentRoom).emit('rematch-ready', {
      players: room.players.map(p => ({ name: p.name, index: p.index })),
      roomName: room.name, topic: newTopic, icon: TOPIC_ICONS[newTopic] || '🎯',
    });
  });

  socket.on('invite-shared', () => {
    analytics.logEvent('invite_shared', { roomId: currentRoom, playerName });
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        analytics.logEvent('player_disconnected', { roomId: currentRoom, playerName });
        clearAllTimers(room);
        room.players = room.players.filter(p => p.id !== socket.id);
        if (!room.isBot) io.to(currentRoom).emit('player-disconnected', { name: playerName });
        if (room.players.filter(p => !p.isBot).length === 0) rooms.delete(currentRoom);
      }
    }
  });
});

// ─── Game Logic ─────────────────────────────────────────────────
function startRound(room) {
  const q = room.questions[room.currentRound];
  room.answers = {};
  const isFinal = room.currentRound === ROUNDS - 1;

  io.to(room.id).emit('round-start', {
    round: room.currentRound + 1, totalRounds: ROUNDS,
    question: q.q, difficulty: q.difficulty, isFinal,
  });

  room.timers.optionReveal = setTimeout(() => {
    room.timerStart = Date.now();
    io.to(room.id).emit('options-reveal', { options: q.options });

    if (room.isBot && room.botProfile) {
      const bp = room.botProfile;
      const delay = bp.minTime + Math.random() * (bp.maxTime - bp.minTime);
      room.timers.botAnswer = setTimeout(() => {
        if (room.answers[1] !== undefined) return;
        const correct = Math.random() < bp.accuracy;
        const ansIdx = correct ? q.answer : [0,1,2,3].filter(i => i !== q.answer)[Math.floor(Math.random() * 3)];
        room.answers[1] = { answerIndex: ansIdx, timeTaken: delay / 1000 };
        io.to(room.id).emit('opponent-answered');
        if (Object.keys(room.answers).length === 2) {
          clearTimeout(room.timers.questionTimeout);
          resolveRound(room);
        }
      }, delay);
    }

    room.timers.questionTimeout = setTimeout(() => {
      for (let i = 0; i < 2; i++) {
        if (room.answers[i] === undefined) room.answers[i] = { answerIndex: -1, timeTaken: TIME_PER_QUESTION };
      }
      resolveRound(room);
    }, (TIME_PER_QUESTION + 0.5) * 1000);
  }, OPTION_REVEAL_DELAY);
}

function resolveRound(room) {
  const q = room.questions[room.currentRound];
  const isFinal = room.currentRound === ROUNDS - 1;
  const mult = isFinal ? FINAL_MULTIPLIER : 1;

  const results = [0, 1].map(i => {
    const ans = room.answers[i] || { answerIndex: -1, timeTaken: TIME_PER_QUESTION };
    const correct = ans.answerIndex === q.answer;
    const speedBonus = Math.round(MAX_SPEED_BONUS * Math.max(0, (TIME_PER_QUESTION - ans.timeTaken) / TIME_PER_QUESTION));
    const points = correct ? (BASE_POINTS + speedBonus) * mult : 0;
    room.scores[i] += points;
    return { correct, points, answerIndex: ans.answerIndex, timeTaken: ans.timeTaken };
  });

  room.roundHistory.push({
    question: q.q, options: q.options, correctAnswer: q.answer,
    fact: q.fact, difficulty: q.difficulty, results, isFinal,
  });

  io.to(room.id).emit('round-result', {
    correctAnswer: q.answer,
    results: results.map(r => ({ correct: r.correct, points: r.points, answerIndex: r.answerIndex })),
    scores: room.scores, fact: q.fact,
  });

  setTimeout(() => {
    if (room.currentRound < ROUNDS - 1) {
      room.currentRound++;
      room.state = 'playing';
      startRound(room);
    } else {
      room.state = 'gameover';
      const winner = room.scores[0] > room.scores[1] ? 0 : room.scores[1] > room.scores[0] ? 1 : -1;
      analytics.logEvent(room.isBot ? 'game_completed_bot' : 'game_completed', {
        roomId: room.id, topic: room.topic, scores: room.scores,
        winner, players: room.players.map(p => p.name),
        botDifficulty: room.botProfile?.name || null,
      });
      io.to(room.id).emit('game-over', {
        scores: room.scores, winner, roundHistory: room.roundHistory,
        players: room.players.map(p => ({ name: p.name, index: p.index })),
        isBot: room.isBot,
      });
    }
  }, POST_REVEAL_DELAY);
}

// ─── Helpers ────────────────────────────────────────────────────
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}
function pickRoomName(topic) {
  const names = ROOM_NAMES[topic] || ['Arena Alpha', 'Battle Room'];
  return names[Math.floor(Math.random() * names.length)];
}
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function selectQuestions(topicQs) {
  const easy = shuffleArray(topicQs.filter(q => q.difficulty === 1));
  const med = shuffleArray(topicQs.filter(q => q.difficulty === 2));
  const hard = shuffleArray(topicQs.filter(q => q.difficulty === 3));
  const fan = shuffleArray(topicQs.filter(q => q.difficulty === 4));
  const sel = [];
  const pick = (a, n) => { for (let i = 0; i < n && a.length; i++) sel.push(a.pop()); };
  pick(easy, 2); pick(med, 3); pick(hard, 1); pick(fan, 1);
  const rem = shuffleArray(topicQs.filter(q => !sel.includes(q)));
  while (sel.length < ROUNDS && rem.length) sel.push(rem.pop());
  sel.sort((a, b) => a.difficulty - b.difficulty);
  return sel.slice(0, ROUNDS);
}
function clearAllTimers(room) {
  if (room.timers) { Object.values(room.timers).forEach(t => clearTimeout(t)); room.timers = {}; }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.createdAt > 60 * 60 * 1000) { clearAllTimers(room); rooms.delete(id); }
  }
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`⚡ R7 server running on port ${PORT}`);
  console.log(`🎮 ${Object.keys(QUESTIONS).length} topics loaded`);
  console.log(`📝 ${Object.values(QUESTIONS).reduce((a, b) => a + b.length, 0)} questions ready`);
});
