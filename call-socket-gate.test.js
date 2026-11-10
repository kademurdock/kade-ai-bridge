'use strict';
/* call-socket-gate.test.js — Nov 10 2026. The rules of the gate on the phone call socket: a
 * signed ticket, or Twilio's own word about the call id, and nothing else. Twilio's REST lookup is
 * a function handed in, so nothing here touches the network. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCallSocketGate, socketGateMode, socketGateStartupLine, sameNumber } = require('./call-socket-gate');

const SID = 'CA0123456789abcdef0123456789abcdef';
const SID2 = 'CAfedcba9876543210fedcba9876543210';
const FROM = '+14175550101';
const notFound = () => Object.assign(new Error('The requested resource was not found'), { status: 404, code: 20404 });

function gate(over = {}) {
  const lines = [];
  const log = { log: (s) => lines.push(s), warn: (s) => lines.push(s) };
  const clock = { t: 5_000_000 };
  const asked = [];
  const calls = over.calls || {};
  const g = createCallSocketGate({
    secret: 'unit-secret', mode: 'enforce', now: () => clock.t, log,
    fetchCall: over.fetchCall === null ? null : (over.fetchCall || (async (sid) => { asked.push(sid); if (!calls[sid]) throw notFound(); return calls[sid]; })),
    ...over.opts,
  });
  /* The whole decision the socket makes, as voice-stream.js makes it. */
  const decide = async (claim) => {
    let v = g.quick(claim);
    if (v.verdict === 'ask') v = await g.settle(claim, v.why);
    return { allowed: g.record(v, claim.callSid), v };
  };
  return { g, decide, lines, clock, asked };
}

test('the mode switch: only off, log and enforce are modes; anything else, and nothing, is log', () => {
  assert.equal(socketGateMode({}), 'log');
  assert.equal(socketGateMode({ CALL_SOCKET_GATE: 'enforce' }), 'enforce');
  assert.equal(socketGateMode({ CALL_SOCKET_GATE: ' OFF ' }), 'off');
  assert.equal(socketGateMode({ CALL_SOCKET_GATE: 'yes' }), 'log');
});

test('A REAL CALL: the ticket minted for a Twilio-signed webhook opens the socket at once, with no lookup', async () => {
  const { g, decide, asked, lines } = gate();
  const ticket = g.mint({ callSid: SID, from: FROM, signed: true });
  const quick = g.quick({ ticket, callSid: SID, from: FROM });
  assert.deepEqual(quick, { verdict: 'pass', how: 'ticket' }, 'decided without waiting for anything');
  assert.equal(g.record(quick, SID), true);
  assert.equal(asked.length, 0);
  assert.match(lines[0], /\[call-socket\] pass \(ticket\) call \.\.cdef/);
  assert.equal((await decide({ ticket: g.mint({ callSid: SID2, from: FROM, signed: true, outbound: true }), callSid: SID2, from: FROM, outbound: true })).allowed, true, 'outbound too');
});

test('THE FORGERY: no ticket and a call id Twilio has never heard of is refused, and the log never shows the number', async () => {
  const { decide, lines, g } = gate();
  const r = await decide({ callSid: SID, from: FROM });
  assert.equal(r.allowed, false);
  assert.match(lines.join('\n'), /refused: no ticket; Twilio does not know that call/);
  assert.doesNotMatch(lines.join('\n'), /4175550101/);
  assert.equal(g.stats().refused, 1);
});

test('a start message with no real call id is refused without asking anyone', async () => {
  const { g, asked } = gate();
  for (const callSid of [undefined, '', 'unknown', 'CA123', 'XX0123456789abcdef0123456789abcdef', `${SID}; drop`]) {
    assert.equal(g.quick({ callSid, from: FROM }).verdict, 'refuse', String(callSid));
  }
  assert.equal(asked.length, 0);
});

