'use strict';
/* outbound-greeting.test.js — Nov 14 2026. What a person hears first when a character calls out
 * (outbound-greeting.js, used by server.js /outbound-call). Pure functions, no network. */
const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('./outbound-greeting');

// Kade's test call, the purpose the model wrote (from the Nov 14 logs).
const HEMP = "Kade wants to know if you're running any sales or clearance deals on hemp products right now, especially THCP vapes and disposables. If so, what do you have in stock and what are the prices?";
const HER_ROW = { name: 'Kade', agentId: 'agent_kiana' };
const base = { agentName: 'Kiana', userName: 'Kade Murdock', purpose: HEMP, calleeName: null, agentId: 'agent_kiana' };

test("KADE'S TEST: her own number called as a business says it is an A I assistant, for whom, the recording notice, then one plain question", () => {
  const r = g.composeOutboundGreeting({ ...base, calleeRec: HER_ROW, business: true });
  assert.equal(r.tier, 'stranger');
  assert.equal(r.business, true);
  assert.equal(r.disclosed, true);
  assert.equal(r.greeting,
    "Hi, this is Kiana, an A I assistant calling for Kade, one of our users. This call may be recorded. " +
    "I'm calling to ask if you're running any sales or clearance deals on hemp products right now.");
  assert.equal(r.greeting2, null);
  assert.equal(/wants to know/.test(r.greeting), false, 'never "Kade wants to know" to a stranger');
  assert.ok(r.greeting.length < 200, `short: ${r.greeting.length} characters (the old stranger greeting for this purpose was about 378)`);
  // The question starts where askAt says (voice-stream.js times nods against it).
  assert.equal(r.greeting.slice(Math.round(r.askAt * r.greeting.length)).startsWith("I'm calling to ask"), true);
});

test('the AI-assistant words come before the question in every stranger greeting, one part or two', () => {
  const shapes = [
    g.composeOutboundGreeting({ ...base, calleeRec: null }),
    g.composeOutboundGreeting({ ...base, calleeRec: HER_ROW, disclose: true }),
    g.composeOutboundGreeting({ ...base, purpose: 'ask whether you are open Sunday', calleeName: "Tony's Pizza", calleeRec: null }),
  ];
  for (const r of shapes) {
    const first = r.greeting;
    assert.match(first, /^Hi, this is Kiana, an A I assistant calling for Kade, one of our users\./, 'the first thing a stranger hears');
    const all = `${r.greeting} ${r.greeting2 || ''}`;
    assert.ok(all.indexOf('This call may be recorded.') > all.indexOf('A I assistant'));
    assert.ok(all.indexOf("I'm calling") > all.indexOf('This call may be recorded.'), 'the question comes last');
  }
});

test('the two-part stranger greeting: who and for whom, "is this X?", then the notice and the question', () => {
  const r = g.composeOutboundGreeting({ ...base, purpose: 'ask whether you are open on Sunday', calleeName: "Tony's Pizza", calleeRec: null });
  assert.equal(r.greeting, "Hi, this is Kiana, an A I assistant calling for Kade, one of our users. Is this Tony's Pizza?");
  assert.equal(r.greeting2, "Thanks! This call may be recorded. I'm calling to ask whether you are open on Sunday.");
  assert.equal(r.greeting.slice(Math.round(r.askAt * r.greeting.length)), "Is this Tony's Pizza?");
  assert.equal(r.greeting2.slice(Math.round(r.ask2At * r.greeting2.length)), "I'm calling to ask whether you are open on Sunday.");
});

test('FAMILY GREETINGS ARE WORD FOR WORD what they were (own character, family, and the two-part "is this ...?")', () => {
  const purpose = 'Kade wants to know if you are coming Sunday';
  const framed = g.framePurpose(purpose);
  const own = g.composeOutboundGreeting({ ...base, purpose, calleeRec: HER_ROW });
  assert.equal(own.tier, 'own');
  assert.equal(own.business, false);
  assert.equal(own.greeting, `Hi! It's Kiana! ${framed}`);
  const fam = g.composeOutboundGreeting({ ...base, purpose, calleeRec: { name: 'Holly', agentId: 'agent_harley' } });
  assert.equal(fam.tier, 'family');
  assert.equal(fam.greeting, `Hi! It's Kiana — Kade's A I. ${framed}`);
  const two = g.composeOutboundGreeting({ ...base, purpose, calleeName: 'Holly', calleeRec: { name: 'Holly', agentId: 'agent_harley' } });
  assert.equal(two.greeting, 'Hi — is this Holly?');
  assert.equal(two.greeting2, `It's Kiana — Kade's A I. ${framed}`);
  // And Kade's own test without the business flag still takes the friend greeting (the July 12 tiers).
  const herTest = g.composeOutboundGreeting({ ...base, calleeRec: HER_ROW });
  assert.equal(herTest.greeting, `Hi! It's Kiana! ${g.framePurpose(HEMP)}`);
});

