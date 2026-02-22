import Busboy from 'busboy';
import { GoogleGenAI } from '@google/genai';

const model = 'gemini-2.0-flash';

const readMultipartAudio = (req) =>
  new Promise((resolve, reject) => {
    try {
      const bb = Busboy({ headers: req.headers, limits: { fileSize: 15 * 1024 * 1024 } });
      let fileBuffer = Buffer.alloc(0);
      let mimeType = 'audio/webm';

      bb.on('file', (_name, file, info) => {
        mimeType = info?.mimeType || info?.mimetype || mimeType;
        const chunks = [];
        file.on('data', (data) => chunks.push(data));
        file.on('end', () => {
          fileBuffer = Buffer.concat(chunks);
        });
      });

      bb.on('error', reject);
      bb.on('finish', () => {
        resolve({ buffer: fileBuffer, mimeType });
      });

      req.pipe(bb);
    } catch (err) {
      reject(err);
    }
  });

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing GEMINI_API_KEY on server.' });
  }

  try {
    const { buffer, mimeType } = await readMultipartAudio(req);
    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ error: 'Missing audio file.' });
    }

    const audioBase64 = buffer.toString('base64');
    const ai = new GoogleGenAI({ apiKey });
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
    return res.status(200).json({ text });
  } catch (_error) {
    return res.status(500).json({ error: 'Transcription failed.' });
  }
}