test('a ticket is for ONE call, ONE number, ONE direction, ONE socket, and a short while', async () => {
  const { g, clock } = gate();
  const t = g.mint({ callSid: SID, from: FROM, signed: true });
  assert.equal(g._ticketProblem(t, { callSid: SID2, from: FROM }), 'ticket is not for this call');
  assert.equal(g._ticketProblem(t, { callSid: SID, from: '+14175559999' }), 'ticket is not for this call');
  assert.equal(g._ticketProblem(t, { callSid: SID, from: FROM, outbound: true }), 'ticket is for the other direction');
  assert.equal(g._ticketProblem(t.slice(0, -2) + 'xx', { callSid: SID, from: FROM }), 'ticket is not for this call');
  assert.equal(g._ticketProblem('v1.zz.s', { callSid: SID, from: FROM }), 'ticket malformed');
  assert.equal(g._ticketProblem('', { callSid: SID, from: FROM }), 'no ticket');
  assert.equal(g._ticketProblem(t, { callSid: SID, from: FROM }), null);
  assert.equal(g.quick({ ticket: t, callSid: SID, from: FROM }).verdict, 'pass');
  assert.equal(g.quick({ ticket: t, callSid: SID, from: FROM }).why, 'ticket already used', 'a second socket with the same ticket');
  const late = g.mint({ callSid: SID2, from: FROM, signed: true });
  clock.t += 2 * 60 * 1000 + 1;
  assert.equal(g._ticketProblem(late, { callSid: SID2, from: FROM }), 'ticket expired');
});

test('a ticket changed to claim the signed flag does not check out', () => {
  const { g } = gate();
  const unsigned = g.mint({ callSid: SID, from: FROM, signed: false });
  const parts = unsigned.split('.');
  assert.equal(parts[2], '-');
  parts[2] = 's';
  assert.equal(g._ticketProblem(parts.join('.'), { callSid: SID, from: FROM }), 'ticket is not for this call');
});

test('a ticket from another process (a different secret) is not accepted', () => {
  const a = createCallSocketGate({ secret: 'one', mode: 'enforce' });
  const b = createCallSocketGate({ secret: 'two', mode: 'enforce' });
  assert.equal(b._ticketProblem(a.mint({ callSid: SID, from: FROM, signed: true }), { callSid: SID, from: FROM }), 'ticket is not for this call');
  // With no secret at all the key is random per process: its own tickets work, nobody else's do.
  const c = createCallSocketGate({ mode: 'enforce' });
  assert.equal(c._ticketProblem(c.mint({ callSid: SID, from: FROM, signed: true }), { callSid: SID, from: FROM }), null);
  assert.notEqual(createCallSocketGate({ mode: 'enforce' })._ticketProblem(c.mint({ callSid: SID, from: FROM, signed: true }), { callSid: SID, from: FROM }), null);
});

test('ANYONE CAN ASK /voice-ws FOR A TICKET: one minted for an unsigned webhook is not enough by itself', async () => {
  const { g, decide, lines } = gate();
  const forged = g.mint({ callSid: SID, from: FROM, signed: false });
  const r = await decide({ ticket: forged, callSid: SID, from: FROM });
  assert.equal(r.allowed, false, 'Twilio has no such call');
  assert.match(lines.join('\n'), /ticket was minted for an unsigned webhook; Twilio does not know that call/);
});

test('A REAL CALL WHOSE SIGNATURE DID NOT CHECK OUT (a webhook address mismatch): Twilio vouches and it passes', async () => {
  const { g, decide, lines, asked } = gate({ calls: { [SID]: { status: 'in-progress', from: FROM, to: '+18335550100' } } });
  const r = await decide({ ticket: g.mint({ callSid: SID, from: FROM, signed: false }), callSid: SID, from: FROM });
  assert.equal(r.allowed, true);
  assert.deepEqual(asked, [SID]);
  assert.match(lines.join('\n'), /pass \(twilio vouched; ticket was minted for an unsigned webhook\)/);
});

test('A REAL CALL WITH NO TICKET AT ALL (a restart between webhook and socket, a TwiML Bin): Twilio vouches and it passes', async () => {
  const { decide } = gate({ calls: { [SID]: { status: 'ringing', from: '(417) 555-0101', to: '+18335550100' } } });
  assert.equal((await decide({ callSid: SID, from: FROM })).allowed, true, 'number formats differ, the line is the same');
});

test('an outbound call is matched on the number that was dialled', async () => {
  const calls = { [SID]: { status: 'in-progress', from: '+18335550100', to: FROM } };
  assert.equal((await gate({ calls }).decide({ callSid: SID, from: FROM, outbound: true })).allowed, true);
  assert.equal((await gate({ calls }).decide({ callSid: SID, from: FROM, outbound: false })).allowed, false, 'claimed as inbound from the callee: no');
});

