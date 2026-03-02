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
app.get('/data', (req, res) => res.sendFile(path.join(__dirname, 'data.html')));
app.get('/sim',  (req, res) => res.sendFile(path.join(__dirname, 'sim.html')));
app.get('/letter', (req, res) => res.sendFile(path.join(__dirname, 'letter.html')));
app.get('/letter/:id', (req, res) => res.sendFile(path.join(__dirname, 'letter-view.html')));
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'manifest.json')));
app.get('/service-worker.js', (req, res) => res.sendFile(path.join(__dirname, 'service-worker.js')));
app.get('/icon-192.png', (req, res) => res.sendFile(path.join(__dirname, 'icon-192.png')));
app.get('/icon-512.png', (req, res) => res.sendFile(path.join(__dirname, 'icon-512.png')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));

// 음성 업로드 임시 저장
// letters용 메모리 업로드 (buffer 직접 접근)
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

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

      // 비용 계산 및 구조화 저장
      if (inputTokens > 0 || outputTokens > 0) {
        const { inputCost, outputCost, totalCost } = calcCost(inputTokens, outputTokens, MODEL);

        // ── 섹션 파싱 (Data Moat 핵심) ──
        function extractSec(key) {
          const m = fullText.match(new RegExp('\\[SECTION:'+key+'\\]([\\s\\S]*?)(?:\\[/SECTION\\]|$)', 'i'));
          return m ? m[1].replace(/\[SUNO:[^\]]+\][\s\S]*?\[\/SUNO\]/gi,'').replace(/\[LYRICS\][\s\S]*?\[\/LYRICS\]/gi,'').trim() : '';
        }
        function extractSuno(key) {
          const m = fullText.match(new RegExp('\\[SUNO:'+key+'\\]([\\s\\S]*?)\\[\/SUNO\\]', 'i'));
          return m ? m[1].trim() : '';
        }
        function extractLyrics() {
          const m = fullText.match(/\[LYRICS\]([\s\S]*?)\[\/LYRICS\]/i);
          return m ? m[1].trim() : '';
        }

        // 감정 키워드 추출 (Data Moat: 언어 패턴 분석용)
        const emotionKeywords = ['감사','사랑','미안','그리움','응원','위로','기쁨','슬픔','외로움','희망','걱정','자랑','행복','아픔','보고싶'];
        const detectedEmotions = emotionKeywords.filter(kw => fullText.includes(kw));

        // 가사 품질 지표
        const lyrics = extractLyrics();
        const lyricsLines = lyrics ? lyrics.split('\n').filter(l=>l.trim()).length : 0;
        const hasSections = ['Verse','Chorus','Bridge','Outro'].filter(k => lyrics.includes(k)).length;

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
          // 구조화 섹션 (LLM 튜닝 데이터셋용)
          sec_intro: extractSec('intro_music'),
          sec_opening: extractSec('opening'),
          sec_story: extractSec('story'),
          sec_reflection: extractSec('reflection'),
          sec_gift_music: extractSec('gift_music'),
          sec_closing: extractSec('closing'),
          sec_outro: extractSec('outro_music'),
          suno_intro: extractSuno('intro'),
          suno_gift: extractSuno('gift'),
          suno_outro: extractSuno('outro'),
          lyrics: lyrics,
          // Data Moat 지표
          detected_emotions: detectedEmotions,
          lyrics_lines: lyricsLines,
          lyrics_sections_count: hasSections,
          word_count: fullText.split(/\s+/).length,
          char_count: fullText.length,
        };

        // 1) 메모리에 항상 저장
        usageMemory.unshift(record);
        if (usageMemory.length > 500) usageMemory.pop();
        console.log(`💰 DJ 생성: $${totalCost.toFixed(6)} | ${detectedEmotions.join(',')||'감정없음'} | 가사${lyricsLines}줄`);

        // 2) Supabase 저장
        supabase.from('api_cost').insert([record]).then(({ error }) => {
          if (error) console.warn('api_cost 저장 실패:', error.message);
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

// ─── 편지 저장 (JSON or FormData 음성) ───────
app.post('/api/letters', memUpload.single('voice'), async (req, res) => {
  try {
    const b = req.body;
    const from_name = b.from_name, to_name = b.to_name;
    if(!from_name || !to_name)
      return res.status(400).json({ error: '필수 항목 누락' });

    let voice_url = null;
    if(req.file){
      const ext = req.file.originalname.split('.').pop() || 'webm';
      const filename = `letter_${uuidv4()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from('voices').upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert:false });
      if(!upErr){
        const { data } = supabase.storage.from('voices').getPublicUrl(filename);
        voice_url = data.publicUrl;
      }
    }

    let emotions = b.emotions || [];
    if(typeof emotions === 'string'){ try{ emotions=JSON.parse(emotions); }catch(e){ emotions=[]; } }

    const letter = {
      id: uuidv4(),
      from_name, to_name,
      from_phone: b.from_phone || null,
      to_phone:   b.to_phone   || null,
      title: b.title || `${from_name}이(가) ${to_name}에게`,
      text:  b.text  || '',
      relation: b.relation || 'anyone',
      emotions,
      voice_url,
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

// ─── Data Moat 분석 API ────────────────────────
app.get('/api/data/overview', async (req, res) => {
  try {
    const [storiesRes, broadcastsRes, lettersRes] = await Promise.all([
      supabase.from('stories').select('id,created_at,audience_type,category,emotions,has_voice,ai_emotion'),
      supabase.from('api_cost').select('*').order('created_at', { ascending: false }),
      supabase.from('letters').select('id,created_at,relation,emotions,broadcast_at'),
    ]);

    const stories    = storiesRes.data  || [];
    const broadcasts = broadcastsRes.data || [];
    const letters    = lettersRes.data  || [];

    // 감정 분포
    const emotionMap = {};
    [...stories, ...letters].forEach(r => {
      (r.emotions||[]).forEach(e => { emotionMap[e] = (emotionMap[e]||0) + 1; });
    });
    broadcasts.forEach(b => {
      (b.detected_emotions||[]).forEach(e => { emotionMap[e] = (emotionMap[e]||0) + 1; });
    });

    // 전환율 (사연→DJ 방송)
    const storiesWithBroadcast = broadcasts.filter(b => b.story_id).length;
    const conversionRate = stories.length > 0 ? (storiesWithBroadcast / stories.length * 100).toFixed(1) : 0;

    // 청취자 유형별 분포
    const audienceMap = {};
    stories.forEach(s => { audienceMap[s.audience_type] = (audienceMap[s.audience_type]||0) + 1; });

    // 음악 장르 분포
    const genreMap = {};
    broadcasts.forEach(b => { if(b.music_genre) genreMap[b.music_genre] = (genreMap[b.music_genre]||0) + 1; });

    // 톤 분포
    const toneMap = {};
    broadcasts.forEach(b => { if(b.dj_tone) toneMap[b.dj_tone] = (toneMap[b.dj_tone]||0) + 1; });

    // 시계열 (일별 사연 제출)
    const dailyMap = {};
    stories.forEach(s => {
      const d = s.created_at?.slice(0,10);
      if(d) dailyMap[d] = (dailyMap[d]||0) + 1;
    });

    // 가사 품질 평균
    const lyricsData = broadcasts.filter(b => b.lyrics_lines > 0);
    const avgLyricsLines = lyricsData.length
      ? (lyricsData.reduce((sum,b) => sum + (b.lyrics_lines||0), 0) / lyricsData.length).toFixed(1)
      : 0;

    // 총 비용
    const totalCost = broadcasts.reduce((s,b) => s + (Number(b.total_cost_usd)||0), 0);

    // 키워드 빈도 (사연 텍스트에서)
    const keywordMap = {};
    const stopWords = new Set(['이','그','저','것','수','등','및','또','로','의','가','을','를','은','는','에','서','와','과','도','으로','에서','이다','있다','하다','되다']);
    stories.forEach(s => {
      (s.text||'').replace(/[^가-힣a-zA-Z\s]/g,'').split(/\s+/).forEach(w => {
        if(w.length >= 2 && !stopWords.has(w)) keywordMap[w] = (keywordMap[w]||0) + 1;
      });
    });
    const topKeywords = Object.entries(keywordMap)
      .sort((a,b) => b[1]-a[1]).slice(0,30)
      .map(([word, count]) => ({ word, count }));

    res.json({
      summary: {
        total_stories: stories.length,
        total_broadcasts: broadcasts.length,
        total_letters: letters.length,
        letters_with_broadcast: letters.filter(l => l.broadcast_at).length,
        conversion_rate: conversionRate,
        total_cost_usd: totalCost.toFixed(4),
        avg_lyrics_lines: avgLyricsLines,
        has_voice_rate: stories.length ? (stories.filter(s=>s.has_voice).length/stories.length*100).toFixed(1) : 0,
      },
      emotion_distribution: Object.entries(emotionMap).sort((a,b)=>b[1]-a[1]).map(([k,v])=>({name:k,count:v})),
      audience_distribution: Object.entries(audienceMap).map(([k,v])=>({name:k,count:v})),
      genre_distribution: Object.entries(genreMap).sort((a,b)=>b[1]-a[1]).map(([k,v])=>({name:k,count:v})),
      tone_distribution: Object.entries(toneMap).sort((a,b)=>b[1]-a[1]).map(([k,v])=>({name:k,count:v})),
      daily_submissions: Object.entries(dailyMap).sort().map(([date,count])=>({date,count})),
      top_keywords: topKeywords,
      recent_broadcasts: broadcasts.slice(0,10).map(b => ({
        id: b.id, story_name: b.story_name, dj_name: b.dj_name,
        dj_tone: b.dj_tone, music_genre: b.music_genre,
        total_cost_usd: b.total_cost_usd, lyrics_lines: b.lyrics_lines,
        detected_emotions: b.detected_emotions, created_at: b.created_at,
      })),
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LLM 튜닝용 데이터셋 export ────────────────
app.get('/api/data/export/dataset', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('api_cost')
      .select('story_text,sec_opening,sec_story,sec_reflection,sec_gift_music,sec_closing,lyrics,suno_gift,detected_emotions,dj_tone,music_genre')
      .not('full_text', 'is', null)
      .order('created_at', { ascending: false });
    if(error) throw error;

    // JSONL 형태 (LLM fine-tuning 표준 포맷)
    const dataset = (data||[]).map(r => ({
      input: {
        story: r.story_text,
        tone: r.dj_tone,
        genre: r.music_genre,
        emotions: r.detected_emotions,
      },
      output: {
        opening: r.sec_opening,
        story_intro: r.sec_story,
        reflection: r.sec_reflection,
        gift_music: r.sec_gift_music,
        closing: r.sec_closing,
        lyrics: r.lyrics,
        suno_prompt: r.suno_gift,
      }
    })).filter(r => r.input.story && r.output.opening);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="blossom_dataset.jsonl"');
    res.send(dataset.map(d => JSON.stringify(d)).join('\n'));
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

// ─── 시뮬레이션 전용 AI 텍스트 생성 프록시 ──────────
app.post('/api/sim/generate', async (req, res) => {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY 미설정' });

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt 없음' });

  try {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
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
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.[0]?.text || '';
          res.json({ success: true, text });
        } catch(e) {
          res.status(500).json({ error: '응답 파싱 오류' });
        }
      });
    });
    apiReq.on('error', e => res.status(500).json({ error: e.message }));
    apiReq.write(body);
    apiReq.end();
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});
