const {test}=require('node:test');
const assert=require('node:assert/strict');
const {deliverReminder}=require('./reminder-delivery');
test('zero sends are preserved for chat; a failed fallback stays retryable without pushing again',async()=>{
  const sub={id:'r',userId:'u'};
  let pushes=0,removed=0,queues=0;
  const hooks={notify:async()=>{pushes++;return {ok:true,sent:0};},queueMissed:async()=>{queues++;throw Error('offline');},save(){},remove(){removed++;},isTestUser:()=>false};
  await assert.rejects(deliverReminder(sub,hooks));
  assert.equal(sub.deliveryStatus,'missed'); assert.equal(removed,0);
  hooks.queueMissed=async()=>{queues++;};
  assert.equal((await deliverReminder(sub,hooks)).queuedForChat,true);
  assert.equal(pushes,1); assert.equal(queues,2); assert.equal(removed,1);
});
test('accepted notifications are completed; test accounts invoke neither delivery channel',async()=>{
  let queued=0,removed=0;
  const hooks={notify:async()=>({ok:true,sent:1}),queueMissed:async()=>{queued++;},save(){},remove(){removed++;},isTestUser:()=>false};
  assert.equal((await deliverReminder({id:'r',userId:'u'},hooks)).sent,1);
  assert.equal(queued,0); assert.equal(removed,1);
  hooks.isTestUser=()=>true; hooks.notify=()=>{throw Error('must not send');};
  assert.equal((await deliverReminder({id:'r',userId:'u'},hooks)).testAccount,true);
  assert.equal(queued,0);
});
