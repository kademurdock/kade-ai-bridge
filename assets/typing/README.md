# Typing-sound drop folder

Drop one or more keyboard/typing-sound `.wav` files in here and redeploy --
no code changes needed. They'll automatically replace the procedurally
generated placeholder typing sound used during the "thinking" gap on phone
calls.

Requirements: 16-bit PCM WAV, mono or stereo (stereo gets downmixed), any
sample rate (gets resampled to 8kHz for telephony). A few seconds long is
plenty since it loops. If you drop in more than one file, the bridge picks
one at random each time it needs to play, so multiple variants = more
variety instead of one obvious loop.
