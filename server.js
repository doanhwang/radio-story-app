const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 8080;

// Supabase 연결
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tureziabjqwzeytedrxt.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_48PiDAwqyfVVuXTIqS7dmw_oz6UD8gc';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 음성 파일 임시 저장
const UPLOADS_DIR = path.join('/tmp', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(cors());
app.use(express.json());

// 클라이언트 앱
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
// 관리자 앱
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.use('/uploads', express.static(UPLOADS_DIR));

// 음성 업로드 설정
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.webm';
    cb(null, `voice_${Date.now()}_${uuidv4().slice(0,8)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ─── 사연 제출 ─────────────────────────────────
app.post('/api/stories', upload.single('voice'), async (req, res) => {
  try {
    const { name, contact, text, category, emotions } = req.body;
    if (!text && !req.file) return res.status(400).json({ error: '텍스트 또는 음성을 입력해주세요.' });

    const story = {
      id: uuidv4(),
      name: name || '익명',
      contact: contact || '',
      text: text || '',
      category: category || '',
      emotions: emotions ? JSON.parse(emotions) : [],
      voice_file: req.file ? req.file.filename : null,
      has_voice: !!req.file,
      ai_emotion: ''
    };

    const { error } = await supabase.from('stories').insert([story]);
    if (error) throw error;

    res.json({ success: true, id: story.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류: ' + err.message });
  }
});

// ─── 사연 목록 조회 ────────────────────────────
app.get('/api/stories', async (req, res) => {
  try {
    const { filter, limit = 500 } = req.query;
    let query = supabase.from('stories').select('*').order('created_at', { ascending: false }).limit(parseInt(limit));

    if (filter && filter !== '전체') {
      if (filter === '텍스트') query = query.not('text', 'eq', '').eq('has_voice', false);
      else if (filter === '음성') query = query.eq('has_voice', true);
      else query = query.eq('category', filter);
    }

    const { data, error } = await query;
    if (error) throw error;

    const items = (data || []).map(s => ({
      ...s,
      timestamp: s.created_at,
      hasVoice: s.has_voice,
      voiceUrl: s.voice_file ? `/uploads/${s.voice_file}` : null,
      aiEmotion: s.ai_emotion || ''
    }));

    res.json({ total: items.length, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── 통계 ──────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const { data, error } = await supabase.from('stories').select('*');
    if (error) throw error;

    const today = new Date().toDateString();
    res.json({
      total: data.length,
      textCount: data.filter(s => s.text).length,
      voiceCount: data.filter(s => s.has_voice).length,
      todayCount: data.filter(s => new Date(s.created_at).toDateString() === today).length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── AI 감정 업데이트 ──────────────────────────
app.patch('/api/stories/:id/emotion', async (req, res) => {
  try {
    const { aiEmotion } = req.body;
    const { error } = await supabase.from('stories').update({ ai_emotion: aiEmotion }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 사연 삭제 ─────────────────────────────────
app.delete('/api/stories/:id', async (req, res) => {
  try {
    // 음성 파일 삭제
    const { data } = await supabase.from('stories').select('voice_file').eq('id', req.params.id).single();
    if (data && data.voice_file) {
      const fp = path.join(UPLOADS_DIR, data.voice_file);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    const { error } = await supabase.from('stories').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 전체 삭제 ─────────────────────────────────
app.delete('/api/stories', async (req, res) => {
  try {
    const { data } = await supabase.from('stories').select('voice_file');
    (data || []).forEach(s => {
      if (s.voice_file) {
        const fp = path.join(UPLOADS_DIR, s.voice_file);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      }
    });
    const { error } = await supabase.from('stories').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🎙️  라디오 사연 서버 실행 중`);
  console.log(`📡  사연 보내기: http://localhost:${PORT}`);
  console.log(`🔐  관리자: http://localhost:${PORT}/admin`);
  console.log(`🗄️  Supabase 연결됨: ${SUPABASE_URL}`);
});
