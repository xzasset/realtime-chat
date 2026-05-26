const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

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

const messageHistory = [];
const rateLimitMap = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of rateLimitMap.entries()) {
    if (now - entry.start > RATE_LIMIT_WINDOW_MS * 2) rateLimitMap.delete(id);
  }
}, RATE_LIMIT_CLEANUP_INTERVAL_MS);

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

function broadcastOnlineCount() {
  io.emit('online', io.engine.clientsCount);
}

io.on('connection', (socket) => {
  broadcastOnlineCount();
  socket.emit('history', messageHistory);

  socket.on('join', (rawUsername) => {
    if (socket.data.username) return;

    const username = sanitize(String(rawUsername || '').trim()).slice(0, MAX_USERNAME_LENGTH) || 'Аноним';
    socket.data.username = username;

    const event = { id: `sys-${Date.now()}-${socket.id}`, type: 'system', text: `${username} joined`, timestamp: Date.now() };
    messageHistory.push(event);
    if (messageHistory.length > MAX_HISTORY) messageHistory.shift();
    io.emit('system', event);
  });

  socket.on('message', (rawText) => {
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
    messageHistory.push(msg);
    if (messageHistory.length > MAX_HISTORY) messageHistory.shift();
    io.emit('message', msg);
  });

  socket.on('typing', (isTyping) => {
    if (!socket.data.username) return;
    socket.broadcast.emit('typing', { username: socket.data.username, isTyping: Boolean(isTyping) });
  });

  socket.on('disconnect', () => {
    rateLimitMap.delete(socket.id);
    broadcastOnlineCount();

    const username = socket.data.username;
    if (!username) return;

    const event = { id: `sys-${Date.now()}-${socket.id}`, type: 'system', text: `${username} left`, timestamp: Date.now() };
    messageHistory.push(event);
    if (messageHistory.length > MAX_HISTORY) messageHistory.shift();
    io.emit('system', event);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
