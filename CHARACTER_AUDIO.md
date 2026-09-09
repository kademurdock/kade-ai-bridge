# Optional character audio metadata — held Part 164

`voice-stream.js` sends `characterAudio(session.agentId, !opts.noCaption)` as
JSON immediately before its existing WAV binary frame. The message has type
`character-audio`, version 1, bounded agent id or null, and a boolean `speech`.
The current `noCaption` caller is the Game Parlor sound-effect path, so those
clips do not drive a character's mouth. Raw LIVE PCM belongs to the Spotter and
is deliberately excluded by the paired client.

This is paired with the fork's `session164-character-call` branch. Old clients
ignore the event. A failed metadata send never prevents the binary send. Audio
bytes, chunking, timing, caption text and synthesis are unchanged. No guessed
cue timestamps or private instructions are sent. No dependency is added.

Run `node --test character-audio.test.js` and `node --check voice-stream.js`.
Tests exercise the actual WAV sender, including preservation of binary identity
and metadata-send failure. This branch is held, not deployed; see the fork's
`CHARACTER_CALL.md` for remaining artwork, UI and release acceptance.
