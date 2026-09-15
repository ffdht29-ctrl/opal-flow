'use strict';
const $=id=>document.getElementById(id);
const labels={pending:'待生成',processing:'生成中',success:'成功',failed:'失败',interrupted:'待确认'};
let dragSelection=null;
let page=1,rows=[],selection=new Map(),editing=null,anchor=null,queryTimer,busy=false,loading=false;
const stamp=v=>v?new Date(v).toLocaleString():'—';
const tell=s=>{$('notice').textContent=s;};
async function db(action,payload={}){const r=await chrome.runtime.sendMessage({type:'LOCAL_DB',action,payload});if(!r?.ok)throw new Error(r?.error||'本地数据库无响应，请重新加载插件。');return r;}
function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
const locked=r=>r.status==='processing'&&Date.now()-(r.processingStartedAt||r.updatedAt||r.createdAt)<120000;
const eligible=()=>rows.filter(r=>!locked(r));
function selected(){
 const available=eligible();
 $('selected').textContent=selection.size?'已选择 '+selection.size+' 条':'未选择';
 $('all').checked=available.length>0&&available.every(r=>selection.has(r.id));
 $('all').indeterminate=selection.size>0&&!$('all').checked;
 $('all').disabled=!available.length||!!editing;
 $('delete').disabled=$('requeue').disabled=!selection.size||!!editing;
 document.querySelectorAll('.promptcard').forEach((card,i)=>{const on=selection.has(rows[i].id);card.classList.toggle('is-selected',on);card.querySelector('input[type=checkbox]').checked=on;card.querySelector('select').disabled=!!editing||locked(rows[i]);});
}
function choose(index,event){
 if(editing||busy||loading||locked(rows[index]))return;
 const row=rows[index];
 if(event.shiftKey&&anchor!==null){
  if(!event.ctrlKey&&!event.metaKey)selection.clear();
  for(let i=Math.min(anchor,index);i<=Math.max(anchor,index);i++)if(!locked(rows[i]))selection.set(rows[i].id,{id:rows[i].id,revision:rows[i].revision});
 }else{
  if(selection.has(row.id))selection.delete(row.id);else selection.set(row.id,{id:row.id,revision:row.revision});
  anchor=index;
 }
 selected();
}
function toggleAll(){if(editing||busy||loading)return;const all=eligible();const clear=all.every(r=>selection.has(r.id));selection.clear();if(!clear)all.forEach(r=>selection.set(r.id,{id:r.id,revision:r.revision}));anchor=null;selected();}
function autoHeight(area){area.style.height='auto';area.style.height=(area.scrollHeight+2)+'px';}
function cardFor(row,index){
 const card=node('article',undefined,'promptcard');card.tabIndex=0;card.setAttribute('aria-label','提示词 '+(index+1));
 const head=node('div',undefined,'cardhead'),check=node('input');check.type='checkbox';check.disabled=locked(row);check.setAttribute('aria-label','选择提示词 '+(index+1));
 check.onclick=e=>{e.stopPropagation();choose(index,e);selected();};
 head.append(check,node('div',row.id,'id'),node('span',stamp(row.uploadedAt),'stamp'),node('span',labels[row.status]||row.status,'badge '+row.status));
 const preview=node('div',row.prompt,'promptpreview');preview.title=locked(row)?'生成未满两分钟，暂时不能编辑':'双击编辑完整提示词';
 const meta=node('div',undefined,'cardmeta');if(row.retryCount)meta.append(node('span','重试 '+row.retryCount));if(row.failReason)meta.append(node('span',row.failReason));
 const topmeta=node('div',undefined,'headmeta');topmeta.append(node('span','尺寸 '+(row.size||'—')),node('span','生成时间 '+stamp(row.generatedAt)));head.insertBefore(topmeta,head.querySelector('.stamp'));
 const state=node('select');state.setAttribute('aria-label','修改任务状态');
 for(const [value,label] of Object.entries(labels)){const option=node('option',label);option.value=value;option.disabled=value==='processing';state.append(option);}
 state.value=row.status;state.disabled=locked(row);state.title=locked(row)?'领取任务两分钟后可手动更改状态':'手动修改状态';
 state.onclick=e=>e.stopPropagation();state.ondblclick=e=>e.stopPropagation();
 state.onchange=()=>action(async()=>{try{await db('edit',{id:row.id,revision:row.revision,prompt:row.prompt,status:state.value,size:row.size,failReason:row.failReason});tell('状态已更新，旧任务结果不会覆盖手动修改。');}finally{await refresh();}});
 head.append(state);card.append(head,preview,meta);
 card.onclick=e=>{if(e.target.closest('button,textarea,input,select')||editing)return;if(e.shiftKey||!window.getSelection()?.toString())choose(index,e);};
 card.ondblclick=e=>{if(!e.target.closest('button,textarea,input,select'))openInline(row,card);};
 card.onkeydown=e=>{if(e.target!==card)return;if(e.key===' '){e.preventDefault();choose(index,e);}};
 return card;
}
async function refresh(){
 if(dragSelection||loading||editing||$('editor').open)return;loading=true;
 try{
 const r=await db('list',{page,query:$('query').value,status:$('filter').value});
 if(editing||$('editor').open)return;
 const kept=new Set(selection.keys());rows=r.rows;page=r.page;selection.clear();for(const row of rows)if(kept.has(row.id)&&!locked(row))selection.set(row.id,{id:row.id,revision:row.revision});
 $('stats').replaceChildren(...[['全部',r.stats.total],['待生成',r.stats.pending],['生成中',r.stats.processing],['成功',r.stats.success],['失败',r.stats.fail],['待确认',r.stats.interrupted]].map(([name,value])=>{const div=node('div',undefined,'stat');div.append(node('span',name),node('strong',String(value??0)));return div;}));
 $('rows').replaceChildren(...rows.map(cardFor));selected();
 $('empty').hidden=rows.length>0;$('empty').textContent=$('query').value||$('filter').value!=='all'?'没有符合筛选条件的提示词。':'还没有提示词。先在 Opal 中提取，或者点击“添加提示词”。';
 $('page').textContent=`第 ${page} / ${r.pages} 页 · ${r.total} 条`;$('prev').disabled=page<=1;$('next').disabled=page>=r.pages;
 }catch(e){tell(e.message);}finally{loading=false;}
}
async function action(fn){if(busy||editing)return;busy=true;try{await fn();}catch(e){tell(e.message);}finally{busy=false;}}
function lockNavigation(on){['add','refresh','query','filter','import','prev','next'].forEach(id=>$(id).disabled=on);if(!on){$('prev').disabled=page<=1;$('next').disabled=page>=Number($('page').textContent.match(/\/ (\d+)/)?.[1]||1);}selected();}
function openInline(row,card){
 if(editing||busy||loading||locked(row))return;
 clearTimeout(queryTimer);window.getSelection()?.removeAllRanges();
 const preview=card.querySelector('.promptpreview'),area=node('textarea',undefined,'inline-editor');area.value=row.prompt;area.maxLength=100000;area.setAttribute('aria-label','编辑完整提示词');
 const actions=node('div',undefined,'inline-actions'),save=node('button','保存'),cancel=node('button','取消','secondary'),error=node('p',undefined,'inline-error');error.setAttribute('role','alert');
 actions.append(cancel,save,node('span',row.status==='processing'?'Ctrl+Enter 保存 · Esc 取消；保存后重新排队':'Ctrl+Enter 保存 · Esc 取消；保留原任务状态'));
 preview.hidden=true;card.insertBefore(area,preview);card.append(actions,error);card.classList.add('is-editing');editing={row,area};lockNavigation(true);autoHeight(area);area.focus();
 area.oninput=()=>autoHeight(area);
 function close(){area.remove();actions.remove();error.remove();preview.hidden=false;card.classList.remove('is-editing');editing=null;lockNavigation(false);card.focus();}
 cancel.onclick=close;
 save.onclick=async()=>{
  if(busy)return;if(!area.value.trim()){error.textContent='提示词不能为空。';return;}
  if(area.value===row.prompt){close();return;}
  busy=true;save.disabled=cancel.disabled=true;
  try{await db('edit',{id:row.id,revision:row.revision,prompt:area.value,status:row.status==='processing'?'pending':row.status,size:row.size||'',failReason:row.failReason||''});close();tell(row.status==='processing'?'提示词已保存并重新排队。':'提示词已保存，任务状态保持不变。');await refresh();}
  catch(e){error.textContent=e.message;}finally{busy=false;save.disabled=cancel.disabled=false;}
 };
 area.onkeydown=e=>{if(e.isComposing)return;if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(!busy)close();}else if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();save.click();}};
}
function appendAddRow(value=''){
 const tr=node('tr'),number=node('td',String($('addRows').children.length+1)),td=node('td'),area=node('textarea');area.value=value;area.maxLength=100000;area.rows=3;area.placeholder='在此输入或粘贴一条完整提示词（可多行）';area.setAttribute('aria-label','提示词 '+number.textContent);td.append(area);tr.append(number,td);$('addRows').append(tr);
 area.oninput=()=>{autoHeight(area);if(area.value.trim()&&tr===$('addRows').lastElementChild)appendAddRow();};
 // Only structured spreadsheet HTML is split into cells. Plain text, including
 // all newlines and blank lines, always remains one prompt.
 area.onpaste=e=>{
  const html=e.clipboardData?.getData('text/html');if(!html)return;
  const doc=new DOMParser().parseFromString(html,'text/html'),table=doc.querySelector('table');if(!table)return;
  const cells=[...table.rows].flatMap(r=>[...r.cells]);if(cells.length<2)return;
  function cellText(cell){const copy=cell.cloneNode(true);copy.querySelectorAll('br').forEach(br=>br.replaceWith('\n'));copy.querySelectorAll('p,div').forEach(el=>el.append('\n'));return copy.textContent.replace(/\r\n/g,'\n').replace(/\n$/,'');}
  const values=cells.map(cellText);if(values.some(v=>v.length>100000)){$('editError').textContent='有单元格超过 100000 字符，请缩短后粘贴。';e.preventDefault();return;}
  if(area.value)return; // Never overwrite an existing cell with a table paste.
  e.preventDefault();area.value=values[0];let cursor=tr;
  values.slice(1).forEach(value=>{const added=appendAddRow(value);cursor.after(added);cursor=added;});
  [...$('addRows').rows].forEach((r,i)=>{r.cells[0].textContent=String(i+1);const t=r.querySelector('textarea');t.setAttribute('aria-label','提示词 '+(i+1));autoHeight(t);});
  if($('addRows').lastElementChild.querySelector('textarea').value.trim())appendAddRow();autoHeight(area);
 };
 requestAnimationFrame(()=>autoHeight(area));return tr;
}
$('add').onclick=()=>{if(editing||busy)return;$('addRows').replaceChildren();for(let i=0;i<5;i++)appendAddRow();$('editError').textContent='';$('editor').showModal();$('addRows').querySelector('textarea')?.focus();};
$('cancel').onclick=()=>{if(!busy)$('editor').close();};
$('editor').addEventListener('cancel',e=>{if(busy)e.preventDefault();});
$('editForm').onsubmit=async e=>{
 e.preventDefault();if(busy)return;
 const prompts=[...$('addRows').querySelectorAll('textarea')].map(t=>t.value).filter(v=>v.trim());
 if(!prompts.length){$('editError').textContent='请至少填写一条提示词。';return;}
 busy=true;$('save').disabled=$('cancel').disabled=true;const areas=[...$('addRows').querySelectorAll('textarea')];areas.forEach(t=>t.disabled=true);
 try{await db('uploadRows',{source:'手动',rows:prompts.map(prompt=>({id:crypto.randomUUID(),prompt}))});$('editor').close();tell('已保存 '+prompts.length+' 条提示词。');await refresh();}
 catch(err){$('editError').textContent=err.message;}finally{busy=false;$('save').disabled=$('cancel').disabled=false;areas.forEach(t=>t.disabled=false);}
};
$('refresh').onclick=refresh;
$('query').oninput=()=>{clearTimeout(queryTimer);queryTimer=setTimeout(()=>{page=1;selection.clear();anchor=null;refresh();},300);};$('filter').onchange=()=>{page=1;selection.clear();anchor=null;refresh();};
$('prev').onclick=()=>{if(!loading){page--;selection.clear();anchor=null;refresh();}};$('next').onclick=()=>{if(!loading){page++;selection.clear();anchor=null;refresh();}};
$('all').onchange=toggleAll;
$('delete').onclick=()=>action(async()=>{if(!selection.size)return;const r=await db('delete',{items:[...selection.values()]});tell('已删除 '+r.count+' 条。');await refresh();});
$('requeue').onclick=()=>action(async()=>{if(!selection.size)throw new Error('请先选择任务。');if(!confirm(`将选中的 ${selection.size} 条重新排队？会清除结果记录，正在运行的 Flow 可立即领取。`))return;const r=await db('requeue',{items:[...selection.values()]});tell('已重新排队 '+r.count+' 条。');await refresh();});
function isTextTarget(target){return target instanceof Element&&!!target.closest('textarea,input:not([type=checkbox]),select,[contenteditable]:not([contenteditable=false])');}
document.addEventListener('keydown',e=>{
 if(e.isComposing||e.repeat||isTextTarget(e.target)||$('editor').open||editing||busy||loading)return;
 if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='a'){e.preventDefault();window.getSelection()?.removeAllRanges();toggleAll();}
 else if(e.key==='Escape'){selection.clear();anchor=null;selected();}
 else if(e.key==='Delete'&&selection.size){e.preventDefault();$('delete').click();}
});
window.addEventListener('resize',()=>{if(editing)autoHeight(editing.area);if($('editor').open)$('addRows').querySelectorAll('textarea').forEach(autoHeight);});

