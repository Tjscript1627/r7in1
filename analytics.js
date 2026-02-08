// R7 Analytics Module — Lightweight event logging
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const SURVEY_FILE = path.join(DATA_DIR, 'surveys.jsonl');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Event Types ────────────────────────────────────────────────
// room_created, room_joined, game_started, game_started_bot,
// answer_submitted, game_completed, game_completed_bot,
// rematch_requested, invite_shared, invite_link_opened,
// player_disconnected, room_timeout_to_bot, survey_submitted,
// topic_selected

function logEvent(type, data = {}) {
  const event = {
    type,
    timestamp: new Date().toISOString(),
    ts: Date.now(),
    ...data,
  };
  try {
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n');
  } catch (e) {
    console.error('Analytics write error:', e.message);
  }
}

function logSurvey(data) {
  const entry = {
    timestamp: new Date().toISOString(),
    ts: Date.now(),
    ...data,
  };
  try {
    fs.appendFileSync(SURVEY_FILE, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('Survey write error:', e.message);
  }
}

// ─── Read & Aggregate ───────────────────────────────────────────
function readEvents(sinceTs = 0) {
  try {
    if (!fs.existsSync(EVENTS_FILE)) return [];
    const lines = fs.readFileSync(EVENTS_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(e => e && e.ts >= sinceTs);
  } catch { return []; }
}

function readSurveys() {
  try {
    if (!fs.existsSync(SURVEY_FILE)) return [];
    const lines = fs.readFileSync(SURVEY_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function getStats(days = 7) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const events = readEvents(since);

  // Basic counts
  const counts = {};
  events.forEach(e => { counts[e.type] = (counts[e.type] || 0) + 1; });

  // Unique players (by name — not perfect but works for now)
  const players = new Set();
  events.forEach(e => { if (e.playerName) players.add(e.playerName); });

  // Games per day
  const gamesByDay = {};
  events.filter(e => e.type === 'game_completed' || e.type === 'game_completed_bot').forEach(e => {
    const day = e.timestamp.split('T')[0];
    gamesByDay[day] = (gamesByDay[day] || 0) + 1;
  });

  // Topic popularity
  const topicPicks = {};
  events.filter(e => e.type === 'topic_selected').forEach(e => {
    topicPicks[e.topic] = (topicPicks[e.topic] || 0) + 1;
  });

  // Question accuracy
  const questionStats = {};
  events.filter(e => e.type === 'answer_submitted').forEach(e => {
    const key = `${e.topic}::${e.question}`;
    if (!questionStats[key]) questionStats[key] = { correct: 0, total: 0, totalTime: 0, topic: e.topic, question: e.question };
    questionStats[key].total++;
    if (e.correct) questionStats[key].correct++;
    questionStats[key].totalTime += (e.timeTaken || 0);
  });

  // Conversion: rooms created vs games started
  const roomsCreated = (counts.room_created || 0);
  const gamesStarted = (counts.game_started || 0) + (counts.game_started_bot || 0);

  // Completion rate
  const gamesCompleted = (counts.game_completed || 0) + (counts.game_completed_bot || 0);

  // Bot vs multiplayer
  const botGames = counts.game_completed_bot || 0;
  const multiGames = counts.game_completed || 0;

  // Rematch rate
  const rematches = counts.rematch_requested || 0;

  // Room timeout to bot
  const timeouts = counts.room_timeout_to_bot || 0;

  // Question difficulty analysis
  const easyQs = []; const hardQs = [];
  Object.values(questionStats).forEach(qs => {
    if (qs.total >= 3) { // only count if seen 3+ times
      const accuracy = qs.correct / qs.total;
      const avgTime = qs.totalTime / qs.total;
      const entry = { ...qs, accuracy: Math.round(accuracy * 100), avgTime: Math.round(avgTime * 10) / 10 };
      if (accuracy > 0.9) easyQs.push(entry);
      if (accuracy < 0.3) hardQs.push(entry);
    }
  });

  return {
    period: `Last ${days} days`,
    totalEvents: events.length,
    uniquePlayers: players.size,
    gamesByDay,
    topicPopularity: Object.entries(topicPicks).sort((a, b) => b[1] - a[1]),
    roomsCreated, gamesStarted, gamesCompleted,
    conversionRate: roomsCreated ? Math.round((gamesStarted / roomsCreated) * 100) : 0,
    completionRate: gamesStarted ? Math.round((gamesCompleted / gamesStarted) * 100) : 0,
    botGames, multiGames, timeouts, rematches,
    tooEasyQuestions: easyQs.sort((a, b) => b.accuracy - a.accuracy).slice(0, 20),
    tooHardQuestions: hardQs.sort((a, b) => a.accuracy - b.accuracy).slice(0, 20),
    eventCounts: counts,
  };
}

function getSurveyStats() {
  const surveys = readSurveys();
  const topicVotes = {};
  const freeText = [];

  surveys.forEach(s => {
    if (s.topics) {
      s.topics.forEach((t, i) => {
        // Weight by priority: first pick gets 10 points, second 9, etc.
        const weight = Math.max(1, 11 - i);
        topicVotes[t] = (topicVotes[t] || 0) + weight;
      });
    }
    if (s.freeText && s.freeText.trim()) freeText.push({ text: s.freeText, player: s.playerName, date: s.timestamp });
  });

  return {
    totalResponses: surveys.length,
    topicRanking: Object.entries(topicVotes).sort((a, b) => b[1] - a[1]),
    freeTextSuggestions: freeText,
  };
}

module.exports = { logEvent, logSurvey, getStats, getSurveyStats, readEvents };
