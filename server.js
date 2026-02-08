const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { QUESTIONS, ROOM_NAMES, TOPIC_ICONS } = require('./questions');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 30000,
  pingInterval: 10000,
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Game Config ────────────────────────────────────────────────
const ROUNDS = 7;
const TIME_PER_QUESTION = 10; // seconds
const OPTION_REVEAL_DELAY = 1200; // ms
const BASE_POINTS = 100;
const MAX_SPEED_BONUS = 100;
const FINAL_MULTIPLIER = 2;
const BETWEEN_ROUND_DELAY = 2200; // ms
const POST_REVEAL_DELAY = 1800; // ms

// ─── Room Storage ───────────────────────────────────────────────
const rooms = new Map();

// ─── API: Get topics list ───────────────────────────────────────
app.get('/api/topics', (req, res) => {
  const topics = Object.keys(QUESTIONS).map(t => ({
    name: t,
    icon: TOPIC_ICONS[t] || '🎯',
    questionCount: QUESTIONS[t].length,
  }));
  res.json(topics);
});

// ─── API: Create room ───────────────────────────────────────────
app.get('/api/create-room/:topic', (req, res) => {
  const topic = decodeURIComponent(req.params.topic);
  if (!QUESTIONS[topic]) return res.status(400).json({ error: 'Invalid topic' });

  const roomId = generateRoomId();
  const roomNames = ROOM_NAMES[topic] || ['Arena'];
  const roomName = roomNames[Math.floor(Math.random() * roomNames.length)];
  const questions = selectQuestions(QUESTIONS[topic]);

  rooms.set(roomId, {
    id: roomId,
    name: roomName,
    topic,
    questions,
    players: [],
    state: 'waiting', // waiting | countdown | playing | between | gameover
    currentRound: 0,
    answers: {},
    scores: [0, 0],
    roundHistory: [],
    timerStart: null,
    timers: {},
    createdAt: Date.now(),
  });

  res.json({ roomId, roomName, topic, icon: TOPIC_ICONS[topic] || '🎯' });
});

// ─── API: Room info (for join page) ─────────────────────────────
app.get('/api/room/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    roomId: room.id,
    roomName: room.name,
    topic: room.topic,
    icon: TOPIC_ICONS[room.topic] || '🎯',
    playerCount: room.players.length,
    state: room.state,
  });
});

// ─── Catch-all for SPA ──────────────────────────────────────────
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
    if (room.players.length >= 2) return socket.emit('error', { message: 'Room is full' });
    if (room.state !== 'waiting') return socket.emit('error', { message: 'Game already started' });

    playerName = (name || 'Player').substring(0, 20);
    playerIndex = room.players.length;
    currentRoom = roomId;
    room.players.push({ id: socket.id, name: playerName, index: playerIndex });

    socket.join(roomId);
    io.to(roomId).emit('room-update', {
      players: room.players.map(p => ({ name: p.name, index: p.index })),
      roomName: room.name,
      topic: room.topic,
      icon: TOPIC_ICONS[room.topic] || '🎯',
    });

    // If 2 players, both can start
    if (room.players.length === 2) {
      io.to(roomId).emit('room-ready');
    }
  });

  socket.on('start-game', () => {
    const room = rooms.get(currentRoom);
    if (!room || room.players.length < 2 || room.state !== 'waiting') return;
    room.state = 'countdown';
    io.to(currentRoom).emit('game-countdown');

    // 3-2-1 countdown then start
    setTimeout(() => {
      room.state = 'playing';
      room.currentRound = 0;
      room.answers = {};
      startRound(room);
    }, 3500);
  });

  socket.on('submit-answer', ({ answerIndex, timestamp }) => {
    const room = rooms.get(currentRoom);
    if (!room || room.state !== 'playing') return;
    if (room.answers[playerIndex] !== undefined) return; // already answered

    const elapsed = (Date.now() - room.timerStart) / 1000;
    // Server-side time validation — clamp to reasonable range
    const timeTaken = Math.max(0, Math.min(TIME_PER_QUESTION, elapsed));

    room.answers[playerIndex] = {
      answerIndex: answerIndex,
      timeTaken: timeTaken,
    };

    // Notify opponent that this player answered (without revealing answer)
    socket.to(currentRoom).emit('opponent-answered');

    // Check if both answered
    if (Object.keys(room.answers).length === 2) {
      clearTimeout(room.timers.questionTimeout);
      resolveRound(room);
    }
  });

  socket.on('request-rematch', () => {
    const room = rooms.get(currentRoom);
    if (!room) return;

    // Reset room for rematch with new questions
    const newQuestions = selectQuestions(QUESTIONS[room.topic]);
    room.questions = newQuestions;
    room.state = 'waiting';
    room.currentRound = 0;
    room.answers = {};
    room.scores = [0, 0];
    room.roundHistory = [];
    clearAllTimers(room);

    io.to(currentRoom).emit('rematch-ready', {
      players: room.players.map(p => ({ name: p.name, index: p.index })),
      roomName: room.name,
      topic: room.topic,
    });
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        clearAllTimers(room);
        room.players = room.players.filter(p => p.id !== socket.id);
        io.to(currentRoom).emit('player-disconnected', { name: playerName });

        // Clean up empty rooms
        if (room.players.length === 0) {
          rooms.delete(currentRoom);
        }
      }
    }
  });
});

