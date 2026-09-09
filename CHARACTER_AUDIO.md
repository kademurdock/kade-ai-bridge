# Optional character audio metadata — held Part 167

Current paired branches: `session167-character-cues` in bridge and fork.
`playBuffer` passes clip-local `opts.synthInput` into the WAV metadata sender.
Both streaming processUnit and one-shot speak supply the exact text synthesized;
mutable captions and subsequently queued directions are never timing sources.

Only a bounded sequence of leading %%%tags%%% becomes optional version-1
`cues: [{at:0,tag:'warm'}]`. Canonical values are allowlisted by the client.
Unknown/negated directions reset to neutral, interior tags get no invented time,
and raw text is never included. The eight-cue/160-character limits bound parsing.
Old clients ignore the optional field; missing/malformed cues leave audio intact.
Audio bytes, TTS options, chunking and scheduling stay unchanged.

Four Node checks exercise canonicalization, actual shared dispatcher, binary
identity and failed metadata sends. The fork's full call-dialog browser test
executes this sender over a real local WebSocket. No production deployment of
this branch was made; full paired live/device acceptance remains open.

## Original envelope

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
