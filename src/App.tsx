import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ConnectionStatus } from '@odysseyml/odyssey';
import slidesData from './data/slides.json';
import { OdysseyService, loadImageFile, type StreamState } from './lib/odyssey';
import './App.css';

interface Slide {
  id: string;
  title: string;
  subtitle: string;
  body: string;
  image: string;
  prompt: string;
  cta: string;
}

type GestureLabel = 'hello' | 'thumbs_up' | 'victory' | 'namaste';

type GestureResult = {
  label: GestureLabel | null;
  reason?: string;
};

const slides = slidesData as Slide[];
const STORAGE_KEY = 'odyssey_api_key';
const GESTURE_DELAY_MS = 1200;
const GEMINI_GESTURE_COOLDOWN_MS = 8000;
const VISION_POLL_MS = 1200;

const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  authenticating: 'Authenticating',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  connected: 'Connected',
  disconnected: 'Disconnected',
  failed: 'Failed'
};

const STREAM_LABELS: Record<StreamState, string> = {
  idle: 'Idle',
  starting: 'Starting stream',
  streaming: 'Streaming',
  ended: 'Ended',
  error: 'Error'
};

const GESTURE_PROMPTS: Record<GestureLabel, string> = {
  hello: 'do hello',
  thumbs_up: 'do thumbs up',
  victory: 'do victory sign',
  namaste: 'do namaste'
};

