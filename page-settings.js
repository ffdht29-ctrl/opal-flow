(() => {
  if (window.PageSettings) return;
  async function request(action, payload) {
    const r=await chrome.runtime.sendMessage({type:'PAGE_SETTINGS',action,...payload});
    if(!r?.ok)throw new Error(r?.error||'无法读取当前页面设置');
    return r.settings||{};
  }
  window.PageSettings={
    async get(keys){const s=await request('get');if(typeof keys==='string')return {[keys]:s[keys]};if(Array.isArray(keys))return Object.fromEntries(keys.map(k=>[k,s[k]]));return {...keys,...s};},
    set(values){return request('set',{values});},
    remove(keys){return request('remove',{keys:Array.isArray(keys)?keys:[keys]});}
  };
})();
