/* -------- Minimal IndexedDB helper -------- */
const DB_NAME = 'igstash-db';
const DB_VER = 1;
const STORE = 'items';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('username', 'username', { unique: false });
        s.createIndex('type', 'type', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbPut(item) {
  const db = await idbOpen();
  return new Promise((res,rej)=>{
    const tx = db.transaction(STORE,'readwrite');
    tx.objectStore(STORE).put(item);
    tx.oncomplete=()=>res();
    tx.onerror=()=>rej(tx.error);
  });
}
async function dbAll() {
  const db = await idbOpen();
  return new Promise((res,rej)=>{
    const tx = db.transaction(STORE,'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess=()=>res(req.result || []);
    req.onerror=()=>rej(req.error);
  });
}
async function dbClear() {
  const db = await idbOpen();
  return new Promise((res,rej)=>{
    const tx = db.transaction(STORE,'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete=()=>res();
    tx.onerror=()=>rej(tx.error);
  });
}

/* -------- UI helpers -------- */
const $ = sel => document.querySelector(sel);
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(()=>{ el.style.display='none'; }, 1600);
}

/* -------- PWA Install prompt (iOS shows Add to Home Screen) -------- */
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $('#btnInstall').style.display = 'inline-block';
});
$('#btnInstall').addEventListener('click', async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt = null;
  } else {
    toast('Use Share → Add to Home Screen');
  }
});

/* -------- Config: Worker URL -------- */
const CFG_KEY = 'igstash-worker-url';
function getWorkerURL() {
  return localStorage.getItem(CFG_KEY) || '';
}
function setWorkerURL(u) {
  localStorage.setItem(CFG_KEY, u.trim());
}
$('#btnConfig').addEventListener('click', () => {
  const cur = getWorkerURL();
  const u = prompt('Enter your Cloudflare Worker URL (e.g. https://yourname.workers.dev)', cur);
  if (u) { setWorkerURL(u); toast('Worker URL saved'); }
});

/* -------- Link categoriser -------- */
function categorise(url) {
  url = url.split('?')[0];
  if (url.includes('/reel/')) return 'Reel';
  if (url.includes('/stories/')) return 'Story';
  if (url.includes('/p/')) return 'Post';
  return 'Unknown';
}

/* -------- Resolve via Worker, then store -------- */
$('#btnResolve').addEventListener('click', async () => {
  const worker = getWorkerURL();
  if (!worker) return toast('Set your Worker URL first');
  const raw = $('#url').value.trim();
  if (!raw) return toast('Paste at least one link');

  // split multiple links by whitespace/newlines
  const links = raw.split(/\s+/).filter(Boolean);
  $('#url').value = '';
  for (const link of links) {
    try {
      await resolveAndSave(worker, link);
    } catch (e) {
      console.error(e);
      toast('Failed: ' + (new URL(link)).pathname);
    }
  }
  await refreshGrid();
  toast('Done');
});

async function resolveAndSave(worker, link) {
  const type = categorise(link);
  const res = await fetch(`${worker}/resolve?url=${encodeURIComponent(link)}`);
  if (!res.ok) throw new Error('Resolve failed');
  const data = await res.json(); // {type, username, title, media:[{url, contentType, filename}]}

  const username = data.username || 'unknown';
  const title = data.title || '';
  const media = data.media || [];

  // Download first media item via proxy and store blob
  for (let i=0; i<media.length; i++) {
    const m = media[i];
    const dl = await fetch(`${worker}/download?u=${encodeURIComponent(m.url)}`);
    if (!dl.ok) continue;
    const blob = await dl.blob();
    const id = `${username}_${Date.now()}_${i}`;
    const thumbURL = (m.contentType || '').startsWith('image/')
      ? URL.createObjectURL(blob)
      : ''; // we will render <video> posterless if empty

    await dbPut({
      id, username,
      type: data.type || type,
      source: link,
      filename: m.filename || `${id}.${mimeToExt(m.contentType)}`,
      contentType: m.contentType || '',
      savedAt: new Date().toISOString(),
      bytes: await blobToBase64(blob), // store base64 so we can rebuild Blob later on iOS
      title
    });
  }
}

