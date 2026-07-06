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

// In-memory room state, keyed by "<mode>:<CODE>" so draw rooms and puzzle rooms
// never collide even if they pick the same 4-letter code.
//   state = { mode, image, log, puzzle }
const rooms = {};
const roomKey = (mode, code) => `${mode}:${code}`;
function newState(mode) { return { mode, image: null, log: [], puzzle: null }; }

// Human-friendly codes; omit easily-confused characters (no O/0/I/1/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeCode(len = 4) {
  let c = '';
  for (let i = 0; i < len; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return c;
}
function uniqueCode(mode) { let c; do { c = makeCode(); } while (rooms[roomKey(mode, c)]); return c; }
function roomSize(key) { return io.sockets.adapter.rooms.get(key)?.size || 0; }

function enterRoom(socket, mode, code) {
  const key = roomKey(mode, code);
  socket.data.roomKey = key;
  socket.data.code = code;
  socket.join(key);
  socket.emit('joined', { code });
  const s = rooms[key];
  socket.emit('snapshot', { image: s.image, log: s.log, puzzle: s.puzzle });
  io.to(key).emit('presence', roomSize(key));
}

io.on('connection', (socket) => {
  // Create a brand-new room with a unique code. mode: 'draw' (default) | 'puzzle'.
  socket.on('create', (payload = {}) => {
    const mode = (payload.mode === 'puzzle') ? 'puzzle' : 'draw';
    const code = uniqueCode(mode);
    rooms[roomKey(mode, code)] = newState(mode);
    enterRoom(socket, mode, code);
  });

  // Join an existing room by code within the same mode. `createIfMissing` is only
  // for fixed-station links (?room=CODE) — the normal Join button never creates.
  socket.on('join', (payload = {}) => {
    const mode = (payload.mode === 'puzzle') ? 'puzzle' : 'draw';
    const code = String(payload.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!code) { socket.emit('joinError', { reason: 'empty' }); return; }
    const key = roomKey(mode, code);
    if (!rooms[key]) {
      if (payload.createIfMissing) rooms[key] = newState(mode);
      else { socket.emit('joinError', { reason: 'not_found', code }); return; }
    }
    enterRoom(socket, mode, code);
  });

  socket.on('op', (op) => {
    const key = socket.data.roomKey;
    if (!key || !rooms[key] || !op || typeof op.t !== 'string') return;
    const state = rooms[key];

    // ── Authoritative: echo to EVERYONE (incl. sender) so the whole room switches
    //    image / puzzle / returns to selection together and can never diverge.
    if (op.t === 'image')        { state.image = op; state.log = []; io.to(key).emit('op', op); return; }
    if (op.t === 'back')         { state.image = null; state.log = []; state.puzzle = null; io.to(key).emit('op', op); return; }
    if (op.t === 'puzzle-start') {
      state.puzzle = {
        src: op.src, rows: op.rows, cols: op.cols,
        pieces: (op.positions || []).map(p => ({ x: p.x, y: p.y, snapped: false })),
      };
      io.to(key).emit('op', op);
      return;
    }

    // ── Puzzle piece updates: relay to others, but keep authoritative positions
    //    on the server so a late joiner rebuilds the board exactly as it stands.
    if (op.t === 'piece-move') {
      if (state.puzzle && state.puzzle.pieces[op.i]) { state.puzzle.pieces[op.i].x = op.x; state.puzzle.pieces[op.i].y = op.y; }
      socket.to(key).emit('op', op); return;
    }
    if (op.t === 'piece-snap') {
      if (state.puzzle && state.puzzle.pieces[op.i]) state.puzzle.pieces[op.i].snapped = true;
      socket.to(key).emit('op', op); return;
    }
    if (op.t === 'piece-grab' || op.t === 'piece-release') { socket.to(key).emit('op', op); return; }

    // ── Draw ops (line / tap / undo / reset): replayable log for late joiners.
    if (op.t === 'reset') { state.log = []; }
    else                  { state.log.push(op); }
    if (state.log.length > 5000) state.log.splice(0, state.log.length - 5000);
    socket.to(key).emit('op', op);
  });

  socket.on('disconnect', () => {
    const key = socket.data.roomKey;
    if (!key) return;
    const size = roomSize(key);
    if (size === 0) delete rooms[key];          // free memory when the room empties
    else io.to(key).emit('presence', size);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`BWA server running on port ${PORT}`));
