// Applies only to downloads initiated by this extension. Other downloads are untouched.
const opalRequestedNames = new Map();
chrome.downloads.onDeterminingFilename.addListener((item,suggest)=>{
  if(item.byExtensionId!==chrome.runtime.id){suggest();return;}
  const requested=opalRequestedNames.get(item.url);
  if(requested){opalRequestedNames.delete(item.url);suggest({filename:requested,conflictAction:'uniquify'});return;}
  // Service worker may have restarted after initiating the download.
  chrome.storage.local.get(null).then(records=>{
    const record=Object.entries(records).find(([key,value])=>key.startsWith('opalDownload:')&&value?.id===item.id)?.[1];
    if(record?.filename)suggest({filename:record.filename,conflictAction:'uniquify'});else suggest();
  }).catch(()=>suggest());
  return true;
});
// 同一时间处理一个下载，避免多个节点重复下载。
let opalDownloadChain = Promise.resolve();

function opalImageKey(url) {
  const u = new URL(url);

  if (
    u.origin !== 'https://opal.google' ||
    !/^\/board\/blobs\/[a-zA-Z0-9-]+$/.test(u.pathname)
  ) {
    throw new Error('不是有效的 Opal 图片资源地址。');
  }

  return 'opalDownload:' + u.pathname.split('/').pop();
}

function opalDateFolder() {
  const d = new Date();
  const date = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  ].join('-');

  return `opal图片 ${date}`;
}

// 比较实际所在文件夹；允许浏览器给重名文件添加 (1)。
function opalFolderMatches(actualFilename, requestedFilename) {
  if (!actualFilename || !requestedFilename) return false;

  const normalize = value => String(value).replace(/\\/g, '/');
  const actual = normalize(actualFilename);
  const requested = normalize(requestedFilename);

  const actualParent = actual.slice(0, actual.lastIndexOf('/'));
  const expectedParent = requested.slice(
    0,
    requested.lastIndexOf('/')
  );

  if (!expectedParent) return false;

  return (
    actualParent === expectedParent ||
    actualParent.endsWith('/' + expectedParent)
  );
}

// 查询真实下载状态，并验证保存位置。
async function opalInspectRecord(key, record) {
  if (!record) {
    return { ok: true, complete: false, pending: false };
  }

  const items = record.id !== undefined
    ? await chrome.downloads.search({ id: record.id })
    : [];

  const item = items[0];

  if (!item) {
    // 下载历史已清除时，只信任之前核对过实际路径的记录。
    if (
      record.state === 'complete' &&
      record.folderVerified === true &&
      opalFolderMatches(record.actualFilename, record.filename)
    ) {
      return { ok: true, complete: true, pending: false };
    }

    return {
      ok: false,
      error: '这张图片有旧下载记录，但无法核实保存位置。请先检查浏览器下载目录；可用新生成的图片测试。'
    };
  }

  if (item.state === 'in_progress') {
    return { ok: true, complete: false, pending: true };
  }

  if (item.state === 'interrupted') {
    await chrome.storage.local.remove(key);
    return { ok: true, complete: false, pending: false };
  }

  if (item.state !== 'complete') {
    return { ok: true, complete: false, pending: true };
  }

  const matched = opalFolderMatches(
    item.filename,
    record.filename
  );

  await chrome.storage.local.set({
    [key]: {
      ...record,
      state: matched ? 'complete' : 'path_mismatch',
      actualFilename: item.filename,
      folderVerified: matched
    }
  });

  if (!matched) {
    return {
      ok: false,
      error:
        '图片已经下载，但没有保存到指定文件夹。\n' +
        '要求路径：' + record.filename + '\n' +
        '实际路径：' + item.filename + '\n' +
        '自动重复下载已停止。可在插件的选择图片窗口中点击“重新保存到文件夹”，手动确认目录；原文件会保留。'
    };
  }

  return {
    ok: true,
    complete: true,
    pending: false,
    id: item.id,
    actualFilename: item.filename
  };
}

async function opalDownloadStatus(url) {
  const key = opalImageKey(url);
  const record = (await chrome.storage.local.get(key))[key];
  return opalInspectRecord(key, record);
}

function opalDownload(url, dataUrl, repair = false) {
  const task = opalDownloadChain.then(async () => {
    const key = opalImageKey(url);
    const old = (await chrome.storage.local.get(key))[key];
    const previous = await opalInspectRecord(key, old);

    if (!previous.ok && !(repair && old?.state === 'path_mismatch')) throw new Error(previous.error);

    if (previous.complete) {
      return { ...previous, skipped: true };
    }

    if (previous.pending) {
      throw new Error('该图片仍在下载，请稍后检查。');
    }

    const match =
      /^data:(image\/(?:png|jpeg|webp|gif|avif));base64,([A-Za-z0-9+/=]+)$/
        .exec(dataUrl || '');

    if (!match || dataUrl.length > 57 * 1024 * 1024) {
      throw new Error('无效或过大的图片数据。');
    }

    const extensions = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/avif': 'avif'
    };

    const imageId = new URL(url).pathname.split('/').pop();
    const filename =
      `${opalDateFolder()}/${imageId}.${extensions[match[1]]}`;

    // Keep the exact request available before onDeterminingFilename can fire.
    opalRequestedNames.set(dataUrl,filename);
    let id;
    try {
      id = await chrome.downloads.download({url:dataUrl,filename,
        saveAs:repair,conflictAction:'uniquify'});
    } catch(e) { opalRequestedNames.delete(dataUrl);throw e; }
    setTimeout(()=>opalRequestedNames.delete(dataUrl),120000);

    const record = {
      id,
      state: 'in_progress',
      filename,
      folderVerified: false
    };

    await chrome.storage.local.set({ [key]: record });

    const start = Date.now();

    while (Date.now() - start < 60000) {
      const result = await opalInspectRecord(key, record);

      if (!result.ok) throw new Error(result.error);

      if (result.complete) {
        return { ...result, id };
      }

      if (!result.pending) {
        throw new Error('图片下载已取消或中断，可以重试。');
      }

      await new Promise(resolve => setTimeout(resolve, 300));
    }

    throw new Error(
      '下载尚未完成，请查看浏览器下载列表。后续检查会继续核对状态，避免重复下载。'
    );
  });

  opalDownloadChain = task.catch(() => {});
  return task;
}