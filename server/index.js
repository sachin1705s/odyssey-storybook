import express from 'express';
import multer from 'multer';
import { GoogleGenAI } from '@google/genai';
import 'dotenv/config';

const app = express();
app.use(express.json({ limit: '1mb' }));
const upload = multer({ storage: multer.memoryStorage() });

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('Missing GEMINI_API_KEY in environment.');
}

const ai = new GoogleGenAI({ apiKey });
const model = 'gemini-2.0-flash';

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/stt', upload.single('audio'), async (req, res) => {
  try {
    if (!apiKey) {
      return res.status(500).json({ error: 'Missing GEMINI_API_KEY on server.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Missing audio file.' });
    }

    const audioBase64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'audio/webm';

    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Transcribe the spoken words only. Return plain text with no extra words.' },
            {
              inlineData: {
                mimeType,
                data: audioBase64
              }
            }
          ]
        }
      ]
    });

    const text = response.text?.trim() || '';
    return res.json({ text });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Transcription failed.' });
  }
});

app.post('/api/gesture', async (req, res) => {
  try {
    if (!apiKey) {
      return res.status(500).json({ error: 'Missing GEMINI_API_KEY on server.' });
    }
    const features = String(req.body?.features ?? '').trim();
    if (!features) {
      return res.status(400).json({ error: 'Missing features.' });
    }

    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                'Classify the gesture from the feature summary. Only return one of: hello, thumbs_up, victory, namaste, none. No extra words.'
            },
            { text: features }
          ]
        }
      ]
    });

    const text = response.text?.trim().toLowerCase() || 'none';
    const label = ['hello', 'thumbs_up', 'victory', 'namaste', 'none'].includes(text) ? text : 'none';
    return res.json({ label });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Gesture classification failed.' });
  }
});

app.post('/api/gesture-vision', async (req, res) => {
  try {
    if (!apiKey) {
      return res.status(500).json({ error: 'Missing GEMINI_API_KEY on server.' });
    }
    const image = String(req.body?.image ?? '').trim();
    const mimeType = String(req.body?.mimeType ?? 'image/jpeg').trim();
    if (!image) {
      return res.status(400).json({ error: 'Missing image.' });
    }

    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                'Classify the hand gesture in this image. Only return one of: hello, thumbs_up, victory, namaste, none. No extra words.'
            },
            {
              inlineData: {
                mimeType,
                data: image
              }
            }
          ]
        }
      ]
    });

    const text = response.text?.trim().toLowerCase() || 'none';
    const label = ['hello', 'thumbs_up', 'victory', 'namaste', 'none'].includes(text) ? text : 'none';
    return res.json({ label });
  } catch (error) {
    console.error(error);
    if (error?.status === 429) {
      return res.status(429).json({ error: 'Rate limited', retryAfterMs: 10000 });
    }
    return res.status(500).json({ error: 'Gesture classification failed.' });
  }
});

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`STT server listening on http://localhost:${port}`);
});