function mimeToExt(m) {
  if (!m) return 'bin';
  if (m.includes('jpeg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('webp')) return 'webp';
  return 'bin';
}
function blobToBase64(blob){
  return new Promise((res)=>{
    const r = new FileReader();
    r.onloadend=()=>res(r.result.split(',')[1]);
    r.readAsDataURL(blob);
  });
}
function base64ToBlob(b64, contentType='application/octet-stream'){
  const byteChars = atob(b64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i=0;i<byteChars.length;i++) bytes[i]=byteChars.charCodeAt(i);
  return new Blob([bytes], {type: contentType});
}

/* -------- Grid rendering & filters -------- */
$('#btnClearFilter').addEventListener('click', async () => {
  $('#filterUser').value = '';
  $('#filterType').value = '';
  await refreshGrid();
});
$('#filterUser').addEventListener('change', refreshGrid);
$('#filterType').addEventListener('change', refreshGrid);

$('#btnWipe').addEventListener('click', async () => {
  if (!confirm('Delete your local IG library from this device?')) return;
  await dbClear();
  await refreshGrid();
  toast('Library wiped');
});

$('#btnExport').addEventListener('click', async () => {
  const all = await dbAll();
  const blob = new Blob([JSON.stringify(all,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `igstash-export-${Date.now()}.json`; a.click();
  URL.revokeObjectURL(url);
});

$('#btnImport').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const arr = JSON.parse(text);
  for (const item of arr) await dbPut(item);
  await refreshGrid();
  toast('Imported');
});

async function refreshGrid() {
  const list = await dbAll();
  // populate user filter
  const users = Array.from(new Set(list.map(x=>x.username))).sort();
  const userSel = $('#filterUser');
  const selected = userSel.value;
  userSel.innerHTML = '<option value="">All users</option>' + users.map(u=>`<option value="${u}">${u}</option>`).join('');
  if (users.includes(selected)) userSel.value = selected;

  // filtering
  const uf = $('#filterUser').value;
  const tf = $('#filterType').value;
  const filtered = list
    .filter(x => !uf || x.username === uf)
    .filter(x => !tf || x.type === tf)
    .sort((a,b)=> new Date(b.savedAt)-new Date(a.savedAt));

  // render
  const grid = $('#grid'); grid.innerHTML = '';
  for (const item of filtered) {
    const blob = base64ToBlob(item.bytes, item.contentType);
    const url = URL.createObjectURL(blob);
    const cell = document.createElement('div');
    cell.className = 'cell';

    let mediaHtml = '';
    if ((item.contentType||'').startsWith('image/')) {
      mediaHtml = `<img class="thumb" src="${url}" alt="thumb">`;
    } else if ((item.contentType||'').startsWith('video/')) {
      mediaHtml = `<video class="thumb" src="${url}" playsinline muted loop></video>`;
    } else {
      mediaHtml = `<div class="thumb"></div>`;
    }

    cell.innerHTML = `
      ${mediaHtml}
      <div class="meta">
        <span>@${item.username}</span>
        <span class="tag">${item.type||'Unknown'}</span>
      </div>
      <div class="actions" style="padding:0 10px 10px">
        <button class="ok" data-id="${item.id}" data-act="save">Save</button>
        <button class="outline" data-id="${item.id}" data-act="copy">Copy Link</button>
        <button class="danger" data-id="${item.id}" data-act="del">Delete</button>
      </div>
    `;
    grid.appendChild(cell);

    // button handlers
    cell.querySelectorAll('button').forEach(btn=>{
      btn.addEventListener('click', async () => {
        const act = btn.dataset.act;
        if (act === 'save') {
          const b = base64ToBlob(item.bytes, item.contentType);
          const u = URL.createObjectURL(b);
          const a = document.createElement('a');
          a.href = u; a.download = item.filename || 'download';
          a.click(); URL.revokeObjectURL(u);
        }
        if (act === 'copy') {
          await navigator.clipboard.writeText(item.source);
          toast('Source link copied');
        }
        if (act === 'del') {
          const all = await dbAll();
          const rest = all.filter(x=>x.id!==item.id);
          await dbClear();
          for (const r of rest) await dbPut(r);
          await refreshGrid();
        }
      });
    });
  }
}
refreshGrid();
