importScripts('db.js','opal-downloads.js');
const isOwnPage = sender => !sender.tab || (sender.url||'').startsWith(chrome.runtime.getURL(''));
function sourceHost(sender){try{return new URL(sender.url||sender.tab?.url||'').hostname || new URL(sender.tab?.url||'').hostname;}catch{return '';}}
const flowActions=new Set(['claimJob','heartbeat','completeJob','failJob','releaseJob','interruptJob','getStats','checkJobs']);
async function handle(msg,sender){
  if(msg.type==='OPAL_DOWNLOAD_STATUS'){if(sourceHost(sender)!=='opal.google')throw new Error('来源不是 Opal。');return opalDownloadStatus(msg.url);}
  if(msg.type==='OPAL_DOWNLOAD'){if(sourceHost(sender)!=='opal.google')throw new Error('来源不是 Opal。');return opalDownload(msg.url,msg.dataUrl,msg.repair===true);}
  if(msg.type==='PAGE_SETTINGS')return pageSettings(msg,sender);
  if(msg.type==='UPLOAD_ROWS'){
    if(sourceHost(sender)!=='opal.google')throw new Error('来源不是 Opal。');
    return LocalQueue.dispatch('uploadRows',{rows:msg.rows,source:'Opal'});
  }
  if(msg.type==='FLOW_DB'){
    if(!['flow.google.com','labs.google'].includes(sourceHost(sender))||!sender.tab)throw new Error('来源不是 Flow。');
    if(!flowActions.has(msg.action))throw new Error('不支持的 Flow 操作。');
    const worker=String(sender.tab.id)+':'+String(sender.documentId||msg.payload?.workerId||'');
    return LocalQueue.dispatch(msg.action,msg.payload||{},worker);
  }
  if(msg.type==='LOCAL_DB'){
    if(!isOwnPage(sender))throw new Error('请从插件数据页面操作。');
    return LocalQueue.dispatch(msg.action,msg.payload||{});
  }
  if(msg.type==='FRAME_STATE'){
    if(sourceHost(sender)!=='opal.google')return {ok:false};
    await pageSettings({action:'set',values:{opalExtractorLastState:msg.state,opalExtractorLastDetail:msg.detail||'',opalExtractorLastChangedAt:new Date().toISOString(),opalExtractorActiveFrameId:sender.frameId,opalExtractorTabId:sender.tab?.id}},sender);
    const badge={RUNNING:'RUN',AUTO_STARTING:'AUTO',SUCCESS:'OK',FAILED:'ERR',STOPPED_NO_RESULT:'?',IDLE:''}[msg.state]||'';
    if(sender.tab?.id){await chrome.action.setBadgeText({tabId:sender.tab.id,text:badge});await chrome.action.setBadgeBackgroundColor({tabId:sender.tab.id,color:'#087f69'});}
    return {ok:true};
  }
  if(msg.type==='STOP_ALL_FLOW'){
    if(!isOwnPage(sender))throw new Error('无权限。');
    const tabs=await chrome.tabs.query({url:['https://flow.google.com/*','https://labs.google/*']});
    const results=await Promise.all(tabs.map(t=>chrome.tabs.sendMessage(t.id,{action:'stopRunner'}).catch(()=>null)));
    return {ok:true,count:results.filter(r=>r?.ok).length};
  }
  throw new Error('未知插件消息。');
}
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
  if(!['OPAL_DOWNLOAD_STATUS','OPAL_DOWNLOAD','PAGE_SETTINGS','UPLOAD_ROWS','FLOW_DB','LOCAL_DB','FRAME_STATE','STOP_ALL_FLOW'].includes(msg?.type))return;
  handle(msg,sender).then(reply).catch(e=>reply({ok:false,error:e?.message||String(e)}));return true;
});

// Session storage is private to the extension service worker and cleared by
// Chromium when the browser session ends. Never store automation in local.
const pageDefaults=()=>({opalExtractorEnabled:false,opalExtractorMode:'monitor',opalSavePrompts:true,opalSaveImages:true,opalAutoDownload:true,flowConcurrency:1,flowEnabled:false});
let settingsChain=Promise.resolve();
function pageSettings(msg,sender){
  const task=settingsChain.then(async()=>{
    const tabId=sender.tab?.id ?? (isOwnPage(sender)?msg.tabId:undefined);
    if(!Number.isInteger(tabId))throw new Error('请先打开 Flow 或 Opal 页面。');
    if(sender.tab&&!['opal.google','flow.google.com','labs.google'].includes(sourceHost(sender)))throw new Error('页面来源无效。');
    const tab=await chrome.tabs.get(tabId),key='page:'+tabId;
    const old=(await chrome.storage.session.get(key))[key];
    const settings={...pageDefaults(),...(old?.url===tab.url?old.settings:{})};
    if(msg.action==='set'){
      const values={...msg.values};
      if('flowConcurrency' in values){const n=Number(values.flowConcurrency);if(!Number.isInteger(n)||n<1||n>20)throw new Error('并发任务数请输入 1–20 的整数。');}
      Object.assign(settings,values);
    }else if(msg.action==='remove')for(const k of msg.keys||[])delete settings[k];
    else if(msg.action!=='get')throw new Error('设置操作无效。');
    await chrome.storage.session.set({[key]:{url:tab.url,settings}});
    if(msg.action==='set'&&['opalExtractorEnabled','opalExtractorMode','opalSavePrompts','opalSaveImages','opalAutoDownload','flowConcurrency'].some(k=>k in (msg.values||{}))){
      await chrome.tabs.sendMessage(tabId,{type:'PAGE_SETTINGS_CHANGED',settings}).catch(()=>{});
    }
    return {ok:true,settings};
  });
  settingsChain=task.catch(()=>{});return task;
}
chrome.tabs.onRemoved.addListener(tabId=>{settingsChain=settingsChain.then(()=>chrome.storage.session.remove('page:'+tabId)).catch(()=>{});});
chrome.tabs.onUpdated.addListener((tabId,change)=>{
  if(!change.url)return;
  settingsChain=settingsChain.then(async()=>{
    const key='page:'+tabId,old=(await chrome.storage.session.get(key))[key];
    if(old&&old.url!==change.url){await chrome.storage.session.remove(key);await chrome.tabs.sendMessage(tabId,{type:'PAGE_SETTINGS_CHANGED',settings:pageDefaults(),navigation:true}).catch(()=>{});}
  }).catch(()=>{});
});
chrome.runtime.onStartup.addListener(()=>chrome.storage.session.clear());
