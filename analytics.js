// R7 Analytics Module — Product Intelligence Engine
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

// ─── Read Helpers ───────────────────────────────────────────────
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

// ─── Enhanced Stats Engine ──────────────────────────────────────
function getStats(days = 7) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const events = readEvents(since);

  // Basic counts
  const counts = {};
  events.forEach(e => { counts[e.type] = (counts[e.type] || 0) + 1; });

  // Unique players
  const players = new Set();
  const playerGameCounts = {};
  events.forEach(e => {
    if (e.playerName) {
      players.add(e.playerName);
    }
  });

  // Games per player
  const playerGames = {};
  events.filter(e => e.type === 'game_completed' || e.type === 'game_completed_bot').forEach(e => {
    if (e.playerName) {
      playerGames[e.playerName] = (playerGames[e.playerName] || 0) + 1;
    }
  });

  // Games per player distribution
  const gamesPerPlayerDist = {};
  Object.values(playerGames).forEach(count => {
    gamesPerPlayerDist[count] = (gamesPerPlayerDist[count] || 0) + 1;
  });

  const totalPlayersWithGames = Object.keys(playerGames).length;
  const avgGamesPerPlayer = totalPlayersWithGames > 0
    ? (Object.values(playerGames).reduce((a, b) => a + b, 0) / totalPlayersWithGames).toFixed(1)
    : 0;
  const repeatPlayers = Object.values(playerGames).filter(c => c > 1).length;
  const repeatRate = totalPlayersWithGames > 0
    ? Math.round((repeatPlayers / totalPlayersWithGames) * 100)
    : 0;

  // Games per day
  const gamesByDay = {};
  events.filter(e => e.type === 'game_completed' || e.type === 'game_completed_bot').forEach(e => {
    const day = e.timestamp.split('T')[0];
    gamesByDay[day] = (gamesByDay[day] || 0) + 1;
  });

  // Topic popularity with completion data
  const topicStarts = {};
  const topicCompletions = {};
  const topicDisconnects = {};
  events.filter(e => e.type === 'game_started' || e.type === 'game_started_bot').forEach(e => {
    if (e.topic) topicStarts[e.topic] = (topicStarts[e.topic] || 0) + 1;
  });
  events.filter(e => e.type === 'game_completed' || e.type === 'game_completed_bot').forEach(e => {
    if (e.topic) topicCompletions[e.topic] = (topicCompletions[e.topic] || 0) + 1;
  });
  events.filter(e => e.type === 'player_disconnected').forEach(e => {
    if (e.topic) topicDisconnects[e.topic] = (topicDisconnects[e.topic] || 0) + 1;
  });

  // Build topic stats array
  const allTopics = new Set([...Object.keys(topicStarts), ...Object.keys(topicCompletions)]);
  const topicStats = [];
  allTopics.forEach(topic => {
    const starts = topicStarts[topic] || 0;
    const completions = topicCompletions[topic] || 0;
    const disconnects = topicDisconnects[topic] || 0;
    topicStats.push({
      topic,
      starts,
      completions,
      disconnects,
      completionRate: starts > 0 ? Math.round((completions / starts) * 100) : 0,
    });
  });
  topicStats.sort((a, b) => b.starts - a.starts);

  // Answer speed analysis
  const speedByRound = {};
  const correctByRound = {};
  events.filter(e => e.type === 'answer_submitted').forEach(e => {
    const round = e.round || 'unknown';
    if (!speedByRound[round]) speedByRound[round] = [];
    speedByRound[round].push(e.timeTaken || 0);
    if (!correctByRound[round]) correctByRound[round] = { correct: 0, total: 0 };
    correctByRound[round].total++;
    if (e.correct) correctByRound[round].correct++;
  });

  const roundAnalysis = [];
  for (let i = 1; i <= 7; i++) {
    const speeds = speedByRound[i] || [];
    const accuracy = correctByRound[i] || { correct: 0, total: 0 };
    roundAnalysis.push({
      round: i,
      avgSpeed: speeds.length > 0 ? (speeds.reduce((a, b) => a + b, 0) / speeds.length / 1000).toFixed(1) : 0,
      accuracy: accuracy.total > 0 ? Math.round((accuracy.correct / accuracy.total) * 100) : 0,
      answers: accuracy.total,
    });
  }

  // Disconnect analysis - which round do players quit?
  const disconnectRounds = {};
  events.filter(e => e.type === 'player_disconnected').forEach(e => {
    const round = e.round || 'unknown';
    disconnectRounds[round] = (disconnectRounds[round] || 0) + 1;
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

  // Conversion
  const roomsCreated = (counts.room_created || 0);
  const gamesStarted = (counts.game_started || 0) + (counts.game_started_bot || 0);
  const gamesCompleted = (counts.game_completed || 0) + (counts.game_completed_bot || 0);
  const botGames = (counts.game_started_bot || 0);
  const multiGames = (counts.game_started || 0);
  const rematches = counts.rematch_requested || 0;
  const timeouts = counts.room_timeout_to_bot || 0;
  const inviteShares = counts.invite_shared || 0;
  const inviteOpens = counts.invite_link_opened || 0;

  // Difficulty flags
  const easyQs = []; const hardQs = [];
  Object.values(questionStats).forEach(qs => {
    if (qs.total >= 3) {
      const accuracy = qs.correct / qs.total;
      const avgTime = qs.totalTime / qs.total;
      const entry = { ...qs, accuracy: Math.round(accuracy * 100), avgTime: Math.round(avgTime / 100) / 10 };
      if (accuracy > 0.9) easyQs.push(entry);
      if (accuracy < 0.3) hardQs.push(entry);
    }
  });

  // Bot difficulty distribution
  const botDifficulty = {};
  events.filter(e => (e.type === 'game_started_bot') && e.botDifficulty).forEach(e => {
    botDifficulty[e.botDifficulty] = (botDifficulty[e.botDifficulty] || 0) + 1;
  });

  // Hourly activity pattern
  const hourlyActivity = {};
  events.filter(e => e.type === 'game_started' || e.type === 'game_started_bot').forEach(e => {
    const hour = new Date(e.timestamp).getHours();
    hourlyActivity[hour] = (hourlyActivity[hour] || 0) + 1;
  });

  // Generate insights
  const insights = generateInsights({
    gamesStarted, gamesCompleted, roomsCreated,
    botGames, multiGames, players: players.size,
    avgGamesPerPlayer, repeatRate, topicStats,
    rematches, timeouts, inviteShares, inviteOpens,
    easyQs, hardQs, disconnectRounds, roundAnalysis,
    gamesPerPlayerDist, botDifficulty, counts,
  });

  return {
    period: days >= 90 ? 'All Time' : `Last ${days} days`,
    // North Stars
    northStars: {
      completionRate: gamesStarted ? Math.round((gamesCompleted / gamesStarted) * 100) : 0,
      avgGamesPerPlayer: parseFloat(avgGamesPerPlayer),
      repeatRate,
      shareToJoinRate: inviteShares > 0 ? Math.round((inviteOpens / inviteShares) * 100) : 0,
    },
    // Core metrics
    totalEvents: events.length,
    uniquePlayers: players.size,
    gamesByDay,
    topicStats,
    roomsCreated, gamesStarted, gamesCompleted,
    conversionRate: roomsCreated ? Math.round((gamesStarted / roomsCreated) * 100) : 0,
    completionRate: gamesStarted ? Math.round((gamesCompleted / gamesStarted) * 100) : 0,
    botGames, multiGames, timeouts, rematches,
    inviteShares, inviteOpens,
    // Player behaviour
    avgGamesPerPlayer: parseFloat(avgGamesPerPlayer),
    repeatRate,
    gamesPerPlayerDist,
    // Content quality
    roundAnalysis,
    disconnectRounds,
    tooEasyQuestions: easyQs.sort((a, b) => b.accuracy - a.accuracy).slice(0, 20),
    tooHardQuestions: hardQs.sort((a, b) => a.accuracy - b.accuracy).slice(0, 20),
    // Mode analysis
    botDifficulty,
    hourlyActivity,
    // Insights
    insights,
    // Raw counts
    eventCounts: counts,
  };
}

// ─── Insight Generator ──────────────────────────────────────────
function generateInsights(d) {
  const insights = [];

  // Completion rate insight
  if (d.gamesStarted > 0) {
    const cr = Math.round((d.gamesCompleted / d.gamesStarted) * 100);
    if (cr < 50) {
      insights.push({
        type: 'critical', icon: '🚨',
        title: 'Players are quitting mid-game',
        detail: `Only ${cr}% of games are completed. ${d.gamesStarted - d.gamesCompleted} games abandoned. Check if specific topics or rounds cause drop-offs.`,
        action: 'Look at "Drop-off by Round" to find where players quit, then review questions at that point.',
      });
    } else if (cr < 75) {
      insights.push({
        type: 'warning', icon: '⚠️',
        title: 'Completion rate needs attention',
        detail: `${cr}% completion — acceptable but could be better. ${d.gamesStarted - d.gamesCompleted} games abandoned.`,
        action: 'Check disconnect patterns: are players leaving on specific rounds or topics?',
      });
    } else {
      insights.push({
        type: 'healthy', icon: '✅',
        title: 'Strong completion rate',
        detail: `${cr}% of games are completed — players are engaged through all 7 rounds.`,
        action: 'Maintain question quality. Focus on getting more players in.',
      });
    }
  }

  // Repeat play insight
  if (d.players > 2) {
    if (d.repeatRate < 20) {
      insights.push({
        type: 'critical', icon: '🚨',
        title: 'Almost no one plays twice',
        detail: `Only ${d.repeatRate}% of players return for a second game. Avg ${d.avgGamesPerPlayer} games/player.`,
        action: 'The first game isn\'t compelling enough. Improve end-of-game hooks: rematch prompt, "try another topic", streak counter.',
      });
    } else if (d.repeatRate < 50) {
      insights.push({
        type: 'warning', icon: '⚠️',
        title: 'Repeat play is moderate',
        detail: `${d.repeatRate}% play more than once. Avg ${d.avgGamesPerPlayer} games/player.`,
        action: 'Good foundation. Add progression hooks: personal best tracking, topic mastery badges.',
      });
    } else {
      insights.push({
        type: 'healthy', icon: '✅',
        title: 'Players are coming back',
        detail: `${d.repeatRate}% play multiple games. Avg ${d.avgGamesPerPlayer} games/player — strong stickiness.`,
        action: 'Focus on acquisition — the product retains well.',
      });
    }
  }

  // Bot vs Multiplayer
  const totalGames = d.botGames + d.multiGames;
  if (totalGames > 0) {
    const botPct = Math.round((d.botGames / totalGames) * 100);
    if (botPct > 90) {
      insights.push({
        type: 'warning', icon: '🤖',
        title: 'Nearly all games are vs bots',
        detail: `${botPct}% bot games. Multiplayer sharing isn't working yet.`,
        action: 'Improve share flow: make the invite link more prominent, add "Challenge a friend" prompts after wins.',
      });
    } else if (botPct > 60) {
      insights.push({
        type: 'info', icon: '🤖',
        title: 'Bot games dominate but multiplayer exists',
        detail: `${botPct}% bot, ${100 - botPct}% multiplayer. Healthy for early stage.`,
        action: 'Multiplayer is the growth engine. Track invite-share-to-join conversion closely.',
      });
    }
  }

  // Invite conversion
  if (d.inviteShares > 0) {
    const convRate = Math.round((d.inviteOpens / d.inviteShares) * 100);
    if (convRate < 20) {
      insights.push({
        type: 'warning', icon: '📤',
        title: 'Shared links aren\'t converting',
        detail: `${d.inviteShares} links shared but only ${convRate}% opened. Links are being ignored.`,
        action: 'Test the share message copy. Make it more compelling: "I just scored 650 on Bollywood trivia. Beat me? 🔥"',
      });
    }
  } else if (totalGames > 5) {
    insights.push({
      type: 'warning', icon: '📤',
      title: 'No invites being shared',
      detail: `${totalGames} games played but zero invite shares. The share mechanism may be broken or hidden.`,
      action: 'Verify the share button works. Consider auto-prompting share after game completion.',
    });
  }

  // Topic concentration
  if (d.topicStats.length > 1) {
    const top = d.topicStats[0];
    const totalStarts = d.topicStats.reduce((a, t) => a + t.starts, 0);
    if (top.starts > totalStarts * 0.5 && totalStarts > 5) {
      insights.push({
        type: 'info', icon: '🔥',
        title: `"${top.topic}" dominates topic selection`,
        detail: `${Math.round((top.starts / totalStarts) * 100)}% of all games are on this topic. Other topics are underexplored.`,
        action: 'Consider: is this because it\'s great, or because others are weak? Improve lesser-played topic content.',
      });
    }

    // Topics with bad completion
    d.topicStats.forEach(t => {
      if (t.starts >= 3 && t.completionRate < 50) {
        insights.push({
          type: 'critical', icon: '💀',
          title: `"${t.topic}" has a drop-off problem`,
          detail: `Only ${t.completionRate}% completion (${t.completions}/${t.starts} games). ${t.disconnects} disconnects.`,
          action: `Review questions in "${t.topic}" — likely has confusing, wrong, or frustrating questions causing rage-quits.`,
        });
      }
    });
  }

  // Too-easy / too-hard questions
  if (d.easyQs.length > 5) {
    insights.push({
      type: 'warning', icon: '😴',
      title: `${d.easyQs.length} questions are too easy`,
      detail: `Questions with >90% accuracy aren't adding challenge. Players might find the game boring.`,
      action: 'Replace or add harder alternatives. Easy questions should be max 20% of any topic.',
    });
  }
  if (d.hardQs.length > 5) {
    insights.push({
      type: 'warning', icon: '🧱',
      title: `${d.hardQs.length} questions are too hard`,
      detail: `Questions with <30% accuracy frustrate players and may be wrong or poorly worded.`,
      action: 'Review each flagged question: is the answer correct? Are options confusing? Rewrite or remove.',
    });
  }

  // Rematch rate
  if (totalGames > 5 && d.rematches === 0) {
    insights.push({
      type: 'warning', icon: '🔄',
      title: 'No rematches happening',
      detail: `${totalGames} games played, zero rematches. Players aren't hooked enough to play again immediately.`,
      action: 'Make rematch button more prominent. Add "Best of 3" mode. Show "You won 4/7 — can you beat 5/7?"',
    });
  }

  // Low data warning
  if (d.gamesStarted < 5) {
    insights.push({
      type: 'info', icon: '📊',
      title: 'Not enough data yet',
      detail: `Only ${d.gamesStarted} games played. Insights become meaningful after 20-30 games.`,
      action: 'Share the game with 10-15 friends and collect a weekend\'s worth of data before drawing conclusions.',
    });
  }

  return insights;
}

// ─── Survey Stats ───────────────────────────────────────────────
function getSurveyStats() {
  const surveys = readSurveys();
  const topicVotes = {};
  const freeText = [];

  surveys.forEach(s => {
    if (s.topics) {
      s.topics.forEach((t, i) => {
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
