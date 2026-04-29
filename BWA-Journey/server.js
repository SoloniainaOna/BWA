require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
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

// ── 1. Upload image to Cloudinary, get public URL ──────────────────────────
app.post('/api/upload', async (req, res) => {
  const { imageBase64 } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

  try {
    const result = await cloudinary.uploader.upload(imageBase64, {
      folder: 'bwa-journey',
      format: 'jpg',
      transformation: [
        { aspect_ratio: '1:1', crop: 'fill', gravity: 'center' },
        { width: 1080, crop: 'scale' },
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`BWA server running on port ${PORT}`));
