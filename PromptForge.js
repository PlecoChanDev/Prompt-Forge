// ==UserScript==
// @name         Prompt Forge
// @namespace    local.chatgpt.image-mentions
// @version      1.8.2
// @description  Reuse files with @mentions, prompt snippets with #tags, and optional random image pools in ChatGPT.
// @author       You
// @match        https://chatgpt.com/*
// @match        https://www.chatgpt.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const DB_NAME = 'chatgpt-image-mentions';
  const DB_VERSION = 2;
  const STORE_NAME = 'images';
  const TAG_STORE_NAME = 'promptTags';
  const HISTORY_RESTORATIONS_KEY = 'cim-history-restorations';
  const HISTORY_RESTORATIONS_LIMIT = 40;
  const HISTORY_RESTORATIONS_MAX_CHARS = 600000;
  const MARKER_RE = /⟦(?:Image|File) reference @([A-Za-z0-9_-]+): ([^⟧]*?)(?: \[ref:([A-Za-z0-9-]+)\])?⟧/g;
  const TAG_MARKER_RE = /⟦Prompt tag #([A-Za-z0-9_-]+): ([^⟧]*?)(?: \[tag:([A-Za-z0-9-]+)\])?⟧/g;
  const MENTION_RE = /(^|\s)@([A-Za-z0-9_-]+)/g;
  const TAG_RE = /(^|\s)#([A-Za-z0-9_-]+)/g;
  const REFERENCE_RE = /(^|\s)([@#])([A-Za-z0-9_-]+)/g;
  const CHIPPABLE_REFERENCE_RE = /(^|\s)([@#])([A-Za-z0-9_-]+)(?=$|[\s.,!?;:()[\]{}'"“”])/g;
  const SUPPORTED_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'webp', 'gif',
    'pdf', 'doc', 'docx', 'odt', 'rtf',
    'xls', 'xlsx', 'csv', 'tsv', 'ods',
    'ppt', 'pptx', 'odp',
    'txt', 'md', 'markdown', 'html', 'htm', 'xml', 'json', 'jsonl', 'yaml', 'yml',
    'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'php', 'java', 'c', 'h', 'cpp', 'cc', 'cs',
    'go', 'rs', 'swift', 'kt', 'kts', 'scala', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'css',
    'scss', 'sass', 'less', 'vue', 'svelte', 'toml', 'ini', 'cfg', 'log', 'tex',
  ]);
  const FILE_ACCEPT = 'image/*,text/*,.pdf,.doc,.docx,.odt,.rtf,.xls,.xlsx,.csv,.tsv,.ods,.ppt,.pptx,.odp,.md,.markdown,.html,.htm,.xml,.json,.jsonl,.yaml,.yml,.js,.jsx,.ts,.tsx,.py,.rb,.php,.java,.c,.h,.cpp,.cc,.cs,.go,.rs,.swift,.kt,.kts,.scala,.sh,.bash,.zsh,.ps1,.sql,.css,.scss,.sass,.less,.vue,.svelte,.toml,.ini,.cfg,.log,.tex';
  const state = {
    records: [],
    recordById: new Map(),
    recordByNickname: new Map(),
    tags: [],
    tagById: new Map(),
    tagByName: new Map(),
    objectUrls: new Map(),
    autocomplete: { open: false, items: [], selected: 0, query: '' },
    sortMode: ['name', 'date', 'type'].includes(localStorage.getItem('cim-file-sort')) ? localStorage.getItem('cim-file-sort') : 'name',
    tagSortMode: ['name', 'date', 'used'].includes(localStorage.getItem('cim-tag-sort')) ? localStorage.getItem('cim-tag-sort') : 'name',
    pendingFile: null,
    editingId: null,
    editingTagId: null,
    modalTab: 'files',
    sending: false,
    internalSubmit: false,
    pendingPlainRestoration: null,
    historyRestorations: [],
    editingPlainRestorations: new WeakMap(),
    tooltipTimer: null,
    autocompleteTimer: null,
  };

  const ICONS = {
    image: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5zM4 16l4.3-4.3a1 1 0 0 1 1.4 0l2.1 2.1 1.5-1.5a1 1 0 0 1 1.4 0L20 17.6M15.5 8.5h.01"/></svg>',
    file: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 3.5h7l5 5v12H6zM13 3.5v5h5M9 13h6M9 16.5h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    edit: '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="m14.5 5.5 4 4M4 20l3.8-.8L19 8a1.4 1.4 0 0 0 0-2l-1-1a1.4 1.4 0 0 0-2 0L4.8 16.2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  function injectStyles() {
    if (document.querySelector('#cim-styles')) return;
    if (!document.head) return;
    const style = document.createElement('style');
    style.id = 'cim-styles';
    style.textContent = `
      :root { --cim-accent:#10a37f; --cim-accent-soft:rgba(16,163,127,.14); --cim-panel:#fff; --cim-border:rgba(0,0,0,.13); --cim-text:#171717; --cim-muted:#6b6b6b; }
      html.dark { --cim-panel:#2f2f2f; --cim-border:rgba(255,255,255,.14); --cim-text:#ececec; --cim-muted:#aaa; --cim-accent-soft:rgba(16,163,127,.22); }
      .cim-library-button { position:relative; color:var(--cim-text); }
      .cim-mention, .cim-sent-mention { display:inline-flex; align-items:center; gap:4px; padding:1px 7px 2px; margin:0 1px; max-width:180px; border:1px solid rgba(16,163,127,.32); border-radius:999px; color:#078568; background:var(--cim-accent-soft); font-weight:600; line-height:1.35; vertical-align:baseline; cursor:default; box-decoration-break:clone; -webkit-box-decoration-break:clone; }
      html.dark .cim-mention, html.dark .cim-sent-mention { color:#5ee0bd; }
      .cim-mention::before, .cim-sent-mention::before { content:'▧'; font-size:.78em; }
      .cim-modal-backdrop { position:fixed; inset:0; z-index:2147483000; display:grid; place-items:center; padding:20px; background:rgba(0,0,0,.52); backdrop-filter:blur(3px); }
      .cim-hidden { display:none !important; }
      .cim-modal { width:min(760px, 96vw); max-height:min(720px, 90vh); overflow:hidden; display:flex; flex-direction:column; color:var(--cim-text); background:var(--cim-panel); border:1px solid var(--cim-border); border-radius:20px; box-shadow:0 24px 80px rgba(0,0,0,.32); font-family:system-ui,-apple-system,sans-serif; }
      .cim-modal-header { display:flex; align-items:center; justify-content:space-between; padding:18px 20px; border-bottom:1px solid var(--cim-border); }
      .cim-modal-header h2 { margin:0; font-size:18px; }
      .cim-tabs { display:flex; gap:5px; padding:8px 20px; border-bottom:1px solid var(--cim-border); }
      .cim-tabs button { padding:7px 12px; border:0; border-radius:8px; color:var(--cim-muted); background:transparent; font:600 12px/1 system-ui; cursor:pointer; }
      .cim-tabs button:hover, .cim-tabs button[aria-selected="true"] { color:var(--cim-text); background:var(--cim-accent-soft); }
      .cim-icon-button { width:34px; height:34px; display:grid; place-items:center; border:0; border-radius:9px; color:inherit; background:transparent; cursor:pointer; }
      .cim-icon-button:hover { background:rgba(127,127,127,.13); }
      .cim-modal-body { display:grid; grid-template-columns:minmax(250px,.9fr) minmax(300px,1.25fr); min-height:0; overflow:auto; }
      .cim-editor { padding:20px; border-right:1px solid var(--cim-border); }
      .cim-dropzone { min-height:154px; display:grid; place-items:center; padding:16px; text-align:center; border:1.5px dashed var(--cim-border); border-radius:14px; color:var(--cim-muted); cursor:pointer; overflow:hidden; }
      .cim-dropzone:hover, .cim-dropzone.cim-dragging { border-color:var(--cim-accent); background:var(--cim-accent-soft); }
      .cim-dropzone img { width:100%; height:180px; object-fit:contain; border-radius:10px; }
      .cim-selected-file { width:100%; display:grid; place-items:center; gap:8px; min-width:0; }
      .cim-selected-file strong { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--cim-text); font-size:13px; }
      .cim-selected-file small { color:var(--cim-muted); }
      .cim-field { display:block; margin-top:14px; }
      .cim-field span { display:block; margin:0 0 6px; font-size:12px; font-weight:650; }
      .cim-field input, .cim-field textarea { width:100%; box-sizing:border-box; padding:10px 11px; border:1px solid var(--cim-border); border-radius:10px; outline:none; color:var(--cim-text); background:transparent; font:14px/1.4 system-ui; resize:vertical; }
      .cim-field input:focus, .cim-field textarea:focus { border-color:var(--cim-accent); box-shadow:0 0 0 3px var(--cim-accent-soft); }
      .cim-help { margin:6px 0 0; color:var(--cim-muted); font-size:11px; line-height:1.4; }
      .cim-primary { width:100%; margin-top:15px; padding:10px 14px; border:0; border-radius:10px; color:white; background:var(--cim-accent); font-weight:650; cursor:pointer; }
      .cim-primary:disabled { opacity:.45; cursor:not-allowed; }
      .cim-form-actions { display:flex; gap:8px; margin-top:15px; }
      .cim-form-actions .cim-primary { flex:1; width:auto; margin-top:0; }
      .cim-secondary { padding:10px 14px; border:1px solid var(--cim-border); border-radius:10px; color:var(--cim-text); background:transparent; font-weight:650; cursor:pointer; }
      .cim-secondary:hover { background:rgba(127,127,127,.1); }
      .cim-library { min-height:280px; padding:20px; overflow:auto; }
      .cim-library-title { display:flex; align-items:baseline; justify-content:space-between; margin-bottom:12px; }
      .cim-library-title strong { font-size:14px; }
      .cim-library-title span { color:var(--cim-muted); font-size:11px; }
      .cim-library-sort { display:flex; gap:4px; margin:-3px 0 12px; }
      .cim-library-sort button { padding:5px 8px; border:0; border-radius:7px; color:var(--cim-muted); background:transparent; font:600 10px/1.2 system-ui; cursor:pointer; }
      .cim-library-sort button:hover, .cim-library-sort button[aria-pressed="true"] { color:var(--cim-text); background:var(--cim-accent-soft); }
      .cim-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(135px,1fr)); gap:12px; }
      .cim-card { position:relative; min-width:0; padding:8px; border:1px solid var(--cim-border); border-radius:13px; background:transparent; }
      .cim-card > img { width:100%; height:98px; object-fit:cover; border-radius:9px; background:rgba(127,127,127,.1); }
      .cim-file-icon { position:relative; width:100%; height:98px; display:grid; place-items:center; border-radius:9px; color:var(--cim-muted); background:rgba(127,127,127,.1); }
      .cim-file-icon::before { content:''; width:42px; height:52px; border:2px solid currentColor; border-radius:6px; opacity:.6; }
      .cim-file-icon span { position:absolute; max-width:78px; padding:3px 6px; overflow:hidden; text-overflow:ellipsis; border-radius:5px; color:white; background:#5b68d8; font-size:10px; font-weight:750; letter-spacing:.03em; }
      .cim-file-icon[data-type="pdf"] span { background:#d44949; }
      .cim-file-icon[data-type="spreadsheet"] span { background:#2b9565; }
      .cim-file-icon[data-type="presentation"] span { background:#d06b35; }
      .cim-file-icon[data-type="text"] span { background:#667085; }
      .cim-file-icon.cim-file-icon-small { position:relative; width:42px; height:42px; flex:none; }
      .cim-file-icon.cim-file-icon-small::before { width:25px; height:31px; border-width:1.5px; }
      .cim-file-icon.cim-file-icon-small span { max-width:36px; padding:2px 3px; font-size:7px; }
      .cim-selected-file .cim-file-icon { position:relative; width:120px; height:105px; }
      .cim-card-name { margin-top:7px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; font-weight:650; }
      .cim-card-note { height:30px; margin-top:2px; overflow:hidden; color:var(--cim-muted); font-size:10px; line-height:15px; }
      .cim-tag-card { min-height:120px; display:flex; flex-direction:column; }
      .cim-tag-card .cim-card-name { color:#7657d6; }
      html.dark .cim-tag-card .cim-card-name { color:#b9a5ff; }
      .cim-tag-card .cim-card-note { height:72px; display:-webkit-box; overflow-wrap:anywhere; -webkit-box-orient:vertical; -webkit-line-clamp:5; white-space:pre-wrap; }
      .cim-tag-pool-badge { width:max-content; margin-top:auto; padding:3px 7px; border-radius:999px; color:#6747c7; background:rgba(118,87,214,.13); font-size:9px; font-weight:700; }
      html.dark .cim-tag-pool-badge { color:#c9bbff; background:rgba(118,87,214,.22); }
      .cim-tag-glyph { width:42px; height:42px; display:grid; place-items:center; border-radius:8px; color:#7657d6; background:rgba(118,87,214,.13); font-size:23px; font-weight:750; }
      .cim-card-actions { position:absolute; top:12px; right:12px; display:flex; gap:4px; opacity:0; transition:opacity .15s; }
      .cim-card:hover .cim-card-actions, .cim-card:focus-within .cim-card-actions { opacity:1; }
      .cim-card-actions button { width:28px; height:28px; display:grid; place-items:center; border:1px solid rgba(0,0,0,.1); border-radius:8px; color:#222; background:rgba(255,255,255,.92); cursor:pointer; }
      .cim-empty { padding:45px 12px; color:var(--cim-muted); text-align:center; font-size:13px; }
      .cim-autocomplete { position:fixed; z-index:2147483015; width:min(350px,calc(100vw - 24px)); max-height:226px; overflow:hidden; padding:6px; border:1px solid var(--cim-border); border-radius:13px; color:var(--cim-text); background:var(--cim-panel); box-shadow:0 12px 38px rgba(0,0,0,.2); font-family:system-ui,-apple-system,sans-serif; }
      .cim-sortbar { display:flex; align-items:center; gap:3px; padding:1px 2px 6px; margin-bottom:3px; border-bottom:1px solid var(--cim-border); }
      .cim-sortbar span { margin-right:auto; padding-left:5px; color:var(--cim-muted); font-size:10px; font-weight:650; text-transform:uppercase; letter-spacing:.04em; }
      .cim-sortbar button { padding:4px 7px; border:0; border-radius:6px; color:var(--cim-muted); background:transparent; font:600 10px/1.2 system-ui; cursor:pointer; }
      .cim-sortbar button:hover, .cim-sortbar button[aria-pressed="true"] { color:var(--cim-text); background:var(--cim-accent-soft); }
      .cim-options { max-height:186px; overflow:hidden; scrollbar-width:none; }
      .cim-options::-webkit-scrollbar { display:none; width:0; height:0; }
      .cim-option { width:100%; display:grid; grid-template-columns:42px 1fr; gap:10px; align-items:center; padding:7px; border:0; border-radius:9px; color:inherit; background:transparent; text-align:left; cursor:pointer; }
      .cim-option:hover, .cim-option[aria-selected="true"] { background:var(--cim-accent-soft); }
      .cim-option img { width:42px; height:42px; object-fit:cover; border-radius:8px; }
      .cim-option strong, .cim-option small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .cim-option > span:last-child { min-width:0; }
      .cim-option strong { font-size:13px; } .cim-option small { margin-top:2px; color:var(--cim-muted); font-size:11px; }
      .cim-tag-menu-title { padding:5px 8px 8px; margin-bottom:3px; border-bottom:1px solid var(--cim-border); color:var(--cim-muted); font-size:10px; font-weight:650; text-transform:uppercase; letter-spacing:.04em; }
      .cim-tooltip { position:fixed; z-index:2147483010; width:270px; padding:9px; border:1px solid var(--cim-border); border-radius:13px; color:var(--cim-text); background:var(--cim-panel); box-shadow:0 12px 38px rgba(0,0,0,.26); font-family:system-ui,-apple-system,sans-serif; pointer-events:auto; }
      .cim-tooltip img { width:100%; max-height:190px; object-fit:contain; border-radius:9px; background:rgba(127,127,127,.1); cursor:zoom-in; }
      .cim-tooltip .cim-file-icon { position:relative; height:145px; }
      .cim-file-link { display:block; color:inherit; text-decoration:none; cursor:pointer; }
      .cim-tooltip strong { display:block; margin:7px 2px 2px; font-size:13px; }
      .cim-tooltip p { max-height:min(320px,55vh); margin:0 2px 2px; overflow:auto; color:var(--cim-muted); font-size:11px; line-height:1.4; white-space:pre-wrap; }
      .cim-lightbox { position:fixed; inset:0; z-index:2147483020; display:grid; place-items:center; padding:30px; background:rgba(0,0,0,.82); cursor:zoom-out; }
      .cim-lightbox img { max-width:95vw; max-height:92vh; object-fit:contain; border-radius:10px; box-shadow:0 20px 80px #000; }
      .cim-toast { position:fixed; left:50%; bottom:90px; z-index:2147483030; max-width:min(440px,90vw); padding:10px 15px; border-radius:999px; color:white; background:#222; box-shadow:0 8px 28px rgba(0,0,0,.3); font:13px/1.35 system-ui; transform:translateX(-50%); }
      .cim-sending { opacity:.55 !important; pointer-events:none !important; }
      .cim-tag-mention, .cim-sent-tag { display:inline-flex; align-items:center; padding:1px 7px 2px; margin:0 1px; max-width:180px; border:1px solid rgba(118,87,214,.32); border-radius:999px; color:#6747c7; background:rgba(118,87,214,.13); font-weight:600; line-height:1.35; vertical-align:baseline; cursor:default; box-decoration-break:clone; -webkit-box-decoration-break:clone; }
      html.dark .cim-tag-mention, html.dark .cim-sent-tag { color:#b9a5ff; background:rgba(118,87,214,.22); }
      .cim-pool-toggle { display:flex; align-items:flex-start; gap:9px; margin-top:14px; padding:10px; border:1px solid var(--cim-border); border-radius:11px; cursor:pointer; }
      .cim-pool-toggle input { margin-top:3px; accent-color:#7657d6; }
      .cim-pool-toggle span { min-width:0; }
      .cim-pool-toggle strong, .cim-pool-toggle small { display:block; }
      .cim-pool-toggle strong { font-size:12px; }
      .cim-pool-toggle small { margin-top:2px; color:var(--cim-muted); font-size:10px; line-height:1.35; }
      .cim-pool-settings { margin-top:8px; padding:10px; border:1px solid rgba(118,87,214,.25); border-radius:11px; background:rgba(118,87,214,.06); }
      .cim-pool-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; font-size:11px; font-weight:650; }
      .cim-pool-count { display:flex; align-items:center; gap:5px; color:var(--cim-muted); font-size:10px; font-weight:600; }
      .cim-pool-count input { width:48px; padding:4px 5px; border:1px solid var(--cim-border); border-radius:7px; color:var(--cim-text); background:var(--cim-panel); text-align:center; }
      .cim-pool-grid { max-height:156px; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; overflow:auto; }
      .cim-pool-option { min-width:0; display:grid; grid-template-columns:auto 34px minmax(0,1fr); align-items:center; gap:6px; padding:5px; border:1px solid var(--cim-border); border-radius:8px; cursor:pointer; }
      .cim-pool-option:has(input:checked) { border-color:#7657d6; background:rgba(118,87,214,.12); }
      .cim-pool-option input { accent-color:#7657d6; }
      .cim-pool-option img { width:34px; height:34px; object-fit:cover; border-radius:6px; }
      .cim-pool-option span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:10px; font-weight:650; }
      .cim-pool-empty { padding:12px 6px; color:var(--cim-muted); text-align:center; font-size:10px; }
      @media (max-width:680px) { .cim-modal-body { grid-template-columns:1fr; } .cim-editor { border-right:0; border-bottom:1px solid var(--cim-border); } .cim-modal { max-height:94vh; } }
    `;
    document.head.appendChild(style);
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('nicknameLower', 'nicknameLower', { unique: true });
        }
        if (!db.objectStoreNames.contains(TAG_STORE_NAME)) {
          const tagStore = db.createObjectStore(TAG_STORE_NAME, { keyPath: 'id' });
          tagStore.createIndex('nameLower', 'nameLower', { unique: true });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function dbRequest(mode, operation, storeName = STORE_NAME) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const request = operation(tx.objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => db.close();
    });
  }

  async function loadRecords() {
    state.records = await dbRequest('readonly', (store) => store.getAll());
    state.records.sort((a, b) => a.nickname.localeCompare(b.nickname));
    rebuildIndexes();
  }

  async function loadTags() {
    state.tags = await dbRequest('readonly', (store) => store.getAll(), TAG_STORE_NAME);
    state.tags.sort((a, b) => a.name.localeCompare(b.name));
    state.tagById = new Map(state.tags.map((tag) => [tag.id, tag]));
    state.tagByName = new Map(state.tags.map((tag) => [tag.nameLower, tag]));
  }

  function rebuildIndexes() {
    state.recordById = new Map(state.records.map((record) => [record.id, record]));
    state.recordByNickname = new Map(state.records.map((record) => [record.nicknameLower, record]));
  }

  function getObjectUrl(record) {
    if (!record?.blob) return '';
    if (!state.objectUrls.has(record.id)) state.objectUrls.set(record.id, URL.createObjectURL(record.blob));
    return state.objectUrls.get(record.id);
  }

  function releaseObjectUrl(id) {
    const url = state.objectUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    state.objectUrls.delete(id);
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value ?? '';
    return div.innerHTML;
  }

  function truncatePreview(value, limit = 140) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...` : text;
  }

  function loadHistoryRestorations() {
    try {
      const parsed = JSON.parse(localStorage.getItem(HISTORY_RESTORATIONS_KEY) || '[]');
      state.historyRestorations = Array.isArray(parsed)
        ? parsed.filter((entry) => typeof entry?.expandedText === 'string' && Array.isArray(entry.restorations))
        : [];
    } catch (error) {
      state.historyRestorations = [];
      console.error('[Prompt Forge] Could not load history chip metadata', error);
    }
  }

  function rememberHistoryRestoration(restoration) {
    if (!restoration?.expandedText || !restoration.restorations?.length) return;
    const entry = {
      expandedText: restoration.expandedText,
      restorations: restoration.restorations.map((item) => ({
        kind: item.kind, name: item.name, expanded: item.expanded,
        note: item.note || '', text: item.text || '', id: item.id || '',
      })),
      createdAt: Date.now(),
    };
    const candidates = [
      entry,
      ...state.historyRestorations.filter((item) => item.expandedText !== entry.expandedText),
    ];
    const retained = [];
    let totalChars = 0;
    for (const candidate of candidates.slice(0, HISTORY_RESTORATIONS_LIMIT)) {
      const size = JSON.stringify(candidate).length;
      if (retained.length && totalChars + size > HISTORY_RESTORATIONS_MAX_CHARS) break;
      retained.push(candidate);
      totalChars += size;
    }
    state.historyRestorations = retained;
    try {
      localStorage.setItem(HISTORY_RESTORATIONS_KEY, JSON.stringify(retained));
    } catch (error) {
      console.error('[Prompt Forge] Could not persist history chip metadata', error);
    }
  }

  function shortId() {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  }

  function fileExtension(value) {
    const name = typeof value === 'string' ? value : value?.fileName || value?.name || '';
    const match = name.toLocaleLowerCase().match(/\.([^.]+)$/);
    return match ? match[1] : '';
  }

  function fileCategory(value) {
    const extension = fileExtension(value);
    const mime = value?.mimeType || value?.type || value?.blob?.type || '';
    if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) return 'image';
    if (extension === 'pdf' || mime === 'application/pdf') return 'pdf';
    if (['xls', 'xlsx', 'csv', 'tsv', 'ods'].includes(extension) || /spreadsheet|excel|csv/.test(mime)) return 'spreadsheet';
    if (['ppt', 'pptx', 'odp'].includes(extension) || /presentation|powerpoint/.test(mime)) return 'presentation';
    if (['doc', 'docx', 'odt', 'rtf'].includes(extension) || /word|document|rtf/.test(mime)) return 'document';
    if (mime.startsWith('text/') || ['txt', 'md', 'markdown', 'html', 'htm', 'xml', 'json', 'jsonl', 'yaml', 'yml', 'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'php', 'java', 'c', 'h', 'cpp', 'cc', 'cs', 'go', 'rs', 'swift', 'kt', 'kts', 'scala', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'toml', 'ini', 'cfg', 'log', 'tex'].includes(extension)) return 'text';
    return 'file';
  }

  function fileTypeLabel(record) {
    return (fileExtension(record) || fileCategory(record)).toLocaleUpperCase();
  }

  function attachmentFileName(record) {
    const extension = fileExtension(record);
    return `${record.nickname}${extension ? `.${extension}` : ''}`;
  }

  function isSupportedFile(file) {
    const extension = fileExtension(file);
    if (extension === 'gdoc') return false;
    return file.type.startsWith('image/') || file.type.startsWith('text/') || SUPPORTED_EXTENSIONS.has(extension);
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }

  function fileVisual(record, small = false) {
    if (fileCategory(record) === 'image') return `<img src="${getObjectUrl(record)}" alt="${escapeHtml(record.nickname || record.fileName || 'Image')}">`;
    return `<div class="cim-file-icon${small ? ' cim-file-icon-small' : ''}" data-type="${fileCategory(record)}"><span>${escapeHtml(fileTypeLabel(record))}</span></div>`;
  }

  function tagRandomPoolRecords(tag) {
    const ids = Array.isArray(tag?.randomPoolIds) ? tag.randomPoolIds : [];
    return ids.map((id) => state.recordById.get(id)).filter((record) => record && fileCategory(record) === 'image');
  }

  function sortedRecords(records = state.records) {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return [...records].sort((a, b) => {
      if (state.sortMode === 'date') return (b.createdAt || b.updatedAt || 0) - (a.createdAt || a.updatedAt || 0) || collator.compare(a.nickname, b.nickname);
      if (state.sortMode === 'type') return collator.compare(fileCategory(a), fileCategory(b)) || collator.compare(fileExtension(a), fileExtension(b)) || collator.compare(a.nickname, b.nickname);
      return collator.compare(a.nickname, b.nickname);
    });
  }

  function sortedTags(tags = state.tags) {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return [...tags].sort((a, b) => {
      if (state.tagSortMode === 'date') return (b.createdAt || b.updatedAt || 0) - (a.createdAt || a.updatedAt || 0) || collator.compare(a.name, b.name);
      if (state.tagSortMode === 'used') return (b.lastUsedOrder || 0) - (a.lastUsedOrder || 0) || (b.lastUsedAt || 0) - (a.lastUsedAt || 0) || collator.compare(a.name, b.name);
      return collator.compare(a.name, b.name);
    });
  }

  function mostRecentlyUsed(items, getName) {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return [...items].sort((a, b) =>
      Number(Boolean(b.lastUsedOrder || b.lastUsedAt)) - Number(Boolean(a.lastUsedOrder || a.lastUsedAt))
      || (b.lastUsedOrder || 0) - (a.lastUsedOrder || 0)
      || (b.lastUsedAt || 0) - (a.lastUsedAt || 0)
      || collator.compare(getName(a), getName(b)));
  }

  function mentionSubtitle(record) {
    if (state.sortMode === 'date') {
      const added = new Date(record.createdAt || record.updatedAt || Date.now()).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      return `${fileTypeLabel(record)} · Added ${added}`;
    }
    return `${fileTypeLabel(record)} · ${record.note || record.fileName}`;
  }

  function createModal() {
    if (document.querySelector('.cim-modal-backdrop')) return;
    if (!document.body) return;
    const backdrop = document.createElement('div');
    backdrop.className = 'cim-modal-backdrop cim-hidden';
    backdrop.innerHTML = `
      <section class="cim-modal" role="dialog" aria-modal="true" aria-labelledby="cim-title">
        <header class="cim-modal-header"><h2 id="cim-title">Prompt Forge library</h2><button type="button" class="cim-icon-button" data-cim-close aria-label="Close">${ICONS.close}</button></header>
        <nav class="cim-tabs" aria-label="Mention types">
          <button type="button" data-cim-tab="files" role="tab" aria-selected="true">@ Files &amp; images</button>
          <button type="button" data-cim-tab="tags" role="tab" aria-selected="false"># Prompt tags</button>
        </nav>
        <div class="cim-modal-body" data-cim-panel="files">
          <form class="cim-editor" id="cim-editor-form">
            <input class="cim-hidden" id="cim-file" type="file" accept="${FILE_ACCEPT}">
            <div class="cim-dropzone" id="cim-dropzone" tabindex="0" role="button"><div>${ICONS.file}<br><strong>Choose or drop a supported file</strong><br><small>Images, documents, PDFs, spreadsheets, presentations, text, and code</small></div></div>
            <label class="cim-field"><span>Nickname</span><input id="cim-nickname" maxlength="40" autocomplete="off" placeholder="character-design" required pattern="[A-Za-z0-9_-]+"></label>
            <p class="cim-help">Use letters, numbers, underscores, or hyphens. Type <b>@nickname</b> in ChatGPT.</p>
            <label class="cim-field"><span>Reference note sent to ChatGPT</span><textarea id="cim-note" rows="3" maxlength="500" placeholder="Use this file as the source for the requested comparison."></textarea></label>
            <p class="cim-help">Type <b>#</b> here to include a saved prompt tag. It will expand when this @file is used.</p>
            <div class="cim-form-actions"><button class="cim-primary" id="cim-save" type="submit">Save file mention</button><button class="cim-secondary cim-hidden" data-cancel-file-edit type="button">Cancel edit</button></div>
          </form>
          <section class="cim-library">
            <div class="cim-library-title"><strong>Your files</strong><span id="cim-library-count"></span></div>
            <div class="cim-library-sort" aria-label="Sort files in mentions library">
              <button type="button" data-library-sort="name">Name</button><button type="button" data-library-sort="date">Date added</button><button type="button" data-library-sort="type">File type</button>
            </div>
            <div class="cim-grid" id="cim-grid"></div>
          </section>
        </div>
        <div class="cim-modal-body cim-hidden" data-cim-panel="tags">
          <form class="cim-editor" id="cim-tag-form">
            <label class="cim-field"><span>Tag name</span><input id="cim-tag-name" maxlength="40" autocomplete="off" placeholder="polish-writing" required pattern="[A-Za-z0-9_-]+"></label>
            <p class="cim-help">Use letters, numbers, underscores, or hyphens. Type <b>#tag-name</b> in ChatGPT.</p>
            <label class="cim-field"><span>Reusable prompt snippet</span><textarea id="cim-tag-text" rows="8" maxlength="12000" required placeholder="Rewrite the following for clarity and concision. Preserve the original meaning and return only the revised text."></textarea></label>
            <p class="cim-help">Type <b>@</b> here to include saved files or images. Calling this #tag will attach and reference them automatically.</p>
            <label class="cim-pool-toggle"><input id="cim-tag-random-enabled" type="checkbox"><span><strong>Choose random images when this tag is used</strong><small>Build a pool from your saved images and draw a fresh sample for every prompt.</small></span></label>
            <div class="cim-pool-settings cim-hidden" id="cim-tag-random-settings">
              <div class="cim-pool-heading"><span>Image pool</span><label class="cim-pool-count">Choose <input id="cim-tag-random-count" type="number" min="1" value="1"> per use</label></div>
              <div class="cim-pool-grid" id="cim-tag-random-pool"></div>
              <p class="cim-help" id="cim-tag-random-summary">Select at least one saved image.</p>
            </div>
            <div class="cim-form-actions"><button class="cim-primary" id="cim-tag-save" type="submit">Save prompt tag</button><button class="cim-secondary cim-hidden" data-cancel-tag-edit type="button">Cancel edit</button></div>
          </form>
          <section class="cim-library">
            <div class="cim-library-title"><strong>Your prompt tags</strong><span id="cim-tag-count"></span></div>
            <div class="cim-library-sort" aria-label="Sort prompt tags in mentions library">
              <button type="button" data-tag-library-sort="name">Name</button><button type="button" data-tag-library-sort="date">Date added</button><button type="button" data-tag-library-sort="used">Last used</button>
            </div>
            <div class="cim-grid" id="cim-tag-grid"></div>
          </section>
        </div>
      </section>`;
    document.body.appendChild(backdrop);

    const fileInput = backdrop.querySelector('#cim-file');
    const dropzone = backdrop.querySelector('#cim-dropzone');
    backdrop.querySelector('[data-cim-close]').addEventListener('click', closeModal);
    backdrop.querySelectorAll('[data-cim-tab]').forEach((button) => button.addEventListener('click', () => switchModalTab(button.dataset.cimTab)));
    backdrop.querySelectorAll('[data-library-sort]').forEach((button) => button.addEventListener('click', () => {
      state.sortMode = button.dataset.librarySort;
      localStorage.setItem('cim-file-sort', state.sortMode);
      updateLibrarySortButtons();
      renderLibrary();
    }));
    backdrop.querySelectorAll('[data-tag-library-sort]').forEach((button) => button.addEventListener('click', () => {
      state.tagSortMode = button.dataset.tagLibrarySort;
      localStorage.setItem('cim-tag-sort', state.tagSortMode);
      updateTagSortButtons();
      renderTagLibrary();
    }));
    backdrop.querySelector('[data-cancel-file-edit]').addEventListener('click', () => { resetEditor(); document.querySelector('#cim-nickname')?.focus(); });
    backdrop.querySelector('[data-cancel-tag-edit]').addEventListener('click', () => { resetTagEditor(); document.querySelector('#cim-tag-name')?.focus(); });
    backdrop.querySelector('#cim-tag-random-enabled').addEventListener('change', updateTagRandomPoolState);
    backdrop.querySelector('#cim-tag-random-count').addEventListener('input', updateTagRandomPoolState);
    backdrop.querySelector('#cim-tag-random-pool').addEventListener('change', updateTagRandomPoolState);
    backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) closeModal(); });
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') fileInput.click(); });
    fileInput.addEventListener('change', () => setPendingFile(fileInput.files[0]));
    for (const type of ['dragenter', 'dragover']) dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.add('cim-dragging'); });
    for (const type of ['dragleave', 'drop']) dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.remove('cim-dragging'); });
    dropzone.addEventListener('drop', (event) => setPendingFile(event.dataTransfer.files[0]));
    backdrop.querySelector('#cim-editor-form').addEventListener('submit', saveEditor);
    backdrop.querySelector('#cim-tag-form').addEventListener('submit', saveTagEditor);
  }

  function openModal() {
    ensureUserscriptUi();
    const backdrop = document.querySelector('.cim-modal-backdrop');
    if (!backdrop) return toast('The mentions library could not be opened. Refresh ChatGPT and try again.');
    resetEditor();
    resetTagEditor();
    renderLibrary();
    renderTagLibrary();
    switchModalTab(state.modalTab);
    backdrop.classList.remove('cim-hidden');
    document.querySelector(state.modalTab === 'tags' ? '#cim-tag-name' : '#cim-nickname')?.focus();
  }

  function closeModal() {
    document.querySelector('.cim-modal-backdrop')?.classList.add('cim-hidden');
    closeAutocomplete();
    resetEditor();
    resetTagEditor();
    requestAnimationFrame(() => hydrateStoredReferences(getEditor()));
  }

  function switchModalTab(tab) {
    closeAutocomplete();
    state.modalTab = tab === 'tags' ? 'tags' : 'files';
    document.querySelectorAll('[data-cim-tab]').forEach((button) => button.setAttribute('aria-selected', String(button.dataset.cimTab === state.modalTab)));
    document.querySelectorAll('[data-cim-panel]').forEach((panel) => panel.classList.toggle('cim-hidden', panel.dataset.cimPanel !== state.modalTab));
  }

  function resetEditor() {
    state.pendingFile = null;
    state.editingId = null;
    const form = document.querySelector('#cim-editor-form');
    if (!form) return;
    form.reset();
    form.querySelector('#cim-dropzone').innerHTML = `<div>${ICONS.file}<br><strong>Choose or drop a supported file</strong><br><small>Images, documents, PDFs, spreadsheets, presentations, text, and code</small></div>`;
    form.querySelector('#cim-save').textContent = 'Save file mention';
    form.querySelector('[data-cancel-file-edit]')?.classList.add('cim-hidden');
  }

  function setPendingFile(file) {
    if (!file) return;
    if (!isSupportedFile(file)) return toast(fileExtension(file) === 'gdoc' ? 'Google .gdoc files are not supported. Export it as PDF or DOCX first.' : 'Choose a common image, document, PDF, spreadsheet, presentation, text, or code file.');
    if (file.size > 512 * 1024 * 1024) return toast('ChatGPT limits files to 512 MB each.');
    if (fileCategory(file) === 'image' && file.size > 20 * 1024 * 1024) return toast('ChatGPT limits images to 20 MB each.');
    if (fileCategory(file) === 'spreadsheet' && file.size > 50 * 1024 * 1024) return toast('ChatGPT limits spreadsheets to approximately 50 MB.');
    state.pendingFile = file;
    const dropzone = document.querySelector('#cim-dropzone');
    if (!dropzone) return toast('The mentions library was reloaded. Open it and choose the file again.');
    if (fileCategory(file) === 'image') {
      const preview = document.createElement('img');
      const url = URL.createObjectURL(file);
      preview.src = url;
      preview.alt = 'Selected image preview';
      preview.onload = () => URL.revokeObjectURL(url);
      dropzone.replaceChildren(preview);
    } else {
      dropzone.innerHTML = `<div class="cim-selected-file">${fileVisual({ fileName: file.name, mimeType: file.type })}<strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(fileTypeLabel(file))} · ${formatBytes(file.size)}</small></div>`;
    }
    const nicknameInput = document.querySelector('#cim-nickname');
    if (nicknameInput && !nicknameInput.value) {
      nicknameInput.value = file.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    }
  }

  async function saveEditor(event) {
    event.preventDefault();
    const nickname = document.querySelector('#cim-nickname').value.trim().replace(/^@/, '');
    const note = document.querySelector('#cim-note').value.trim().replace(/[⟦⟧]/g, '');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(nickname)) return toast('Nickname can only contain letters, numbers, underscores, and hyphens.');
    const duplicate = state.recordByNickname.get(nickname.toLocaleLowerCase());
    if (duplicate && duplicate.id !== state.editingId) return toast(`@${nickname} is already in your library.`);
    const old = state.editingId ? state.recordById.get(state.editingId) : null;
    const file = state.pendingFile;
    if (!old && !file) return toast('Choose a file first.');
    const record = {
      id: old?.id || shortId(), nickname, nicknameLower: nickname.toLocaleLowerCase(), note,
      blob: file || old.blob, fileName: file?.name || old.fileName,
      mimeType: file?.type || old.mimeType || old.blob.type || 'application/octet-stream',
      lastModified: file?.lastModified || old.lastModified || Date.now(),
      createdAt: old?.createdAt || Date.now(), updatedAt: Date.now(),
    };
    try {
      await dbRequest('readwrite', (store) => store.put(record));
      releaseObjectUrl(record.id);
      await loadRecords();
      resetEditor();
      renderLibrary();
      refreshTagRandomPool();
      toast(`Saved @${nickname}`);
    } catch (error) {
      console.error('[Prompt Forge] Save failed', error);
      toast('Could not save the file. Browser storage may be full.');
    }
  }

  function renderLibrary() {
    const grid = document.querySelector('#cim-grid');
    if (!grid) return;
    updateLibrarySortButtons();
    document.querySelector('#cim-library-count').textContent = `${state.records.length} saved`;
    if (!state.records.length) {
      grid.innerHTML = '<div class="cim-empty">Add your first file, then type its @nickname in the ChatGPT prompt.</div>';
      return;
    }
    grid.innerHTML = sortedRecords().map((record) => `
      <article class="cim-card" data-id="${record.id}">
        ${fileVisual(record)}
        <div class="cim-card-actions"><button type="button" data-edit aria-label="Edit @${escapeHtml(record.nickname)}">${ICONS.edit}</button><button type="button" data-delete aria-label="Delete @${escapeHtml(record.nickname)}">${ICONS.trash}</button></div>
        <div class="cim-card-name">@${escapeHtml(record.nickname)}</div><div class="cim-card-note">${escapeHtml(record.note || `${fileTypeLabel(record)} file reference`)}</div>
      </article>`).join('');
    grid.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => editRecord(button.closest('.cim-card').dataset.id)));
    grid.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', () => deleteRecord(button.closest('.cim-card').dataset.id)));
  }

  function updateLibrarySortButtons() {
    document.querySelectorAll('[data-library-sort]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.librarySort === state.sortMode)));
  }

  function editRecord(id) {
    const record = state.recordById.get(id);
    if (!record) return;
    state.editingId = id;
    state.pendingFile = null;
    document.querySelector('#cim-nickname').value = record.nickname;
    document.querySelector('#cim-note').value = record.note;
    document.querySelector('#cim-dropzone').innerHTML = fileCategory(record) === 'image'
      ? `<img src="${getObjectUrl(record)}" alt="${escapeHtml(record.nickname)}">`
      : `<div class="cim-selected-file">${fileVisual(record)}<strong>${escapeHtml(record.fileName)}</strong><small>${escapeHtml(fileTypeLabel(record))}</small></div>`;
    document.querySelector('#cim-save').textContent = 'Update file mention';
    document.querySelector('[data-cancel-file-edit]')?.classList.remove('cim-hidden');
    document.querySelector('#cim-nickname').focus();
  }

  async function deleteRecord(id) {
    const record = state.recordById.get(id);
    if (!record || !confirm(`Delete @${record.nickname} and its locally stored file?`)) return;
    await dbRequest('readwrite', (store) => store.delete(id));
    releaseObjectUrl(id);
    await loadRecords();
    if (state.editingId === id) resetEditor();
    renderLibrary();
    refreshTagRandomPool();
    toast(`Deleted @${record.nickname}`);
  }

  function resetTagEditor() {
    state.editingTagId = null;
    const form = document.querySelector('#cim-tag-form');
    if (!form) return;
    form.reset();
    renderTagRandomPool([]);
    form.querySelector('#cim-tag-save').textContent = 'Save prompt tag';
    form.querySelector('[data-cancel-tag-edit]')?.classList.add('cim-hidden');
  }

  function selectedTagRandomPoolIds() {
    return [...document.querySelectorAll('#cim-tag-random-pool input[type="checkbox"]:checked')].map((input) => input.value);
  }

  function renderTagRandomPool(selectedIds = selectedTagRandomPoolIds()) {
    const grid = document.querySelector('#cim-tag-random-pool');
    if (!grid) return;
    const selected = new Set(selectedIds);
    const images = sortedRecords(state.records.filter((record) => fileCategory(record) === 'image'));
    grid.innerHTML = images.length ? images.map((record) => `
      <label class="cim-pool-option" title="@${escapeHtml(record.nickname)}">
        <input type="checkbox" value="${escapeHtml(record.id)}"${selected.has(record.id) ? ' checked' : ''}>
        ${fileVisual(record, true)}
        <span>@${escapeHtml(record.nickname)}</span>
      </label>`).join('') : '<div class="cim-pool-empty">Add an image to your file library to create a random pool.</div>';
    updateTagRandomPoolState();
  }

  function refreshTagRandomPool() {
    const enabled = document.querySelector('#cim-tag-random-enabled')?.checked;
    const count = document.querySelector('#cim-tag-random-count')?.value;
    const selectedIds = selectedTagRandomPoolIds();
    renderTagRandomPool(selectedIds);
    const enabledInput = document.querySelector('#cim-tag-random-enabled');
    const countInput = document.querySelector('#cim-tag-random-count');
    if (enabledInput) enabledInput.checked = Boolean(enabled);
    if (countInput && count) countInput.value = count;
    updateTagRandomPoolState();
  }

  function updateTagRandomPoolState() {
    const enabledInput = document.querySelector('#cim-tag-random-enabled');
    const settings = document.querySelector('#cim-tag-random-settings');
    const countInput = document.querySelector('#cim-tag-random-count');
    const summary = document.querySelector('#cim-tag-random-summary');
    if (!enabledInput || !settings || !countInput || !summary) return;
    settings.classList.toggle('cim-hidden', !enabledInput.checked);
    const selectedCount = selectedTagRandomPoolIds().length;
    const maximum = Math.max(1, selectedCount);
    countInput.max = String(maximum);
    countInput.value = String(Math.min(maximum, Math.max(1, Number(countInput.value) || 1)));
    countInput.disabled = selectedCount === 0;
    summary.textContent = selectedCount
      ? `${selectedCount} image${selectedCount === 1 ? '' : 's'} in the pool; ${countInput.value} will be chosen and attached per use.`
      : 'Select at least one saved image.';
  }

  async function saveTagEditor(event) {
    event.preventDefault();
    const name = document.querySelector('#cim-tag-name').value.trim().replace(/^#/, '');
    const text = document.querySelector('#cim-tag-text').value.trim().replace(/[⟦⟧]/g, '');
    const randomEnabled = document.querySelector('#cim-tag-random-enabled').checked;
    const randomPoolIds = randomEnabled ? selectedTagRandomPoolIds() : [];
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) return toast('Tag names can only contain letters, numbers, underscores, and hyphens.');
    if (!text) return toast('Enter the reusable prompt snippet.');
    if (randomEnabled && !randomPoolIds.length) return toast('Select at least one image for the random pool.');
    const randomPoolCount = randomEnabled
      ? Math.min(randomPoolIds.length, Math.max(1, Number(document.querySelector('#cim-tag-random-count').value) || 1))
      : 0;
    const duplicate = state.tagByName.get(name.toLocaleLowerCase());
    if (duplicate && duplicate.id !== state.editingTagId) return toast(`#${name} is already in your library.`);
    const old = state.editingTagId ? state.tagById.get(state.editingTagId) : null;
    const tag = {
      ...(old || {}),
      id: old?.id || shortId(), name, nameLower: name.toLocaleLowerCase(), text,
      randomPoolIds, randomPoolCount,
      createdAt: old?.createdAt || Date.now(), updatedAt: Date.now(),
    };
    try {
      await dbRequest('readwrite', (store) => store.put(tag), TAG_STORE_NAME);
      await loadTags();
      resetTagEditor();
      renderTagLibrary();
      toast(`Saved #${name}`);
    } catch (error) {
      console.error('[Prompt Forge] Prompt tag save failed', error);
      toast('Could not save the prompt tag.');
    }
  }

  function renderTagLibrary() {
    const grid = document.querySelector('#cim-tag-grid');
    if (!grid) return;
    updateTagSortButtons();
    document.querySelector('#cim-tag-count').textContent = `${state.tags.length} saved`;
    if (!state.tags.length) {
      grid.innerHTML = '<div class="cim-empty">Save a reusable prompt, then type its #tag in the ChatGPT prompt.</div>';
      return;
    }
    grid.innerHTML = sortedTags().map((tag) => `
      <article class="cim-card cim-tag-card" data-id="${tag.id}">
        <div class="cim-card-actions"><button type="button" data-edit-tag aria-label="Edit #${escapeHtml(tag.name)}">${ICONS.edit}</button><button type="button" data-delete-tag aria-label="Delete #${escapeHtml(tag.name)}">${ICONS.trash}</button></div>
        <div class="cim-card-name">#${escapeHtml(tag.name)}</div><div class="cim-card-note">${escapeHtml(truncatePreview(tag.text, 180))}</div>
        ${tagRandomPoolRecords(tag).length ? `<div class="cim-tag-pool-badge">Random images · ${Math.min(tag.randomPoolCount || 1, tagRandomPoolRecords(tag).length)} of ${tagRandomPoolRecords(tag).length}</div>` : ''}
      </article>`).join('');
    grid.querySelectorAll('[data-edit-tag]').forEach((button) => button.addEventListener('click', () => editTag(button.closest('.cim-tag-card').dataset.id)));
    grid.querySelectorAll('[data-delete-tag]').forEach((button) => button.addEventListener('click', () => deleteTag(button.closest('.cim-tag-card').dataset.id)));
  }

  function updateTagSortButtons() {
    document.querySelectorAll('[data-tag-library-sort]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.tagLibrarySort === state.tagSortMode)));
  }

  function editTag(id) {
    const tag = state.tagById.get(id);
    if (!tag) return;
    state.editingTagId = id;
    document.querySelector('#cim-tag-name').value = tag.name;
    document.querySelector('#cim-tag-text').value = tag.text;
    const poolRecords = tagRandomPoolRecords(tag);
    document.querySelector('#cim-tag-random-enabled').checked = poolRecords.length > 0;
    document.querySelector('#cim-tag-random-count').value = String(Math.min(tag.randomPoolCount || 1, Math.max(1, poolRecords.length)));
    renderTagRandomPool(poolRecords.map((record) => record.id));
    document.querySelector('#cim-tag-save').textContent = 'Update prompt tag';
    document.querySelector('[data-cancel-tag-edit]')?.classList.remove('cim-hidden');
    document.querySelector('#cim-tag-name').focus();
  }

  async function deleteTag(id) {
    const tag = state.tagById.get(id);
    if (!tag || !confirm(`Delete #${tag.name} and its reusable prompt snippet?`)) return;
    await dbRequest('readwrite', (store) => store.delete(id), TAG_STORE_NAME);
    await loadTags();
    if (state.editingTagId === id) resetTagEditor();
    renderTagLibrary();
    toast(`Deleted #${tag.name}`);
  }

  function ensureComposerButton() {
    const plus = document.querySelector('#composer-plus-btn, [data-testid="composer-plus-btn"]');
    if (!plus || document.querySelector('.cim-library-button')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${plus.className || 'composer-btn'} cim-library-button`;
    button.setAttribute('aria-label', 'Open mentions library');
    button.title = 'Prompt Forge files and prompt tags';
    button.innerHTML = ICONS.file;
    button.addEventListener('click', openModal);
    const host = plus.parentElement?.parentElement || plus.parentElement;
    host?.appendChild(button);
    if (host) { host.style.display = 'flex'; host.style.alignItems = 'center'; }
  }

  function getEditor() {
    return document.querySelector('#prompt-textarea[contenteditable="true"], div.ProseMirror[contenteditable="true"]');
  }

  function getCaretContext(editor) {
    const selection = getSelection();
    if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return null;
    const range = selection.getRangeAt(0).cloneRange();
    const before = range.cloneRange();
    before.selectNodeContents(editor);
    before.setEnd(range.endContainer, range.endOffset);
    const text = before.toString().replace(/\u00a0/g, ' ');
    const match = text.match(/(?:^|\s)([@#])([A-Za-z0-9_-]*)$/);
    return match ? { trigger: match[1], query: match[2], range } : null;
  }

  function getTagEditorContext(textarea) {
    if (!textarea || textarea.selectionStart == null) return null;
    const caret = textarea.selectionStart;
    const match = textarea.value.slice(0, caret).match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
    return match ? { trigger: '@', query: match[1], start: caret - match[1].length - 1, end: caret } : null;
  }

  function getFileNoteContext(textarea) {
    if (!textarea || textarea.selectionStart == null) return null;
    const caret = textarea.selectionStart;
    const match = textarea.value.slice(0, caret).match(/(?:^|\s)#([A-Za-z0-9_-]*)$/);
    return match ? { trigger: '#', query: match[1], start: caret - match[1].length - 1, end: caret } : null;
  }

  function updateAutocomplete(allowRetry = true) {
    const editor = getEditor();
    const context = editor && getCaretContext(editor);
    if (!context) {
      if (allowRetry && editor && document.activeElement === editor) {
        clearTimeout(state.autocompleteTimer);
        state.autocompleteTimer = setTimeout(() => { state.autocompleteTimer = null; updateAutocomplete(false); }, 35);
        return;
      }
      return closeAutocomplete();
    }
    const query = context.query.toLocaleLowerCase();
    const kind = context.trigger === '#' ? 'tags' : 'files';
    const matches = kind === 'tags'
      ? state.tags.filter((tag) => tag.nameLower.includes(query))
      : state.records.filter((record) => record.nicknameLower.includes(query));
    const items = (query
      ? (kind === 'tags' ? sortedTags(matches) : sortedRecords(matches))
      : mostRecentlyUsed(matches, (item) => kind === 'tags' ? item.name : item.nickname)).slice(0, 3);
    if (!items.length) return closeAutocomplete();
    state.autocomplete = { open: true, items, selected: 0, query: context.query, kind, source: 'composer' };
    renderAutocomplete(context.range);
  }

  function updateTagEditorAutocomplete(textarea = document.querySelector('#cim-tag-text')) {
    const context = getTagEditorContext(textarea);
    if (!context || !state.records.length) return closeAutocomplete();
    const query = context.query.toLocaleLowerCase();
    const matches = state.records.filter((record) => record.nicknameLower.includes(query));
    const items = (query ? sortedRecords(matches) : mostRecentlyUsed(matches, (record) => record.nickname)).slice(0, 3);
    if (!items.length) return closeAutocomplete();
    state.autocomplete = { open: true, items, selected: 0, query: context.query, kind: 'files', source: 'tagEditor' };
    renderAutocomplete(null);
  }

  function updateFileNoteAutocomplete(textarea = document.querySelector('#cim-note')) {
    const context = getFileNoteContext(textarea);
    if (!context || !state.tags.length) return closeAutocomplete();
    const query = context.query.toLocaleLowerCase();
    const matches = state.tags.filter((tag) => tag.nameLower.includes(query));
    const items = (query ? sortedTags(matches) : mostRecentlyUsed(matches, (tag) => tag.name)).slice(0, 3);
    if (!items.length) return closeAutocomplete();
    state.autocomplete = { open: true, items, selected: 0, query: context.query, kind: 'tags', source: 'fileNote' };
    renderAutocomplete(null);
  }

  function renderAutocomplete(range) {
    createFloatingUi();
    const menu = document.querySelector('.cim-autocomplete');
    if (!menu) return;
    const isTags = state.autocomplete.kind === 'tags';
    menu.innerHTML = isTags ? `
      ${state.autocomplete.query ? `<div class="cim-sortbar" aria-label="Sort prompt tags"><span>Sort</span>
        <button type="button" data-tag-sort="name" aria-pressed="${state.tagSortMode === 'name'}">Name</button>
        <button type="button" data-tag-sort="date" aria-pressed="${state.tagSortMode === 'date'}">Date added</button>
        <button type="button" data-tag-sort="used" aria-pressed="${state.tagSortMode === 'used'}">Last used</button>
      </div>` : '<div class="cim-tag-menu-title">Recent & available prompt tags</div>'}
      <div class="cim-options">${state.autocomplete.items.map((tag, index) => `
        <button type="button" class="cim-option" data-index="${index}" aria-selected="${index === state.autocomplete.selected}">
          <span class="cim-tag-glyph">#</span><span><strong>#${escapeHtml(tag.name)}</strong><small>${escapeHtml(truncatePreview(tag.text, 90))}${tagRandomPoolRecords(tag).length ? ` · Random ${Math.min(tag.randomPoolCount || 1, tagRandomPoolRecords(tag).length)} of ${tagRandomPoolRecords(tag).length}` : ''}</small></span>
        </button>`).join('')}</div>` : `
      ${state.autocomplete.query ? `<div class="cim-sortbar" aria-label="Sort file mentions"><span>Sort</span>
        <button type="button" data-sort="name" aria-pressed="${state.sortMode === 'name'}">Name</button>
        <button type="button" data-sort="date" aria-pressed="${state.sortMode === 'date'}">Date added</button>
        <button type="button" data-sort="type" aria-pressed="${state.sortMode === 'type'}">File type</button>
      </div>` : '<div class="cim-tag-menu-title">Recent & available files & images</div>'}
      <div class="cim-options">${state.autocomplete.items.map((record, index) => `
        <button type="button" class="cim-option" data-index="${index}" aria-selected="${index === state.autocomplete.selected}">
          ${fileVisual(record, true)}<span><strong>@${escapeHtml(record.nickname)}</strong><small>${escapeHtml(mentionSubtitle(record))}</small></span>
        </button>`).join('')}</div>`;
    menu.classList.remove('cim-hidden');
    const editor = getEditor();
    const libraryTextarea = document.querySelector(state.autocomplete.source === 'fileNote' ? '#cim-note' : '#cim-tag-text');
    let anchor;
    let surfaceRect;
    if ((state.autocomplete.source === 'tagEditor' || state.autocomplete.source === 'fileNote') && libraryTextarea) {
      anchor = libraryTextarea.getBoundingClientRect();
      surfaceRect = anchor;
    } else if (editor && range) {
      const rect = range.getBoundingClientRect();
      const editorRect = editor.getBoundingClientRect();
      anchor = rect.width || rect.height ? rect : editorRect;
      surfaceRect = (editor.closest('[data-composer-surface="true"]') || editor).getBoundingClientRect();
    } else {
      return closeAutocomplete();
    }
    const width = 350;
    let left = Math.min(anchor.left, innerWidth - width - 12);
    left = Math.max(12, left);
    const estimatedHeight = Math.min(226, state.autocomplete.items.length * 58 + 52);
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.max(8, surfaceRect.top - estimatedHeight - 8)}px`;
    menu.querySelectorAll('.cim-option').forEach((button) => {
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => chooseMention(Number(button.dataset.index)));
    });
    menu.querySelectorAll('[data-sort]').forEach((button) => {
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        state.sortMode = button.dataset.sort;
        localStorage.setItem('cim-file-sort', state.sortMode);
        state.autocomplete.selected = 0;
        updateLibrarySortButtons();
        renderLibrary();
        if (state.autocomplete.source === 'tagEditor') updateTagEditorAutocomplete();
        else if (state.autocomplete.source === 'fileNote') updateFileNoteAutocomplete();
        else updateAutocomplete();
      });
    });
    menu.querySelectorAll('[data-tag-sort]').forEach((button) => {
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        state.tagSortMode = button.dataset.tagSort;
        localStorage.setItem('cim-tag-sort', state.tagSortMode);
        state.autocomplete.selected = 0;
        updateTagSortButtons();
        renderTagLibrary();
        if (state.autocomplete.source === 'fileNote') updateFileNoteAutocomplete();
        else updateAutocomplete();
      });
    });
  }

  function closeAutocomplete() {
    clearTimeout(state.autocompleteTimer);
    state.autocompleteTimer = null;
    state.autocomplete.open = false;
    document.querySelector('.cim-autocomplete')?.classList.add('cim-hidden');
  }

  function chooseMention(index) {
    const item = state.autocomplete.items[index];
    const isTag = state.autocomplete.kind === 'tags';
    if (state.autocomplete.source === 'tagEditor' || state.autocomplete.source === 'fileNote') {
      const isFileNote = state.autocomplete.source === 'fileNote';
      const textarea = document.querySelector(isFileNote ? '#cim-note' : '#cim-tag-text');
      const context = isFileNote ? getFileNoteContext(textarea) : getTagEditorContext(textarea);
      if (!item || !textarea || !context) return closeAutocomplete();
      const replacement = isFileNote ? `#${item.name} ` : `@${item.nickname} `;
      textarea.setRangeText(replacement, context.start, context.end, 'end');
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: replacement }));
      closeAutocomplete();
      textarea.focus();
      return;
    }
    const editor = getEditor();
    const context = editor && getCaretContext(editor);
    if (!item || !context) return closeAutocomplete();
    const trigger = isTag ? '#' : '@';
    const name = isTag ? item.name : item.nickname;
    const selection = getSelection();
    let range = context.range;
    const amount = context.query.length + 1;
    if (range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset >= amount) {
      range.setStart(range.startContainer, range.startOffset - amount);
      selection.removeAllRanges();
      selection.addRange(range);
      const replacement = `${trigger}${name} `;
      const inserted = document.execCommand('insertText', false, replacement);
      if (inserted) {
        closeAutocomplete();
        editor.focus();
        requestAnimationFrame(() => hydrateStoredReferences(editor));
        return;
      }
    } else {
      document.execCommand('delete', false);
      document.execCommand('insertText', false, `${trigger}${name} `);
      closeAutocomplete();
      dispatchEditorInput(editor, `${trigger}${name} `);
      requestAnimationFrame(() => hydrateStoredReferences(editor));
      return;
    }
    range.deleteContents();
    const reference = document.createTextNode(`${trigger}${name}`);
    const space = document.createTextNode('\u00a0');
    range.insertNode(space);
    range.insertNode(reference);
    range.setStartAfter(space);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    closeAutocomplete();
    dispatchEditorInput(editor, `${trigger}${name} `);
    editor.focus();
    requestAnimationFrame(() => hydrateStoredReferences(editor));
  }

  function hydrateStoredReferences(editor = getEditor()) {
    if (!editor) return 0;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest('.cim-mention, .cim-tag-mention, .cim-sent-mention, .cim-sent-tag')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    const replacements = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      CHIPPABLE_REFERENCE_RE.lastIndex = 0;
      for (const match of node.data.matchAll(CHIPPABLE_REFERENCE_RE)) {
        const isTag = match[2] === '#';
        const item = isTag
          ? state.tagByName.get(match[3].toLocaleLowerCase())
          : state.recordByNickname.get(match[3].toLocaleLowerCase());
        if (!item) continue;
        const start = match.index + match[1].length;
        replacements.push({ node, start, end: start + match[2].length + match[3].length, isTag, item });
      }
    }
    for (const replacement of replacements.reverse()) {
      if (!replacement.node.isConnected) continue;
      const range = document.createRange();
      range.setStart(replacement.node, replacement.start);
      range.setEnd(replacement.node, replacement.end);
      range.deleteContents();
      const chip = document.createElement('span');
      chip.className = replacement.isTag ? 'cim-tag-mention' : 'cim-mention';
      chip.contentEditable = 'false';
      if (replacement.isTag) {
        chip.dataset.cimTagId = replacement.item.id;
        chip.textContent = `#${replacement.item.name}`;
      } else {
        chip.dataset.cimId = replacement.item.id;
        chip.textContent = `@${replacement.item.nickname}`;
      }
      range.insertNode(chip);
    }
    if (replacements.length) {
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: null }));
    }
    return replacements.length;
  }

  function handleEditorKeydown(event) {
    if (state.autocomplete.open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopImmediatePropagation();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        state.autocomplete.selected = (state.autocomplete.selected + direction + state.autocomplete.items.length) % state.autocomplete.items.length;
        renderAutocomplete(getSelection().getRangeAt(0));
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault(); event.stopImmediatePropagation();
        chooseMention(state.autocomplete.selected);
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); closeAutocomplete(); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.isComposing) {
      const text = getEditor()?.innerText || '';
      if (hasStoredMentions(text)) {
        event.preventDefault(); event.stopImmediatePropagation();
        prepareAndSend();
      }
    }
  }

  function handleLibraryTextareaKeydown(event, expectedSource) {
    if (!state.autocomplete.open || state.autocomplete.source !== expectedSource) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopImmediatePropagation();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      state.autocomplete.selected = (state.autocomplete.selected + direction + state.autocomplete.items.length) % state.autocomplete.items.length;
      renderAutocomplete(null);
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault(); event.stopImmediatePropagation();
      chooseMention(state.autocomplete.selected);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation();
      closeAutocomplete();
    }
  }

  function collectMentionedRecords(text) {
    const found = new Map();
    for (const match of text.matchAll(MENTION_RE)) {
      const record = state.recordByNickname.get(match[2].toLocaleLowerCase());
      if (record) found.set(record.id, record);
    }
    return [...found.values()];
  }

  function collectMentionedTags(text) {
    const found = new Map();
    for (const match of text.matchAll(TAG_RE)) {
      const tag = state.tagByName.get(match[2].toLocaleLowerCase());
      if (tag) found.set(tag.id, tag);
    }
    return [...found.values()];
  }

  function randomSample(items, count) {
    const shuffled = [...items];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const random = crypto.getRandomValues(new Uint32Array(1))[0] % (index + 1);
      [shuffled[index], shuffled[random]] = [shuffled[random], shuffled[index]];
    }
    return shuffled.slice(0, Math.min(shuffled.length, Math.max(0, count)));
  }

  function resolvePromptDependencies(text) {
    const records = new Map();
    const tags = new Map();
    const visited = new Set();
    const randomSelections = new Map();
    const visitRecord = (record) => {
      records.set(record.id, record);
      const key = `file:${record.id}`;
      if (visited.has(key)) return;
      visited.add(key);
      visitText(record.note || '');
    };
    const visitTag = (tag) => {
      tags.set(tag.id, tag);
      const key = `tag:${tag.id}`;
      if (visited.has(key)) return;
      visited.add(key);
      visitText(tag.text || '');
      const pool = tagRandomPoolRecords(tag);
      const selected = randomSample(pool, Math.min(tag.randomPoolCount || 1, pool.length));
      randomSelections.set(tag.id, selected);
      selected.forEach(visitRecord);
    };
    const visitText = (value) => {
      collectMentionedRecords(value).forEach(visitRecord);
      collectMentionedTags(value).forEach(visitTag);
    };
    visitText(text);
    return { records: [...records.values()], tags: [...tags.values()], randomSelections };
  }

  async function markMentionsUsed(records, tags) {
    try {
      let order = Number(localStorage.getItem('cim-usage-sequence')) || 0;
      const usedAt = Date.now();
      const writes = [];
      for (const record of records) {
        record.lastUsedOrder = ++order;
        record.lastUsedAt = usedAt;
        writes.push(dbRequest('readwrite', (store) => store.put(record)));
      }
      for (const tag of tags) {
        tag.lastUsedOrder = ++order;
        tag.lastUsedAt = usedAt;
        writes.push(dbRequest('readwrite', (store) => store.put(tag), TAG_STORE_NAME));
      }
      localStorage.setItem('cim-usage-sequence', String(order));
      await Promise.all(writes);
    } catch (error) {
      console.error('[Prompt Forge] Could not persist mention usage ranking', error);
    }
  }

  async function markMentionsUsedAfterSend(editor, records, tags) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (!editor.isConnected || !(editor.innerText || '').trim()) {
        await markMentionsUsed(records, tags);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return false;
  }

  function hasStoredMentions(text) {
    return collectMentionedRecords(text).length > 0 || collectMentionedTags(text).length > 0;
  }

  function expandedPrompt(text, records, tags, randomSelections = new Map()) {
    const context = {
      byName: new Map(records.map((record) => [record.nicknameLower, record])),
      tagsByName: new Map(tags.map((tag) => [tag.nameLower, tag])),
      randomSelections,
    };
    const restorations = [];
    return { text: expandReferences(text, context, new Set(), restorations), restorations };
  }

  function expandReferences(text, context, stack, restorations) {
    return text.replace(REFERENCE_RE, (whole, prefix, trigger, name) => {
      if (trigger === '@') {
        const record = context.byName.get(name.toLocaleLowerCase());
        if (!record) return whole;
        const expanded = expandedFileReference(record, context, stack);
        restorations.push({ kind: 'file', name: record.nickname, expanded, note: record.note || '', id: record.id });
        return `${prefix}${expanded}`;
      }
      const tag = context.tagsByName.get(name.toLocaleLowerCase());
      if (!tag) return whole;
      const expanded = expandedTagReference(tag, context, stack);
      restorations.push({ kind: 'tag', name: tag.name, expanded, text: tag.text, id: tag.id });
      return `${prefix}${expanded}`;
    });
  }

  function plainFileReference(record, context, stack) {
    const key = `file:${record.id}`;
    if (stack.has(key)) return attachmentFileName(record);
    const nextStack = new Set(stack);
    nextStack.add(key);
    const guidance = record.note
      ? renderPlainReferences(record.note, context, nextStack).trim().replace(/[.!?]+$/, '')
      : '';
    const fileName = attachmentFileName(record);
    return guidance ? `${fileName} — ${guidance}` : fileName;
  }

  function plainTagReference(tag, context, stack) {
    const key = `tag:${tag.id}`;
    if (stack.has(key)) return `#${tag.name}`;
    const nextStack = new Set(stack);
    nextStack.add(key);
    const instruction = renderPlainReferences(tag.text, context, nextStack);
    const selected = context.randomSelections.get(tag.id) || [];
    const randomSection = selected.length
      ? `\nImages: ${selected.map((record) => plainFileReference(record, context, nextStack)).join('; ')}`
      : '';
    return `${instruction}${randomSection}`;
  }

  function renderPlainReferences(text, context, stack) {
    return text.replace(REFERENCE_RE, (whole, prefix, trigger, name) => {
      if (trigger === '@') {
        const record = context.byName.get(name.toLocaleLowerCase());
        return record ? `${prefix}${plainFileReference(record, context, stack)}` : whole;
      }
      const tag = context.tagsByName.get(name.toLocaleLowerCase());
      return tag ? `${prefix}${plainTagReference(tag, context, stack)}` : whole;
    });
  }

  function expandedFileReference(record, context, stack) {
    return plainFileReference(record, context, stack);
  }

  function expandedTagReference(tag, context, stack) {
    return plainTagReference(tag, context, stack);
  }

  function normalizedEditorText(value) {
    return String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200b\u2060]/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function editorTextMatches(editor, expected) {
    return normalizedEditorText(editor?.innerText || editor?.textContent || '') === normalizedEditorText(expected);
  }

  function dispatchEditorInput(editor, text) {
    try {
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    } catch (error) {
      console.warn('[Prompt Forge] InputEvent construction failed; using a basic input event', error);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function setEditorText(editor, text) {
    const value = String(text ?? '');
    try {
      // A selection made entirely of contenteditable="false" chips may make
      // execCommand report success without changing anything. Flatten first.
      editor.querySelectorAll('.cim-mention, .cim-tag-mention').forEach((chip) => {
        chip.replaceWith(document.createTextNode(chip.textContent || ''));
      });
      editor.normalize();
      editor.focus();
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      const inserted = document.execCommand('insertText', false, value);
      if (inserted && editorTextMatches(editor, value)) return true;
    } catch (error) {
      console.warn('[Prompt Forge] Native composer rewrite failed; using the DOM fallback', error);
    }
    try {
      const paragraph = document.createElement('p');
      paragraph.textContent = value;
      editor.replaceChildren(paragraph);
      dispatchEditorInput(editor, value);
      return editorTextMatches(editor, value);
    } catch (error) {
      console.error('[Prompt Forge] Composer fallback rewrite failed', error);
      return false;
    }
  }

  async function waitForSendButton(form, timeout = 2500) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const send = form.querySelector('#composer-submit-button, [data-testid="send-button"]');
      if (send && !send.disabled && send.getAttribute('aria-disabled') !== 'true') return send;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('ChatGPT did not enable the send button after expanding the prompt.');
  }

  function countAttachmentTiles(form) {
    return form.querySelectorAll('button[aria-label^="Remove file"], button[aria-label*="Remove file"]').length;
  }

  async function attachRecords(form, records) {
    const input = form.querySelector('#upload-files, input[type="file"][multiple]');
    if (!input) throw new Error('ChatGPT file input was not found.');
    const before = countAttachmentTiles(form);
    const transfer = new DataTransfer();
    for (const file of input.files || []) transfer.items.add(file);
    for (const record of records) {
      if (!record?.blob || typeof record.blob.arrayBuffer !== 'function') {
        throw new Error(`The saved file @${record?.nickname || 'unknown'} is unavailable. Re-add it to the library and try again.`);
      }
      transfer.items.add(new File([record.blob], attachmentFileName(record), {
        type: record.mimeType || record.blob.type || 'application/octet-stream', lastModified: record.lastModified || Date.now(),
      }));
    }
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const expected = before + records.length;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const send = form.querySelector('#composer-submit-button, [data-testid="send-button"]');
      if (countAttachmentTiles(form) >= expected && send && !send.disabled) return;
      await new Promise((resolve) => setTimeout(resolve, 160));
    }
    throw new Error('Timed out while ChatGPT was attaching the saved file.');
  }

  async function prepareAndSend() {
    if (state.sending) return;
    const editor = getEditor();
    const form = editor?.closest('form');
    if (!editor || !form) return toast('ChatGPT composer was not found. Refresh the page and try again.');
    const originalText = (editor.innerText || editor.textContent || '').replace(/\u00a0/g, ' ').trim();
    let records = [];
    let tags = [];
    state.sending = true;
    closeAutocomplete();
    document.querySelectorAll('.cim-library-button').forEach((button) => button.classList.add('cim-sending'));
    try {
      const dependencies = resolvePromptDependencies(originalText);
      records = dependencies.records;
      tags = dependencies.tags;
      if (!records.length && !tags.length) return;
      const expansion = expandedPrompt(originalText, records, tags, dependencies.randomSelections);
      if (!normalizedEditorText(expansion.text)) throw new Error('The saved prompt expanded to empty text.');
      if (!setEditorText(editor, expansion.text)) throw new Error('ChatGPT rejected the expanded prompt text.');
      if (records.length) await attachRecords(form, records);
      let send = await waitForSendButton(form);
      if (!editorTextMatches(editor, expansion.text) && !setEditorText(editor, expansion.text)) {
        throw new Error('ChatGPT reset the composer before the expanded prompt could be sent.');
      }
      send = await waitForSendButton(form);
      const restoration = {
        expandedText: expansion.text,
        restorations: expansion.restorations,
        expiresAt: Date.now() + 10000,
      };
      state.pendingPlainRestoration = restoration;
      state.internalSubmit = true;
      send.click();
      void markMentionsUsedAfterSend(editor, records, tags)
        .then((sent) => {
          if (sent) rememberHistoryRestoration(restoration);
          else {
            if (state.pendingPlainRestoration === restoration) state.pendingPlainRestoration = null;
            console.warn('[Prompt Forge] ChatGPT did not clear the composer after the send attempt.');
          }
        })
        .catch((error) => console.error('[Prompt Forge] Could not finalize sent mention metadata', error));
      const parts = [];
      if (records.length) parts.push(`${records.length} file${records.length === 1 ? '' : 's'}`);
      if (tags.length) parts.push(`${tags.length} prompt tag${tags.length === 1 ? '' : 's'}`);
      toast(`Expanded ${parts.join(' and ')} from your mentions`);
      setTimeout(processSentMarkers, 250);
    } catch (error) {
      console.error('[Prompt Forge] Send failed', error);
      state.pendingPlainRestoration = null;
      const restored = setEditorText(editor, originalText);
      toast(restored
        ? (error.message || 'Could not send the expanded prompt.')
        : 'Could not send or restore the composer. Copy your draft before refreshing.');
    } finally {
      setTimeout(() => { state.internalSubmit = false; state.sending = false; document.querySelectorAll('.cim-sending').forEach((node) => node.classList.remove('cim-sending')); }, 800);
    }
  }

  function interceptClick(event) {
    const send = event.target.closest?.('#composer-submit-button, [data-testid="send-button"]');
    if (!send || state.internalSubmit) return;
    const editor = getEditor();
    if (!hasStoredMentions(editor?.innerText || '')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    prepareAndSend();
  }

  function interceptSubmit(event) {
    if (state.internalSubmit || !event.target.matches?.('form')) return;
    const editor = event.target.querySelector('#prompt-textarea[contenteditable="true"], div.ProseMirror[contenteditable="true"]');
    if (!editor || !hasStoredMentions(editor.innerText || '')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    prepareAndSend();
  }

  function createSentFileChip(nickname, note = '', id = '', expanded = '') {
    const chip = document.createElement('span');
    const record = state.recordByNickname.get(nickname.toLocaleLowerCase());
    chip.className = 'cim-sent-mention';
    chip.dataset.cimId = id || record?.id || '';
    chip.dataset.cimNickname = nickname;
    chip.dataset.cimNote = note;
    chip.dataset.cimExpanded = expanded;
    chip.textContent = `@${nickname}`;
    return chip;
  }

  function createSentTagChip(name, text = '', id = '', expanded = '') {
    const chip = document.createElement('span');
    const tag = state.tagByName.get(name.toLocaleLowerCase());
    chip.className = 'cim-sent-tag';
    chip.dataset.cimTagId = id || tag?.id || '';
    chip.dataset.cimTagName = name;
    chip.dataset.cimTagText = text;
    chip.dataset.cimExpanded = expanded;
    chip.textContent = `#${name}`;
    return chip;
  }

  function processSentMarkers() {
    const root = document.querySelector('main') || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.data.includes('⟦Image reference @') && !node.data.includes('⟦File reference @')) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest('#prompt-textarea, .cim-tooltip, .cim-modal')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      MARKER_RE.lastIndex = 0;
      if (!MARKER_RE.test(node.data)) continue;
      MARKER_RE.lastIndex = 0;
      const fragment = document.createDocumentFragment();
      let last = 0;
      for (const match of node.data.matchAll(MARKER_RE)) {
        fragment.append(node.data.slice(last, match.index));
        const chip = document.createElement('span');
        chip.className = 'cim-sent-mention';
        const record = state.recordByNickname.get(match[1].toLocaleLowerCase());
        chip.dataset.cimId = match[3] || record?.id || '';
        chip.dataset.cimNickname = match[1];
        chip.dataset.cimNote = match[2];
        chip.textContent = `@${match[1]}`;
        fragment.append(chip);
        last = match.index + match[0].length;
      }
      fragment.append(node.data.slice(last));
      node.replaceWith(fragment);
    }
    const tagWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.data.includes('⟦Prompt tag #')) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest('#prompt-textarea, .cim-tooltip, .cim-modal')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const tagNodes = [];
    while (tagWalker.nextNode()) tagNodes.push(tagWalker.currentNode);
    for (const node of tagNodes) {
      TAG_MARKER_RE.lastIndex = 0;
      if (!TAG_MARKER_RE.test(node.data)) continue;
      TAG_MARKER_RE.lastIndex = 0;
      const fragment = document.createDocumentFragment();
      let last = 0;
      for (const match of node.data.matchAll(TAG_MARKER_RE)) {
        fragment.append(node.data.slice(last, match.index));
        const chip = document.createElement('span');
        chip.className = 'cim-sent-tag';
        const tag = state.tagByName.get(match[1].toLocaleLowerCase());
        chip.dataset.cimTagId = match[3] || tag?.id || '';
        chip.dataset.cimTagName = match[1];
        chip.dataset.cimTagText = match[2];
        chip.textContent = `#${match[1]}`;
        fragment.append(chip);
        last = match.index + match[0].length;
      }
      fragment.append(node.data.slice(last));
      node.replaceWith(fragment);
    }
    replaceMarkersAcrossMessages(root);
    restorePendingPlainReferences(root);
    restoreStoredHistoryReferences(root);
    restoreExitedEditingReferences(root);
  }

  function replaceMarkersAcrossMessages(root) {
    root.querySelectorAll('[data-message-author-role="user"], article[data-turn="user"]').forEach((message) => {
      replaceMarkerAcrossElement(message, MARKER_RE, (match) => {
        return createSentFileChip(match[1], match[2], match[3]);
      });
      replaceMarkerAcrossElement(message, TAG_MARKER_RE, (match) => {
        return createSentTagChip(match[1], match[2], match[3]);
      });
    });
    cleanupLegacyMarkerTails(root);
  }

  function restorePendingPlainReferences(root) {
    const pending = state.pendingPlainRestoration;
    if (!pending) return;
    if (Date.now() > pending.expiresAt) {
      state.pendingPlainRestoration = null;
      return;
    }
    const messages = [...root.querySelectorAll('[data-message-author-role="user"], article[data-turn="user"]')];
    const message = messages.at(-1);
    if (!message || !findPlainText(readRestorableText(message), pending.expandedText)) return;
    const remaining = [];
    for (const item of pending.restorations) {
      const chip = item.kind === 'tag'
        ? () => createSentTagChip(item.name, item.text, item.id, item.expanded)
        : () => createSentFileChip(item.name, item.note, item.id, item.expanded);
      if (!replaceFirstPlainText(message, item.expanded, chip)) remaining.push(item);
    }
    state.pendingPlainRestoration = remaining.length ? { ...pending, restorations: remaining } : null;
  }

  function restoreStoredHistoryReferences(root) {
    if (!state.historyRestorations.length) return;
    const messages = [...root.querySelectorAll('[data-message-author-role="user"], article[data-turn="user"]')];
    for (const message of messages) {
      if (message.dataset.cimEditingExpanded === 'true') continue;
      const editables = [
        ...(message.matches('[contenteditable="true"]') ? [message] : []),
        ...message.querySelectorAll('[contenteditable="true"]'),
      ];
      for (const editable of editables) {
        if (editable.querySelector('.cim-sent-mention, .cim-sent-tag')) continue;
        restoreHistoryIntoElement(editable);
      }
      if (editables.length || message.querySelector('.cim-sent-mention, .cim-sent-tag')) continue;
      restoreHistoryIntoElement(message);
    }
  }

  function restoreHistoryIntoElement(element) {
    const text = readRestorableText(element);
    const restoration = state.historyRestorations.find((entry) => findPlainText(text, entry.expandedText));
    if (!restoration) return false;
    let restored = false;
    for (const item of restoration.restorations) {
      const chip = item.kind === 'tag'
        ? () => createSentTagChip(item.name, item.text, item.id, item.expanded)
        : () => createSentFileChip(item.name, item.note, item.id, item.expanded);
      restored = replaceFirstPlainText(element, item.expanded, chip) || restored;
    }
    return restored;
  }

  function expandSentChipForEditing(chip) {
    const editable = chip.closest('[contenteditable="true"]');
    const message = chip.closest('[data-message-author-role="user"], article[data-turn="user"]');
    const expanded = chip.dataset.cimExpanded;
    if (!editable || !message || !expanded) return false;
    const item = chip.matches('.cim-sent-tag')
      ? {
        kind: 'tag', name: chip.dataset.cimTagName || chip.textContent.replace(/^#/, ''),
        text: chip.dataset.cimTagText || '', id: chip.dataset.cimTagId || '', expanded,
      }
      : {
        kind: 'file', name: chip.dataset.cimNickname || chip.textContent.replace(/^@/, ''),
        note: chip.dataset.cimNote || '', id: chip.dataset.cimId || '', expanded,
      };
    const editingItems = state.editingPlainRestorations.get(message) || [];
    editingItems.push(item);
    state.editingPlainRestorations.set(message, editingItems);
    message.dataset.cimEditingExpanded = 'true';
    const text = document.createTextNode(expanded);
    chip.replaceWith(text);
    const selection = getSelection();
    const range = document.createRange();
    range.setStartAfter(text);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: expanded }));
    editable.focus();
    return true;
  }

  function restoreExitedEditingReferences(root) {
    root.querySelectorAll('[data-cim-editing-expanded="true"]').forEach((message) => {
      if (message.querySelector('[contenteditable="true"]')) return;
      const items = state.editingPlainRestorations.get(message) || [];
      for (const item of items) {
        const chip = item.kind === 'tag'
          ? () => createSentTagChip(item.name, item.text, item.id, item.expanded)
          : () => createSentFileChip(item.name, item.note, item.id, item.expanded);
        replaceFirstPlainText(message, item.expanded, chip);
      }
      state.editingPlainRestorations.delete(message);
      delete message.dataset.cimEditingExpanded;
    });
  }

  function readRestorableText(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest('button, .cim-sent-mention, .cim-sent-tag') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    let text = '';
    while (walker.nextNode()) text += walker.currentNode.data;
    return text.replace(/\u00a0/g, ' ');
  }

  function replaceFirstPlainText(element, value, makeChip) {
    if (!value) return false;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest('button, .cim-sent-mention, .cim-sent-tag') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    const textNodes = [];
    let text = '';
    while (walker.nextNode()) {
      textNodes.push({ node: walker.currentNode, start: text.length, end: text.length + walker.currentNode.data.length });
      text += walker.currentNode.data;
    }
    const match = findPlainText(text, value);
    if (!match) return false;
    const index = match.index;
    const endOffset = index + match.length;
    const start = textNodes.find((entry) => index >= entry.start && index < entry.end);
    const end = [...textNodes].reverse().find((entry) => endOffset > entry.start && endOffset <= entry.end);
    if (!start || !end || !start.node.isConnected || !end.node.isConnected) return false;
    const range = document.createRange();
    range.setStart(start.node, index - start.start);
    range.setEnd(end.node, endOffset - end.start);
    range.deleteContents();
    range.insertNode(makeChip());
    return true;
  }

  function findPlainText(text, value) {
    const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    const source = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
    const match = new RegExp(source).exec(text);
    return match ? { index: match.index, length: match[0].length } : null;
  }

  function cleanupLegacyMarkerTails(root) {
    root.querySelectorAll('[data-message-author-role="user"], article[data-turn="user"]').forEach((message) => {
      const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) {
        if (!/^\s*(?:as a reference\.\s*)?\[(?:ref|tag):[A-Za-z0-9-]+\]⟧/.test(node.data)) continue;
        let previous = node.previousSibling;
        while (previous?.nodeType === Node.TEXT_NODE && !previous.data.trim()) previous = previous.previousSibling;
        if (previous?.nodeType !== Node.ELEMENT_NODE || !previous.matches('.cim-sent-mention, .cim-sent-tag')) continue;
        node.data = node.data.replace(/^\s*(?:as a reference\.\s*)?\[(?:ref|tag):[A-Za-z0-9-]+\]⟧\s*/, ' ');
      }
    });
  }

  function replaceMarkerAcrossElement(element, pattern, makeChip) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest('button, .cim-sent-mention, .cim-sent-tag') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    const textNodes = [];
    let text = '';
    while (walker.nextNode()) {
      textNodes.push({ node: walker.currentNode, start: text.length, end: text.length + walker.currentNode.data.length });
      text += walker.currentNode.data;
    }
    pattern.lastIndex = 0;
    const matches = [...text.matchAll(pattern)];
    for (const match of matches.reverse()) {
      const start = textNodes.find((entry) => match.index >= entry.start && match.index < entry.end);
      const endOffset = match.index + match[0].length;
      const end = [...textNodes].reverse().find((entry) => endOffset > entry.start && endOffset <= entry.end);
      if (!start || !end || !start.node.isConnected || !end.node.isConnected) continue;
      const range = document.createRange();
      range.setStart(start.node, match.index - start.start);
      range.setEnd(end.node, endOffset - end.start);
      range.deleteContents();
      range.insertNode(makeChip(match));
    }
  }

  function showTooltip(target) {
    clearTimeout(state.tooltipTimer);
    createFloatingUi();
    if (target.matches('.cim-tag-mention, .cim-sent-tag')) {
      const tag = state.tagById.get(target.dataset.cimTagId) || state.tagByName.get((target.dataset.cimTagName || target.textContent.slice(1)).toLocaleLowerCase());
      const name = tag?.name || target.dataset.cimTagName || target.textContent.replace(/^#/, '');
      const text = tag?.text || target.dataset.cimTagText || 'Saved prompt snippet';
      const poolRecords = tagRandomPoolRecords(tag);
      const poolSummary = poolRecords.length
        ? `<p><b>Random image pool:</b> chooses ${Math.min(tag.randomPoolCount || 1, poolRecords.length)} of ${poolRecords.length} per use<br>${poolRecords.map((record) => `@${escapeHtml(record.nickname)}`).join(', ')}</p>`
        : '';
      const tooltip = document.querySelector('.cim-tooltip');
      if (!tooltip) return;
      tooltip.innerHTML = `<strong>#${escapeHtml(name)}</strong><p>${escapeHtml(text)}</p>${poolSummary}`;
      tooltip.classList.remove('cim-hidden');
      positionTooltip(tooltip, target);
      return;
    }
    const id = target.dataset.cimId;
    const record = state.recordById.get(id) || state.recordByNickname.get((target.dataset.cimNickname || target.textContent.slice(1)).toLocaleLowerCase());
    const nickname = record?.nickname || target.dataset.cimNickname || target.textContent.replace(/^@/, '');
    const note = record?.note || target.dataset.cimNote || `Use the attached file named @${nickname} as a reference.`;
    const tooltip = document.querySelector('.cim-tooltip');
    if (!tooltip) return;
    const linkedPreview = record
      ? (fileCategory(record) === 'image'
        ? `<img src="${getObjectUrl(record)}" alt="${escapeHtml(nickname)}">`
        : `<a class="cim-file-link" href="${getObjectUrl(record)}" download="${escapeHtml(record.fileName)}" title="Download ${escapeHtml(record.fileName)}">${fileVisual(record)}</a>`)
      : '';
    tooltip.innerHTML = `${linkedPreview}<strong>@${escapeHtml(nickname)}${record ? ` · ${escapeHtml(fileTypeLabel(record))}` : ''}</strong><p>${escapeHtml(note)}</p>`;
    tooltip.classList.remove('cim-hidden');
    positionTooltip(tooltip, target);
    const image = tooltip.querySelector('img');
    if (image) image.addEventListener('click', () => showLightbox(image.src, nickname));
  }

  function positionTooltip(tooltip, target) {
    const rect = target.getBoundingClientRect();
    const width = 270;
    tooltip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
    const height = tooltip.offsetHeight;
    tooltip.style.top = `${rect.top > height + 12 ? rect.top - height - 8 : rect.bottom + 8}px`;
  }

  function scheduleHideTooltip() {
    clearTimeout(state.tooltipTimer);
    state.tooltipTimer = setTimeout(() => document.querySelector('.cim-tooltip')?.classList.add('cim-hidden'), 180);
  }

  function showLightbox(src, alt) {
    const box = document.createElement('div');
    box.className = 'cim-lightbox';
    box.innerHTML = `<img src="${src}" alt="${escapeHtml(alt)}">`;
    box.addEventListener('click', () => box.remove());
    document.body.appendChild(box);
  }

  function toast(message) {
    document.querySelector('.cim-toast')?.remove();
    const element = document.createElement('div');
    element.className = 'cim-toast';
    element.textContent = message;
    document.body.appendChild(element);
    setTimeout(() => element.remove(), 3200);
  }

  function createFloatingUi() {
    if (!document.body) return;
    if (!document.querySelector('.cim-autocomplete')) {
      const autocomplete = document.createElement('div');
      autocomplete.className = 'cim-autocomplete cim-hidden';
      autocomplete.setAttribute('role', 'listbox');
      document.body.appendChild(autocomplete);
    }
    if (!document.querySelector('.cim-tooltip')) {
      const tooltip = document.createElement('div');
      tooltip.className = 'cim-tooltip cim-hidden';
      tooltip.addEventListener('mouseenter', () => clearTimeout(state.tooltipTimer));
      tooltip.addEventListener('mouseleave', scheduleHideTooltip);
      document.body.appendChild(tooltip);
    }
  }

  function ensureUserscriptUi() {
    injectStyles();
    createModal();
    createFloatingUi();
  }

  function bindGlobalEvents() {
    document.addEventListener('input', (event) => {
      if (event.target.matches?.('#prompt-textarea[contenteditable="true"], div.ProseMirror[contenteditable="true"]')) {
        clearTimeout(state.autocompleteTimer);
        state.autocompleteTimer = setTimeout(() => { state.autocompleteTimer = null; updateAutocomplete(); }, 20);
      } else if (event.target.matches?.('#cim-tag-text')) {
        clearTimeout(state.autocompleteTimer);
        state.autocompleteTimer = setTimeout(() => { state.autocompleteTimer = null; updateTagEditorAutocomplete(event.target); }, 20);
      } else if (event.target.matches?.('#cim-note')) {
        clearTimeout(state.autocompleteTimer);
        state.autocompleteTimer = setTimeout(() => { state.autocompleteTimer = null; updateFileNoteAutocomplete(event.target); }, 20);
      }
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.target.matches?.('#cim-tag-text')) { handleLibraryTextareaKeydown(event, 'tagEditor'); return; }
      if (event.target.matches?.('#cim-note')) { handleLibraryTextareaKeydown(event, 'fileNote'); return; }
      if (event.target.closest?.('#prompt-textarea[contenteditable="true"], div.ProseMirror[contenteditable="true"]')) handleEditorKeydown(event);
      if (event.key === 'Escape' && !document.querySelector('.cim-modal-backdrop')?.classList.contains('cim-hidden')) closeModal();
    }, true);
    document.addEventListener('focusout', (event) => {
      const editor = event.target.closest?.('#prompt-textarea[contenteditable="true"], div.ProseMirror[contenteditable="true"]');
      if (editor) requestAnimationFrame(() => hydrateStoredReferences(editor));
    }, true);
    document.addEventListener('click', interceptClick, true);
    document.addEventListener('click', (event) => {
      const chip = event.target.closest?.('.cim-sent-mention, .cim-sent-tag');
      if (!chip || !expandSentChipForEditing(chip)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    document.addEventListener('submit', interceptSubmit, true);
    document.addEventListener('mouseover', (event) => {
      const mention = event.target.closest?.('.cim-mention, .cim-sent-mention, .cim-tag-mention, .cim-sent-tag');
      if (mention) showTooltip(mention);
    });
    document.addEventListener('mouseout', (event) => {
      const mention = event.target.closest?.('.cim-mention, .cim-sent-mention, .cim-tag-mention, .cim-sent-tag');
      if (mention && !mention.contains(event.relatedTarget)) scheduleHideTooltip();
    });
    document.addEventListener('scroll', () => { scheduleHideTooltip(); }, true);
    window.addEventListener('resize', () => { closeAutocomplete(); scheduleHideTooltip(); });
  }

  async function init() {
    ensureUserscriptUi();
    bindGlobalEvents();
    loadHistoryRestorations();
    try { await Promise.all([loadRecords(), loadTags()]); } catch (error) { console.error('[Prompt Forge] Storage initialization failed', error); toast('Prompt Forge could not open browser storage.'); }
    ensureComposerButton();
    hydrateStoredReferences(getEditor());
    processSentMarkers();
    let scheduled = false;
    new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; ensureUserscriptUi(); ensureComposerButton(); processSentMarkers(); });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  init();
})();
