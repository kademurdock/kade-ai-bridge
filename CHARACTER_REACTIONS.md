# Character audio metadata — Part 175

Every web/native WAV is preceded immediately by `character-audio` version 1. Speech paths explicitly capture the actual synthesis input and originating agent before awaiting a provider. Only leading authored speech directions are mapped to a bounded expression enum; captions and ordinary prose are not emotion input. The packet holds no transcript. Game effects and unidentified audio emit a non-speech packet so a previous speaker cannot leak into them. A presentation-send exception cannot block the existing WAV send. Phone/mulaw bytes and timing are unchanged. Old clients ignore the optional packet.

The matching native implementation is in kade-ai-native `Sources/CharacterPerformance.swift`. Both use the same `character-cues.json` / `CharacterMotionTests/cues.json` fixtures. Native samples its real output/player clock rather than treating an early server state as audible completion. Production model and TTS requests are unchanged; this adds no generation request or GPU/video service.

Tests execute the actual WAV sender and confirm metadata ordering, unchanged binary identity, non-speech clearing, and audio continuation after a metadata error. Run `node --test character-audio.test.js voice-stream.carry.test.js voice-stream.part110.test.js`.
