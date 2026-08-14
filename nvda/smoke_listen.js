'use strict';
process.env.NVDA_RELAY_PORT=process.env.NVDA_RELAY_PORT||'6903';
const { attachNvdaAgent } = require('./bridge-nvda');
const { FakeNvda } = require('./fake_nvda');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function mockApp(){const routes={};const reg=m=>(p,...h)=>{routes[m+' '+p]=h;};return{get:reg('GET'),post:reg('POST'),async call(m,p,o={}){const hs=routes[m+' '+p];const req={body:o.body||{},query:o.query||{},get:()=>undefined};let sc=200,jo=null;const res={status(c){sc=c;return this;},json(x){jo=x;return this;}};for(let i=0;i<hs.length;i++){if(i<hs.length-1)await new Promise(r=>hs[i](req,res,r));else await hs[i](req,res);}return{statusCode:sc,body:jo};}};}
(async()=>{
  const app=mockApp();
  const h=attachNvdaAgent(app,{bridgeSecretOk:(r,p)=>p==='s',runNotify:async()=>({ok:true}),json:(rq,rs,n)=>n()});
  await sleep(400);
  const st=await app.call('POST','/nvda/start',{body:{secret:'s',mode:'listen',userId:'kade'}});
  console.log('start mode:',st.body.mode,'status:',st.body.status);
  const fake=new FakeNvda({host:'127.0.0.1',port:6903,key:st.body.channelKey,react:(e,api)=>{if(e.type==='connect'){api.speak('Firefox. App Store Connect. Heading level 1, App Privacy.');}},log:()=>{}});
  await fake.start(); await sleep(1500);
  const s2=await app.call('GET','/nvda/status',{query:{secret:'s',runId:st.body.runId}});
  console.log('status:',s2.body.status,'| heard:',JSON.stringify(s2.body.lastLines));
  const run=[...h.runs.values()][0];
  const keysSent=run.recorder.find('action').length;
  console.log('keys/actions sent:',keysSent);
  fake.close();
  const ok = s2.body.status==='listening' && s2.body.lastLines.some(l=>/App Privacy/.test(l)) && keysSent===0;
  console.log(ok?'LISTEN MODE: PASS (hears screen, zero keys)':'LISTEN MODE: FAIL');
  process.exit(ok?0:1);
})().catch(e=>{console.error(e);process.exit(1)});
