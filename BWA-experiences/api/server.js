const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json({ limit: '20mb' }));

const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const IG_ACCOUNT_ID   = process.env.IG_ACCOUNT_ID;
const PUBLIC_URL      = (process.env.PUBLIC_URL || 'http://localhost:8080').replace(/\/$/, '');

const PHOTOS_DIR = '/photos';
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

// ── POST STORY ──
app.post('/api/post-story', async (req, res) => {
  if (!IG_ACCESS_TOKEN || !IG_ACCOUNT_ID) {
    return res.status(500).json({ success: false, error: 'Instagram API not configured (IG_ACCESS_TOKEN / IG_ACCOUNT_ID missing)' });
  }

  const { image, instagram } = req.body;
  if (!image || !instagram) {
    return res.status(400).json({ success: false, error: 'Missing image or instagram field' });
  }

  // Save image to shared volume (served publicly by nginx)
  const filename  = `${uuidv4()}.jpg`;
  const filepath  = path.join(PHOTOS_DIR, filename);
  const b64       = image.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(filepath, Buffer.from(b64, 'base64'));

  const imageUrl = `${PUBLIC_URL}/photos/${filename}`;
  const handle   = instagram.replace(/^@/, '').trim();

  const cleanup = () => { try { fs.unlinkSync(filepath); } catch (_) {} };

  try {
    // 1. Create story media — try with collaborator tag first
    const payload = {
      image_url:  imageUrl,
      media_type: 'STORIES',
      access_token: IG_ACCESS_TOKEN,
      collaborators: [handle]
    };

    let creationId;
    try {
      const r = await axios.post(`https://graph.facebook.com/v19.0/${IG_ACCOUNT_ID}/media`, payload);
      creationId = r.data.id;
    } catch (tagErr) {
      // Collaborator tag failed (private account, not found…) — retry without
      console.warn('Collaborator tag failed, retrying without:', tagErr?.response?.data?.error?.message);
      delete payload.collaborators;
      const r = await axios.post(`https://graph.facebook.com/v19.0/${IG_ACCOUNT_ID}/media`, payload);
      creationId = r.data.id;
    }

    // 2. Publish story
    await axios.post(`https://graph.facebook.com/v19.0/${IG_ACCOUNT_ID}/media_publish`, {
      creation_id: creationId,
      access_token: IG_ACCESS_TOKEN
    });

    // Delete image after 2 hours
    setTimeout(cleanup, 7_200_000);

    res.json({ success: true });
  } catch (err) {
    console.error('Instagram API error:', err?.response?.data || err.message);
    cleanup();
    const igMsg = err?.response?.data?.error?.message;
    res.status(500).json({ success: false, error: igMsg || err.message });
  }
});

app.listen(3000, () => {
  console.log('BWA API running on :3000');
  console.log('  IG_ACCOUNT_ID :', IG_ACCOUNT_ID  || '(not set)');
  console.log('  PUBLIC_URL    :', PUBLIC_URL);
});
