"""Natural-sounding speech for Jarvis, on your Mac, free: Kokoro (open-weight, Apache-2.0) via kokoro-onnx.

The dashboard server starts this once and keeps it running so the model stays loaded. Protocol: one JSON object
per line on stdin, {"text", "voice", "speed", "out"}; it writes a WAV to "out" and answers {"ok": true} or
{"error": "..."} on stdout. Installed by `fleet tts install` into ~/.fleet/tts.
"""
import json
import os
import sys

import soundfile as sf
from kokoro_onnx import Kokoro

HERE = os.environ.get('FLEET_TTS_DIR', os.path.expanduser('~/.fleet/tts'))
kokoro = Kokoro(os.path.join(HERE, 'kokoro-v1.0.onnx'), os.path.join(HERE, 'voices-v1.0.bin'))
VOICES = set(kokoro.get_voices())
print(json.dumps({'ready': True, 'voices': sorted(VOICES)}), flush=True)

for line in sys.stdin:
    try:
        req = json.loads(line)
        voice = req.get('voice') if req.get('voice') in VOICES else 'bm_george'
        lang = 'en-gb' if voice[:1] == 'b' else 'en-us'
        samples, rate = kokoro.create(req['text'], voice=voice, speed=float(req.get('speed') or 1.0), lang=lang)
        sf.write(req['out'], samples, rate)
        print(json.dumps({'ok': True}), flush=True)
    except Exception as e:  # one bad request shouldn't take the voice down
        print(json.dumps({'error': str(e)}), flush=True)