function App() {
  const envApiKey = import.meta.env.VITE_ODYSSEY_API_KEY as string | undefined;
  const [apiKey, setApiKey] = useState<string | undefined>(envApiKey);
  const [keyInput, setKeyInput] = useState('');
  const [index, setIndex] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [streamState, setStreamState] = useState<StreamState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isStreamingReady, setIsStreamingReady] = useState(false);
  const [speechText, setSpeechText] = useState('');
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [textPrompt, setTextPrompt] = useState('');
  const [gesturesEnabled, setGesturesEnabled] = useState(false);
  const [gestureStatus, setGestureStatus] = useState('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraRef = useRef<HTMLVideoElement | null>(null);
  const serviceRef = useRef<OdysseyService | null>(null);
  const requestIdRef = useRef(0);
  const detectFrameRef = useRef<number | null>(null);
  const pendingGestureRef = useRef<GestureLabel | null>(null);
  const pendingTimerRef = useRef<number | null>(null);
  const lastGeminiAtRef = useRef(0);
  const lastVisionCheckRef = useRef(0);
  const visionInFlightRef = useRef(false);
  const visionRetryAtRef = useRef(0);
  const lastCaptureAtRef = useRef(0);
  const [gestureLatency, setGestureLatency] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const slide = slides[index];
  const slideCount = slides.length;

  const statusSummary = useMemo(() => {
    const connection = CONNECTION_LABELS[connectionStatus];
    const stream = STREAM_LABELS[streamState];
    return `${connection} · ${stream}`;
  }, [connectionStatus, streamState]);

  useEffect(() => {
    if (envApiKey) {
      return;
    }
    const storedKey = localStorage.getItem(STORAGE_KEY);
    if (storedKey) {
      setApiKey(storedKey);
    }
  }, [envApiKey]);

  useEffect(() => {
    if (!apiKey) {
      setError('Missing Odyssey API key. Add it in the overlay or set VITE_ODYSSEY_API_KEY in .env.');
      return;
    }

    const service = new OdysseyService(apiKey);
    serviceRef.current = service;

    service
      .connect({
        onConnected: (stream) => {
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play().catch(() => undefined);
          }
        },
        onStatusChange: (status) => {
          setConnectionStatus(status);
        },
        onStreamStarted: () => {
          setStreamState('streaming');
          setIsStreamingReady(true);
        },
        onStreamEnded: () => {
          setStreamState('ended');
          setIsStreamingReady(false);
        },
        onStreamError: (reason, message) => {
          setStreamState('error');
          setIsStreamingReady(false);
          setError(`${reason}: ${message}`);
        },
        onError: (err) => {
          setStreamState('error');
          setIsStreamingReady(false);
          setError(err.message);
        }
      })
      .catch((err) => {
        setStreamState('error');
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      service
        .endStream()
        .catch(() => undefined)
        .finally(() => {
          service.disconnect().catch(() => undefined);
        });
    };
  }, [apiKey]);

  useEffect(() => {
    const service = serviceRef.current;
    if (!service || connectionStatus !== 'connected') {
      return;
    }

    const requestId = ++requestIdRef.current;
    setStreamState('starting');
    setIsStreamingReady(false);
    setError(null);

    const run = async () => {
      await service.endStream().catch(() => undefined);
      const file = await loadImageFile(slide.image, `${slide.id}.png`);
      if (requestIdRef.current !== requestId) {
        return;
      }
      await service.startStream({ prompt: slide.prompt, image: file, portrait: false });
    };

    run().catch((err) => {
      if (requestIdRef.current !== requestId) {
        return;
      }
      setStreamState('error');
      setIsStreamingReady(false);
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [connectionStatus, index, slide.id, slide.image, slide.prompt]);

  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stop();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    return () => {
      if (detectFrameRef.current) {
        cancelAnimationFrame(detectFrameRef.current);
      }
      cameraRef.current?.srcObject && (cameraRef.current.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
    };
  }, []);

  const handlePrev = () => {
    setIndex((prev) => (prev - 1 + slideCount) % slideCount);
  };

  const handleNext = () => {
    setIndex((prev) => (prev + 1) % slideCount);
  };

  const handleInteract = (promptOverride?: string) => {
    if (!serviceRef.current || !isStreamingReady) {
      return;
    }
    const prompt = (promptOverride ?? slide.cta).trim();
    if (!prompt) {
      return;
    }
    serviceRef.current.interact(prompt).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  const handleSaveKey = () => {
    const trimmed = keyInput.trim();
    if (!trimmed) {
      setError('Please enter a valid Odyssey API key.');
      return;
    }
    localStorage.setItem(STORAGE_KEY, trimmed);
    setApiKey(trimmed);
    setKeyInput('');
    setError(null);
  };

  const handleTextPromptSubmit = () => {
    const prompt = textPrompt.trim();
    if (!prompt) {
      return;
    }
    handleInteract(prompt);
    setTextPrompt('');
  };

  const handleTextPromptKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleTextPromptSubmit();
    }
  };

  const startRecording = async () => {
    if (isRecording || isTranscribing) {
      return;
    }
    setSpeechError(null);
    setSpeechText('');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);

      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        setIsRecording(false);
        setIsTranscribing(true);

        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        audioChunksRef.current = [];

        try {
          const form = new FormData();
          form.append('audio', blob, 'wish.webm');

          const response = await fetch('/api/stt', {
            method: 'POST',
            body: form
          });

          if (!response.ok) {
            throw new Error('Transcription failed');
          }

          const data = (await response.json()) as { text?: string };
          const transcript = (data.text ?? '').trim();
          if (transcript) {
            setSpeechText(transcript);
            handleInteract(transcript);
          } else {
            setSpeechError('We did not hear anything. Try again.');
          }
        } catch (err) {
          setSpeechError('Transcription failed. Try again.');
        } finally {
          setIsTranscribing(false);
          mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
          mediaStreamRef.current = null;
        }
      };

      setIsRecording(true);
      recorder.start();
    } catch (err) {
      setSpeechError('Microphone access was blocked.');
    }
  };

  const stopRecording = () => {
    if (!isRecording) {
      return;
    }
    mediaRecorderRef.current?.stop();
  };

  const scheduleGesturePrompt = (label: GestureLabel) => {
    pendingGestureRef.current = label;
    if (pendingTimerRef.current) {
      window.clearTimeout(pendingTimerRef.current);
    }
    pendingTimerRef.current = window.setTimeout(() => {
      if (pendingGestureRef.current !== label) {
        return;
      }
      const prompt = GESTURE_PROMPTS[label];
      handleInteract(prompt);
      setGestureStatus(`Gesture: ${label}`);
      pendingGestureRef.current = null;
    }, GESTURE_DELAY_MS);
  };

  const classifyGestureFromFrame = async (dataUrl: string) => {
    const now = Date.now();
    if (visionInFlightRef.current) {
      return;
    }
    if (now < visionRetryAtRef.current) {
      return;
    }
    if (now - lastGeminiAtRef.current < GEMINI_GESTURE_COOLDOWN_MS) {
      return;
    }
    visionInFlightRef.current = true;
    lastGeminiAtRef.current = now;

    const [meta, base64] = dataUrl.split(',');
    const mimeMatch = /data:(.*?);base64/.exec(meta);
    const mimeType = mimeMatch?.[1] ?? 'image/jpeg';

    try {
      const response = await fetch('/api/gesture-vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64, mimeType })
      });

      if (response.status === 429) {
        const data = (await response.json()) as { retryAfterMs?: number };
        visionRetryAtRef.current = Date.now() + (data.retryAfterMs ?? 10000);
        return;
      }
      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as { label?: string };
      const label = data.label as GestureLabel | undefined;
      if (label && GESTURE_PROMPTS[label]) {
        const latency = Date.now() - lastCaptureAtRef.current;
        setGestureLatency(latency);
        scheduleGesturePrompt(label);
      }
    } catch {
      // ignore
    } finally {
      visionInFlightRef.current = false;
    }
  };

  const startGestureLoop = () => {
    const camera = cameraRef.current;
    if (!camera) {
      return;
    }

    const detect = () => {
      if (!cameraRef.current) {
        return;
      }
      const now = performance.now();
      if (now - lastVisionCheckRef.current >= VISION_POLL_MS) {
        lastVisionCheckRef.current = now;
        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext('2d');
          if (ctx) {
            const width = camera.videoWidth || 320;
            const height = camera.videoHeight || 240;
            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(camera, 0, 0, width, height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
            if (isStreamingReady) {
              lastCaptureAtRef.current = Date.now();
              classifyGestureFromFrame(dataUrl);
            }
          }
        }
      }
      detectFrameRef.current = requestAnimationFrame(detect);
    };

    detectFrameRef.current = requestAnimationFrame(detect);
  };

  const enableGestures = async () => {
    if (gesturesEnabled) {
      return;
    }
    try {
      setGestureStatus('Starting camera...');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      if (cameraRef.current) {
        cameraRef.current.srcObject = stream;
        await cameraRef.current.play();
      }
      setGesturesEnabled(true);
      setGestureStatus('Gesture detection on');
      startGestureLoop();
    } catch (err) {
      setGestureStatus('Gesture setup failed');
    }
  };

  const disableGestures = () => {
    setGesturesEnabled(false);
    setGestureStatus('Gesture detection off');
    if (detectFrameRef.current) {
      cancelAnimationFrame(detectFrameRef.current);
      detectFrameRef.current = null;
    }
    if (cameraRef.current?.srcObject) {
      (cameraRef.current.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
      cameraRef.current.srcObject = null;
    }
  };

  const showKeyOverlay = !apiKey;

  return (
    <div className="app">
      <div className="video-layer">
        <div
          className="background-fallback"
          style={{ backgroundImage: `url(${slide.image})` }}
          aria-hidden
        />
        <video ref={videoRef} className="video-element" autoPlay playsInline muted />
        <div className="video-overlay" />
      </div>

      <div className="ui">
        <header className="top-bar">
          <div className="status-stack">
            <span className={`status-pill status-${connectionStatus}`}>{CONNECTION_LABELS[connectionStatus]}</span>
            <span className={`status-pill status-stream-${streamState}`}>{STREAM_LABELS[streamState]}</span>
          </div>
          <div className="status-line">{statusSummary}</div>
        </header>

        <main className="slide-shell" />

        <footer className="story-bar">
          <div className="story-text">
            <span className="story-index">
              {String(index + 1).padStart(2, '0')} / {String(slideCount).padStart(2, '0')}
            </span>
            <p>{slide.body}</p>
            {speechText ? <div className="speech-preview">Heard: “{speechText}”</div> : null}
            {speechError ? <div className="speech-preview speech-error">{speechError}</div> : null}
            {gestureStatus ? <div className="speech-preview">{gestureStatus}</div> : null}
            {gestureLatency !== null ? (
              <div className="speech-preview">Gesture latency: {gestureLatency}ms + 1200ms delay</div>
            ) : null}
            {error ? <div className="error-box">{error}</div> : null}
          </div>
          <div className="story-actions">
            <div className="prompt-input">
              <input
                type="text"
                value={textPrompt}
                onChange={(event) => setTextPrompt(event.target.value)}
                onKeyDown={handleTextPromptKeyDown}
                placeholder="Type a wish..."
                disabled={!isStreamingReady}
              />
              <button className="btn ghost" onClick={handleTextPromptSubmit} disabled={!isStreamingReady}>
                Send
              </button>
            </div>
            <button className="btn ghost" onClick={handlePrev}>
              Back
            </button>
            <button className="btn primary" onClick={handleNext}>
              Next
            </button>
            <button className="btn accent" onClick={() => handleInteract()} disabled={!isStreamingReady}>
              {slide.cta}
            </button>
            <button
              className={`btn mic ${isRecording ? 'listening' : ''}`}
              onMouseDown={startRecording}
              onMouseUp={stopRecording}
              onMouseLeave={stopRecording}
              onTouchStart={startRecording}
              onTouchEnd={stopRecording}
              disabled={!isStreamingReady || isTranscribing}
            >
              {isTranscribing ? 'Listening…' : isRecording ? 'Release to send' : 'Speak a wish'}
            </button>
            <button
              className={`btn ghost ${gesturesEnabled ? 'active' : ''}`}
              onClick={gesturesEnabled ? disableGestures : enableGestures}
              disabled={!isStreamingReady}
            >
              {gesturesEnabled ? 'Gestures on' : 'Enable gestures'}
            </button>
          </div>
        </footer>
      </div>

      <video ref={cameraRef} className="camera-feed" playsInline muted />

      {showKeyOverlay ? (
        <div className="key-overlay" role="dialog" aria-modal="true">
          <div className="key-card">
            <h2>Enter Odyssey API Key</h2>
            <p>We store it locally in your browser for this device.</p>
            <div className="key-input">
              <input
                type="password"
                value={keyInput}
                onChange={(event) => setKeyInput(event.target.value)}
                placeholder="ody_..."
                autoComplete="off"
              />
              <button className="btn primary" onClick={handleSaveKey}>
                Save & Connect
              </button>
            </div>
            <p className="key-hint">You can also set VITE_ODYSSEY_API_KEY in .env.</p>
          </div>
        </div>
      ) : null}
      <canvas ref={canvasRef} className="camera-feed" />
    </div>
  );
}

export default App;
