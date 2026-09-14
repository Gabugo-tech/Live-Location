const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// Generate a new session ID and redirect to the share page
app.get('/create', (req, res) => {
  const sessionId = uuidv4();
  res.redirect(`/share.html?id=${sessionId}`);
});

// In-memory store: sessionId -> last known location
const sessions = {};

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  // Sharer joins their session room and starts sending location
  socket.on('join-share', (sessionId) => {
    socket.join(sessionId);
    console.log(`Sharer joined session: ${sessionId}`);

    // Send last known location to this sharer (reconnect case)
    if (sessions[sessionId]) {
      socket.emit('location-update', sessions[sessionId]);
    }
  });

  // Viewer joins the session room to watch
  socket.on('join-view', (sessionId) => {
    socket.join(sessionId);
    console.log(`Viewer joined session: ${sessionId}`);

    // Send the last known location immediately if available
    if (sessions[sessionId]) {
      socket.emit('location-update', sessions[sessionId]);
    } else {
      socket.emit('waiting'); // sharer hasn't connected yet
    }
  });

  // Sharer sends a location update
  socket.on('send-location', ({ sessionId, lat, lng, accuracy }) => {
    const data = { lat, lng, accuracy, timestamp: Date.now() };
    sessions[sessionId] = data;
    // Broadcast to everyone in the session room (viewers)
    io.to(sessionId).emit('location-update', data);
  });

  // Sharer stops sharing
  socket.on('stop-sharing', (sessionId) => {
    delete sessions[sessionId];
    io.to(sessionId).emit('sharing-stopped');
    console.log(`Session ended: ${sessionId}`);
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Live Location server running at http://localhost:${PORT}`);
});
