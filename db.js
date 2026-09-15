/* Durable local queue. All mutations commit in one IndexedDB transaction. */
const LocalQueue = (() => {
  const NAME='opal-flow-local-v1', LEASE=180000, COOLDOWN=120000;
  let opening;
  const statuses=['pending','processing','success','failed','interrupted'];
  const active=(r,now=Date.now())=>r.status==='processing' && r.leaseUntil>now;
  const effective=(r,now=Date.now())=>r.status==='processing' && !active(r,now)?'interrupted':r.status;
  function open() {
    if(!opening) opening=new Promise((resolve,reject)=>{
      const q=indexedDB.open(NAME,1);
      q.onupgradeneeded=()=>{const s=q.result.createObjectStore('jobs',{keyPath:'id'});s.createIndex('createdAt','createdAt');};
      q.onerror=()=>{opening=null;reject(q.error);};
      q.onblocked=()=>{opening=null;reject(new Error('数据库升级被其他插件页面阻挡，请关闭后重试。'));};
      q.onsuccess=()=>{const db=q.result;db.onversionchange=()=>{db.close();opening=null;};resolve(db);};
    });
    return opening;
  }
  async function transaction(mode,fn) {
    const db=await open();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('jobs',mode),store=tx.objectStore('jobs');let result,problem;
      const fail=e=>{problem=e;try{tx.abort();}catch{};};
      tx.oncomplete=()=>resolve(result);
      tx.onabort=()=>reject(problem||tx.error||new Error('本地数据写入失败。'));
      tx.onerror=()=>{};
      const q=store.getAll();q.onerror=()=>fail(q.error);
      q.onsuccess=()=>{try{result=fn(q.result,store);}catch(e){fail(e);}};
    });
  }
  function cleanText(v,max,name) {
    if(typeof v!=='string'||!v.trim()||v.length>max) throw new Error(name+'不能为空或超过 '+max+' 字符。');
    return v.trim();
  }
  function newRow(r,source='手动') {
    const now=Date.now();
    return {id:cleanText(r.id||crypto.randomUUID(),500,'ID'),prompt:cleanText(r.prompt,100000,'提示词'),
      createdAt:now,updatedAt:now,uploadedAt:now,source:source,status:'pending',size:'',generatedAt:null,
      retryCount:0,mediaIds:[],failReason:'',nextRetryAt:0,lockToken:'',workerId:'',leaseUntil:0,revision:1};
  }
  function unlock(r){r.lockToken='';r.workerId='';r.leaseUntil=0;}
  function touch(r){r.revision++;r.updatedAt=Date.now();}
  function protect(r){if(active(r) && Date.now()-(r.processingStartedAt||r.updatedAt||r.createdAt)<120000)throw new Error('任务生成未满两分钟，暂时不能手动修改。');}
  async function upload(rows,source='Opal') {
    if(!Array.isArray(rows)||!rows.length||rows.length>1000)throw new Error('每批需要 1–1000 条提示词。');
    const prepared=rows.map(r=>newRow(r,source));
    return transaction('readwrite',(all,store)=>{
      all.sort((a,b)=>(a.queueOrder||a.createdAt)-(b.queueOrder||b.createdAt)||a.id.localeCompare(b.id));let order=0;for(const old of all){old.queueOrder=++order;store.put(old);}const ids=new Set(all.map(r=>r.id));let inserted=0,skipped=0;
      for(const r of prepared){if(ids.has(r.id)){skipped++;continue;}r.queueOrder=++order;store.add(r);ids.add(r.id);inserted++;}
      return {ok:true,inserted,skipped};
    });
  }
  async function claim(workerId,p={}) {
    if(!workerId)throw new Error('缺少任务执行器标识。');
    return transaction('readwrite',(all,store)=>{
      const now=Date.now();all.sort((a,b)=>(a.queueOrder||a.createdAt)-(b.queueOrder||b.createdAt)||a.id.localeCompare(b.id));
      for(const r of all){
        if(r.status==='processing' && !active(r,now)){
          r.status='interrupted';r.failReason='页面关闭或心跳中断，请确认 Flow 结果后再手动重新排队。';unlock(r);touch(r);store.put(r);continue;
        }
        if(!['pending','failed'].includes(r.status)||r.nextRetryAt>now||(p.excludePrompts||[]).some(v=>String(v).replace(/\s+/g,' ').trim()===r.prompt.replace(/\s+/g,' ').trim()))continue;
        r.processingStartedAt=now;r.status='processing';r.workerId=workerId;r.lockToken=crypto.randomUUID();r.leaseUntil=now+LEASE;r.failReason='';touch(r);store.put(r);
        return {ok:true,job:{id:r.id,jobId:r.id,prompt:r.prompt,retryCount:r.retryCount,lockToken:r.lockToken}};
      }
      return {ok:true,job:null};
    });
  }
  async function settle(action,p,workerId){
    return transaction('readwrite',(all,store)=>{
      const r=all.find(r=>r.id===p.jobId);
      if(!r)throw new Error('任务不存在。');
      if(action!=='heartbeat' && r.receipt?.action===action && r.receipt?.token===p.lockToken && r.receipt?.worker===workerId && r.receipt?.revision===r.revision) return {ok:true,retryCount:r.retryCount};
      if(!active(r)||r.workerId!==workerId||!p.lockToken||r.lockToken!==p.lockToken)return {ok:false,code:'STALE_JOB',error:'任务已被手动修改或锁已过期'};
      if(action==='heartbeat'){r.leaseUntil=Date.now()+LEASE;store.put(r);return {ok:true};}
      else if(action==='completeJob'){
        r.status='success';r.size=String(p.size||'').slice(0,100);r.generatedAt=Date.now();
        r.mediaIds=Array.isArray(p.mediaIds)?p.mediaIds.slice(0,100).map(s=>String(s).slice(0,4096)):[];
        r.failReason='';r.nextRetryAt=0;unlock(r);
      }else if(action==='failJob'){
        r.status='failed';r.generatedAt=Date.now();r.retryCount++;r.nextRetryAt=Date.now()+COOLDOWN;r.failReason=String(p.reason||'生成失败').slice(0,2000);unlock(r);
      }else if(action==='interruptJob'){r.status='interrupted';r.failReason=String(p.reason||'生成结果待确认').slice(0,2000);unlock(r);}
      else if(action==='releaseJob'){r.status='pending';unlock(r);}
      else throw new Error('不支持的任务操作。');
      touch(r);if(action!=='heartbeat')r.receipt={action,token:p.lockToken,worker:workerId,revision:r.revision};store.put(r);return {ok:true,retryCount:r.retryCount};
    });
  }
  function stats(all){
    const s={ok:true,total:all.length,success:0,fail:0,eligible:0,processing:0,interrupted:0,pending:0};const now=Date.now();
    for(const r of all){const status=effective(r,now);if(status==='success')s.success++;if(status==='failed')s.fail++;if(status==='pending')s.pending++;if(status==='processing')s.processing++;if(status==='interrupted')s.interrupted++;if(['pending','failed'].includes(status)&&r.nextRetryAt<=now)s.eligible++;}return s;
  }
  async function getStats(){return transaction('readonly',all=>stats(all));}
  async function list(p={}){return transaction('readonly',all=>{
    const q=String(p.query||'').toLowerCase(),filter=p.status||'all';
    const filtered=all.filter(r=>(filter==='all'||effective(r)===filter)&&(!q||(r.prompt+' '+r.id).toLowerCase().includes(q)));
    filtered.sort((a,b)=>(a.queueOrder||a.createdAt)-(b.queueOrder||b.createdAt)||a.id.localeCompare(b.id));
    const page=Math.max(1,Math.min(Number(p.page)||1,Math.max(1,Math.ceil(filtered.length/50))));
    const rows=filtered.slice((page-1)*50,page*50).map(r=>({...r,status:effective(r),lockToken:undefined,workerId:undefined}));
    return {ok:true,rows,page,total:filtered.length,pages:Math.max(1,Math.ceil(filtered.length/50)),stats:stats(all)};
  });}
  async function edit(p){return transaction('readwrite',(all,store)=>{
    const r=all.find(r=>r.id===p.id);if(!r)throw new Error('任务不存在。');protect(r);
    if(p.revision!==r.revision)throw new Error('这条数据已发生变化，请关闭编辑框、刷新后重新编辑。');
    const prompt=cleanText(p.prompt,100000,'提示词');
    if(!['pending','success','failed','interrupted'].includes(p.status))throw new Error('状态无效。');
    r.prompt=prompt;r.status=p.status;r.size=String(p.size||'').slice(0,100);r.failReason=String(p.failReason||'').slice(0,2000);unlock(r);
    if(p.status==='pending'){r.retryCount=0;r.nextRetryAt=0;r.generatedAt=null;r.mediaIds=[];r.size='';r.failReason='';}
    if(p.status==='success'){r.generatedAt=r.generatedAt||Date.now();r.nextRetryAt=0;}
    if(p.status==='failed')r.nextRetryAt=Date.now()+COOLDOWN;
    touch(r);store.put(r);return {ok:true};
  });}
  async function bulk(p,remove){
    if(!Array.isArray(p.items)||!p.items.length)throw new Error('请先选择数据。');
    return transaction('readwrite',(all,store)=>{
      const map=new Map(all.map(r=>[r.id,r]));
      const selected=p.items.map(i=>{const r=map.get(i.id);if(!r)throw new Error('所选数据已被删除，请刷新。');protect(r);if(r.revision!==i.revision)throw new Error('所选数据状态已更新，请刷新后重试。');return r;});
      for(const r of selected){if(remove)store.delete(r.id);else{r.status='pending';r.retryCount=0;r.nextRetryAt=0;r.generatedAt=null;r.mediaIds=[];r.size='';r.failReason='';unlock(r);touch(r);store.put(r);}}
      return {ok:true,count:selected.length};
    });
  }
  async function exportData(){return transaction('readonly',all=>({ok:true,backup:{format:'opal-flow-local',version:1,exportedAt:new Date().toISOString(),jobs:all.sort((a,b)=>(a.queueOrder||a.createdAt)-(b.queueOrder||b.createdAt)||a.id.localeCompare(b.id)).map(r=>{const copy={...r};if(copy.status==='processing'){copy.status='interrupted';copy.failReason='从备份恢复的未完成任务，请确认结果后重新排队。';}unlock(copy);delete copy.receipt;return copy;})}}));}
  async function importData(backup){
    if(backup?.format!=='opal-flow-local'||backup.version!==1||!Array.isArray(backup.jobs)||backup.jobs.length>50000)throw new Error('请选择本插件导出的 JSON 备份（最多 5 万条）。');
    const date=(v,fallback)=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:fallback;
    const prepared=backup.jobs.map(v=>{
      const r=newRow(v,String(v.source||'导入').slice(0,100));
      r.status=statuses.includes(v.status)?v.status:'pending';if(r.status==='processing')r.status='interrupted';
      r.createdAt=date(v.createdAt,r.createdAt);r.uploadedAt=date(v.uploadedAt,r.createdAt);r.generatedAt=date(v.generatedAt,null);
      r.retryCount=Math.max(0,Math.min(1000000,Math.floor(Number(v.retryCount)||0)));r.nextRetryAt=date(v.nextRetryAt,0);
      r.size=String(v.size||'').slice(0,100);r.failReason=String(v.failReason||'').slice(0,2000);
      r.mediaIds=Array.isArray(v.mediaIds)?v.mediaIds.slice(0,100).map(s=>String(s).slice(0,4096)):[];return r;
    });
    return transaction('readwrite',(all,store)=>{
      all.sort((a,b)=>(a.queueOrder||a.createdAt)-(b.queueOrder||b.createdAt)||a.id.localeCompare(b.id));let order=0;for(const old of all){old.queueOrder=++order;store.put(old);}const ids=new Set(all.map(r=>r.id));let inserted=0,skipped=0;
      for(const r of prepared){if(ids.has(r.id)){skipped++;continue;}r.queueOrder=++order;store.add(r);ids.add(r.id);inserted++;}return {ok:true,inserted,skipped};
    });
  }
  async function dispatch(action,p={},workerId=''){
    switch(action){case 'uploadRows':return upload(p.rows,p.source||'Opal');case 'claimJob':return claim(workerId,p);case 'checkJobs':return transaction('readonly',all=>({ok:true,jobs:all.filter(r=>active(r)&&r.workerId===workerId).map(r=>({id:r.id,lockToken:r.lockToken}))}));case 'heartbeat':case 'completeJob':case 'failJob':case 'releaseJob':case 'interruptJob':return settle(action,p,workerId);case 'getStats':return getStats();case 'list':return list(p);case 'edit':return edit(p);case 'delete':return bulk(p,true);case 'requeue':return bulk(p,false);case 'export':return exportData();case 'import':return importData(p.backup);default:throw new Error('未知本地数据操作。');}
  }
  return {dispatch,open,NAME};
})();
if(typeof module!=='undefined')module.exports=LocalQueue;
