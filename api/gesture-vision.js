import { GoogleGenAI } from '@google/genai';

const model = 'gemini-2.0-flash';

const readJson = async (req) => {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
  }
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing GEMINI_API_KEY on server.' });
  }

  const body = await readJson(req);
  const image = String(body.image ?? '').trim();
  const mimeType = String(body.mimeType ?? 'image/jpeg').trim();
  if (!image) {
    return res.status(400).json({ error: 'Missing image.' });
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
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
    return res.status(200).json({ label });
  } catch (error) {
    if (error?.status === 429) {
      return res.status(429).json({ error: 'Rate limited', retryAfterMs: 10000 });
    }
    return res.status(500).json({ error: 'Gesture classification failed.' });
  }
}
