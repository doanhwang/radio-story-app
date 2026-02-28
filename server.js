const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');

const app = express();
const PORT = process.env.PORT || 8080;

const UPLOADS_DIR = path.join('/tmp', 'uploads');
const DATA_FILE = path.join('/tmp', 'stories.json');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const adapter = new JSONFile(DATA_FILE);
const db = new Low(adapter, { stories: [] });

async function initDB() {
  await db.read();
  db.data ||= { stories: [] };
  await db.write();
}

app.use(cors());
app.use(express.json());

// 클라이언트 앱 (사연 보내기)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 관리자 앱 (비밀번호로 보호)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.use('/uploads', express.static(UPLOADS_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.webm';
    cb(null, `voice_${Date.now()}_${uuidv4().slice(0,8)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.post('/api/stories', upload.single('voice'), async (req, res) => {
  try {
    await db.read();
    const { name, contact, text, category, emotions } = req.body;
    if (!text && !req.file) return res.status(400).json({ error: '텍스트 또는 음성을 입력해주세요.' });
    const story = {
      id: uuidv4(), name: name || '익명', contact: contact || '',
      text: text || '', category: category || '',
      emotions: emotions ? JSON.parse(emotions) : [],
      voiceFile: req.file ? req.file.filename : null,
      hasVoice: !!req.file, timestamp: new Date().toISOString()
    };
    db.data.stories.unshift(story);
    await db.write();
    res.json({ success: true, id: story.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류' });
  }
});

app.get('/api/stories', async (req, res) => {
  await db.read();
  const { filter, limit = 500 } = req.query;
  let list = db.data.stories;
  if (filter && filter !== '전체') {
    if (filter === '텍스트') list = list.filter(s => s.text && !s.hasVoice);
    else if (filter === '음성') list = list.filter(s => s.hasVoice);
    else list = list.filter(s => s.category === filter);
  }
  const items = list.slice(0, parseInt(limit)).map(s => ({
    ...s, voiceUrl: s.voiceFile ? `/uploads/${s.voiceFile}` : null
  }));
  res.json({ total: list.length, items });
});

app.get('/api/stats', async (req, res) => {
  await db.read();
  const stories = db.data.stories;
  const today = new Date().toDateString();
  res.json({
    total: stories.length,
    textCount: stories.filter(s => s.text).length,
    voiceCount: stories.filter(s => s.hasVoice).length,
    todayCount: stories.filter(s => new Date(s.timestamp).toDateString() === today).length
  });
});

app.delete('/api/stories/:id', async (req, res) => {
  await db.read();
  const story = db.data.stories.find(s => s.id === req.params.id);
  if (story && story.voiceFile) {
    const fp = path.join(UPLOADS_DIR, story.voiceFile);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  db.data.stories = db.data.stories.filter(s => s.id !== req.params.id);
  await db.write();
  res.json({ success: true });
});

app.delete('/api/stories', async (req, res) => {
  await db.read();
  db.data.stories.forEach(s => {
    if (s.voiceFile) {
      const fp = path.join(UPLOADS_DIR, s.voiceFile);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
  });
  db.data.stories = [];
  await db.write();
  res.json({ success: true });
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🎙️  라디오 사연 서버 실행 중`);
    console.log(`📡  사연 보내기: http://localhost:${PORT}`);
    console.log(`🔐  관리자: http://localhost:${PORT}/admin`);
  });
});
