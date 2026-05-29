const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const Redis = require('ioredis');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
const MAX_USERNAME_LENGTH = 32;
const MAX_PASSWORD_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_HISTORY = 50;
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60_000;
const AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
const AUTH_RATE_LIMIT_MAX = 10;

if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET env variable is not set');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CLIENT_ORIGIN || 'http://localhost:3000', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e4,
});

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
redis.on('error', (err) => console.error('Redis error:', err));

const rateLimitMap = new Map();
const authRateLimitMap = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of rateLimitMap.entries()) {
    if (now - entry.start > RATE_LIMIT_WINDOW_MS * 2) rateLimitMap.delete(id);
  }
  for (const [ip, entry] of authRateLimitMap.entries()) {
    if (now - entry.start > AUTH_RATE_LIMIT_WINDOW_MS * 2) authRateLimitMap.delete(ip);
  }
}, RATE_LIMIT_CLEANUP_INTERVAL_MS);

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'build')));

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

function isRateLimited(map, key, windowMs, max) {
  const now = Date.now();
  const entry = map.get(key) || { count: 0, start: now };
  if (now - entry.start > windowMs) {
    map.set(key, { count: 1, start: now });
    return false;
  }
  if (entry.count >= max) return true;
  entry.count++;
  map.set(key, entry);
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

const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

function getClientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

app.post('/auth/register', async (req, res) => {
  const ip = getClientIp(req);
  if (isRateLimited(authRateLimitMap, ip, AUTH_RATE_LIMIT_WINDOW_MS, AUTH_RATE_LIMIT_MAX)) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }

  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Invalid input' });
  }

  const clean = sanitize(username.trim()).slice(0, MAX_USERNAME_LENGTH);
  if (clean.length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters' });
  if (!/^[a-zA-Z0-9_\-а-яА-ЯёЁ]+$/.test(clean)) return res.status(400).json({ error: 'Username contains invalid characters' });

  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (password.length > MAX_PASSWORD_LENGTH) return res.status(400).json({ error: 'Password too long' });

  const exists = await redis.exists(`user:${clean}`);
  if (exists) return res.status(409).json({ error: 'Username already taken' });

  const hash = await bcrypt.hash(password, 10);
  await redis.set(`user:${clean}`, JSON.stringify({ username: clean, hash }));

  const token = jwt.sign({ username: clean }, JWT_SECRET, { expiresIn: '7d' });
  res.status(201).json({ token, username: clean });
});

app.post('/auth/login', async (req, res) => {
  const ip = getClientIp(req);
  if (isRateLimited(authRateLimitMap, ip, AUTH_RATE_LIMIT_WINDOW_MS, AUTH_RATE_LIMIT_MAX)) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }

  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Invalid input' });
  }

  const clean = sanitize(username.trim()).slice(0, MAX_USERNAME_LENGTH);
  const raw = await redis.get(`user:${clean}`);

  if (!raw) {
    await bcrypt.hash('dummy', 10);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const user = JSON.parse(raw);
  const valid = await bcrypt.compare(password, user.hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ username: clean }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username: clean });
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token || typeof token !== 'string') return next(new Error('AUTH_REQUIRED'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (typeof payload.username !== 'string') return next(new Error('AUTH_INVALID'));
    socket.data.username = payload.username;
    next();
  } catch {
    next(new Error('AUTH_INVALID'));
  }
});

io.on('connection', (socket) => {
  broadcastOnlineCount();

  getHistory()
    .then((history) => socket.emit('history', history))
    .catch((err) => {
      console.error('Failed to load history:', err);
      socket.emit('history', []);
    });

  const joinEvent = {
    id: `sys-${Date.now()}-${socket.id}`,
    type: 'system',
    text: `${socket.data.username} joined`,
    timestamp: Date.now(),
  };
  pushToHistory(joinEvent).catch((err) => console.error('Failed to push join event:', err));
  io.emit('system', joinEvent);

  socket.on('message', (rawText) => {
    if (isRateLimited(rateLimitMap, socket.id, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX)) {
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
    pushToHistory(msg).catch((err) => console.error('Failed to push message:', err));
    io.emit('message', msg);
  });

  socket.on('typing', (isTyping) => {
    socket.broadcast.emit('typing', { username: socket.data.username, isTyping: Boolean(isTyping) });
  });

  socket.on('disconnect', () => {
    rateLimitMap.delete(socket.id);
    broadcastOnlineCount();
    const event = {
      id: `sys-${Date.now()}-${socket.id}`,
      type: 'system',
      text: `${socket.data.username} left`,
      timestamp: Date.now(),
    };
    pushToHistory(event).catch((err) => console.error('Failed to push leave event:', err));
    io.emit('system', event);
  });
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => {
    redis.quit();
    process.exit(0);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
