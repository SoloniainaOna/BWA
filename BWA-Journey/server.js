require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const http     = require('http');
const { Server } = require('socket.io');
const { v2: cloudinary } = require('cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const IG_USER_ID = process.env.INSTAGRAM_USER_ID;
const IG_TOKEN   = process.env.INSTAGRAM_TOKEN;
const IG_API     = 'https://graph.facebook.com/v20.0';

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Serve the whole site (index.html, collab/, filters/, videos/, …) so the app
// and the real-time server share one origin/port. Optional if you already use
// XAMPP/nginx for the static files.
app.use(express.static(__dirname));

// ── 1. Upload image to Cloudinary, get public URL ──────────────────────────
app.post('/api/upload', async (req, res) => {
  const { imageBase64 } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

  try {
    const result = await cloudinary.uploader.upload(imageBase64, {
      folder: 'bwa-journey',
      format: 'jpg',
      transformation: [
        { aspect_ratio: '1.91', crop: 'pad', background: 'black', width: 1080 },
      ],
    });
    res.json({ url: result.secure_url });
  } catch (err) {
    console.error('Cloudinary error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ── 2. Create Instagram media container ───────────────────────────────────
app.post('/api/instagram/create', async (req, res) => {
  const { imageUrl, caption } = req.body;
  if (!imageUrl || !caption) return res.status(400).json({ error: 'Missing fields' });

  try {
    const { default: fetch } = await import('node-fetch');
    const response = await fetch(`${IG_API}/${IG_USER_ID}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url:    imageUrl,
        caption:      caption,
        access_token: IG_TOKEN,
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ containerId: data.id });
  } catch (err) {
    console.error('Instagram create error:', err);
    res.status(500).json({ error: 'Create container failed' });
  }
});

// ── 3. Publish the container ───────────────────────────────────────────────
app.post('/api/instagram/publish', async (req, res) => {
  const { containerId } = req.body;
  if (!containerId) return res.status(400).json({ error: 'No container ID' });

  try {
    const { default: fetch } = await import('node-fetch');
    const response = await fetch(`${IG_API}/${IG_USER_ID}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creation_id:  containerId,
        access_token: IG_TOKEN,
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ success: true, postId: data.id });
  } catch (err) {
    console.error('Instagram publish error:', err);
    res.status(500).json({ error: 'Publish failed' });
  }
});

// ── Draw Together: real-time collaboration (Socket.IO) ─────────────────────
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// In-memory room state. Cleared automatically when the last peer leaves.
//   rooms[room] = { image: {t:'image',src} | null, log: [ ...ops ] }
const rooms = {};

io.on('connection', (socket) => {
  let room = null;

  socket.on('join', (r) => {
    room = String(r || 'draw-together').slice(0, 64);
    socket.join(room);
    if (!rooms[room]) rooms[room] = { image: null, log: [] };

    // Send current state so a late joiner catches up
    socket.emit('snapshot', { image: rooms[room].image, log: rooms[room].log });

    const count = io.sockets.adapter.rooms.get(room)?.size || 1;
    io.to(room).emit('presence', count);
  });

  socket.on('op', (op) => {
    if (!room || !rooms[room] || !op || typeof op.t !== 'string') return;
    const state = rooms[room];

    if (op.t === 'image')      { state.image = op; state.log = []; }   // new image resets the canvas
    else if (op.t === 'reset') { state.log = []; }
    else                       { state.log.push(op); }                 // line / tap / undo — replayable in order

    // Keep the log bounded for a very long session
    if (state.log.length > 5000) state.log.splice(0, state.log.length - 5000);

    socket.to(room).emit('op', op);   // relay to everyone else in the room
  });

  socket.on('disconnect', () => {
    if (!room) return;
    const count = io.sockets.adapter.rooms.get(room)?.size || 0;
    if (count === 0) delete rooms[room];        // free memory when the room empties
    else io.to(room).emit('presence', count);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`BWA server running on port ${PORT}`));