test('who gets the business rules: errands and business:true always, an unregistered number unless the chat said business:false', () => {
  const pick = (o) => g.composeOutboundGreeting({ ...base, ...o });
  assert.deepEqual([pick({ calleeRec: null }).tier, pick({ calleeRec: null }).business], ['stranger', true]);
  assert.deepEqual([pick({ calleeRec: null, business: false }).tier, pick({ calleeRec: null, business: false }).business], ['stranger', false]);
  assert.deepEqual([pick({ calleeRec: HER_ROW, disclose: true }).tier, pick({ calleeRec: HER_ROW, disclose: true }).business], ['stranger', true]);
  assert.deepEqual([pick({ calleeRec: HER_ROW, business: false }).tier, pick({ calleeRec: HER_ROW, business: false }).business], ['own', false]);
  assert.deepEqual([pick({ calleeRec: HER_ROW }).tier, pick({ calleeRec: HER_ROW }).business], ['own', false]);
});

test('a placeholder name is never spoken: "calling for one of our users"', () => {
  for (const userName of ['a Kade-AI user', '', null, 'a customer']) {
    const r = g.composeOutboundGreeting({ ...base, userName, calleeRec: null, purpose: 'What time do you close tonight?' });
    assert.equal(r.greeting, "Hi, this is Kiana, an A I assistant calling for one of our users. This call may be recorded. I've got a quick question — what time do you close tonight?", String(userName));
  }
  assert.equal(g.firstNameOf('Kade Murdock'), 'Kade');
  assert.equal(g.firstNameOf('Amber'), 'Amber');
});

test('strangerAsk: the question first, in plain words', () => {
  const ask = (p) => g.strangerAsk(p, 'Kade');
  assert.equal(ask('Kade wants to know whether the pharmacy has her refill ready'), "I'm calling to ask whether the pharmacy has her refill ready.");
  assert.equal(ask('Kade is wondering if you deliver'), "I'm calling to ask if you deliver.");
  assert.equal(ask('she would like to find out your Sunday hours'), "I'm calling to ask about your Sunday hours.");
  assert.equal(ask('Kade wants to know what time you close'), "I'm calling to ask what time you close.");
  assert.equal(ask('Kade needs to ask about her order'), "I'm calling to ask about her order.");
  assert.equal(ask('ask what time you close'), "I'm calling to ask what time you close.");
  assert.equal(ask('Are you open on Thanksgiving?'), "I've got a quick question — are you open on Thanksgiving?");
  // A long purpose keeps its first question; "Dr." does not end it.
  assert.equal(ask('Ask if Dr. Patel has any openings Tuesday afternoon for a new patient, and whether they take Medicare. Also ask about parking.'),
    "I'm calling to ask if Dr. Patel has any openings Tuesday afternoon for a new patient, and whether they take Medicare.");
  // A first sentence that is only background keeps the question after it.
  assert.match(ask('Kade is planning a big birthday party for about twenty people next month at her house. Do you cater, and what would it cost per person?'), /Do you cater/);
  // Kade's own: first question, cut before the "especially" tail.
  assert.equal(ask(HEMP), "I'm calling to ask if you're running any sales or clearance deals on hemp products right now.");
});

test('framePurpose is unchanged (moved from server.js)', () => {
  assert.equal(g.framePurpose('is your refrigerator running?'), "I've got a quick question — is your refrigerator running?");
  assert.equal(g.framePurpose('fun test call from her big sister'), "I'm calling about fun test call from her big sister.");
  assert.equal(g.framePurpose('she wants to say hi'), "I'm calling because she wants to say hi.");
  assert.equal(g.framePurpose("I'm calling to check on the order"), "I'm calling to check on the order.");
  assert.equal(g.framePurpose(''), "I'm calling on their behalf");
});

test('a stranger\'s voicemail says the same who and for whom, and the question in the past', () => {
  assert.equal(g.strangerVoicemail({ agentName: 'Kiana', userName: 'Kade Murdock', purpose: HEMP }),
    "Hi, this is Kiana, an A I assistant calling for Kade, one of our users. I was calling to ask if you're running any sales or clearance deals on hemp products right now. Sorry I missed you. Bye!");
  assert.equal(g.strangerVoicemail({ agentName: 'Kiana', userName: 'Kade', purpose: 'What time do you close?' }),
    'Hi, this is Kiana, an A I assistant calling for Kade, one of our users. I had a quick question: what time do you close? Sorry I missed you. Bye!');
});
