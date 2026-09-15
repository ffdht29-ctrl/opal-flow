const $=id=>document.getElementById(id);
const own=msg=>chrome.runtime.sendMessage(msg);
const ask=(tabId,msg,opts)=>chrome.tabs.sendMessage(tabId,msg,opts);
let activeTab=null,busy=false;
async function pageGet(){const r=await own({type:'PAGE_SETTINGS',action:'get',tabId:activeTab.id});if(!r.ok)throw new Error(r.error);return r.settings;}
async function pageSet(values){const r=await own({type:'PAGE_SETTINGS',action:'set',tabId:activeTab.id,values});if(!r.ok)throw new Error(r.error);}
function notice(text){$('notice').textContent=text;$('notice').style.display=text?'block':'none';}
function host(tab){try{return new URL(tab?.url||'').hostname;}catch{return '';}}
const isFlow=tab=>['flow.google.com','labs.google'].includes(host(tab));
async function use(fn){if(busy)return;busy=true;notice('正在处理…');try{await fn();}catch(e){notice(e.message||String(e));}finally{busy=false;await refresh();}}
async function refresh(){
  try{
    [activeTab]=await chrome.tabs.query({active:true,currentWindow:true});
    const s=await pageGet();
    $('saveImages').checked=s.opalSaveImages!==false;$('savePrompts').checked=s.opalSavePrompts!==false;$('autoDownload').checked=s.opalAutoDownload!==false;
    $('autoDownload').disabled=!$('saveImages').checked;$('pickImages').hidden=!$('saveImages').checked;
    $('manual').disabled=!$('savePrompts').checked;
    if(document.activeElement!==$('mode'))$('mode').value=s.opalExtractorMode;
    if(document.activeElement!==$('concurrency'))$('concurrency').value=1;
    $('opalToggle').textContent=s.opalExtractorEnabled?'停止 Opal':'开始 Opal';$('opalToggle').classList.toggle('stop',s.opalExtractorEnabled);
    $('opalState').textContent=(s.opalExtractorEnabled?'运行中':'已停止')+(s.opalExtractorLastDetail?'\n'+s.opalExtractorLastDetail:'');
    const stats=await own({type:'LOCAL_DB',action:'getStats'});
    if(stats.ok)$('stats').textContent=`共 ${stats.total} 条 · 待生成 ${stats.eligible} · 成功 ${stats.success} · 待确认 ${stats.interrupted}`;
    if(isFlow(activeTab)){
      const res=await ask(activeTab.id,{action:'getRunnerState'}).catch(()=>null);
      if(res?.ok){const f=res.state;$('flowToggle').textContent=f.running?'停止当前 Flow 页面':'开始当前 Flow 页面';$('flowToggle').classList.toggle('stop',f.running);$('flowState').textContent=(f.running?'运行中':'已停止')+'\n'+f.message+'\n'+(f.lastResult?'最近结果：'+f.lastResult+'\n':'')+(f.currentJob?'任务 '+f.currentJob.id+'\n':'')+(f.progress||'')+(f.jobs?.length?'\n'+f.jobs.map(j=>j.id+'：'+j.status).join('\n'):'');}
      else $('flowState').textContent='点击开始将加载 Flow 自动生成脚本。';
    }else{$('flowState').textContent='请切换到 Flow 项目页面，再点击开始。其他已启动的 Flow 页面会继续运行。';$('flowToggle').textContent='开始当前 Flow 页面';$('flowToggle').classList.remove('stop');}
  }catch(e){notice('状态读取失败：'+e.message);}
}
async function ensureOpal(){
  if(host(activeTab)!=='opal.google')throw new Error('请先切换到 Opal 页面。');
  await chrome.scripting.executeScript({target:{tabId:activeTab.id,allFrames:true},files:['page-settings.js','opal.js']});
}
$('library').onclick=()=>chrome.runtime.openOptionsPage();
$('mode').onchange=()=>use(async()=>{await ensureOpal();await pageSet({opalExtractorMode:$('mode').value});notice('Opal 模式已保存。');});
$('opalToggle').onclick=()=>use(async()=>{
  await ensureOpal();const s=await pageGet();
  if(!s.opalExtractorEnabled&&s.opalSaveImages===false&&s.opalSavePrompts===false)throw new Error('请至少勾选下载图片或上传提示词。');
  await pageSet({opalExtractorEnabled:!s.opalExtractorEnabled,opalExtractorAutoNextAt:''});notice(s.opalExtractorEnabled?'Opal 已停止。':'Opal 已启动，可以切换到 Flow 标签页。');
});
$('manual').onclick=()=>use(async()=>{
  await ensureOpal();const s=await pageGet();
  const frames=await chrome.scripting.executeScript({target:{tabId:activeTab.id,allFrames:true},func:()=>!!window.__OPAL_LOCAL_LOADED__});
  let found=0,inserted=0,skipped=0;const errors=[];
  for(const frame of frames.filter(f=>f.result)){
    try{
      const r=await ask(activeTab.id,{type:'MANUAL_EXTRACT'},{frameId:frame.frameId});
      if(r?.ok){found+=r.count||0;inserted+=r.inserted||0;skipped+=r.skipped||0;}
      else if(r?.error)errors.push(r.error);
    }catch(e){errors.push(e.message);}
  }
  if(!found)throw new Error([...new Set(errors)].join('\n')||'页面尚未加载结果，请展开 Output 后重试。');
  notice(`已扫描当前页面：新增保存 ${inserted} 条，已保存的重复内容 ${skipped} 条。`);
});
$('concurrency').onchange=()=>use(async()=>{if(!isFlow(activeTab))throw new Error('请先切换到 Flow 页面。');await pageSet({flowConcurrency:Number($('concurrency').value)});notice('当前 Flow 页面的并发数已保存。');});
$('flowToggle').onclick=()=>use(async()=>{
  if(!isFlow(activeTab))throw new Error('请在 Flow 的具体项目页面点击开始。');
  let res=await ask(activeTab.id,{action:'getRunnerState'}).catch(()=>null);
  if(!res?.ok){await chrome.scripting.executeScript({target:{tabId:activeTab.id},files:['page-settings.js','flow-config.js','flow.js']});res=await ask(activeTab.id,{action:'getRunnerState'});}
  const action=res.state.running?'stopRunner':'startRunner';const result=await ask(activeTab.id,{action});
  if(!result?.ok)throw new Error(result?.error||'操作失败');notice(action==='startRunner'?'Flow 已启动，Opal 可同时继续保存提示词。':'已请求停止 Flow，当前任务将先完成。');
});
$('stopAll').onclick=()=>use(async()=>{const r=await own({type:'STOP_ALL_FLOW'});if(!r.ok)throw new Error(r.error);notice('已通知所有 Flow 页面停止领取新任务。');});
refresh();const timer=setInterval(()=>{if(!busy)refresh();},500);window.addEventListener('unload',()=>clearInterval(timer));

for(const [id,key] of [['saveImages','opalSaveImages'],['savePrompts','opalSavePrompts'],['autoDownload','opalAutoDownload']]) {
 $(id).onchange=()=>use(async()=>{await ensureOpal();await pageSet({[key]:$(id).checked});notice('选项已保存。');});
}
$('pickImages').onclick=()=>use(async()=>{
 await ensureOpal();
 const frames=await chrome.scripting.executeScript({target:{tabId:activeTab.id,allFrames:true},func:()=>!!window.__OPAL_LOCAL_LOADED__});
 const errors=[];
 for(const frame of frames.filter(f=>f.result)){
   const result=await ask(activeTab.id,{type:'OPAL_PICK_IMAGES'},{frameId:frame.frameId}).catch(e=>({error:e.message}));
   if(result?.ok){window.close();return;}
   if(result?.error)errors.push(result.error);
 }
 throw new Error([...new Set(errors)].join('\n')||'未找到图片，请展开节点 Output。');
});
