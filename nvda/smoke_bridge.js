'use strict';
process.env.NVDA_RELAY_PORT=process.env.NVDA_RELAY_PORT||'6899';process.env.KADE_NVDA_TIERS=process.env.KADE_NVDA_TIERS||JSON.stringify({step:{provider:'moonshot',model:'kimi-k2.6',effort:'none'}});
const { attachNvdaAgent } = require('./bridge-nvda');
const { FakeNvda } = require('./fake_nvda');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makePage(){
  const els=[{role:'document',text:'App Store Connect. Document.'},{role:'heading',text:'Heading level 1, App Privacy'},{role:'text',text:'Data collection summary. Your app collects no data.'},{role:'heading',text:'Heading level 2, Publish your privacy details'},{role:'button',text:'Publish, button'}];
  let cur=0,publish='none';
  const at=()=>els[cur].text;
  const nextOf=r=>{for(let i=cur+1;i<els.length;i++)if(els[i].role===r){cur=i;return els[i].text;}return 'No more '+r+'s';};
  const prevOf=r=>{for(let i=cur-1;i>=0;i--)if(els[i].role===r){cur=i;return els[i].text;}return 'No previous '+r;};
  return (event,api)=>{
    if(event.type==='connect')return api.speak(els[0].text+' '+els[1].text);
    if(event.type==='paste')return api.speak(event.text+' Edit.');
    if(event.type!=='key')return;
    const c=event.chord;
    if(c==='enter'||c==='space'){ if(els[cur].role==='button'&&/Publish/i.test(els[cur].text)){ if(publish==='none'){publish='confirm';return api.speak('Are you sure you want to publish these changes? Publish, button.');} if(publish==='confirm'){publish='done';return api.speak('Published. Your App Privacy information is now visible on the App Store.');}} return api.speak('Activated. '+at()); }
    if(c==='h')return api.speak(nextOf('heading'));
    if(c==='shift+h')return api.speak(prevOf('heading'));
    if(c==='b'||c==='tab')return api.speak(nextOf('button'));
    if(c==='down'){cur=Math.min(cur+1,els.length-1);return api.speak(at());}
    if(c==='up'){cur=Math.max(cur-1,0);return api.speak(at());}
    return api.speak(at());
  };
}

function mockApp(){
  const routes={}; const reg=m=>(p,...h)=>{routes[m+' '+p]=h;};
  return { get:reg('GET'), post:reg('POST'),
    async call(m,p,opt={}){ const hs=routes[m+' '+p]; if(!hs)throw new Error('no route '+p);
      const req={body:opt.body||{},query:opt.query||{},get:()=>undefined};
      let sc=200,jo=null; const res={status(c){sc=c;return this;},json(o){jo=o;return this;}};
      for(let i=0;i<hs.length;i++){ if(i<hs.length-1){await new Promise(r=>hs[i](req,res,r));} else {await hs[i](req,res);} }
      return {statusCode:sc,body:jo}; } };
}

async function main(){
  if(!process.env.MOONSHOT_KEY){console.log('no MOONSHOT_KEY — skip');process.exit(0);}
  const app=mockApp(); const notifies=[];
  const deps={ bridgeSecretOk:(req,prov)=>prov==='testsecret', runNotify:async n=>{notifies.push(n);return{ok:true};}, json:(req,res,next)=>next() };
  const h=attachNvdaAgent(app,deps);
  await sleep(500);
  const start=await app.call('POST','/nvda/start',{body:{secret:'testsecret',goal:'Get to the Publish button for the App Privacy details and publish them.',userId:'kade'}});
  console.log('START status:',start.statusCode,'| runId:',start.body.runId,'| connect words present:',!!start.body.connect.words);
  const runId=start.body.runId, key=start.body.channelKey;
  const fake=new FakeNvda({host:'127.0.0.1',port:6899,key,react:makePage(),log:()=>{}});
  await fake.start();
  let done=false,confirms=0;
  for(let i=0;i<50;i++){ await sleep(700);
    const st=(await app.call('GET','/nvda/status',{query:{secret:'testsecret',runId}})).body;
    if(st.pendingConfirm){ await app.call('POST','/nvda/confirm',{body:{secret:'testsecret',runId,approve:true}}); confirms++; }
    if(['done','error','stopped'].includes(st.status)){done=true;break;} }
  const tr=(await app.call('GET','/nvda/transcript',{query:{secret:'testsecret',runId}})).body;
  const published=/Published\./.test(tr.transcript||'');
  const forbidden=await app.call('POST','/nvda/start',{body:{goal:'x'}});
  console.log('\n--- transcript tail ---\n'+(tr.transcript||'').split('\n').slice(-10).join('\n'));
  console.log('\nconfirms answered:',confirms,'| owner notifies:',notifies.length,'| no-secret gate:',forbidden.statusCode);
  fake.close(); if(h.relay) await h.relay.stop();
  const ok=published&&done&&forbidden.statusCode===403&&confirms>=1;
  console.log(ok?'\nBRIDGE SMOKE: PASS':'\nBRIDGE SMOKE: FAIL');
  process.exit(ok?0:1);
}
main().catch(e=>{console.error('fatal',e);process.exit(1)});
