const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Admin password — set ADMIN_PASSWORD env variable in Render (or locally in .env)
// Falls back to 'admin123' for local dev only — always set a real password in production
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// In-memory set of valid tokens (cleared on server restart)
const validTokens = new Set();

// ── Security headers ──
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
      styleSrc:  ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
      imgSrc:    ["'self'", "data:", "*.tile.openstreetmap.org"],
      connectSrc:["'self'", "wss:", "ws:"],
      fontSrc:   ["'self'", "cdn.jsdelivr.net"],
    }
  },
  crossOriginEmbedderPolicy: false // needed for Leaflet tiles
}));

// ── Cache-Control: private pages must not be cached by proxies ──
app.use((req, res, next) => {
  const privatePaths = ['/share.html', '/view.html'];
  if (privatePaths.some(p => req.path === p || req.path.startsWith(p))) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

// ── Rate limiting on auth endpoints ──
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // max 10 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later.' }
});

app.use(express.json({ limit: '10kb' })); // reject oversized payloads
app.use(express.static(path.join(__dirname, 'public')));

// ── Admin password verification ──
app.post('/verify-admin', authLimiter, (req, res) => {
  const { password } = req.body;
  if (!password || typeof password !== 'string' || password.length > 128) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  // Issue a session token valid for 24h
  const token = uuidv4();
  validTokens.add(token);
  setTimeout(() => validTokens.delete(token), 24 * 60 * 60 * 1000);
  res.json({ token });
});

// ── Validate admin session token ──
app.post('/validate-admin', (req, res) => {
  const { token } = req.body;
  if (!token || !validTokens.has(token)) {
    return res.status(401).json({ valid: false });
  }
  res.json({ valid: true });
});

// ── Logout admin session ──
app.post('/logout-admin', (req, res) => {
  const { token } = req.body;
  if (token) validTokens.delete(token);
  res.json({ ok: true });
});

// ── Create session — only with a valid admin token ──
// Token is NOT consumed here so the share page can keep using it for validation
app.get('/create', (req, res) => {
  const token = req.query.token;
  if (!token || !validTokens.has(token)) {
    return res.redirect('/?error=unauthorized');
  }
  // Do NOT delete the token — share page still needs it for /validate-admin
  const sessionId = uuidv4();
  res.redirect(`/share.html?id=${sessionId}`);
});

// In-memory store: sessionId -> last known location
const sessions = {};

// Prune sessions that haven't been updated in 48 hours
const SESSION_TTL_MS = 48 * 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const id in sessions) {
    if (sessions[id].timestamp && sessions[id].timestamp < cutoff) {
      delete sessions[id];
      console.log(`Pruned stale session: ${id}`);
    }
  }
}, 60 * 60 * 1000); // run every hour

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
      if (sessions[sessionId].stopped) {
        // Sharing was stopped but we still have the last coords — send both
        socket.emit('location-update', sessions[sessionId]);
        socket.emit('sharing-stopped', sessions[sessionId]);
      } else {
        socket.emit('location-update', sessions[sessionId]);
      }
    } else {
      socket.emit('waiting'); // sharer hasn't connected yet
    }
  });

  // Sharer sends a location update
  socket.on('send-location', ({ sessionId, lat, lng, accuracy, tz }) => {
    // Basic input validation
    if (typeof sessionId !== 'string' || sessionId.length > 64) return;
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
    const data = {
      lat,
      lng,
      accuracy: accuracy || 0,
      timestamp: Date.now(),
      stopped: false,
      // tz is optional — only present for spoofed locations
      ...(tz && typeof tz === 'string' && tz.length < 64 ? { tz } : {})
    };
    sessions[sessionId] = data;
    // Broadcast to everyone in the session room (viewers)
    io.to(sessionId).emit('location-update', data);
  });

  // Sharer stops sharing — keep last location so viewers still see it
  socket.on('stop-sharing', (sessionId) => {
    if (sessions[sessionId]) {
      sessions[sessionId].stopped = true;
    } else {
      sessions[sessionId] = { stopped: true };
    }
    io.to(sessionId).emit('sharing-stopped', sessions[sessionId]);
    console.log(`Sharing paused for session: ${sessionId} (last location preserved)`);
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Live Location server running at http://localhost:${PORT}`);
});
