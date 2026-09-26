// Voice messages: tap the mic to record, then send or discard.
// Records AAC in MP4 where the browser can (plays on iPhone and Android alike),
// otherwise Opus in WebM.

import { toast, announce } from './common.js';
import { formatDuration } from './media.js';

const $ = (id) => document.getElementById(id);

const PREFERRED = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
const MAX_MS = 15 * 60 * 1000;
const MIN_MS = 500;

let recorder = null;
let stream = null;
let chunks = [];
let startedAt = 0;
let timer = null;
let starting = false;
let onDone = null;

function pickType() {
  if (typeof MediaRecorder === 'undefined') return null;
  if (!MediaRecorder.isTypeSupported) return '';
  return PREFERRED.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

/** The type the server stores: no codec parameters. */
function baseType(type) {
  const t = (type || '').split(';')[0].trim().toLowerCase();
  if (t === 'audio/x-m4a' || t === 'audio/m4a') return 'audio/mp4';
  if (t === 'video/webm') return 'audio/webm';
  if (t === 'video/mp4') return 'audio/mp4';
  return t || 'audio/webm';
}

export function isRecording() {
  return !!recorder || starting;
}

function setUi(on) {
  const composer = $('composer');
  composer.classList.toggle('is-recording', on);
  $('recording').hidden = !on;
  for (const id of ['attach-button', 'message-input', 'record-button', 'send-button']) $(id).hidden = on;
  $('record-time').textContent = '0:00';
}

function tick() {
  const ms = Date.now() - startedAt;
  $('record-time').textContent = formatDuration(Math.floor(ms / 1000) * 1000);
  if (ms >= MAX_MS) stop(true);
}

function releaseMic() {
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null;
}

async function start() {
  if (isRecording()) return;
  const type = pickType();
  if (type === null || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("This browser can't record voice messages.");
    return;
  }
  starting = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    starting = false;
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    const missing = err && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError');
    toast(
      denied
        ? 'TealTalk isn’t allowed to use the microphone. Allow it in your browser or phone settings to send voice messages.'
        : missing
          ? 'No microphone found.'
          : 'Could not start recording.',
      6000,
    );
    return;
  }
  if (!starting) {
    releaseMic(); // cancelled while the permission prompt was up
    return;
  }
  try {
    recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  } catch {
    try {
      recorder = new MediaRecorder(stream);
    } catch {
      starting = false;
      releaseMic();
      toast("This browser can't record voice messages.");
      return;
    }
  }
  starting = false;
  chunks = [];
  recorder.addEventListener('dataavailable', (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  });
  recorder.start(250);
  startedAt = Date.now();
  setUi(true);
  timer = setInterval(tick, 250);
  announce('Recording');
  $('record-send').focus({ preventScroll: true });
}

/** Stop; `send` false throws the recording away. */
function stop(send) {
  starting = false;
  if (!recorder) return;
  const rec = recorder;
  recorder = null;
  clearInterval(timer);
  const durationMs = Date.now() - startedAt;
  setUi(false);
  const finish = () => {
    releaseMic();
    const type = rec.mimeType || (chunks[0] && chunks[0].type) || '';
    const blob = new Blob(chunks, { type: baseType(type) });
    chunks = [];
    if (!send) {
      announce('Voice message discarded');
      return;
    }
    if (durationMs < MIN_MS || !blob.size) {
      toast('Too short. Tap the mic, speak, then tap send.');
      return;
    }
    onDone(blob, baseType(type), durationMs);
  };
  if (rec.state === 'inactive') finish();
  else {
    rec.addEventListener('stop', finish, { once: true });
    rec.stop();
  }
  $('record-button').focus({ preventScroll: true });
}

export function cancelRecording() {
  stop(false);
}

export function initRecorder({ onRecorded }) {
  onDone = onRecorded;
  $('record-button').addEventListener('click', start);
  $('record-cancel').addEventListener('click', () => stop(false));
  $('record-send').addEventListener('click', () => stop(true));
  $('recording').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      stop(false);
    }
  });
}