// ─── Game Logic ─────────────────────────────────────────────────
function startRound(room) {
  const q = room.questions[room.currentRound];
  room.answers = {};
  const isFinal = room.currentRound === ROUNDS - 1;

  // Send question without options first
  io.to(room.id).emit('round-start', {
    round: room.currentRound + 1,
    totalRounds: ROUNDS,
    question: q.q,
    difficulty: q.difficulty,
    isFinal,
  });

  // After delay, reveal options and start timer
  room.timers.optionReveal = setTimeout(() => {
    room.timerStart = Date.now();
    io.to(room.id).emit('options-reveal', {
      options: q.options,
    });

    // Auto-resolve when time runs out
    room.timers.questionTimeout = setTimeout(() => {
      // Fill in missing answers as timeouts
      for (let i = 0; i < 2; i++) {
        if (room.answers[i] === undefined) {
          room.answers[i] = { answerIndex: -1, timeTaken: TIME_PER_QUESTION };
        }
      }
      resolveRound(room);
    }, (TIME_PER_QUESTION + 0.5) * 1000); // small buffer
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
    question: q.q,
    options: q.options,
    correctAnswer: q.answer,
    fact: q.fact,
    difficulty: q.difficulty,
    results,
    isFinal,
  });

  io.to(room.id).emit('round-result', {
    correctAnswer: q.answer,
    results: results.map(r => ({ correct: r.correct, points: r.points, answerIndex: r.answerIndex })),
    scores: room.scores,
    fact: q.fact,
  });

  // Next round or game over
  setTimeout(() => {
    if (room.currentRound < ROUNDS - 1) {
      room.currentRound++;
      room.state = 'playing';
      startRound(room);
    } else {
      room.state = 'gameover';
      const winner = room.scores[0] > room.scores[1] ? 0 : room.scores[1] > room.scores[0] ? 1 : -1;
      io.to(room.id).emit('game-over', {
        scores: room.scores,
        winner,
        roundHistory: room.roundHistory,
        players: room.players.map(p => ({ name: p.name, index: p.index })),
      });
    }
  }, POST_REVEAL_DELAY);
}

// ─── Helpers ────────────────────────────────────────────────────
function generateRoomId() {
  // Short readable IDs
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
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
  if (room.timers) {
    Object.values(room.timers).forEach(t => clearTimeout(t));
    room.timers = {};
  }
}

// ─── Cleanup stale rooms every 30 min ───────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.createdAt > 60 * 60 * 1000) { // 1 hour
      clearAllTimers(room);
      rooms.delete(id);
    }
  }
}, 30 * 60 * 1000);

// ─── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`⚡ R7 server running on port ${PORT}`);
  console.log(`🎮 ${Object.keys(QUESTIONS).length} topics loaded`);
  console.log(`📝 ${Object.values(QUESTIONS).reduce((a, b) => a + b.length, 0)} questions ready`);
});
