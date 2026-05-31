/**
 * Voice Service — Speech Recognition + Audio Visualization
 * Captures microphone input, transcribes speech, and provides real-time audio data.
 */

// ─── State ─────────────────────────────────────────────────
let recognition = null;
let audioContext = null;
let analyser = null;
let microphone = null;
let dataArray = null;
let isListening = false;
let rafId = null;

// Callbacks
let onTranscript = null;
let onAudioData = null;
let onStateChange = null;
let onError = null;

const SAMPLE_SIZE = 64; // Number of frequency bins we expose

// ─── Audio Visualization Setup ─────────────────────────────

async function initAudio() {
  if (audioContext) return;

  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 128;
  analyser.smoothingTimeConstant = 0.85;

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  microphone = audioContext.createMediaStreamSource(stream);
  microphone.connect(analyser);

  dataArray = new Uint8Array(analyser.frequencyBinCount);
}

function startAudioLoop() {
  function loop() {
    if (!isListening) return;

    analyser.getByteFrequencyData(dataArray);

    // Downsample to SAMPLE_SIZE bins
    const bins = new Uint8Array(SAMPLE_SIZE);
    const binWidth = Math.floor(dataArray.length / SAMPLE_SIZE);
    for (let i = 0; i < SAMPLE_SIZE; i++) {
      let sum = 0;
      for (let j = 0; j < binWidth; j++) {
        sum += dataArray[i * binWidth + j];
      }
      bins[i] = sum / binWidth;
    }

    if (onAudioData) onAudioData(bins);
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);
}

function stopAudioLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

// ─── Speech Recognition Setup ──────────────────────────────

function initRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    throw new Error('Speech Recognition não suportado neste navegador');
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'pt-BR';

  recognition.onstart = () => {
    isListening = true;
    if (onStateChange) onStateChange('listening');
    startAudioLoop();
  };

  recognition.onresult = (event) => {
    let interim = '';
    let final = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        final += transcript;
      } else {
        interim += transcript;
      }
    }

    if (onTranscript) onTranscript({ final, interim });
  };

  recognition.onerror = (event) => {
    console.warn('Speech recognition error:', event.error);
    if (onError) onError(event.error);
    // Don't stop on no-speech, just keep listening
    if (event.error === 'no-speech') return;
    stop();
  };

  recognition.onend = () => {
    // Auto-restart if still supposed to be listening
    if (isListening) {
      try {
        recognition.start();
      } catch {
        stop();
      }
    }
  };
}

// ─── Public API ────────────────────────────────────────────

export const voiceService = {
  SAMPLE_SIZE,

  isSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  },

  async start(callbacks) {
    if (isListening) return;

    onTranscript = callbacks.onTranscript || null;
    onAudioData = callbacks.onAudioData || null;
    onStateChange = callbacks.onStateChange || null;
    onError = callbacks.onError || null;

    try {
      await initAudio();
      if (!recognition) initRecognition();
      recognition.start();
    } catch (err) {
      console.error('Voice start error:', err);
      if (onError) onError(err.message);
      throw err;
    }
  },

  stop() {
    isListening = false;
    stopAudioLoop();

    if (recognition) {
      try {
        recognition.stop();
      } catch {
        // ignore
      }
    }

    if (onStateChange) onStateChange('processing');

    // After a brief processing period, go idle
    setTimeout(() => {
      if (!isListening && onStateChange) onStateChange('idle');
    }, 1200);
  },

  isListening() {
    return isListening;
  },

  cleanup() {
    stop();
    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }
    if (microphone) {
      microphone.disconnect();
      microphone = null;
    }
    analyser = null;
    dataArray = null;
    recognition = null;
  },
};
