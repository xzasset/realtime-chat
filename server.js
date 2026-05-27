const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const Redis = require('ioredis');

const PORT = process.env.PORT || 4000;
const MAX_USERNAME_LENGTH = 32;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_HISTORY = 50;
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60_000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CLIENT_ORIGIN || 'http://localhost:3000', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e4,
});

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

redis.on('error', (err) => console.error('Redis error:', err));

const rateLimitMap = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of rateLimitMap.entries()) {
    if (now - entry.start > RATE_LIMIT_WINDOW_MS * 2) rateLimitMap.delete(id);
  }
}, RATE_LIMIT_CLEANUP_INTERVAL_MS);

app.use(express.static(path.join(__dirname, 'build')));

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

function isRateLimited(socketId) {
  const now = Date.now();
  const entry = rateLimitMap.get(socketId) || { count: 0, start: now };
  if (now - entry.start > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(socketId, { count: 1, start: now });
    return false;
  }
  if (entry.count >= RATE_LIMIT_MAX) return true;
  entry.count++;
  rateLimitMap.set(socketId, entry);
  return false;
}

async function pushToHistory(msg) {
  await redis.lpush('chat:history', JSON.stringify(msg));
  await redis.ltrim('chat:history', 0, MAX_HISTORY - 1);
}

async function getHistory() {
  const raw = await redis.lrange('chat:history', 0, -1);
  return raw.map((s) => JSON.parse(s)).reverse();
}

function broadcastOnlineCount() {
  io.emit('online', io.engine.clientsCount);
}

io.on('connection', async (socket) => {
  broadcastOnlineCount();

  try {
    const history = await getHistory();
    socket.emit('history', history);
  } catch (err) {
    console.error('Failed to load history:', err);
    socket.emit('history', []);
  }

  socket.on('join', async (rawUsername) => {
    if (socket.data.username) return;

    const username = sanitize(String(rawUsername || '').trim()).slice(0, MAX_USERNAME_LENGTH) || 'Аноним';
    socket.data.username = username;

    const event = { id: `sys-${Date.now()}-${socket.id}`, type: 'system', text: `${username} joined`, timestamp: Date.now() };
    await pushToHistory(event);
    io.emit('system', event);
  });

  socket.on('message', async (rawText) => {
    if (!socket.data.username) return;

    if (isRateLimited(socket.id)) {
      socket.emit('error', { message: 'Too many messages. Slow down.' });
      return;
    }

    const text = sanitize(String(rawText || '').trim()).slice(0, MAX_MESSAGE_LENGTH);
    if (!text) return;

    const msg = {
      id: `${Date.now()}-${socket.id}`,
      username: socket.data.username,
      text,
      timestamp: Date.now(),
    };
    await pushToHistory(msg);
    io.emit('message', msg);
  });

  socket.on('typing', (isTyping) => {
    if (!socket.data.username) return;
    socket.broadcast.emit('typing', { username: socket.data.username, isTyping: Boolean(isTyping) });
  });

  socket.on('disconnect', async () => {
    rateLimitMap.delete(socket.id);
    broadcastOnlineCount();

    const username = socket.data.username;
    if (!username) return;

    const event = { id: `sys-${Date.now()}-${socket.id}`, type: 'system', text: `${username} left`, timestamp: Date.now() };
    await pushToHistory(event);
    io.emit('system', event);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
