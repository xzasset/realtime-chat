const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: 'http://localhost:3000', methods: ['GET', 'POST'] }
});

io.on('connection', (socket) => {
  socket.on('message', (data) => {
    io.emit('message', data);
  });

  socket.on('disconnect', () => {});
});

server.listen(4000);
