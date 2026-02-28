const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── 폴더 생성 ────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
[UPLOADS_DIR, DATA_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── DB (JSON 파일 기반) ───────────────────────────
const adapter = new JSONFile(path.join(DATA_DIR, 'stories.json'));
const db = new Low(adapter, { stories: [] });

async function initDB() {
  await db.read();
  db.data ||= { stories: [] };
  await db.write();
}

// ─── 미들웨어 ─────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── 음성 파일 업로드 설정 ─────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.webm';
    cb(null, `voice_${Date.now()}_${uuidv4().slice(0,8)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/x-m4a', 'audio/m4a'];
    if (allowed.includes(file.mimetype) || file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('음성 파일만 업로드 가능합니다.'));
    }
  }
});

// ─── API: 사연 제출 ────────────────────────────────
app.post('/api/stories', upload.single('voice'), async (req, res) => {
  try {
    await db.read();

    const { name, contact, text, category, emotions } = req.body;

    if (!text && !req.file) {
      return res.status(400).json({ error: '텍스트 또는 음성 사연을 입력해주세요.' });
    }

    const story = {
      id: uuidv4(),
      name: name || '익명',
      contact: contact || '',
      text: text || '',
      category: category || '',
      emotions: emotions ? JSON.parse(emotions) : [],
      voiceFile: req.file ? req.file.filename : null,
      hasVoice: !!req.file,
      timestamp: new Date().toISOString()
    };

    db.data.stories.unshift(story);
    await db.write();

    res.json({ success: true, id: story.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// ─── API: 사연 목록 조회 ───────────────────────────
app.get('/api/stories', async (req, res) => {
  await db.read();
  const { filter, page = 1, limit = 50 } = req.query;
  let list = db.data.stories;

  if (filter && filter !== '전체') {
    if (filter === '텍스트') list = list.filter(s => s.text && !s.hasVoice);
    else if (filter === '음성') list = list.filter(s => s.hasVoice);
    else list = list.filter(s => s.category === filter);
  }

  const total = list.length;
  const start = (page - 1) * limit;
  const items = list.slice(start, start + parseInt(limit)).map(s => ({
    ...s,
    voiceUrl: s.voiceFile ? `/uploads/${s.voiceFile}` : null
  }));

  res.json({ total, items });
});

// ─── API: 통계 ────────────────────────────────────
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

// ─── API: 사연 삭제 ───────────────────────────────
app.delete('/api/stories/:id', async (req, res) => {
  await db.read();
  const story = db.data.stories.find(s => s.id === req.params.id);
  if (story && story.voiceFile) {
    const filePath = path.join(UPLOADS_DIR, story.voiceFile);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  db.data.stories = db.data.stories.filter(s => s.id !== req.params.id);
  await db.write();
  res.json({ success: true });
});

// ─── API: 전체 삭제 ──────────────────────────────
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

// ─── 시작 ─────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🎙️  라디오 사연 서버 실행 중`);
    console.log(`📡  http://localhost:${PORT}`);
    console.log(`📋  관리자: http://localhost:${PORT}?tab=admin\n`);
  });
});