function download(name,text,type){const url=URL.createObjectURL(new Blob([text],{type}));const a=node('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
const filename=ext=>'opal-flow-'+new Date().toISOString().replace(/[:.]/g,'-')+'.'+ext;
$('export').onclick=()=>action(async()=>{const {backup}=await db('export');download(filename('json'),JSON.stringify(backup,null,2),'application/json');tell('已导出全部 '+backup.jobs.length+' 条任务为 JSON 备份。');});
$('csv').onclick=()=>action(async()=>{
 const {backup}=await db('export');const escape=v=>{let s=String(v??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
 const data=[['ID','提示词','提示上传时间','GoogleFlow是否使用','尺寸','生成时间','Flow是否生成成功','重试次数','失败原因','MediaIds'],...backup.jobs.map(r=>[r.id,r.prompt,stamp(r.uploadedAt),r.status==='success'?'已使用':'',r.size,stamp(r.generatedAt),labels[r.status],r.retryCount,r.failReason,r.mediaIds.join('\n')])];
 download(filename('csv'),'\uFEFF'+data.map(r=>r.map(escape).join(',')).join('\r\n'),'text/csv;charset=utf-8');tell('已导出全部任务为 CSV，可用 Excel 查看。恢复数据请使用 JSON 备份。');
});
$('import').onclick=()=>$('file').click();$('file').onchange=()=>action(async()=>{try{const f=$('file').files[0];if(!f)return;if(f.size>50*1024*1024)throw new Error('备份超过 50 MB，请分批处理。');const backup=JSON.parse(await f.text());if(!confirm('导入此 JSON 备份？相同 ID 会跳过，不覆盖已有数据。'))return;const r=await db('import',{backup});tell(`已导入 ${r.inserted} 条，跳过已有 ID ${r.skipped} 条。`);await refresh();}finally{$('file').value='';}});

const timer=setInterval(()=>{if(!busy&&!loading&&!editing&&!$('editor').open&&!isTextTarget(document.activeElement))refresh();},1000);window.addEventListener('unload',()=>clearInterval(timer));refresh();

// Marquee selection toggles intersected rows against the starting snapshot.
let suppressDragClick=false;
$('rows').addEventListener('click',e=>{if(suppressDragClick){e.preventDefault();e.stopImmediatePropagation();suppressDragClick=false;}},true);
$('rows').addEventListener('pointerdown',e=>{
 if(e.button!==0||editing||busy||loading||e.target.closest('button,input,select,textarea'))return;
 dragSelection={id:e.pointerId,x:e.clientX,y:e.clientY,pageY:e.pageY,base:new Map(selection),active:false,box:null,lastX:e.clientX,lastY:e.clientY};
});
function drawMarquee(){
 const d=dragSelection;if(!d?.active)return;
 const x=Math.min(d.x,d.lastX),y=Math.min(d.pageY-window.scrollY,d.lastY),w=Math.abs(d.x-d.lastX),h=Math.abs(d.pageY-window.scrollY-d.lastY);
 Object.assign(d.box.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px'});
 selection=new Map(d.base);
 document.querySelectorAll('.promptcard').forEach((card,i)=>{
  const r=card.getBoundingClientRect(),row=rows[i];
  if(!locked(row)&&r.right>x&&r.left<x+w&&r.bottom>y&&r.top<y+h){
   if(d.base.has(row.id))selection.delete(row.id);else selection.set(row.id,{id:row.id,revision:row.revision});
  }
 });selected();
}
function scrollMarquee(){
 const d=dragSelection;if(!d?.active)return;
 if(d.lastY<45)window.scrollBy(0,-12);else if(d.lastY>innerHeight-45)window.scrollBy(0,12);
 drawMarquee();d.raf=requestAnimationFrame(scrollMarquee);
}
window.addEventListener('pointermove',e=>{
 const d=dragSelection;if(!d||d.id!==e.pointerId)return;
 d.lastX=e.clientX;d.lastY=e.clientY;
 if(!d.active&&Math.hypot(e.clientX-d.x,e.clientY-d.y)>6){
  d.active=true;d.box=node('div',undefined,'selection-marquee');document.body.append(d.box);scrollMarquee();
 }
 if(d.active){e.preventDefault();drawMarquee();}
},{passive:false});
function endMarquee(cancel=false){
 const d=dragSelection;if(!d)return;
 if(d.active){cancelAnimationFrame(d.raf);d.box.remove();suppressDragClick=true;setTimeout(()=>suppressDragClick=false,0);if(cancel){selection=d.base;selected();}}
 dragSelection=null;
}
window.addEventListener('pointerup',()=>endMarquee());
window.addEventListener('pointercancel',()=>endMarquee(true));
window.addEventListener('blur',()=>endMarquee(true));
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&dragSelection){e.preventDefault();e.stopImmediatePropagation();endMarquee(true);}},true);
