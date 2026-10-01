const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path    = require('path');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

const PORT = process.env.PORT || 3000;

// ── Fail fast if ADMIN_PASSWORD is not set in production ──
if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
  console.error('FATAL: ADMIN_PASSWORD environment variable is not set. Exiting.');
  process.exit(1);
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// In-memory set of valid tokens
const validTokens = new Set();

// ── Security headers ──
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
      scriptSrcAttr: ["'unsafe-inline'"], // allow onclick= handlers
      styleSrc:      ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
      imgSrc:        ["'self'", "data:", "maps.wikimedia.org"],
      connectSrc:    ["'self'", "wss:", "ws:"],
      fontSrc:       ["'self'", "cdn.jsdelivr.net"],
    }
  },
  crossOriginEmbedderPolicy: false // needed for Leaflet tiles
}));

// ── Cache-Control: private pages must never be cached by proxies ──
app.use((req, res, next) => {
  if (req.path === '/share.html' || req.path === '/view.html') {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

// ── Rate limiting on auth endpoints ──
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later.' }
});

app.use(express.json({ limit: '10kb' }));
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
app.get('/create', (req, res) => {
  const token = req.query.token;
  if (!token || !validTokens.has(token)) {
    return res.redirect('/?error=unauthorized');
  }
  const sessionId = uuidv4();
  res.redirect(`/share.html?id=${sessionId}`);
});

// ── 404 handler — must be after all routes and static ──
app.use((req, res) => {
  res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Page Not Found</title>
  <style>
    body { font-family: 'Segoe UI', sans-serif; background: #0f172a; color: #fff; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; flex-direction: column; gap: 16px; }
    h1 { font-size: 2rem; }
    p  { color: rgba(255,255,255,0.5); }
    a  { color: #e94560; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>404 &mdash; Page Not Found</h1>
  <p>This page doesn't exist.</p>
  <a href="/">Go back home &rarr;</a>
</body>
</html>`);
});

// ── In-memory session store ──
const sessions = {};

// Prune sessions idle for more than 48 hours
const SESSION_TTL_MS = 48 * 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const id in sessions) {
    if (sessions[id].timestamp && sessions[id].timestamp < cutoff) {
      delete sessions[id];
      console.log('Pruned stale session:', id);
    }
  }
}, 60 * 60 * 1000);

// ── Socket.io ──
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('join-share', (sessionId) => {
    socket.join(sessionId);
    console.log('Sharer joined session:', sessionId);
    if (sessions[sessionId]) {
      socket.emit('location-update', sessions[sessionId]);
    }
  });

  socket.on('join-view', (sessionId) => {
    socket.join(sessionId);
    console.log('Viewer joined session:', sessionId);
    if (sessions[sessionId]) {
      if (sessions[sessionId].stopped) {
        socket.emit('location-update', sessions[sessionId]);
        socket.emit('sharing-stopped', sessions[sessionId]);
      } else {
        socket.emit('location-update', sessions[sessionId]);
      }
    } else {
      socket.emit('waiting');
    }
  });

  socket.on('send-location', ({ sessionId, lat, lng, accuracy, tz }) => {
    if (typeof sessionId !== 'string' || sessionId.length > 64) return;
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
    const data = {
      lat, lng,
      accuracy: accuracy || 0,
      timestamp: Date.now(),
      stopped: false,
      ...(tz && typeof tz === 'string' && tz.length < 64 ? { tz } : {})
    };
    sessions[sessionId] = data;
    io.to(sessionId).emit('location-update', data);
  });

  socket.on('stop-sharing', (sessionId) => {
    if (sessions[sessionId]) {
      sessions[sessionId].stopped = true;
    } else {
      sessions[sessionId] = { stopped: true };
    }
    io.to(sessionId).emit('sharing-stopped', sessions[sessionId]);
    console.log('Sharing paused for session:', sessionId);
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log('Live Location server running at http://localhost:' + PORT);
});
