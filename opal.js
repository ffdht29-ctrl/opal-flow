(() => {
  if (window.__OPAL_LOCAL_LOADED__) return;
  window.__OPAL_LOCAL_LOADED__ = true;
  const POLL_MS = 800;
  const STOP_SETTLE_MS = 1600;
  const RETRY_MS = 900;
  const MAX_RETRIES = 15;

  const AUTO_SUCCESS_MIN_MS = 5000;
  const AUTO_SUCCESS_MAX_MS = 10000;
  const AUTO_FAIL_MIN_MS = 3000;
  const AUTO_FAIL_MAX_MS = 5000;
  const AUTO_REPLAY_SETTLE_MS = 900;
  const AUTO_BUTTON_WAIT_MS = 9000;
  const AUTO_RUNNING_WAIT_MS = 12000;

  const IS_TOP = window === window.top;
  let cachedController = null;
  let lastStatus = 'unknown';
  let sawRunning = false;
  let runId = null;
  let stopToken = 0;
  let processing = false;
  let baselineFingerprints = new Set();
  let lastUploadedBatchFingerprint = '';

  let workflowEnabled = false;
  let operationMode = 'monitor'; // monitor | auto
  let autoCycleTimer = null;
  let autoCycleBusy = false;
  let lastReportKey = '';

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const randomMs = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

  function rootsDeep(start = document) {
    const roots = [], seen = new Set();
    function visit(root) {
      if (!root || seen.has(root)) return;
      seen.add(root);
      roots.push(root);
      if(root.shadowRoot)visit(root.shadowRoot);
      let els = [];
      try { els = root.querySelectorAll ? root.querySelectorAll('*') : []; } catch { return; }
      for (const el of els) if (el.shadowRoot) visit(el.shadowRoot);
    }
    visit(start);
    return roots;
  }

  function deepQueryAll(selector) {
    const out = [], seen = new Set();
    for (const root of rootsDeep()) {
      let list = [];
      try { list = root.querySelectorAll(selector); } catch { continue; }
      for (const el of list) {
        if (!seen.has(el)) {
          seen.add(el);
          out.push(el);
        }
      }
    }
    return out;
  }

  function findController() {
    if (cachedController?.isConnected) return cachedController;
    for (const root of rootsDeep()) {
      try {
        const el = root.querySelector?.('bb-app-controller');
        if (el) {
          cachedController = el;
          return el;
        }
      } catch {}
    }
    return null;
  }

  function deepText(node) {
    const parts = [], seen = new Set();
    const block = new Set(['P','DIV','LI','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','PRE','BR','SECTION']);
    function walk(n) {
      if (!n || seen.has(n)) return;
      seen.add(n);
      if (n.nodeType === Node.TEXT_NODE) {
        parts.push(n.nodeValue || '');
        return;
      }
      const tag = n.tagName || '';
      if(['SCRIPT','STYLE','TEMPLATE','TEXTAREA','INPUT'].includes(tag)||n.isContentEditable)return;
      if (block.has(tag)) parts.push('\n');
      if (n.shadowRoot) walk(n.shadowRoot);
      for (const child of n.childNodes || []) walk(child);
      if (block.has(tag)) parts.push('\n');
    }
    walk(node);
    return parts.join('')
      .replace(/\uFEFF/g,'')
      .replace(/[ \t]+\n/g,'\n')
      .replace(/\n[ \t]+/g,'\n')
      .replace(/\n{3,}/g,'\n\n')
      .trim();
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  function currentFatalError() {
    const selectors = ['#activity section.error', '.step-error[data-label="Error:"]', 'details.error'];
    for (const selector of selectors) {
      for (const el of deepQueryAll(selector)) {
        const text = deepText(el);
        if (isVisible(el) && /Oops,\s*something went wrong|Please try again\.?|unexpected error occurred while calling the model/i.test(text)) {
          return { failed: true, reason: text };
        }
      }
    }
    return { failed: false, reason: '' };
  }

  function parsePromptBlocks(text, containerIndex = 0) {
    const results = [];
    const re = /提示词\s*0*(\d+)\s*[:：]\s*\{/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const number = Number(m[1]);
      const start = re.lastIndex;
      let depth = 1, i = start;
      for (; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
          depth--;
          if (depth === 0) {
            const prompt = text.slice(start, i).trim();
            if (prompt.length > 0) results.push({ number, prompt, containerIndex, offset: m.index });
            re.lastIndex = i + 1;
            break;
          }
        }
      }
    }
    return results;
  }

  // Only direct outputs of generating steps. Never model traces or layout output.
  function nodeOutputs() {
    return deepQueryAll('div.output[data-label="Output:"],.output[data-label="Output"],[data-testid="node-output"]').filter(out=>
      !out.closest('.step-input,.model-trace,[data-label="Input:"],[data-label="System:"]'));
  }
  function collectAllPromptBlocks(manual = false) {
    const blocks=[],containers=new Set(nodeOutputs());
    // Manual recovery also reads rendered result components, including completed
    // app previews. Never scan the entire body or editable prompt definitions.
    if(manual)deepQueryAll('bb-llm-output,bb-user-output,bb-app-preview,[data-testid="output"],[data-testid="app-output"],#output,.app-output')
      .filter(el=>!el.closest('[contenteditable="true"],textarea,.step-input,[data-label="Input:"],.model-trace'))
      .forEach(el=>containers.add(el));
    if(manual&&!IS_TOP&&!findController()&&!containers.size&&!deepQueryAll('textarea,[contenteditable="true"]').length&&document.body)containers.add(document.body);
    [...containers].forEach((out,idx)=>blocks.push(...parsePromptBlocks(deepText(out),idx)));
    return blocks;
  }
  function blockFingerprint(x) { return x.prompt.replace(/\s+/g,' ').trim(); }
  function snapshotBaseline() {
    baselineFingerprints = new Set(collectAllPromptBlocks().map(blockFingerprint));
    baselineImages = new Set(collectImages().map(x => x.url));
  }
  function extractNewPrompts(all = false) {
    const unique = new Map();
    for (const x of collectAllPromptBlocks(all)) {
      const fp = blockFingerprint(x);
      if ((all || !baselineFingerprints.has(fp)) && (all || !savedPrompts.has(fp))) unique.set(fp, x);
    }
    return [...unique.values()];
  }
  let savePrompts = true, saveImages = true, autoDownload = true;
  let baselineImages = new Set(), savedPrompts = new Set(), imageCache = new Map();
  let collecting = false, pollBusy = false, roundCount = 0;
  const downloadInFlight = new Set(), downloadedImages = new Set(), retryAfter = new Map();
  function collectImages() {
    const found = new Map();
    nodeOutputs().forEach((out, index) => {
      const title = out.parentElement.querySelector(':scope > summary .title')?.textContent.trim() || `节点 ${index+1}`;
      for (const root of rootsDeep(out)) for (const img of root.querySelectorAll('img')) {
        const url = img.currentSrc || img.getAttribute('src');
        if (!url || !/^https:\/\/opal\.google\/board\/blobs\/[^/?#]+(?:[?#].*)?$/.test(url)) continue;
        found.set(url, {url, title, width:img.naturalWidth, height:img.naturalHeight});
      }
    });
    return [...found.values()];
  }
  async function downloadImage(item, repair = false) {
    if (downloadInFlight.has(item.url) || downloadedImages.has(item.url)) return;
    downloadInFlight.add(item.url);
    try {
      const state=await chrome.runtime.sendMessage({type:'OPAL_DOWNLOAD_STATUS',url:item.url});
      if(!state?.ok&&!repair)throw new Error(state?.error||'无法读取下载记录');
      if(state.complete){downloadedImages.add(item.url);return state;}
      if(state.pending)throw new Error('该图片仍在下载，请稍后重试。');
      const response=await fetch(item.url,{credentials:'include',signal:AbortSignal.timeout(25000)});
      if(!response.ok)throw new Error('图片资源返回 HTTP '+response.status);
      const blob=await response.blob();
      if(!/^image\/(png|jpeg|webp|gif|avif)$/.test(blob.type)||!blob.size)throw new Error('资源不是图片，请确认 Opal 登录状态。');
      if(blob.size>40*1024*1024)throw new Error('图片超过40MB，请使用网页自带下载。');
      const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('图片读取失败'));reader.readAsDataURL(blob);});
      const r = await chrome.runtime.sendMessage({type:'OPAL_DOWNLOAD',url:item.url,dataUrl,repair});
      if (!r?.ok) throw new Error(r?.error || '下载失败');
      downloadedImages.add(item.url);
      retryAfter.delete(item.url);
      return r;
    } catch (e) {
      retryAfter.set(item.url, Date.now()+15000);
      await report('FAILED', '图片下载失败，可用手动选择重试：'+e.message, true);
      throw e;
    } finally { downloadInFlight.delete(item.url); }
  }
  let imageDrain=null;
  function drainImages(){
    if(imageDrain)return imageDrain;
    imageDrain=(async()=>{
      for(const item of imageCache.values()){
        if(!workflowEnabled||!saveImages||!autoDownload)break;
        if((retryAfter.get(item.url)||0)>Date.now())continue;
        await downloadImage(item).catch(()=>{});
      }
    })().finally(()=>{imageDrain=null;});
    return imageDrain;
  }
  async function collectAvailable(all = false) {
    if (collecting) return;
    collecting = true;
    try {
      for (const item of collectImages()) {
        if (all || !baselineImages.has(item.url)) imageCache.set(item.url,item);
      }
      if (savePrompts) {
        const prompts = extractNewPrompts(all);
        for (let i=0;i<prompts.length;i+=500) {
          const batch=prompts.slice(i,i+500);
          if (await upload(batch)) {
            batch.forEach(x=>savedPrompts.add(blockFingerprint(x)));
            roundCount += batch.length;
          }
        }
      }
      if (saveImages && autoDownload) drainImages();
    } finally { collecting = false; }
  }
  function imagePicker() {
    for (const item of collectImages()) imageCache.set(item.url,item);
    if (!imageCache.size) return {ok:false,error:'小节点 Output 中没有发现图片。'};
    document.getElementById('__opal_image_picker')?.remove();
    const host=document.createElement('div'); host.id='__opal_image_picker';
    const root=host.attachShadow({mode:'open'});
    root.innerHTML=`<style>:host{position:fixed;inset:0;z-index:2147483647;background:#0007;font:14px system-ui;color:#18392f}section{background:white;margin:4vh auto;padding:20px;border-radius:12px;max-width:900px;width:85%;max-height:85vh;overflow:auto}header{display:flex;gap:12px;align-items:center;position:sticky;top:0;background:white;padding:8px}h2{font-size:18px;flex:1}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px}label{border:1px solid #cad8cf;border-radius:8px;padding:8px;cursor:pointer}img{width:100%;height:150px;object-fit:contain;display:block}button{padding:8px 12px;cursor:pointer}p{white-space:pre-wrap}</style><section><header><h2>选择 Opal 小节点图片</h2><button id="all">全选 / 取消</button><button id="save">下载所选</button><button id="repair">重新保存到文件夹</button><button id="close">关闭</button></header><p id="status"></p><main></main></section>`;
    const entries=[];
    for(const item of imageCache.values()) {
      const label=document.createElement('label'),check=document.createElement('input'),img=document.createElement('img'),text=document.createElement('span');
      check.type='checkbox';check.disabled=downloadedImages.has(item.url);check.checked=!check.disabled;
      img.src=item.url; text.textContent=item.title+(check.disabled?' · 已下载':'');
      label.append(check,text,img);root.querySelector('main').append(label);entries.push({item,check,text});
    }
    root.getElementById('status').textContent=`共 ${entries.length} 张；已下载的图片会自动跳过。`;
    root.getElementById('close').onclick=()=>host.remove();
    root.getElementById('all').onclick=()=>{const available=entries.filter(x=>!x.check.disabled),on=!available.every(x=>x.check.checked);available.forEach(x=>x.check.checked=on);};
    async function saveSelection(repair=false){
      const buttons=[root.getElementById('save'),root.getElementById('repair')];buttons.forEach(b=>b.disabled=true);
      let done=0;const errors=[];
      try{
        for(const x of entries.filter(x=>x.check.checked&&!x.check.disabled)){
          try{await downloadImage(x.item,repair);x.check.checked=false;x.check.disabled=true;x.text.textContent=x.item.title+' · 已下载';done++;}
          catch(e){errors.push(e.message||String(e));}
        }
        root.getElementById('status').textContent=`完成 ${done} 张，失败 ${errors.length} 张。`+(errors.length?'\n'+[...new Set(errors)].join('\n'):'');
      }finally{buttons.forEach(b=>b.disabled=false);}
    }
    root.getElementById('save').onclick=()=>saveSelection(false);
    root.getElementById('repair').onclick=()=>saveSelection(true);
    document.documentElement.append(host);return {ok:true,count:entries.length};
  }

  function makeId(number) {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}${String(d.getSeconds()).padStart(2,'0')}${String(d.getMilliseconds()).padStart(3,'0')}`;
    const rnd = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)+Date.now().toString(36)).replace(/-/g,'').slice(0,12);
    return `OPAL-${stamp}-${String(number).padStart(2,'0')}-${rnd}`;
  }

  async function sha256(text) {
    const dig = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(dig)].map(b => b.toString(16).padStart(2,'0')).join('');
  }

  // 页面右下角提示框已取消；状态只发送到插件 popup / badge。
  async function report(state, detail = '', force = false) {
    const key = `${state}|${detail}`;
    if (!force && key === lastReportKey) return;
    lastReportKey = key;
    try {
      await chrome.runtime.sendMessage({ type:'FRAME_STATE', state, detail });
    } catch {}
  }

  function findVisibleButton(selector) {
    const buttons = deepQueryAll(selector);
    return buttons.find(el => isVisible(el) && !el.disabled) || null;
  }

  async function waitForVisibleButton(selector, timeoutMs = AUTO_BUTTON_WAIT_MS) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!workflowEnabled || operationMode !== 'auto') return null;
      const btn = findVisibleButton(selector);
      if (btn) return btn;
      await sleep(250);
    }
    return null;
  }

  async function waitForRunning(timeoutMs = AUTO_RUNNING_WAIT_MS) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!workflowEnabled || operationMode !== 'auto') return false;
      const c = findController();
      if (c?.getAttribute('status') === 'running') return true;
      await sleep(250);
    }
    return false;
  }

  async function clearAutoScheduleMarker() {
    try { await window.PageSettings.set({ opalExtractorAutoNextAt: '' }); } catch {}
  }

  function cancelAutoCycle() {
    if (autoCycleTimer) {
      clearTimeout(autoCycleTimer);
      autoCycleTimer = null;
    }
    clearAutoScheduleMarker();
  }

  async function scheduleAutoCycle(minMs, maxMs, reason) {
    if (!workflowEnabled || operationMode !== 'auto') return;
    cancelAutoCycle();
    const delay = randomMs(minMs, maxMs);
    const nextAt = new Date(Date.now() + delay).toISOString();
    try { await window.PageSettings.set({ opalExtractorAutoNextAt: nextAt }); } catch {}
    autoCycleTimer = setTimeout(() => {
      autoCycleTimer = null;
      clearAutoScheduleMarker();
      runAutoCycle(reason).catch(() => {});
    }, delay);
  }

  async function runAutoCycle(reason = 'auto') {
    if (!workflowEnabled || operationMode !== 'auto' || autoCycleBusy) return;
    const c = findController();
    if (!c) {
      await report('IDLE', '全自动模式：等待 Opal 运行区出现。');
      await scheduleAutoCycle(1200, 2000, '等待运行区');
      return;
    }
    if (c.getAttribute('status') === 'running') return;

    autoCycleBusy = true;
    try {
      await clearAutoScheduleMarker();
      if (!workflowEnabled || operationMode !== 'auto') return;

      const replay = findVisibleButton('#replay');
      if (replay) {
        await report('AUTO_STARTING', `全自动模式：点击刷新按钮（${reason}）。`, true);
        replay.click();
        await sleep(AUTO_REPLAY_SETTLE_MS);
      } else {
        await report('AUTO_STARTING', `全自动模式：未发现刷新按钮，直接寻找 Start（${reason}）。`, true);
      }

      if (!workflowEnabled || operationMode !== 'auto') return;
      const runButton = await waitForVisibleButton('#run');
      if (!runButton) {
        await report('STOPPED_NO_RESULT', '全自动模式：没有找到可点击的 Start 按钮，几秒后重试。', true);
        await scheduleAutoCycle(AUTO_FAIL_MIN_MS, AUTO_FAIL_MAX_MS, '未找到 Start');
        return;
      }

      runButton.click();
      await report('AUTO_STARTING', '已点击 Start，等待 Opal 进入 running。', true);

      const started = await waitForRunning();
      if (!started && workflowEnabled && operationMode === 'auto') {
        await report('FAILED', '自动点击 Start 后未检测到 running，几秒后重新刷新并重试。', true);
        await scheduleAutoCycle(AUTO_FAIL_MIN_MS, AUTO_FAIL_MAX_MS, '启动未成功');
      }
    } finally {
      autoCycleBusy = false;
    }
  }

  let lastUploadStats={inserted:0,skipped:0};
  async function upload(items) {
    const batchFp = await sha256(items.map(x => `${x.number}:${x.prompt}`).join('\n---\n'));
    if (!runId?.startsWith('manual-') && batchFp === lastUploadedBatchFingerprint) {
      lastUploadStats={inserted:0,skipped:items.length};
      await report('SUCCESS', `识别 ${items.length} 条；本批次已保存到本地，已跳过重复。`, true);
      return true;
    }

    const pendingKey = 'opalLocalPending:' + location.href;
    const oldPending = (await window.PageSettings.get(pendingKey))[pendingKey];
    const rows = oldPending?.fingerprint === batchFp ? oldPending.rows : await Promise.all(items.map(async x => ({ id:'OPAL-' + await sha256(location.href.split('#')[0]+'|'+blockFingerprint(x)), prompt:x.prompt, promptNumber:x.number })));
    if (oldPending && oldPending.fingerprint !== batchFp) {
      const retry = await chrome.runtime.sendMessage({type:'UPLOAD_ROWS',rows:oldPending.rows,meta:{pageUrl:location.href}});
      if (!retry?.ok) { await report('FAILED','上一批尚未保存，已停止新一轮。请检查本地存储并手动重试。',true); return false; }
    }
    await window.PageSettings.set({[pendingKey]:{fingerprint:batchFp,rows}});
    const res = await chrome.runtime.sendMessage({
      type:'UPLOAD_ROWS',
      rows,
      meta:{ runId, pageUrl:location.href, extractedAt:new Date().toISOString() }
    });

    if (!res?.ok) {
      await window.PageSettings.set({
        opalExtractorPendingRows:rows,
        opalExtractorPendingMeta:{runId,pageUrl:location.href,extractedAt:new Date().toISOString()}
      });
      const msg = res?.error || '保存到本地失败';
      await report(
        /本地数据库|自动保存到本地已关闭/.test(msg) ? 'WAITING_CONFIG' : 'STOPPED_NO_RESULT',
        `已提取 ${rows.length} 条，但未保存到本地：${msg}`,
        true
      );
      return false;
    }

    await window.PageSettings.remove(pendingKey);
    lastUploadedBatchFingerprint = batchFp;
    lastUploadStats={inserted:res.inserted??items.length,skipped:res.skipped??0};
    await window.PageSettings.remove(['opalExtractorPendingRows','opalExtractorPendingMeta']);
    await report('SUCCESS', `成功提取 ${items.length} 条；写入 ${res.inserted ?? items.length} 条，跳过重复 ${res.skipped ?? 0} 条。`, true);
    return true;
  }

  async function handleRunFailure(detail) {
    await report('FAILED', detail, true);
    if (workflowEnabled && operationMode === 'auto') {
      await scheduleAutoCycle(AUTO_FAIL_MIN_MS, AUTO_FAIL_MAX_MS, '上轮失败');
    }
  }

  async function finalize(token) {
    if (processing || !workflowEnabled) return;
    processing = true;
    try {
      await sleep(STOP_SETTLE_MS);
      if (token !== stopToken || !workflowEnabled) return;

      const c = findController();
      if (!c || c.getAttribute('status') === 'running') return;

      await collectAvailable();
      for (let i=0;i<3 && token===stopToken && workflowEnabled;i++) {
        await sleep(RETRY_MS);
        await collectAvailable();
      }
      if(saveImages && autoDownload && imageDrain) await imageDrain;
      if (token!==stopToken || !workflowEnabled) return;
      const detail = `本轮保存 ${roundCount} 条提示词；本页累计发现 ${imageCache.size} 张图片，已下载 ${[...imageCache.keys()].filter(x=>downloadedImages.has(x)).length} 张。`;
      await report(currentFatalError().failed?'FAILED':'SUCCESS', detail + (currentFatalError().failed?' 后续节点报错，已保留小节点结果。':''),true);
      if (workflowEnabled && operationMode==='auto') {
        await scheduleAutoCycle(AUTO_SUCCESS_MIN_MS,AUTO_SUCCESS_MAX_MS,'本轮结束');
      }

    } finally {
      processing = false;
    }
  }

  async function poll() {
    if (!workflowEnabled) return;

    const c = findController();
    if (!c) {
      if (lastStatus !== 'no-controller') {
        lastStatus = 'no-controller';
        await report('IDLE', '等待嵌套 Opal 运行区出现。');
      }
      return;
    }

    const status = c.getAttribute('status') || 'unknown';
    if (status === 'running') {
      if (lastStatus !== 'running') {
        runId = `run-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
        sawRunning = true;
        stopToken++;
        roundCount = 0;

        cancelAutoCycle();
      }
      await report('RUNNING', '检测到嵌套 Opal：status=running');
    } else if (status === 'stopped') {
      if (lastStatus === 'running' && sawRunning) {
        sawRunning = false;
        const token = ++stopToken;
        finalize(token);
      } else if (lastStatus === 'unknown' || lastStatus === 'no-controller') {
        await report('IDLE', operationMode === 'auto' ? '全自动模式已启动，准备自动运行。' : '监控模式已启动，等待 Opal 运行。');
      }
    }
    lastStatus = status;
    await collectAvailable();
  }

  async function applyControlState(nextEnabled, nextMode, initial = false) {
    const enabledChanged = workflowEnabled !== nextEnabled;
    const modeChanged = operationMode !== nextMode;
    workflowEnabled = nextEnabled;
    operationMode = nextMode;

    if (!workflowEnabled) {
      cancelAutoCycle();
      stopToken++;
      sawRunning = false;
      processing = false;
      lastStatus = 'unknown';
      const c = findController();
      if (c) await report('IDLE', '插件已停止。', true);
      return;
    }

    if (enabledChanged || modeChanged || initial) {
      lastStatus = 'unknown';
      lastReportKey = '';
      snapshotBaseline();
      if (findController()?.getAttribute('status')==='running') { baselineFingerprints.clear(); baselineImages.clear(); }
      if (operationMode === 'auto') {
        await report('IDLE', '全自动模式已启动，准备刷新并运行。', true);
        await scheduleAutoCycle(250, 700, '开始全自动');
      } else {
        cancelAutoCycle();
        await report('IDLE', '监控模式已启动：只识别和保存到本地，不自动点击刷新/Start。', true);
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'OPAL_PICK_IMAGES') { sendResponse(saveImages ? imagePicker() : {ok:false,error:'请先勾选下载图片。'}); return; }
    if (msg?.type === 'OPAL_PING') { sendResponse({ok:true,controller:!!findController()}); return; }
    if (msg?.type === 'MANUAL_EXTRACT') {
      (async () => {
        const c = findController();
        if (c?.getAttribute('status') === 'running') {
          sendResponse({ok:false,error:'Opal 当前仍在 running，请等待本轮完成。'});return;
        }
        if (!savePrompts) { sendResponse({ok:false,error:'请先勾选上传提示词。'}); return; }
        const prompts = extractNewPrompts(true);
        if (!prompts.length) {
          sendResponse({ok:false,error:'当前页面未发现完整的“提示词NN:{...}”结果；请展开节点 Output 或结果预览后重试。'});return;
        }
        runId = `manual-${Date.now()}`;
        const saved = await upload(prompts);
        sendResponse({ok:saved,count:prompts.length,inserted:lastUploadStats.inserted,skipped:lastUploadStats.skipped,error:saved ? undefined : '本地保存失败，请查看状态。'});
      })().catch(e=>sendResponse({ok:false,error:e.message||String(e)}));
      return true;
    }
  });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type !== 'PAGE_SETTINGS_CHANGED') return;
    const s=msg.settings;
    savePrompts=s.opalSavePrompts!==false;saveImages=s.opalSaveImages!==false;autoDownload=s.opalAutoDownload!==false;
    applyControlState(s.opalExtractorEnabled === true, s.opalExtractorMode === 'auto' ? 'auto' : 'monitor');
  });

  (async () => {
    const s = await window.PageSettings.get({
      opalExtractorMode:'monitor',
      opalExtractorEnabled:false, opalSavePrompts:true, opalSaveImages:true, opalAutoDownload:true
    });
    savePrompts=s.opalSavePrompts!==false;saveImages=s.opalSaveImages!==false;autoDownload=s.opalAutoDownload!==false;
    await applyControlState(s.opalExtractorEnabled === true, s.opalExtractorMode === 'auto' ? 'auto' : 'monitor', true);
    setInterval(async()=>{if(pollBusy)return;pollBusy=true;try{await poll();}catch(e){await report('FAILED',e.message);}finally{pollBusy=false;}}, POLL_MS);
    setTimeout(poll, 200);
  })();
})();