test('a real call id with somebody else\'s number is refused: the id of a live call does not let you be another caller', async () => {
  const { decide, lines } = gate({ calls: { [SID]: { status: 'in-progress', from: '+14175550202', to: '+18335550100' } } });
  assert.equal((await decide({ callSid: SID, from: FROM })).allowed, false);
  assert.match(lines.join('\n'), /the number does not match the call/);
});

test('a call that is over is not a call: an old call id is refused', async () => {
  for (const status of ['completed', 'busy', 'failed', 'no-answer', 'canceled']) {
    const { decide } = gate({ calls: { [SID]: { status, from: FROM } } });
    assert.equal((await decide({ callSid: SID, from: FROM })).allowed, false, status);
  }
});

test('a second socket for a call that is already connected is refused', async () => {
  const { g, decide } = gate({ calls: { [SID]: { status: 'in-progress', from: FROM } } });
  assert.equal((await decide({ ticket: g.mint({ callSid: SID, from: FROM, signed: true }), callSid: SID, from: FROM, alreadyLive: true })).allowed, false);
});

test('NEVER REFUSE A FAMILY CALL BECAUSE A CHECK FAILED: Twilio down, slow, or no credentials lets the call through, loudly', async () => {
  const down = gate({ fetchCall: async () => { throw Object.assign(new Error('service unavailable'), { status: 503 }); } });
  assert.equal((await down.decide({ callSid: SID, from: FROM })).allowed, true);
  assert.match(down.lines.join('\n'), /UNVERIFIED and let through \(no ticket; Twilio could not be asked \(503\)\)/);

  const slow = gate({ fetchCall: () => new Promise(() => {}), opts: { lookupTimeoutMs: 60 } });
  const t0 = Date.now();
  assert.equal((await slow.decide({ callSid: SID, from: FROM })).allowed, true);
  assert.ok(Date.now() - t0 < 1500, 'the call does not wait on a hung lookup');
  assert.match(slow.lines.join('\n'), /timed out/);

  const none = gate({ fetchCall: null });
  assert.equal((await none.decide({ callSid: SID, from: FROM })).allowed, true);
  assert.match(none.lines.join('\n'), /no Twilio credentials to check with/);
  assert.equal(none.g.stats().unverified, 1);
  assert.equal(none.g.stats().refused, 0);
});

test('LOG MODE (the default): the same forgery is let through and the line says what enforce would do', async () => {
  const { decide, lines, g } = gate({ opts: { mode: 'log' } });
  assert.equal((await decide({ callSid: SID, from: FROM })).allowed, true);
  assert.match(lines.join('\n'), /would refuse: no ticket; Twilio does not know that call .*mode log: let through/);
  assert.deepEqual([g.stats().wouldRefuse, g.stats().refused], [1, 0]);
});

test('OFF: nothing is checked, nothing is logged, nothing is asked', async () => {
  const { g, decide, lines, asked } = gate({ opts: { mode: 'off' } });
  assert.equal((await decide({ callSid: 'nonsense', from: FROM })).allowed, true);
  assert.equal(lines.length, 0);
  assert.equal(asked.length, 0);
  assert.equal(g.mode, 'off');
});

test('the log is capped, so a flood of forged sockets cannot fill it', async () => {
  const { decide, lines } = gate();
  for (let i = 0; i < 60; i++) await decide({ callSid: SID, from: FROM });
  assert.equal(lines.length, 20);
});

test('sameNumber: last ten digits, formats ignored, and a withheld number only matches a withheld number', () => {
  assert.equal(sameNumber('+14175550101', '4175550101'), true);
  assert.equal(sameNumber('+14175550101', '(417) 555-0101'), true);
  assert.equal(sameNumber('+14175550101', '+14175550102'), false);
  assert.equal(sameNumber('anonymous', 'unknown'), true);
  assert.equal(sameNumber('anonymous', '+14175550101'), false);
  assert.equal(sameNumber('', '+14175550101'), false);
});

test('the startup line names the mode, and says so when Twilio cannot be asked', () => {
  assert.equal(socketGateStartupLine({ mode: 'log', canAskTwilio: true }), '[call-socket] mode log on /ws/media');
  assert.match(socketGateStartupLine({ mode: 'enforce', canAskTwilio: false }), /NO Twilio credentials/);
  assert.match(socketGateStartupLine({ mode: 'off' }), /accepts any client/);
});
