(() => {
  if (window.__FLOW_LOCAL_RUNNER_LOADED__) return;
  window.__FLOW_LOCAL_RUNNER_LOADED__ = true;
  const C={WAIT_FOR_START_MS:30000,GENERATION_TIMEOUT_MS:240000,HEARTBEAT_INTERVAL_MS:30000,IDLE_POLL_MS:1000,...window.FLOW_RUNNER_DEFAULTS};
  const S={running:false,stopRequested:false,loopActive:false,workerId:crypto.randomUUID(),message:'未启动',progress:'',concurrency:1,jobs:[],submitting:null,retired:[]};
  const seenMedia=new Set();
  const normalize=s=>String(s||'').replace(/\s+/g,' ').trim();
  // Inspect open shadow roots as well as the main Flow document.
  function queryAll(selector, start=document){
    const found=new Set(),seen=new Set();
    function visit(root){
      if(!root||seen.has(root))return;seen.add(root);
      if(root.shadowRoot)visit(root.shadowRoot);
      root.querySelectorAll(selector).forEach(el=>found.add(el));
      root.querySelectorAll('*').forEach(el=>{if(el.shadowRoot)visit(el.shadowRoot);});
    }
    visit(start);return [...found];
  }
  const rootSelector='flow-grid-tile-container';
  const leafSelector='flow-pending-tile,flow-image-tile,flow-error-tile,flow-failed-tile';
  const genericSelector='[data-generation-id],[data-request-id],[data-task-id]';
  function roots(){
    const wrappers=queryAll(rootSelector);
    const candidates=queryAll(leafSelector+','+genericSelector).filter(el=>
      !wrappers.some(w=>w.contains(el)) && !el.closest('flow-rich-text-editor,[contenteditable="true"]'));
    return [...wrappers,...candidates.filter(el=>!candidates.some(other=>other!==el&&other.contains(el)))];
  }
  function keys(el){
    const nodes=[el,...queryAll(leafSelector+','+genericSelector,el)];
    return [...new Set(nodes.flatMap(n=>['data-generation-id','data-request-id','data-task-id','data-id','id']
      .map(a=>n.getAttribute(a)?a+':'+n.getAttribute(a):'').filter(Boolean)))];
  }
  function pending(el){return el.matches('flow-pending-tile')||!!queryAll('flow-pending-tile,[role="progressbar"],.loading-percentage',el).length;}
  function visible(el){return el.isConnected&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden';}
  // Material icon ligatures and SVG symbol names are identifiers, not localized
  // error messages. Scope every signal to this task's tiles, never page alerts.
  function failure(el){
    if(!el.isConnected)return false;
    // Custom-element hosts can have no box (display:contents). Inspect their
    // rendered error panel instead of discarding visible descendant errors.
    const panels=queryAll('flow-error-tile,flow-failed-tile',el);
    if(el.matches('flow-error-tile,flow-failed-tile'))panels.push(el);
    if(panels.some(panel=>visible(panel)||queryAll('.error-tile,.error-title,.error-message-text',panel).some(visible)))return true;
    if(!visible(el))return false;
    if(el.matches('flow-error-tile,flow-failed-tile,[data-status="failed"],[data-state="error"]')||queryAll('flow-error-tile,flow-failed-tile,[data-status="failed"],[data-state="error"]',el).some(visible))return true;
    const names=new Set(['error','error_outline','warning','warning_amber','report','report_problem','cancel','broken_image','image_not_supported','block']);
    return queryAll('mat-icon,.material-icons,.material-symbols-outlined,.material-symbols-rounded,[class*="google-symbols"],i,[data-icon],svg use,svg[data-testid],svg[data-icon]',el).some(icon=>{
      if(!visible(icon))return false;
      // A menu's cancel/remove button is not a generation error indicator.
      if(icon.closest('button,[role="button"]'))return false;
      const tokens=[icon.textContent,icon.getAttribute('data-icon'),icon.getAttribute('data-testid'),icon.getAttribute('svgicon'),icon.getAttribute('fonticon'),icon.getAttribute('href'),icon.getAttribute('xlink:href')];
      return tokens.some(v=>names.has(normalize(v).toLowerCase().replace(/^.*[#:/]/,'')));
    });
  }
  function slots(el){const parts=queryAll(leafSelector,el);return parts.length?parts:[el];}
  function mediaKey(img){return img.dataset.mediaId||img.currentSrc||img.src;}
  function outputHost(img){return img.closest('flow-image-tile');}
  function serverResult(img){
    const host=outputHost(img),src=img.currentSrc||img.getAttribute('src')||img.src||'';
    // Flow publishes media-id only on its finished image result. Thumbnail
    // network loading is independent of generation completion (including lazy loading).
    return !!host&&!pending(host)&&!!img.getAttribute('data-media-id')&&
      /^(https?:|blob:|data:image\/)/.test(src);
  }
  function images(el){
    return queryAll('img',el).filter(img=>!!mediaKey(img)&&
      (!img.closest('flow-pending-tile'))&&
      !img.closest('[contenteditable="true"],flow-rich-text-editor,.avatar,[data-avatar],.reference-images')&&
      (serverResult(img)||(img.complete&&img.naturalWidth>0&&
        (img.matches('img.image,img[data-media-id]')||Math.min(img.naturalWidth,img.naturalHeight)>=64))));
  }
  function effectiveConcurrency(){return 1;}
  function snapshotBatch(job){
    // Flow inserts this submission before existing history. Save that boundary,
    // not prompt text or a per-card ID that disappears on a DOM rebuild.
    const cards=roots();
    job.baseline=cards.map(el=>({el,keys:keys(el),media:images(el).map(mediaKey),state:failure(el)?'failed':pending(el)?'pending':'other'}));
    job.beforeMedia=new Set([...seenMedia,...cards.flatMap(images).map(mediaKey)]);
    job.batchSize=0;job.tiles=new Set();job.failureAt=0;
  }
  function batchCards(job){
    const cards=roots(),base=job.baseline||[];
    let count=Math.max(0,cards.length-base.length);
    // A surviving history card gives the number inserted ahead of history,
    // even when the virtual list drops old cards from its end.
    for(let i=0;i<cards.length;i++){
      const card=cards[i],ids=keys(card),media=images(card).map(mediaKey);
      const old=base.findIndex(b=>
        b.media.some(k=>media.includes(k))||b.keys.some(k=>ids.includes(k))||
        (b.el===card&&(failure(card)?'failed':pending(card)?'pending':'other')===b.state&&
          (!b.media.length||b.media.some(k=>media.includes(k)))));
      if(old>=0){count=Math.max(0,i-old);break;}
    }
    job.batchSize=Math.max(job.batchSize||0,count);
    // A temporarily missing card is not a failure. The observed batch size
    // remains the required count; new replacement elements can fill its slots.
    const current=cards.slice(0,Math.min(count,job.batchSize));
    job.tiles=new Set(current);
    return current;
  }
  function discover(job){return batchCards(job);}
  function publicState(){return {running:S.running,stopRequested:S.stopRequested,message:S.message,lastResult:S.lastResult||'',progress:`并发 ${S.jobs.length+S.retired.length}/${effectiveConcurrency()}（设置 ${S.concurrency}）${effectiveConcurrency()<S.concurrency?' · 页面缺少稳定任务ID，逐批跟踪':''}`,concurrency:S.concurrency,currentJob:S.jobs[0]?{id:S.jobs[0].id}:null,jobs:S.jobs.map(j=>({id:j.id,startedAt:j.startedAt,status:j.phase||'提交中'}))};}
  async function settings(){const s=await window.PageSettings.get({flowConcurrency:1,flowEnabled:false});S.concurrency=1;return s;}
  chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
    if(msg?.type==='PAGE_SETTINGS_CHANGED'){
      S.concurrency=1;
      if(msg.navigation){S.stopRequested=true;S.jobs.forEach(j=>j.invalid=true);}
      return;
    }
    if(msg?.action==='getRunnerState'){reply({ok:true,state:publicState()});return;}
    if(msg?.action==='startRunner'){
      start().then(()=>reply({ok:true,state:publicState()})).catch(e=>reply({ok:false,error:String(e)}));return true;
    }
    if(msg?.action==='stopRunner'){
      S.stopRequested=true;window.PageSettings.set({flowEnabled:false}).catch(()=>{});S.message='停止领取新任务，等待已提交任务回写';reply({ok:true,state:publicState()});return;
    }
  });
  async function start(){
    await settings();if(S.running){S.stopRequested=false;await window.PageSettings.set({flowEnabled:true});return;}
    if(!findEditor()||!findGenerateButton())throw new Error('请打开 Flow 具体项目的生成页面。');
    await window.PageSettings.set({flowEnabled:true});S.running=true;S.stopRequested=false;runLoop();
  }
  async function api(action,payload={}){return await chrome.runtime.sendMessage({type:'FLOW_DB',action,payload:{...payload,workerId:S.workerId}})||{ok:false,error:'本地数据库无响应'};}
  async function finish(job,action,detail={}){
    if(job.done||job.invalid)return;
    let r;
    for(let i=0;i<3;i++){try{r=await api(action,{jobId:job.id,lockToken:job.lockToken,...detail});}catch(e){r={ok:false,error:String(e)};}if(r.ok||r.code==='STALE_JOB')break;await sleep(250);}
    if(!r.ok&&r.code!=='STALE_JOB'){S.stopRequested=true;throw new Error('结果回写失败：'+r.error);}
    job.done=true;job.finishedAt=Date.now();S.lastResult=r.code==='STALE_JOB'?'任务已手动修改，旧结果不再回写':`${job.id}：${action==='completeJob'?'成功':action==='failJob'?'失败':'待确认'}`;S.message=r.code==='STALE_JOB'?'任务已手动修改，旧结果不再回写':`${job.id}：${action==='completeJob'?'成功':action==='failJob'?'失败，两分钟后重试':'待确认'}`;
  }
  async function inspect(job){
    if(job.done||job.invalid)return;
    const tiles=batchCards(job);
    const successful=tiles.flatMap(images).filter(img=>!job.beforeMedia.has(mediaKey(img)));
    if(successful.length){job.phase='成功';await finish(job,'completeJob',{mediaIds:successful.map(mediaKey),size:detectAspectRatio(successful[0])});return;}
    const failed=tiles.filter(failure).length;
    const generating=tiles.filter(t=>pending(t)&&!failure(t)).length;
    job.phase=job.batchSize?`本次 ${job.batchSize} 张：失败 ${failed}，生成中 ${generating}`:'等待本次新图片';
    if(job.batchSize>0&&tiles.length===job.batchSize&&failed===job.batchSize){
      job.failureAt ||= Date.now();
      if(Date.now()-job.failureAt>=1500){await finish(job,'failJob',{reason:`本次 ${job.batchSize} 张图片全部失败，没有成功图片`});return;}
    }else job.failureAt=0;
    if(Date.now()-job.startedAt>C.GENERATION_TIMEOUT_MS)await finish(job,'interruptJob',{reason:'生成结果超时，未能确认本任务结果；可手动修改状态后重新排队'});
    if(!job.done&&Date.now()-job.heartbeatAt>=C.HEARTBEAT_INTERVAL_MS){
      const r=await api('heartbeat',{jobId:job.id,lockToken:job.lockToken});job.heartbeatAt=Date.now();
      if(r.code==='STALE_JOB')job.invalid=true;else if(!r.ok)throw new Error(r.error);
    }
  }
  async function submit(job){
    try{
      const editor=await waitFor(findEditor,20000,200,'没有找到 Flow 输入框');
      if(job.invalid||job.done)return;
      await setPrompt(editor,job.prompt);
      const button=await waitFor(()=>{const b=findGenerateButton();return b&&!b.disabled?b:null;},15000,200,'生成按钮不可点击');
      const valid=await api('heartbeat',{jobId:job.id,lockToken:job.lockToken});
      if(!valid.ok){job.invalid=true;return;}
      if(job.invalid||job.done)return;
      if(S.stopRequested){await finish(job,'releaseJob');return;}
      snapshotBatch(job);
      job.clicked=true;job.startedAt=Date.now();button.click();S.message=`${job.id}：已提交，独立跟踪中`;
      const deadline=Date.now()+C.WAIT_FOR_START_MS;
      while(Date.now()<deadline&&!job.done&&!job.invalid){
        discover(job,true);
        if(job.tiles.size){await sleep(1000);discover(job,true);return;}
        await sleep(200);
      }
      if(!job.done&&!job.invalid)await finish(job,'interruptJob',{reason:'提交后未找到可独立关联的任务卡片，请核对 Flow 结果'});
    }catch(e){if(!job.done&&!job.invalid)await finish(job,job.clicked?'interruptJob':'failJob',{reason:String(e)});}
    finally{if(S.submitting===job)S.submitting=null;}
  }
  let wakeLoop=null,changePending=false;
  function signalChange(){changePending=true;if(wakeLoop)wakeLoop();}
  function waitForChange(){
    if(changePending){changePending=false;return sleep(50);}
    return new Promise(resolve=>{const done=()=>{clearTimeout(timer);wakeLoop=null;changePending=false;resolve();};const timer=setTimeout(done,250);wakeLoop=done;});
  }
  const observedRoots=new WeakSet();
  function observeResults(){
    const visit=root=>{
      if(!observedRoots.has(root)){
        observedRoots.add(root);
        new MutationObserver(records=>{
          signalChange();}).observe(root,{subtree:true,childList:true,attributes:true,characterData:true});
        root.addEventListener('load',signalChange,true);root.addEventListener('error',signalChange,true);
      }
      root.querySelectorAll('*').forEach(el=>{if(el.shadowRoot)visit(el.shadowRoot);});
    };visit(document);
  }
  async function runLoop(){
    if(S.loopActive)return;S.loopActive=true;
    try{
      while(true){
        observeResults();
        if(S.jobs.length){
          const r=await api('checkJobs');if(!r.ok)throw new Error(r.error);
          for(const job of S.jobs)if(!r.jobs.some(j=>j.id===job.id&&j.lockToken===job.lockToken))job.invalid=true;
          // Always check the earliest submission first, without waiting for it
          // to finish before checking later jobs.
          for(const job of S.jobs)if(job.clicked)await inspect(job);
          for(const job of S.jobs)if(job.done)S.retired.push(job);
          S.jobs=S.jobs.filter(j=>!j.done&&!j.invalid);
        }
        for(const job of S.retired)discover(job);
        queryAll('img').forEach(img=>seenMedia.add(mediaKey(img)));
        S.retired=S.retired.filter(j=>Date.now()-j.startedAt<C.GENERATION_TIMEOUT_MS&&(Date.now()-(j.finishedAt||0)<2000||j.tiles.size<j.batchSize||[...j.tiles].some(t=>pending(t)&&!failure(t))));
        if(S.stopRequested&&!S.jobs.length&&!S.submitting)break;
        if(!S.stopRequested&&!S.submitting&&S.jobs.length+S.retired.length<effectiveConcurrency()){
          const r=await api('claimJob',{excludePrompts:[]});if(!r.ok)throw new Error(r.error);
          if(r.job){
            const j={...r.job,token:r.job.lockToken,startedAt:Date.now(),heartbeatAt:Date.now(),tiles:new Set(),before:new Set(roots()),beforeKeys:new Set(),beforeMedia:new Set()};
            S.jobs.push(j);S.submitting=j;
            submit(j).catch(e=>{S.message=String(e);S.stopRequested=true;});
          }else if(!S.jobs.length)S.message='等待下一条可用提示词（失败任务冷却两分钟）';
        }
        await waitForChange();
      }
    }catch(e){S.message='运行异常：'+String(e);S.stopRequested=true;S.jobs.forEach(j=>j.invalid=true);}
    finally{S.running=false;S.loopActive=false;S.jobs=[];await window.PageSettings.set({flowEnabled:false}).catch(()=>{});}
  }
  // Restore per-page preferences only; refresh never silently resubmits jobs.
  settings().catch(()=>{});
  function findEditor() {
    return document.querySelector('flow-rich-text-editor .ProseMirror[contenteditable="true"]') ||
           document.querySelector('.ProseMirror[contenteditable="true"]');
  }

  function findGenerateButton() {
    return document.querySelector('flow-generate-icon-button button') ||
           document.querySelector('flow-generate-icon-button button[aria-label="开始生成"]') ||
           document.querySelector('button[type="submit"][aria-label="開始生成"]') ||
           document.querySelector('button[type="submit"][aria-label="开始生成"]') ||
           document.querySelector('flow-generate-icon-button button[type="submit"]');
  }

  async function setPrompt(editor, text) {
    editor.click();
    editor.focus();

    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete', false);

    document.execCommand('insertText', false, text);

    if ((editor.textContent || '').trim() !== text.trim()) {
      editor.innerHTML = '';
      const p = document.createElement('p');
      p.textContent = text;
      editor.appendChild(p);
    }

    editor.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text
    }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));

    await sleep(350);
  }

  function detectSelectedAspectRatio() {
    const icons = [...document.querySelectorAll('.settings-summary mat-icon, button.settings-trigger-button mat-icon')];
    for (const icon of icons) {
      const t = normalize(icon.textContent);
      const m = t.match(/crop_(\d+)_(\d+)/i);
      if (m) return `${m[1]}:${m[2]}`;
    }
    return '';
  }

  function detectAspectRatio(img) {
    const w = img.naturalWidth || 0;
    const h = img.naturalHeight || 0;
    if (!w || !h) return detectSelectedAspectRatio();
    const g = gcd(w, h);
    const rw = Math.round(w / g), rh = Math.round(h / g);
    if (rw <= 32 && rh <= 32) return `${rw}:${rh}`;
    return detectSelectedAspectRatio() || `${w}x${h}`;
  }

  function gcd(a, b) {
    while (b) [a, b] = [b, a % b];
    return a;
  }

  function waitFor(fn, timeout, interval, errorMessage) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        try {
          const value = fn();
          if (value) {
            clearInterval(timer);
            resolve(value);
            return;
          }
          if (Date.now() - start >= timeout) {
            clearInterval(timer);
            reject(new Error(errorMessage || '等待超时'));
          }
        } catch (e) {
          clearInterval(timer);
          reject(e);
        }
      }, interval);
    });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
})();
