const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 8080;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tureziabjqwzeytedrxt.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_48PiDAwqyfVVuXTIqS7dmw_oz6UD8gc';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 임시 업로드 폴더 (Supabase 업로드 전 임시 저장)
const UPLOADS_DIR = path.join('/tmp', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/test', (req, res) => res.sendFile(path.join(__dirname, 'test.html')));

// ─── 타입별 사연 입력 앱 (방법 B: 단일 HTML + URL 파라미터) ───
// /story?type=self    → 장애인 당사자
// /story?type=parent  → 장애인 자녀 부모
// /story?type=helper  → 장애인 활동지원사
// /story?type=care    → 치매 가족 돌봄자
app.get('/story', (req, res) => res.sendFile(path.join(__dirname, 'story.html')));
app.get('/dj', (req, res) => res.sendFile(path.join(__dirname, 'dj.html')));
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'manifest.json')));
app.get('/service-worker.js', (req, res) => res.sendFile(path.join(__dirname, 'service-worker.js')));
app.get('/icon-192.png', (req, res) => res.sendFile(path.join(__dirname, 'icon-192.png')));
app.get('/icon-512.png', (req, res) => res.sendFile(path.join(__dirname, 'icon-512.png')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));

// 음성 업로드 임시 저장
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.webm';
    cb(null, `voice_${Date.now()}_${uuidv4().slice(0,8)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ─── Supabase Storage 업로드 함수 ──────────────
async function uploadToStorage(filePath, fileName) {
  const fileBuffer = fs.readFileSync(filePath);
  const ext = path.extname(fileName);
  const mimeMap = { '.webm':'audio/webm', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.m4a':'audio/mp4', '.ogg':'audio/ogg' };
  const contentType = mimeMap[ext] || 'audio/webm';

  const { data, error } = await supabase.storage
    .from('voices')
    .upload(fileName, fileBuffer, { contentType, upsert: true });

  if (error) throw error;

  const { data: urlData } = supabase.storage.from('voices').getPublicUrl(fileName);
  return urlData.publicUrl;
}

// ─── Claude API 프록시 (DJ 방송 생성) ─────────
app.post('/api/dj/generate', async (req, res) => {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.' });
  }

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt가 없습니다.' });

  const body = JSON.stringify({
    model: 'claude-opus-4-5',
    max_tokens: 4000,
    stream: true,
    messages: [{ role: 'user', content: prompt }]
  });

  // SSE 스트리밍 헤더
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  const apiReq = https.request(options, (apiRes) => {
    apiRes.on('data', (chunk) => {
      res.write(chunk);
    });
    apiRes.on('end', () => {
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  apiReq.on('error', (e) => {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  });

  apiReq.write(body);
  apiReq.end();
});


app.post('/api/stories', upload.single('voice'), async (req, res) => {
  try {
    const { name, contact, text, category, emotions, audience_type } = req.body;
    if (!text && !req.file) return res.status(400).json({ error: '텍스트 또는 음성을 입력해주세요.' });

    let voiceUrl = null;
    let voiceFile = null;

    // 음성 파일이 있으면 Supabase Storage에 업로드
    if (req.file) {
      voiceFile = req.file.filename;
      voiceUrl = await uploadToStorage(req.file.path, req.file.filename);
      // 임시 파일 삭제
      fs.unlinkSync(req.file.path);
    }

    const story = {
      id: uuidv4(),
      name: name || '익명',
      contact: contact || '',
      text: text || '',
      category: category || '',
      emotions: emotions ? JSON.parse(emotions) : [],
      audience_type: audience_type || 'self',
      voice_file: voiceFile,
      voice_url: voiceUrl,
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

// ─── 사연 목록 ─────────────────────────────────
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
      voiceUrl: s.voice_url || null,
      aiEmotion: s.ai_emotion || ''
    }));

    res.json({ total: items.length, items });
  } catch (err) {
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

// ─── 사연 삭제 ─────────────────────────────────
app.delete('/api/stories/:id', async (req, res) => {
  try {
    const { data } = await supabase.from('stories').select('voice_file').eq('id', req.params.id).single();
    // Supabase Storage에서도 음성 파일 삭제
    if (data && data.voice_file) {
      await supabase.storage.from('voices').remove([data.voice_file]);
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
    const files = (data || []).filter(s => s.voice_file).map(s => s.voice_file);
    if (files.length > 0) {
      await supabase.storage.from('voices').remove(files);
    }
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
  console.log(`📦  음성 파일: Supabase Storage (voices 버킷)`);
});
