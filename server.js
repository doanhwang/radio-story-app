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
app.get('/letter', (req, res) => res.sendFile(path.join(__dirname, 'letter.html')));
app.get('/letter/:id', (req, res) => res.sendFile(path.join(__dirname, 'letter-view.html')));
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

// ─── DJ 비용 메모리 저장소 (서버 재시작 전까지 유지) ──
const usageMemory = [];

// ─── Claude 모델별 요금 (USD per 1M tokens) ────
const CLAUDE_PRICING = {
  'claude-opus-4-5':       { input: 15.0,  output: 75.0  },
  'claude-sonnet-4-20250514': { input: 3.0,   output: 15.0  },
  'claude-haiku-4-5-20251001':{ input: 0.25,  output: 1.25  },
};
const MODEL = 'claude-opus-4-5';

function calcCost(inputTokens, outputTokens, model) {
  const price = CLAUDE_PRICING[model] || CLAUDE_PRICING['claude-opus-4-5'];
  const inputCost  = (inputTokens  / 1_000_000) * price.input;
  const outputCost = (outputTokens / 1_000_000) * price.output;
  return { inputCost, outputCost, totalCost: inputCost + outputCost };
}

// ─── Claude API 프록시 (DJ 방송 생성) ─────────
app.post('/api/dj/generate', async (req, res) => {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다. Railway Variables를 확인하세요.' });
  }

  const { prompt, story_id, story_name, story_text, dj_name, dj_tone, music_genre } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt가 없습니다.' });

  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 4000,
    stream: true,
    messages: [{ role: 'user', content: prompt }]
  });

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
    if (apiRes.statusCode !== 200) {
      let errBody = '';
      apiRes.on('data', d => errBody += d);
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(errBody);
          res.status(apiRes.statusCode).json({ error: parsed.error?.message || errBody });
        } catch(e) {
          res.status(apiRes.statusCode).json({ error: errBody || 'Anthropic API 오류' });
        }
      });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let rawBuffer = '';
    let fullText = '';
    let inputTokens = 0;
    let outputTokens = 0;

    apiRes.on('data', (chunk) => {
      const text = chunk.toString();
      rawBuffer += text;
      res.write(chunk); // 클라이언트에 그대로 전달

      // 토큰 사용량 파싱 (message_delta 이벤트)
      const lines = text.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const j = JSON.parse(line.slice(5).trim());
          if (j.type === 'message_start' && j.message?.usage) {
            inputTokens = j.message.usage.input_tokens || 0;
          }
          if (j.type === 'message_delta' && j.usage) {
            outputTokens = j.usage.output_tokens || 0;
          }
          if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') {
            fullText += j.delta.text || '';
          }
        } catch(e) {}
      }
    });

    apiRes.on('end', async () => {
      res.write('data: [DONE]\n\n');
      res.end();

      // 비용 계산
      if (inputTokens > 0 || outputTokens > 0) {
        const { inputCost, outputCost, totalCost } = calcCost(inputTokens, outputTokens, MODEL);
        const record = {
          id: uuidv4(),
          created_at: new Date().toISOString(),
          model: MODEL,
          story_id: story_id || null,
          story_name: story_name || '알 수 없음',
          story_text: story_text || '',
          dj_name: dj_name || 'DJ 은하',
          dj_tone: dj_tone || '',
          music_genre: music_genre || '',
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          input_cost_usd: inputCost,
          output_cost_usd: outputCost,
          total_cost_usd: totalCost,
          full_text: fullText,
        };

        // 1) 메모리에 항상 저장 (즉시, 신뢰성 높음)
        usageMemory.unshift(record);
        if (usageMemory.length > 500) usageMemory.pop();
        console.log(`💰 DJ 생성 비용: $${totalCost.toFixed(6)} (in:${inputTokens} / out:${outputTokens})`);

        // 2) Supabase에도 저장 시도 (실패해도 무시)
        supabase.from('api_cost').insert([record]).then(({ error }) => {
          if (error) console.warn('dj_usage Supabase 저장 실패 (무시):', error.message);
        });
      }
    });
  });

  apiReq.on('error', (e) => {
    console.error('Anthropic API 요청 오류:', e.message);
    if (!res.headersSent) {
      res.status(500).json({ error: '서버 연결 오류: ' + e.message });
    }
  });

  apiReq.write(body);
  apiReq.end();
});

// ─── DJ 비용 통계 조회 ──────────────────────────
app.get('/api/dj/usage', async (req, res) => {
  // 메모리에 데이터 있으면 즉시 반환 (Supabase 불필요)
  if (usageMemory.length > 0) {
    const total_cost   = usageMemory.reduce((s, r) => s + (Number(r.total_cost_usd)  || 0), 0);
    const total_input  = usageMemory.reduce((s, r) => s + (Number(r.input_tokens)    || 0), 0);
    const total_output = usageMemory.reduce((s, r) => s + (Number(r.output_tokens)   || 0), 0);
    return res.json({ records: usageMemory, total_cost, total_input, total_output, count: usageMemory.length, source: 'memory' });
  }

  // 메모리 비어있으면 Supabase 시도
  try {
    const { data, error } = await supabase
      .from('api_cost')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;

    const total_cost   = data.reduce((s, r) => s + (Number(r.total_cost_usd) || 0), 0);
    const total_input  = data.reduce((s, r) => s + (Number(r.input_tokens)   || 0), 0);
    const total_output = data.reduce((s, r) => s + (Number(r.output_tokens)  || 0), 0);
    res.json({ records: data, total_cost, total_input, total_output, count: data.length, source: 'supabase' });
  } catch(err) {
    // Supabase도 실패하면 빈 응답 (오류 아님)
    res.json({ records: [], total_cost: 0, total_input: 0, total_output: 0, count: 0, source: 'none', error: err.message });
  }
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

// ─── 편지 저장 ────────────────────────────────
app.post('/api/letters', async (req, res) => {
  try {
    const { from_name, to_name, title, text, relation, emotions } = req.body;
    if(!from_name || !to_name || !text)
      return res.status(400).json({ error: '필수 항목 누락' });

    const letter = {
      id: uuidv4(),
      from_name, to_name, title: title || `${from_name}이(가) ${to_name}에게`,
      text, relation: relation || 'anyone',
      emotions: emotions || [],
      broadcast_text: null,
      broadcast_at: null,
    };

    const { error } = await supabase.from('letters').insert([letter]);
    if(error) throw error;

    res.json({ success:true, id: letter.id });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 편지 조회 (공유 링크용) ──────────────────
app.get('/api/letters/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('letters').select('*').eq('id', req.params.id).single();
    if(error) throw error;
    if(!data) return res.status(404).json({ error: '편지를 찾을 수 없습니다' });
    res.json(data);
  } catch(err) {
    res.status(404).json({ error: err.message });
  }
});

// ─── 편지 목록 (DJ 스튜디오용) ───────────────
app.get('/api/letters', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('letters').select('*')
      .order('created_at', { ascending: false }).limit(200);
    if(error) throw error;
    res.json({ total: data.length, items: data });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 편지에 방송 텍스트 저장 (DJ 스튜디오 연동) ─
app.patch('/api/letters/:id/broadcast', async (req, res) => {
  try {
    const { broadcast_text } = req.body;
    const { error } = await supabase.from('letters')
      .update({ broadcast_text, broadcast_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if(error) throw error;
    res.json({ success: true });
  } catch(err) {
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
