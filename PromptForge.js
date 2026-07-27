// ==UserScript==
// @name         Prompt Forge
// @namespace    local.chatgpt.image-mentions
// @version      2.6.1
// @description  Reuse files, prompt snippets, and visual !workflow graphs in ChatGPT.
// @author       You
// @match        https://chatgpt.com/*
// @match        https://www.chatgpt.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const DB_NAME = 'chatgpt-image-mentions';
  const DB_VERSION = 3;
  const STORE_NAME = 'images';
  const TAG_STORE_NAME = 'promptTags';
  const AUTOMATION_STORE_NAME = 'automations';
  const HISTORY_RESTORATIONS_KEY = 'cim-history-restorations';
  const HISTORY_RESTORATIONS_LIMIT = 60;
  const HISTORY_RESTORATIONS_MAX_CHARS = 600000;
  const RETRY_ON_ERROR_KEY = 'cim-retry-on-error';
  const AUTOMATIC_ERROR_RETRY_LIMIT = 1;
  const STANDALONE_RETRY_TIMEOUT_MS = 15 * 60 * 1000;
  const MARKER_RE = /⟦(?:Image|File) reference @([A-Za-z0-9_-]+): ([^⟧]*?)(?: \[ref:([A-Za-z0-9-]+)\])?⟧/g;
  const TAG_MARKER_RE = /⟦Prompt tag #([A-Za-z0-9_-]+): ([^⟧]*?)(?: \[tag:([A-Za-z0-9-]+)\])?⟧/g;
  const MENTION_RE = /(^|\s)@([A-Za-z0-9_-]+)/g;
  const TAG_RE = /(^|\s)#([A-Za-z0-9_-]+)/g;
  const AUTOMATION_RE = /(^|\s)!([A-Za-z0-9_-]+)/g;
  const REFERENCE_RE = /(^|\s)([@#])([A-Za-z0-9_-]+)/g;
  const CHIPPABLE_REFERENCE_RE = /(^|\s)([@#!])([A-Za-z0-9_-]+)(?=$|[\s.,!?;:()[\]{}'"“”])/g;
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
    automations: [],
    automationById: new Map(),
    automationByName: new Map(),
    objectUrls: new Map(),
    autocomplete: { open: false, items: [], selected: 0, query: '' },
    sortMode: ['name', 'date', 'type'].includes(localStorage.getItem('cim-file-sort')) ? localStorage.getItem('cim-file-sort') : 'name',
    tagSortMode: ['name', 'date', 'used'].includes(localStorage.getItem('cim-tag-sort')) ? localStorage.getItem('cim-tag-sort') : 'name',
    pendingFile: null,
    editingId: null,
    editingTagId: null,
    editingAutomationId: null,
    modalTab: 'files',
    sending: false,
    internalSubmit: false,
    pendingPlainRestoration: null,
    historyRestorations: [],
    editingPlainRestorations: new WeakMap(),
    tooltipTimer: null,
    autocompleteTimer: null,
    automationRun: null,
    standaloneRetry: null,
    retryOnError: localStorage.getItem(RETRY_ON_ERROR_KEY) === 'true',
    workflowZoom: 1,
    workflowConnections: [],
    workflowConnectionFrame: null,
    workflowResizeObserver: null,
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
      .cim-field input, .cim-field textarea, .cim-field select { width:100%; box-sizing:border-box; padding:10px 11px; border:1px solid var(--cim-border); border-radius:10px; outline:none; color:var(--cim-text); background:var(--cim-panel); font:14px/1.4 system-ui; resize:vertical; }
      .cim-field input:focus, .cim-field textarea:focus, .cim-field select:focus { border-color:var(--cim-accent); box-shadow:0 0 0 3px var(--cim-accent-soft); }
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
      .cim-modal:has([data-cim-panel="automate"]:not(.cim-hidden)) { width:min(760px,96vw); }
      .cim-modal-backdrop.cim-workflow-designing-backdrop { padding:8px; }
      .cim-modal.cim-workflow-designing, .cim-modal.cim-workflow-designing:has([data-cim-panel="automate"]:not(.cim-hidden)) { width:calc(100vw - 16px); height:calc(100vh - 16px); max-height:none; border-radius:8px; }
      .cim-automation-layout { grid-template-columns:minmax(390px,1.25fr) minmax(270px,.75fr); }
      .cim-automation-editor { overflow:auto; }
      .cim-automation-intro { margin:0 0 12px; color:var(--cim-muted); font-size:11px; line-height:1.45; }
      .cim-skill-palette { display:flex; flex-wrap:wrap; gap:6px; margin:12px 0 9px; }
      .cim-skill-palette button { padding:7px 9px; border:1px solid var(--cim-border); border-radius:8px; color:var(--cim-text); background:transparent; font:650 11px/1 system-ui; cursor:pointer; }
      .cim-skill-palette button:hover { border-color:#db7c26; background:rgba(219,124,38,.1); }
      .cim-node-graph { position:relative; display:flex; flex-direction:column; gap:16px; margin-top:8px; }
      .cim-node { position:relative; padding:11px; border:1px solid var(--cim-border); border-radius:12px; background:rgba(127,127,127,.045); }
      .cim-node:not(:last-child)::after { content:''; position:absolute; left:21px; top:100%; width:2px; height:17px; background:#db7c26; opacity:.65; }
      .cim-node::before { content:''; position:absolute; left:17px; top:-5px; width:8px; height:8px; border:2px solid #db7c26; border-radius:50%; background:var(--cim-panel); }
      .cim-node:first-child::before { display:none; }
      .cim-node.cim-node-dragging { opacity:.4; }
      .cim-node-header { display:flex; align-items:center; gap:7px; margin-bottom:8px; }
      .cim-node-order { color:#db7c26; font:750 10px/1 ui-monospace,SFMono-Regular,Consolas,monospace; }
      .cim-node-type { margin-right:auto; color:var(--cim-text); font:750 11px/1 ui-monospace,SFMono-Regular,Consolas,monospace; text-transform:uppercase; }
      .cim-node-header button { width:25px; height:25px; display:grid; place-items:center; border:0; border-radius:6px; color:var(--cim-muted); background:transparent; cursor:pointer; }
      .cim-node-header button:hover { color:var(--cim-text); background:rgba(127,127,127,.13); }
      .cim-node textarea { min-height:92px; font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace !important; }
      .cim-node-options { display:flex; align-items:center; gap:8px; margin-top:8px; color:var(--cim-muted); font-size:10px; }
      .cim-node-options input { width:58px; padding:5px 6px; border:1px solid var(--cim-border); border-radius:7px; color:var(--cim-text); background:var(--cim-panel); }
      .cim-node-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
      .cim-node-fields .cim-field { margin-top:8px; }
      .cim-node-fields .cim-field.cim-field-wide { grid-column:1/-1; }
      .cim-approval-actions { display:flex; flex-wrap:wrap; gap:6px; margin-top:9px; }
      .cim-approval-actions button { flex:1; min-width:68px; }
      .cim-workflow-host { min-height:0; flex:1; overflow:auto; }
      .cim-workflow-home { min-height:360px; padding:20px; }
      .cim-workflow-home-header { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:22px; padding:16px; border:1px solid var(--cim-border); border-radius:14px; background:linear-gradient(135deg,rgba(219,124,38,.12),rgba(118,87,214,.08)); }
      .cim-workflow-home-header h3 { margin:0; font-size:18px; }
      .cim-workflow-home-header p { margin:5px 0 0; color:var(--cim-muted); font-size:12px; }
      .cim-workflow-home-header .cim-primary { width:auto; margin:0; white-space:nowrap; }
      .cim-workflow-home > .cim-grid { grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); }
      .cim-settings-panel { min-height:360px; padding:20px; overflow:auto; }
      .cim-settings-panel h3 { margin:0; font-size:18px; }
      .cim-settings-panel > p { margin:5px 0 18px; color:var(--cim-muted); font-size:12px; line-height:1.45; }
      .cim-setting-toggle { max-width:560px; display:flex; align-items:flex-start; gap:11px; padding:14px; border:1px solid var(--cim-border); border-radius:13px; cursor:pointer; }
      .cim-setting-toggle:has(input:checked) { border-color:rgba(219,124,38,.52); background:rgba(219,124,38,.08); }
      .cim-setting-toggle input { margin-top:3px; accent-color:#db7c26; }
      .cim-setting-toggle span { min-width:0; }
      .cim-setting-toggle strong, .cim-setting-toggle small { display:block; }
      .cim-setting-toggle strong { font-size:13px; }
      .cim-setting-toggle small { margin-top:4px; color:var(--cim-muted); font-size:11px; line-height:1.45; }
      .cim-workflow-panel { min-height:0; height:100%; flex:1; display:flex; flex-direction:column; overflow:hidden; background:#1d1f21; }
      .cim-workflow-toolbar { display:grid; grid-template-columns:auto minmax(150px,.7fr) minmax(240px,1.4fr) 110px auto; align-items:end; gap:9px; padding:10px 12px; border-bottom:1px solid #050505; background:linear-gradient(#4b4d4f,#3a3c3e); box-shadow:inset 0 1px rgba(255,255,255,.08); }
      .cim-workflow-toolbar > .cim-secondary { align-self:end; padding:8px 10px; border-color:#222; color:#eee; background:#343638; }
      .cim-workflow-toolbar .cim-field { margin:0; }
      .cim-workflow-toolbar .cim-field span { color:#ddd; }
      .cim-workflow-toolbar .cim-field input { padding:7px 9px; border-color:#171717; color:#f4f4f4; background:#26282a; box-shadow:inset 0 1px 2px #0008; }
      .cim-workflow-toolbar-actions { display:flex; gap:6px; }
      .cim-workflow-toolbar-actions .cim-primary, .cim-workflow-toolbar-actions .cim-secondary { width:auto; margin:0; padding:8px 12px; }
      .cim-workflow-workspace { min-height:0; flex:1; display:grid; grid-template-columns:230px minmax(0,1fr); }
      .cim-workflow-sidebar { min-height:0; display:flex; flex-direction:column; border-right:1px solid #090909; color:#ddd; background:#2b2d2f; box-shadow:inset -1px 0 rgba(255,255,255,.04); }
      .cim-workflow-sidebar h3 { margin:0; padding:9px 10px 7px; border-top:1px solid #111; border-bottom:1px solid #171717; background:#36383a; font-size:11px; letter-spacing:.04em; text-transform:uppercase; }
      .cim-workflow-sidebar-head { display:flex; align-items:center; justify-content:space-between; }
      .cim-workflow-sidebar-head span { color:#aaa; font-size:9px; }
      .cim-workflow-sidebar .cim-skill-palette { display:grid; grid-template-columns:1fr; gap:3px; margin:0; padding:7px; overflow:auto; }
      .cim-workflow-sidebar .cim-skill-palette button { display:flex; align-items:center; padding:7px 9px; border-color:#171717; border-radius:4px; color:#e4e4e4; background:linear-gradient(#454749,#353739); box-shadow:inset 0 1px rgba(255,255,255,.06); text-align:left; }
      .cim-workflow-sidebar .cim-skill-palette button:hover { border-color:#df8a36; background:#4b4138; }
      .cim-variable-tools { display:grid; grid-template-columns:1fr; gap:3px; padding:7px; border-top:1px solid #151515; }
      .cim-variable-tools button { padding:6px 8px; border:1px solid #181818; border-radius:4px; color:#cdd6e0; background:#31363b; font:600 10px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace; cursor:pointer; text-align:left; }
      .cim-workflow-library { min-height:110px; flex:1; padding:6px; overflow:auto; border-top:1px solid #151515; }
      .cim-workflow-library .cim-grid { display:flex; flex-direction:column; gap:4px; }
      .cim-workflow-library .cim-card { min-height:0; padding:7px 8px; border-color:#181818; border-radius:4px; background:#333537; }
      .cim-workflow-library .cim-card-name { margin:0; color:#f0a45c; font-size:11px; }
      .cim-workflow-library .cim-card-note { height:auto; max-height:28px; line-height:14px; }
      .cim-workflow-library .cim-automation-badge { display:none; }
      .cim-workflow-library .cim-card-actions { top:4px; right:4px; }
      .cim-graph-shell { min-width:0; min-height:0; display:flex; flex-direction:column; background:#181a1c; }
      .cim-graph-toolbar { height:38px; flex:none; display:flex; align-items:center; gap:6px; padding:0 9px; border-bottom:1px solid #070707; color:#ddd; background:linear-gradient(#383a3c,#2d2f31); }
      .cim-graph-toolbar strong { margin-right:auto; font-size:12px; font-weight:650; }
      .cim-graph-toolbar small { color:#999; font-size:9px; }
      .cim-graph-toolbar button { min-width:28px; height:26px; padding:0 7px; border:1px solid #171717; border-radius:4px; color:#ddd; background:#414345; font:650 11px/1 system-ui; cursor:pointer; }
      .cim-graph-toolbar button:hover { background:#505255; }
      .cim-graph-viewport { min-height:0; flex:1; position:relative; overflow:auto; cursor:grab; background-color:#17191b; background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(rgba(255,255,255,.075) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.075) 1px,transparent 1px); background-size:16px 16px,16px 16px,80px 80px,80px 80px; }
      .cim-graph-viewport.cim-panning { cursor:grabbing; user-select:none; }
      .cim-graph-canvas { position:relative; width:1800px; height:1100px; transform-origin:0 0; }
      .cim-graph-connections { position:absolute; inset:0; z-index:0; width:100%; height:100%; overflow:visible; pointer-events:none; }
      .cim-graph-connections path { fill:none; stroke:#d8d8d8; stroke-width:2; filter:drop-shadow(0 1px 1px #000); }
      .cim-graph-connections path[data-key] { pointer-events:stroke; cursor:pointer; }
      .cim-graph-connections path[data-key]:hover { stroke-width:5; filter:drop-shadow(0 0 3px currentColor); }
      .cim-graph-canvas .cim-node-graph { position:absolute; inset:0; z-index:1; display:block; margin:0; }
      .cim-graph-canvas .cim-node { position:absolute; width:300px; min-width:0; padding:0 9px 10px; border:1px solid #060606; border-radius:5px; color:#ddd; background:#242729; box-shadow:0 3px 9px #000b,inset 0 0 0 1px rgba(255,255,255,.04); }
      .cim-graph-canvas .cim-node.cim-node-dragging { z-index:10; opacity:.9; will-change:transform; }
      .cim-graph-canvas .cim-node::before, .cim-graph-canvas .cim-node::after { display:none; }
      .cim-graph-canvas .cim-node-header { height:31px; margin:0 -9px 7px; padding:0 9px; border-radius:4px 4px 0 0; background:linear-gradient(90deg,#2e6d91,#23485e); cursor:move; user-select:none; }
      .cim-graph-canvas .cim-node[data-node-type="condition"] .cim-node-header { background:linear-gradient(90deg,#8b3030,#562020); }
      .cim-graph-canvas .cim-node[data-node-type="approval"] .cim-node-header { background:linear-gradient(90deg,#7b5b20,#4d3918); }
      .cim-graph-canvas .cim-node[data-node-type="image"] .cim-node-header { background:linear-gradient(90deg,#396f38,#254c26); }
      .cim-graph-canvas .cim-node[data-node-type="extract"] .cim-node-header, .cim-graph-canvas .cim-node[data-node-type="foreach"] .cim-node-header { background:linear-gradient(90deg,#674487,#422c58); }
      .cim-graph-canvas .cim-node[data-node-type="validate"] .cim-node-header { background:linear-gradient(90deg,#9a5b24,#603817); }
      .cim-graph-canvas .cim-node[data-node-type="subflow"] .cim-node-header { background:linear-gradient(90deg,#286d65,#194842); }
      .cim-graph-canvas .cim-node[data-node-type="delay"] .cim-node-header { background:linear-gradient(90deg,#555b62,#353a3f); }
      .cim-graph-canvas .cim-node-order { color:#fff; }
      .cim-graph-canvas .cim-node-type { color:#fff; font-size:10px; text-shadow:0 1px #000; }
      .cim-graph-canvas .cim-node-header button { color:#ddd; }
      .cim-graph-canvas .cim-field span { color:#bbb; }
      .cim-graph-canvas .cim-field input, .cim-graph-canvas .cim-field textarea, .cim-graph-canvas .cim-field select { padding:7px 8px; border-color:#111; border-radius:4px; color:#eee; background:#191b1d; font-size:11px; box-shadow:inset 0 1px 2px #0009; }
      .cim-graph-canvas .cim-node textarea { min-height:68px; }
      .cim-graph-canvas .cim-help, .cim-graph-canvas .cim-node-options { color:#999; }
      .cim-node-pin { position:absolute; top:11px; width:11px; height:11px; border:2px solid #eee; border-radius:50%; background:#292b2d; box-shadow:0 0 0 1px #050505; }
      .cim-node-pin-input { left:-7px; }
      .cim-node-pin-output { right:-7px; background:#eee; cursor:crosshair; }
      .cim-branch-port { position:absolute; right:-7px; z-index:3; display:flex; align-items:center; gap:5px; color:#ddd; font:700 9px/1 system-ui; text-shadow:0 1px #000; }
      .cim-branch-port-true { top:43px; color:#82df78; }
      .cim-branch-port-false { top:68px; color:#ef7777; }
      .cim-branch-port .cim-node-pin { position:static; display:block; cursor:crosshair; }
      .cim-branch-port-true .cim-node-pin { border-color:#82df78; background:#82df78; }
      .cim-branch-port-false .cim-node-pin { border-color:#ef7777; background:#ef7777; }
      .cim-graph-connections path.cim-connection-preview { stroke:#f3b35e; stroke-dasharray:6 4; filter:none; }
      .cim-graph-connections path[data-branch="true"] { stroke:#82df78; }
      .cim-graph-connections path[data-branch="false"] { stroke:#ef7777; }
      .cim-automation-card { min-height:132px; display:flex; flex-direction:column; }
      .cim-automation-card .cim-card-name { color:#c26818; }
      html.dark .cim-automation-card .cim-card-name { color:#f4a85f; }
      .cim-automation-badge { width:max-content; margin-top:auto; padding:3px 7px; border-radius:999px; color:#a7520a; background:rgba(219,124,38,.13); font-size:9px; font-weight:700; }
      html.dark .cim-automation-badge { color:#ffc083; background:rgba(219,124,38,.2); }
      .cim-automation-glyph { width:42px; height:42px; display:grid; place-items:center; border-radius:8px; color:#b55b0d; background:rgba(219,124,38,.14); font-size:23px; font-weight:800; }
      .cim-automation-mention { display:inline-flex; align-items:center; padding:1px 7px 2px; margin:0 1px; max-width:180px; border:1px solid rgba(219,124,38,.38); border-radius:999px; color:#ad5509; background:rgba(219,124,38,.13); font-weight:650; line-height:1.35; vertical-align:baseline; cursor:default; }
      html.dark .cim-automation-mention { color:#ffb66f; background:rgba(219,124,38,.21); }
      .cim-run-status { position:fixed; right:18px; bottom:82px; z-index:2147483030; width:min(350px,calc(100vw - 36px)); padding:12px; border:1px solid rgba(219,124,38,.38); border-radius:14px; color:var(--cim-text); background:var(--cim-panel); box-shadow:0 12px 38px rgba(0,0,0,.25); font-family:system-ui,-apple-system,sans-serif; }
      .cim-run-status header { display:flex; align-items:center; gap:8px; }
      .cim-run-status strong { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
      .cim-run-status button { padding:6px 9px; border:1px solid rgba(219,124,38,.42); border-radius:8px; color:#b55b0d; background:transparent; font-size:10px; font-weight:700; cursor:pointer; }
      .cim-run-status p { margin:7px 0 0; color:var(--cim-muted); font-size:11px; line-height:1.4; }
      .cim-run-progress { height:3px; margin-top:9px; overflow:hidden; border-radius:999px; background:rgba(127,127,127,.16); }
      .cim-run-progress span { display:block; height:100%; background:#db7c26; transition:width .2s; }
      @media (max-width:680px) { .cim-modal-body, .cim-automation-layout { grid-template-columns:1fr; } .cim-editor { border-right:0; border-bottom:1px solid var(--cim-border); } .cim-modal { max-height:94vh; } }
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
        if (!db.objectStoreNames.contains(AUTOMATION_STORE_NAME)) {
          const automationStore = db.createObjectStore(AUTOMATION_STORE_NAME, { keyPath: 'id' });
          automationStore.createIndex('nameLower', 'nameLower', { unique: true });
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

  async function loadAutomations() {
    state.automations = await dbRequest('readonly', (store) => store.getAll(), AUTOMATION_STORE_NAME);
    state.automations.sort((a, b) => a.name.localeCompare(b.name));
    state.automationById = new Map(state.automations.map((automation) => [automation.id, automation]));
    state.automationByName = new Map(state.automations.map((automation) => [automation.nameLower, automation]));
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
        ? parsed.filter((entry) =>
          typeof entry?.expandedText === 'string'
          && Array.isArray(entry.restorations)
          && typeof entry.turnId === 'string'
          && entry.turnId)
        : [];
      // Text-only legacy entries could rewrite an unrelated ChatGPT message that
      // happened to contain the same words. Keep only turn-scoped cache records.
      if (!Array.isArray(parsed) || state.historyRestorations.length !== parsed.length) {
        localStorage.setItem(HISTORY_RESTORATIONS_KEY, JSON.stringify(state.historyRestorations));
      }
    } catch (error) {
      state.historyRestorations = [];
      localStorage.removeItem(HISTORY_RESTORATIONS_KEY);
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
      turnId: restoration.turnId || '',
      createdAt: Date.now(),
    };
    if (!entry.turnId) return;
    const candidates = [
      entry,
      ...state.historyRestorations.filter((item) => item.turnId !== entry.turnId),
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
        <nav class="cim-tabs" aria-label="Prompt Forge sections">
          <button type="button" data-cim-tab="files" role="tab" aria-selected="true">@ Files &amp; images</button>
          <button type="button" data-cim-tab="tags" role="tab" aria-selected="false"># Prompt tags</button>
          <button type="button" data-cim-tab="automate" role="tab" aria-selected="false">! Workflow</button>
          <button type="button" data-cim-tab="options" role="tab" aria-selected="false">Options</button>
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
        <div class="cim-workflow-host cim-hidden" data-cim-panel="automate">
          <section class="cim-workflow-home" id="cim-workflow-home">
            <div class="cim-workflow-home-header"><div><h3>Workflows</h3><p>Build reusable prompt graphs and invoke them with <b>!name</b>.</p></div><button type="button" class="cim-primary" data-new-workflow>+ New workflow</button></div>
            <div class="cim-library-title"><strong>Your workflows</strong><span id="cim-automation-count"></span></div>
            <div class="cim-grid" id="cim-automation-grid"></div>
          </section>
          <form id="cim-automation-form" class="cim-workflow-panel cim-hidden">
            <header class="cim-workflow-toolbar">
              <button type="button" class="cim-secondary" data-close-workflow-designer>← Workflows</button>
              <label class="cim-field"><span>Workflow chip</span><input id="cim-automation-name" maxlength="40" autocomplete="off" placeholder="video-pipeline" required pattern="[A-Za-z0-9_-]+"></label>
              <label class="cim-field"><span>Description</span><input id="cim-automation-description" maxlength="160" placeholder="Turn an idea into a complete production package."></label>
              <label class="cim-field"><span>Timeout (min)</span><input id="cim-automation-timeout" type="number" min="1" max="60" value="15"></label>
              <div class="cim-workflow-toolbar-actions"><button class="cim-primary" id="cim-automation-save" type="submit">Save workflow</button><button class="cim-secondary cim-hidden" data-cancel-automation-edit type="button">Cancel edit</button></div>
            </header>
            <div class="cim-workflow-workspace">
              <aside class="cim-workflow-sidebar">
                <h3>+ Add node</h3>
                <div class="cim-skill-palette" aria-label="Workflow nodes">
                  <button type="button" data-add-automation-node="prompt">Prompt</button>
                  <button type="button" data-add-automation-node="delay">Delay</button>
                  <button type="button" data-add-automation-node="image">Generated Image</button>
                  <button type="button" data-add-automation-node="condition">If / Else</button>
                  <button type="button" data-add-automation-node="approval">Approval</button>
                  <button type="button" data-add-automation-node="foreach">For Each</button>
                  <button type="button" data-add-automation-node="validate">Retry / Validate</button>
                  <button type="button" data-add-automation-node="extract">Extract Variable</button>
                  <button type="button" data-add-automation-node="subflow">Run Workflow</button>
                </div>
                <h3>Variables</h3>
                <div class="cim-variable-tools">
                  <button type="button" data-insert-automation-variable="input">{{input}}</button>
                  <button type="button" data-insert-automation-variable="last">{{last}}</button>
                  <button type="button" data-insert-automation-variable="lastImage">{{lastImage}}</button>
                </div>
              </aside>
              <section class="cim-graph-shell">
                <div class="cim-graph-toolbar"><strong>Workflow Graph</strong><small>Connect dots to route · click a line to sever</small><button type="button" data-graph-zoom-out aria-label="Zoom out">−</button><button type="button" data-graph-zoom-label>100%</button><button type="button" data-graph-zoom-in aria-label="Zoom in">+</button><button type="button" data-graph-fit>Fit</button></div>
                <div class="cim-graph-viewport" id="cim-graph-viewport">
                  <div class="cim-graph-canvas" id="cim-graph-canvas">
                    <svg class="cim-graph-connections" id="cim-graph-connections" aria-hidden="true"></svg>
                    <div class="cim-node-graph" id="cim-automation-nodes"></div>
                  </div>
                </div>
              </section>
            </div>
          </form>
        </div>
        <section class="cim-settings-panel cim-hidden" data-cim-panel="options">
          <h3>Options</h3>
          <p>Configure Prompt Forge across regular chats, saved references, and workflows.</p>
          <label class="cim-setting-toggle">
            <input id="cim-retry-on-error" type="checkbox">
            <span>
              <strong>Retry on error</strong>
              <small>For any ChatGPT send, use the native Try again action once after an image-generation failure. If it is unavailable, edit and resend the same prompt. Policy refusals are not retried.</small>
            </span>
          </label>
        </section>
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
    backdrop.querySelector('[data-cancel-automation-edit]').addEventListener('click', closeWorkflowDesigner);
    backdrop.querySelector('[data-close-workflow-designer]').addEventListener('click', closeWorkflowDesigner);
    backdrop.querySelector('[data-new-workflow]').addEventListener('click', () => openWorkflowDesigner());
    backdrop.querySelector('#cim-tag-random-enabled').addEventListener('change', updateTagRandomPoolState);
    backdrop.querySelector('#cim-tag-random-count').addEventListener('input', updateTagRandomPoolState);
    backdrop.querySelector('#cim-tag-random-pool').addEventListener('change', updateTagRandomPoolState);
    backdrop.querySelector('#cim-retry-on-error').addEventListener('change', (event) => {
      state.retryOnError = event.target.checked;
      if (!state.retryOnError) state.standaloneRetry = null;
      localStorage.setItem(RETRY_ON_ERROR_KEY, String(state.retryOnError));
    });
    backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) closeModal(); });
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') fileInput.click(); });
    fileInput.addEventListener('change', () => setPendingFile(fileInput.files[0]));
    for (const type of ['dragenter', 'dragover']) dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.add('cim-dragging'); });
    for (const type of ['dragleave', 'drop']) dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.remove('cim-dragging'); });
    dropzone.addEventListener('drop', (event) => setPendingFile(event.dataTransfer.files[0]));
    backdrop.querySelector('#cim-editor-form').addEventListener('submit', saveEditor);
    backdrop.querySelector('#cim-tag-form').addEventListener('submit', saveTagEditor);
    backdrop.querySelector('#cim-automation-form').addEventListener('submit', saveAutomationEditor);
    backdrop.querySelectorAll('[data-add-automation-node]').forEach((button) => button.addEventListener('click', () => appendAutomationNode(button.dataset.addAutomationNode)));
    backdrop.querySelectorAll('[data-insert-automation-variable]').forEach((button) => {
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => insertAutomationVariable(button.dataset.insertAutomationVariable));
    });
    backdrop.querySelector('#cim-automation-nodes').addEventListener('click', handleAutomationNodeAction);
    backdrop.querySelector('#cim-automation-nodes').addEventListener('pointerdown', handleWorkflowNodePointerDown);
    backdrop.querySelector('#cim-graph-connections').addEventListener('click', handleWorkflowConnectionClick);
    backdrop.querySelector('#cim-graph-viewport').addEventListener('pointerdown', handleWorkflowCanvasPointerDown);
    backdrop.querySelector('#cim-graph-viewport').addEventListener('wheel', (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setWorkflowZoom(state.workflowZoom + (event.deltaY < 0 ? .1 : -.1));
    }, { passive: false });
    backdrop.querySelector('[data-graph-zoom-in]').addEventListener('click', () => setWorkflowZoom(state.workflowZoom + .1));
    backdrop.querySelector('[data-graph-zoom-out]').addEventListener('click', () => setWorkflowZoom(state.workflowZoom - .1));
    backdrop.querySelector('[data-graph-fit]').addEventListener('click', fitWorkflowGraph);
  }

  function openModal() {
    ensureUserscriptUi();
    const backdrop = document.querySelector('.cim-modal-backdrop');
    if (!backdrop) return toast('The mentions library could not be opened. Refresh ChatGPT and try again.');
    resetEditor();
    resetTagEditor();
    closeWorkflowDesigner();
    renderLibrary();
    renderTagLibrary();
    renderAutomationLibrary();
    renderOptions();
    switchModalTab(state.modalTab);
    backdrop.classList.remove('cim-hidden');
    const focusTarget = state.modalTab === 'tags' ? '#cim-tag-name'
      : state.modalTab === 'automate' ? '[data-new-workflow]'
        : state.modalTab === 'options' ? '#cim-retry-on-error' : '#cim-nickname';
    document.querySelector(focusTarget)?.focus();
  }

  function closeModal() {
    document.querySelector('.cim-modal-backdrop')?.classList.add('cim-hidden');
    closeAutocomplete();
    resetEditor();
    resetTagEditor();
    closeWorkflowDesigner();
    requestAnimationFrame(() => hydrateStoredReferences(getEditor()));
  }

  function switchModalTab(tab) {
    closeAutocomplete();
    state.modalTab = ['files', 'tags', 'automate', 'options'].includes(tab) ? tab : 'files';
    if (state.modalTab !== 'automate') closeWorkflowDesigner();
    document.querySelectorAll('[data-cim-tab]').forEach((button) => button.setAttribute('aria-selected', String(button.dataset.cimTab === state.modalTab)));
    document.querySelectorAll('[data-cim-panel]').forEach((panel) => panel.classList.toggle('cim-hidden', panel.dataset.cimPanel !== state.modalTab));
    if (state.modalTab === 'automate') requestAnimationFrame(() => { setWorkflowZoom(state.workflowZoom); scheduleWorkflowConnections(); });
  }

  function renderOptions() {
    const retryOnError = document.querySelector('#cim-retry-on-error');
    if (retryOnError) retryOnError.checked = state.retryOnError;
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

  function automationNodeMarkup(node = { type: 'prompt' }) {
    const allowedTypes = new Set(['prompt', 'delay', 'image', 'condition', 'approval', 'foreach', 'validate', 'extract', 'subflow']);
    const type = allowedTypes.has(node.type) ? node.type : 'prompt';
    const id = node.id || shortId();
    const x = Math.max(20, Number(node.x) || 40);
    const y = Math.max(20, Number(node.y) || 50);
    const position = `data-node-x="${x}" data-node-y="${y}" style="transform:translate3d(${x}px,${y}px,0)"`;
    const selected = (value, expected) => value === expected ? ' selected' : '';
    const header = (label, hasOutput = true) => `<div class="cim-node-header"><span class="cim-node-pin cim-node-pin-input"></span><span class="cim-node-order">01</span><span class="cim-node-type">${label}</span><button type="button" data-node-up title="Earlier in execution">←</button><button type="button" data-node-down title="Later in execution">→</button><button type="button" data-node-delete title="Delete node">×</button>${hasOutput ? '<span class="cim-node-pin cim-node-pin-output" data-branch="next"></span>' : ''}</div>`;
    if (type === 'delay') {
      return `<article class="cim-node" ${position} data-node-id="${id}" data-node-type="delay">
        ${header('Delay')}
        <div class="cim-node-options"><label>Wait <input data-node-seconds type="number" min="1" max="3600" value="${Math.min(3600, Math.max(1, Number(node.seconds) || 5))}"> seconds before continuing</label></div>
      </article>`;
    }
    if (type === 'image') {
      return `<article class="cim-node" ${position} data-node-id="${id}" data-node-type="image">
        ${header('Generated Image · capture')}
        <div class="cim-node-fields"><label class="cim-field cim-field-wide"><span>Save the latest generated image as</span><input data-node-image-name maxlength="40" value="${escapeHtml(node.name || 'image')}" placeholder="hero"></label></div>
        <p class="cim-help">Use it later as <b>{{image:${escapeHtml(node.name || 'image')}}}</b>. <b>{{lastImage}}</b> always refers to the newest generated image.</p>
      </article>`;
    }
    if (type === 'condition') {
      return `<article class="cim-node" ${position} data-node-id="${id}" data-node-type="condition">
        ${header('If / Else · route', false)}
        <div class="cim-branch-port cim-branch-port-true"><span>True</span><i class="cim-node-pin cim-node-pin-output" data-branch="true"></i></div>
        <div class="cim-branch-port cim-branch-port-false"><span>False</span><i class="cim-node-pin cim-node-pin-output" data-branch="false"></i></div>
        <div class="cim-node-fields">
          <label class="cim-field cim-field-wide"><span>Value to test</span><input data-node-condition-source value="${escapeHtml(node.source || '{{last}}')}" placeholder="{{last}} or {{var:score}}"></label>
          <label class="cim-field"><span>Condition</span><select data-node-operator>
            <option value="contains"${selected(node.operator, 'contains')}>Contains</option><option value="not_contains"${selected(node.operator, 'not_contains')}>Does not contain</option>
            <option value="equals"${selected(node.operator, 'equals')}>Equals</option><option value="not_empty"${selected(node.operator, 'not_empty')}>Is not empty</option>
            <option value="regex"${selected(node.operator, 'regex')}>Matches regex</option><option value="image_exists"${selected(node.operator, 'image_exists')}>Image exists</option>
          </select></label>
          <label class="cim-field"><span>Expected text / regex</span><input data-node-expected value="${escapeHtml(node.expected || '')}" placeholder="approved"></label>
        </div>
        <p class="cim-help">Connect the True and False dots to the nodes each result should run next. An unconnected result ends the workflow.</p>
      </article>`;
    }
    if (type === 'approval') {
      return `<article class="cim-node" ${position} data-node-id="${id}" data-node-type="approval">
        ${header('Approval · pause for review')}
        <label class="cim-field"><span>Checkpoint message</span><input data-node-approval-message maxlength="240" value="${escapeHtml(node.message || 'Review the latest result before continuing.')}" placeholder="Approve the script before image generation."></label>
        <p class="cim-help">The run panel offers Continue, Retry last prompt, Edit last output, and Stop.</p>
      </article>`;
    }
    if (type === 'foreach') {
      return `<article class="cim-node" ${position} data-node-id="${id}" data-node-type="foreach">
        ${header('For Each · list prompt')}
        <label class="cim-field"><span>Items (one per line, JSON array, or variable)</span><textarea data-node-list-source maxlength="12000" placeholder="{{input}}">${escapeHtml(node.source || '{{input}}')}</textarea></label>
        <label class="cim-field"><span>Prompt sent for each item</span><textarea data-node-template maxlength="12000" required placeholder="Create a scene for {{item}} ({{index}} of {{itemTotal}}).">${escapeHtml(node.template || '')}</textarea></label>
      </article>`;
    }
    if (type === 'validate') {
      return `<article class="cim-node" ${position} data-node-id="${id}" data-node-type="validate">
        ${header('Retry / Validate · quality gate')}
        <div class="cim-node-fields">
          <label class="cim-field cim-field-wide"><span>Value to validate</span><input data-node-validation-source value="${escapeHtml(node.source || '{{last}}')}" placeholder="{{last}}"></label>
          <label class="cim-field"><span>Rule</span><select data-node-operator>
            <option value="not_empty"${selected(node.operator || 'not_empty', 'not_empty')}>Is not empty</option><option value="contains"${selected(node.operator, 'contains')}>Contains</option>
            <option value="not_contains"${selected(node.operator, 'not_contains')}>Does not contain</option><option value="equals"${selected(node.operator, 'equals')}>Equals</option>
            <option value="regex"${selected(node.operator, 'regex')}>Matches regex</option><option value="image_exists"${selected(node.operator, 'image_exists')}>Image exists</option>
          </select></label>
          <label class="cim-field"><span>Expected text / regex</span><input data-node-expected value="${escapeHtml(node.expected || '')}"></label>
          <label class="cim-field"><span>Maximum retries</span><input data-node-retries type="number" min="1" max="10" value="${Math.min(10, Math.max(1, Number(node.retries) || 2))}"></label>
        </div>
        <p class="cim-help">If validation fails, the previous prompt is sent again until it passes or retries run out.</p>
      </article>`;
    }
    if (type === 'extract') {
      return `<article class="cim-node" ${position} data-node-id="${id}" data-node-type="extract">
        ${header('Extract Variable · parse output')}
        <div class="cim-node-fields">
          <label class="cim-field"><span>Variable name</span><input data-node-variable-name maxlength="40" value="${escapeHtml(node.name || 'result')}" placeholder="script"></label>
          <label class="cim-field"><span>Extraction mode</span><select data-node-extract-mode><option value="full"${selected(node.mode || 'full', 'full')}>Entire value</option><option value="regex"${selected(node.mode, 'regex')}>Regex capture</option><option value="json"${selected(node.mode, 'json')}>JSON path</option></select></label>
          <label class="cim-field cim-field-wide"><span>Source</span><textarea data-node-extract-source maxlength="12000">${escapeHtml(node.source || '{{last}}')}</textarea></label>
          <label class="cim-field cim-field-wide"><span>Regex or JSON path</span><input data-node-extract-pattern value="${escapeHtml(node.pattern || '')}" placeholder="Title:\\s*(.+) or scenes.0.title"></label>
        </div>
        <p class="cim-help">Reference the saved value later with <b>{{var:${escapeHtml(node.name || 'result')}}}</b>.</p>
      </article>`;
    }
    if (type === 'subflow') {
      const targetId = node.automationId || '';
      const targets = [...state.automations];
      if (targetId && !targets.some((automation) => automation.id === targetId)) targets.push({ id: targetId, name: 'Missing workflow' });
      return `<article class="cim-node" ${position} data-node-id="${id}" data-node-type="subflow">
        ${header('Run Workflow · sub-graph')}
        <label class="cim-field"><span>Workflow</span><select data-node-automation-id><option value="">Choose a workflow</option>${targets.map((automation) => `<option value="${escapeHtml(automation.id)}"${selected(targetId, automation.id)}>!${escapeHtml(automation.name)}</option>`).join('')}</select></label>
        <label class="cim-field"><span>Input passed to it</span><textarea data-node-template maxlength="12000">${escapeHtml(node.input || '{{input}}')}</textarea></label>
        <p class="cim-help">Nested workflows share outputs and variables. Recursive loops and nesting deeper than five levels are blocked.</p>
      </article>`;
    }
    return `<article class="cim-node" ${position} data-node-id="${id}" data-node-type="prompt">
      ${header('Prompt · waits for completion')}
      <label class="cim-field"><span>What should be sent?</span><textarea data-node-template maxlength="12000" required placeholder="Create an image for: {{input}}">${escapeHtml(node.template || '')}</textarea></label>
      <div class="cim-node-options"><label>Run <input data-node-repeat type="number" min="1" max="50" value="${Math.min(50, Math.max(1, Number(node.repeat) || 1))}"> time(s)</label><span>Each repeat waits for the full response.</span></div>
    </article>`;
  }

  function appendAutomationNode(type = 'prompt', node = null) {
    const graph = document.querySelector('#cim-automation-nodes');
    if (!graph) return;
    const count = graph.children.length;
    const previous = graph.lastElementChild;
    const positioned = node || {
      type,
      x: 50 + (count % 4) * 340,
      y: 60 + Math.floor(count / 4) * 300,
    };
    graph.insertAdjacentHTML('beforeend', automationNodeMarkup(positioned));
    const added = graph.lastElementChild;
    if (previous && added) {
      const branch = previous.dataset.nodeType === 'condition' ? 'true' : 'next';
      if (!state.workflowConnections.some((connection) => connection.from === previous.dataset.nodeId && connection.branch === branch)) {
        state.workflowConnections.push({ from: previous.dataset.nodeId, to: added.dataset.nodeId, branch });
      }
    }
    observeWorkflowNodeSizes(false);
    updateAutomationNodeOrder();
    added?.querySelector('textarea, input')?.focus();
  }

  function defaultWorkflowConnections(nodes) {
    const connections = [];
    nodes.forEach((node, index) => {
      if (node.type !== 'condition') {
        if (nodes[index + 1]) connections.push({ from: node.id, to: nodes[index + 1].id, branch: 'next' });
        return;
      }
      for (const branch of ['true', 'false']) {
        const action = node[`${branch}Action`] || (branch === 'true' ? 'continue' : 'skip');
        if (action === 'stop') continue;
        const skip = action === 'skip' ? Math.min(50, Math.max(1, Number(node[`${branch}Skip`]) || 1)) : 0;
        const target = nodes[index + skip + 1];
        if (target) connections.push({ from: node.id, to: target.id, branch });
      }
    });
    return connections;
  }

  function sanitizeWorkflowConnections(connections, nodes) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const slots = new Set();
    const clean = [];
    for (const connection of Array.isArray(connections) ? connections : []) {
      const source = byId.get(connection?.from);
      if (!source || !byId.has(connection?.to) || connection.from === connection.to) continue;
      const branch = source.type === 'condition' && ['true', 'false'].includes(connection.branch)
        ? connection.branch
        : source.type === 'condition' ? 'true' : 'next';
      const slot = `${connection.from}:${branch}`;
      if (slots.has(slot)) continue;
      slots.add(slot);
      clean.push({ from: connection.from, to: connection.to, branch });
    }
    return clean;
  }

  function setAutomationNodes(nodes, connections) {
    const graph = document.querySelector('#cim-automation-nodes');
    if (!graph) return;
    const prepared = (Array.isArray(nodes) ? nodes : []).map((node, index) => ({
      ...node,
      id: node.id || shortId(),
      x: Number(node.x) || 50 + (index % 4) * 340,
      y: Number(node.y) || 60 + Math.floor(index / 4) * 300,
    }));
    state.workflowConnections = sanitizeWorkflowConnections(
      Array.isArray(connections) ? connections : defaultWorkflowConnections(prepared),
      prepared,
    );
    graph.innerHTML = prepared.map((node) => automationNodeMarkup(node)).join('');
    observeWorkflowNodeSizes(true);
    updateAutomationNodeOrder();
  }

  function observeWorkflowNodeSizes(reset = false) {
    if (!('ResizeObserver' in window)) return;
    if (!state.workflowResizeObserver) state.workflowResizeObserver = new ResizeObserver(scheduleWorkflowConnections);
    if (reset) state.workflowResizeObserver.disconnect();
    document.querySelectorAll('#cim-automation-nodes .cim-node').forEach((node) => state.workflowResizeObserver.observe(node));
  }

  function readAutomationNodes() {
    return [...document.querySelectorAll('#cim-automation-nodes .cim-node')].map((element) => {
      const type = element.dataset.nodeType;
      const value = (selector) => element.querySelector(selector)?.value?.trim() || '';
      const base = {
        id: element.dataset.nodeId || shortId(), type,
        x: Math.max(20, Math.round(Number(element.dataset.nodeX) || 40)),
        y: Math.max(20, Math.round(Number(element.dataset.nodeY) || 50)),
      };
      if (type === 'delay') {
        return { ...base, seconds: Math.min(3600, Math.max(1, Number(element.querySelector('[data-node-seconds]')?.value) || 1)) };
      }
      if (type === 'image') return { ...base, name: value('[data-node-image-name]') };
      if (type === 'condition') {
        return {
          ...base, source: value('[data-node-condition-source]'),
          operator: value('[data-node-operator]'), expected: value('[data-node-expected]'),
        };
      }
      if (type === 'approval') return { ...base, message: value('[data-node-approval-message]') };
      if (type === 'foreach') return { ...base, source: value('[data-node-list-source]'), template: value('[data-node-template]') };
      if (type === 'validate') {
        return {
          ...base, source: value('[data-node-validation-source]'),
          operator: value('[data-node-operator]'), expected: value('[data-node-expected]'),
          retries: Math.min(10, Math.max(1, Number(value('[data-node-retries]')) || 1)),
        };
      }
      if (type === 'extract') {
        return {
          ...base, name: value('[data-node-variable-name]'),
          mode: value('[data-node-extract-mode]'), source: value('[data-node-extract-source]'),
          pattern: value('[data-node-extract-pattern]'),
        };
      }
      if (type === 'subflow') {
        return {
          ...base,
          automationId: value('[data-node-automation-id]'), input: value('[data-node-template]'),
        };
      }
      return {
        ...base, type: 'prompt',
        template: element.querySelector('[data-node-template]')?.value.trim() || '',
        repeat: Math.min(50, Math.max(1, Number(element.querySelector('[data-node-repeat]')?.value) || 1)),
      };
    });
  }

  function readWorkflowConnections() {
    return sanitizeWorkflowConnections(state.workflowConnections, readAutomationNodes());
  }

  function scheduleWorkflowConnections() {
    if (state.workflowConnectionFrame) return;
    state.workflowConnectionFrame = requestAnimationFrame(() => {
      state.workflowConnectionFrame = null;
      updateWorkflowConnections();
    });
  }

  function updateAutomationNodeOrder() {
    document.querySelectorAll('#cim-automation-nodes .cim-node').forEach((node, index) => {
      const order = node.querySelector('.cim-node-order');
      if (order) order.textContent = String(index + 1).padStart(2, '0');
      node.classList.remove('cim-node-dragging');
    });
    scheduleWorkflowConnections();
  }

  function handleAutomationNodeAction(event) {
    const node = event.target.closest('.cim-node');
    if (!node) return;
    if (event.target.closest('[data-node-delete]')) {
      const id = node.dataset.nodeId;
      state.workflowConnections = state.workflowConnections.filter((connection) => connection.from !== id && connection.to !== id);
      node.remove();
    }
    else if (event.target.closest('[data-node-up]') && node.previousElementSibling) node.parentElement.insertBefore(node, node.previousElementSibling);
    else if (event.target.closest('[data-node-down]') && node.nextElementSibling) node.parentElement.insertBefore(node.nextElementSibling, node);
    else return;
    updateAutomationNodeOrder();
  }

  function updateWorkflowConnections() {
    const graph = document.querySelector('#cim-automation-nodes');
    const canvas = document.querySelector('#cim-graph-canvas');
    const svg = document.querySelector('#cim-graph-connections');
    if (!graph || !canvas || !svg) return;
    const nodes = [...graph.querySelectorAll('.cim-node')];
    const byId = new Map(nodes.map((node) => [node.dataset.nodeId, node]));
    let width = 1800;
    let height = 1100;
    for (const node of nodes) {
      const x = Number(node.dataset.nodeX) || 0;
      const y = Number(node.dataset.nodeY) || 0;
      width = Math.max(width, x + node.offsetWidth + 220);
      height = Math.max(height, y + node.offsetHeight + 180);
    }
    const widthPx = `${width}px`;
    const heightPx = `${height}px`;
    if (canvas.style.width !== widthPx) canvas.style.width = widthPx;
    if (canvas.style.height !== heightPx) canvas.style.height = heightPx;
    const viewBox = `0 0 ${width} ${height}`;
    if (svg.getAttribute('viewBox') !== viewBox) svg.setAttribute('viewBox', viewBox);
    const existing = new Map([...svg.querySelectorAll('path[data-key]')].map((path) => [path.dataset.key, path]));
    const live = new Set();
    for (const connection of state.workflowConnections) {
      const source = byId.get(connection.from);
      const target = byId.get(connection.to);
      if (!source || !target) continue;
      const key = `${connection.from}:${connection.branch}:${connection.to}`;
      live.add(key);
      let path = existing.get(key);
      if (!path) {
        path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        svg.appendChild(path);
      }
      const pin = source.querySelector(`.cim-node-pin-output[data-branch="${connection.branch}"]`)
        || source.querySelector('.cim-node-pin-output');
      const x1 = (Number(source.dataset.nodeX) || 0) + source.offsetWidth;
      const branchPort = pin?.closest('.cim-branch-port');
      const pinTop = branchPort ? branchPort.offsetTop + pin.offsetTop : (pin?.offsetTop || 11);
      const y1 = (Number(source.dataset.nodeY) || 0) + pinTop + (pin?.offsetHeight || 10) / 2;
      const x2 = Number(target.dataset.nodeX) || 0;
      const input = target.querySelector('.cim-node-pin-input');
      const y2 = (Number(target.dataset.nodeY) || 0) + (input?.offsetTop || 11) + (input?.offsetHeight || 10) / 2;
      const curve = Math.max(65, Math.abs(x2 - x1) * .45);
      path.dataset.key = key;
      path.dataset.from = connection.from;
      path.dataset.to = connection.to;
      path.dataset.branch = connection.branch;
      path.setAttribute('d', `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`);
    }
    for (const [key, path] of existing) {
      if (!live.has(key)) path.remove();
    }
  }

  function handleWorkflowNodePointerDown(event) {
    const outputPin = event.target.closest('.cim-node-pin-output');
    if (outputPin) {
      const sourceNode = outputPin.closest('.cim-node');
      if (sourceNode) startWorkflowConnection(event, sourceNode, outputPin.dataset.branch || 'next');
      return;
    }
    const header = event.target.closest('.cim-node-header');
    const node = header?.closest('.cim-node');
    if (!node || event.target.closest('button, input, textarea, select')) return;
    if (event.target.closest('.cim-node-pin')) return;
    event.preventDefault();
    node.setPointerCapture?.(event.pointerId);
    node.classList.add('cim-node-dragging');
    const startX = event.clientX;
    const startY = event.clientY;
    const originalX = Number(node.dataset.nodeX) || 40;
    const originalY = Number(node.dataset.nodeY) || 50;
    const zoom = state.workflowZoom || 1;
    const move = (moveEvent) => {
      const x = Math.max(20, Math.round(originalX + (moveEvent.clientX - startX) / zoom));
      const y = Math.max(20, Math.round(originalY + (moveEvent.clientY - startY) / zoom));
      node.dataset.nodeX = String(x);
      node.dataset.nodeY = String(y);
      node.style.transform = `translate3d(${x}px,${y}px,0)`;
      scheduleWorkflowConnections();
    };
    const end = () => {
      node.classList.remove('cim-node-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      scheduleWorkflowConnections();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end, { once: true });
  }

  function startWorkflowConnection(event, sourceNode, branch = 'next') {
    event.preventDefault();
    event.stopPropagation();
    const canvas = document.querySelector('#cim-graph-canvas');
    const svg = document.querySelector('#cim-graph-connections');
    if (!canvas || !svg) return;
    const preview = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    preview.classList.add('cim-connection-preview');
    svg.appendChild(preview);
    const sourcePin = sourceNode.querySelector(`.cim-node-pin-output[data-branch="${branch}"]`) || event.target;
    const x1 = (Number(sourceNode.dataset.nodeX) || 0) + sourceNode.offsetWidth;
    const branchPort = sourcePin.closest('.cim-branch-port');
    const pinTop = branchPort ? branchPort.offsetTop + sourcePin.offsetTop : (sourcePin.offsetTop || 11);
    const y1 = (Number(sourceNode.dataset.nodeY) || 0) + pinTop + (sourcePin.offsetHeight || 10) / 2;
    const move = (moveEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x2 = (moveEvent.clientX - rect.left) / (state.workflowZoom || 1);
      const y2 = (moveEvent.clientY - rect.top) / (state.workflowZoom || 1);
      const curve = Math.max(65, Math.abs(x2 - x1) * .45);
      preview.setAttribute('d', `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`);
    };
    const end = (upEvent) => {
      window.removeEventListener('pointermove', move);
      preview.remove();
      const inputPin = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest('.cim-node-pin-input');
      const targetNode = inputPin?.closest('.cim-node');
      if (targetNode && targetNode !== sourceNode) {
        state.workflowConnections = state.workflowConnections.filter((connection) =>
          !(connection.from === sourceNode.dataset.nodeId && connection.branch === branch));
        state.workflowConnections.push({
          from: sourceNode.dataset.nodeId,
          to: targetNode.dataset.nodeId,
          branch,
        });
      }
      scheduleWorkflowConnections();
    };
    move(event);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end, { once: true });
  }

  function handleWorkflowConnectionClick(event) {
    const path = event.target.closest('path[data-key]');
    if (!path) return;
    event.preventDefault();
    event.stopPropagation();
    state.workflowConnections = state.workflowConnections.filter((connection) =>
      !(connection.from === path.dataset.from
        && connection.to === path.dataset.to
        && connection.branch === path.dataset.branch));
    path.remove();
    scheduleWorkflowConnections();
    toast('Connection removed.');
  }

  function handleWorkflowCanvasPointerDown(event) {
    const viewport = event.currentTarget;
    if (event.target.closest('.cim-node, path[data-key], button, input, textarea, select')) return;
    event.preventDefault();
    viewport.classList.add('cim-panning');
    const startX = event.clientX;
    const startY = event.clientY;
    const scrollLeft = viewport.scrollLeft;
    const scrollTop = viewport.scrollTop;
    const move = (moveEvent) => {
      viewport.scrollLeft = scrollLeft - (moveEvent.clientX - startX);
      viewport.scrollTop = scrollTop - (moveEvent.clientY - startY);
    };
    const end = () => {
      viewport.classList.remove('cim-panning');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end, { once: true });
  }

  function setWorkflowZoom(value) {
    state.workflowZoom = Math.min(1.5, Math.max(.5, Math.round(value * 10) / 10));
    const canvas = document.querySelector('#cim-graph-canvas');
    if (canvas) canvas.style.zoom = String(state.workflowZoom);
    const label = document.querySelector('[data-graph-zoom-label]');
    if (label) label.textContent = `${Math.round(state.workflowZoom * 100)}%`;
    scheduleWorkflowConnections();
  }

  function fitWorkflowGraph() {
    setWorkflowZoom(.8);
    const viewport = document.querySelector('#cim-graph-viewport');
    if (viewport) { viewport.scrollLeft = 0; viewport.scrollTop = 0; }
  }

  function insertAutomationVariable(variable) {
    let textarea = document.activeElement?.matches?.('#cim-automation-nodes [data-node-template]')
      ? document.activeElement
      : document.querySelector('#cim-automation-nodes .cim-node:last-child [data-node-template]');
    if (!textarea) {
      appendAutomationNode('prompt');
      textarea = document.querySelector('#cim-automation-nodes .cim-node:last-child [data-node-template]');
    }
    if (!textarea) return;
    const tokenName = variable === 'last' ? 'last' : variable === 'lastImage' ? 'lastImage' : 'input';
    const token = `{{${tokenName}}}`;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const leading = start > 0 && !/\s/.test(textarea.value[start - 1]) ? ' ' : '';
    const trailing = end < textarea.value.length && !/\s/.test(textarea.value[end]) ? ' ' : '';
    textarea.setRangeText(`${leading}${token}${trailing}`, start, end, 'end');
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: token }));
    textarea.focus();
  }

  function resetAutomationEditor() {
    state.editingAutomationId = null;
    const form = document.querySelector('#cim-automation-form');
    if (!form) return;
    form.reset();
    const timeout = form.querySelector('#cim-automation-timeout');
    if (timeout) timeout.value = '15';
    setAutomationNodes([{ type: 'prompt', repeat: 1, template: '{{input}}' }]);
    form.querySelector('#cim-automation-save').textContent = 'Save workflow';
    form.querySelector('[data-cancel-automation-edit]')?.classList.add('cim-hidden');
  }

  function openWorkflowDesigner(id = null) {
    resetAutomationEditor();
    document.querySelector('#cim-workflow-home')?.classList.add('cim-hidden');
    document.querySelector('#cim-automation-form')?.classList.remove('cim-hidden');
    document.querySelector('.cim-modal')?.classList.add('cim-workflow-designing');
    document.querySelector('.cim-modal-backdrop')?.classList.add('cim-workflow-designing-backdrop');
    if (id) {
      const automation = state.automationById.get(id);
      if (!automation) return closeWorkflowDesigner();
      state.editingAutomationId = id;
      document.querySelector('#cim-automation-name').value = automation.name;
      document.querySelector('#cim-automation-description').value = automation.description || '';
      document.querySelector('#cim-automation-timeout').value = String(automation.timeoutMinutes || 15);
      setAutomationNodes(automation.nodes || [], automation.connections);
      document.querySelector('#cim-automation-save').textContent = 'Update workflow';
      document.querySelector('[data-cancel-automation-edit]')?.classList.remove('cim-hidden');
    }
    requestAnimationFrame(() => {
      fitWorkflowGraph();
      document.querySelector('#cim-automation-name')?.focus();
    });
  }

  function closeWorkflowDesigner() {
    document.querySelector('#cim-automation-form')?.classList.add('cim-hidden');
    document.querySelector('#cim-workflow-home')?.classList.remove('cim-hidden');
    document.querySelector('.cim-modal')?.classList.remove('cim-workflow-designing');
    document.querySelector('.cim-modal-backdrop')?.classList.remove('cim-workflow-designing-backdrop');
    resetAutomationEditor();
    renderAutomationLibrary();
  }

  async function saveAutomationEditor(event) {
    event.preventDefault();
    const name = document.querySelector('#cim-automation-name').value.trim().replace(/^!/, '');
    const description = document.querySelector('#cim-automation-description').value.trim();
    const timeoutMinutes = Math.min(60, Math.max(1, Number(document.querySelector('#cim-automation-timeout').value) || 15));
    const nodes = readAutomationNodes();
    const connections = readWorkflowConnections();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) return toast('Workflow names can only contain letters, numbers, underscores, and hyphens.');
    if (!nodes.length || !nodes.some((node) => ['prompt', 'foreach', 'subflow'].includes(node.type))) return toast('Add at least one Prompt, For Each, or Run Workflow node.');
    if (nodes.some((node) => ['prompt', 'foreach'].includes(node.type) && !node.template)) return toast('Every Prompt and For Each node needs prompt text.');
    if (nodes.some((node) => ['image', 'extract'].includes(node.type) && !/^[A-Za-z0-9_-]{1,40}$/.test(node.name))) return toast('Image and variable names can only contain letters, numbers, underscores, and hyphens.');
    if (nodes.some((node) => node.type === 'subflow' && !node.automationId)) return toast('Choose a workflow for every Run Workflow node.');
    const incoming = new Set(connections.map((connection) => connection.to));
    const roots = nodes.filter((node) => !incoming.has(node.id));
    if (roots.length !== 1) return toast('Connect the workflow so it has exactly one starting node.');
    const outgoing = new Map(nodes.map((node) => [node.id, []]));
    connections.forEach((connection) => outgoing.get(connection.from)?.push(connection.to));
    const reachable = new Set();
    const pending = [roots[0].id];
    while (pending.length) {
      const id = pending.pop();
      if (reachable.has(id)) continue;
      reachable.add(id);
      pending.push(...(outgoing.get(id) || []));
    }
    if (reachable.size !== nodes.length) return toast('Connect every workflow node to the starting node.');
    const promptRuns = automationPromptRunCount({ nodes });
    if (promptRuns > 100) return toast('A workflow can run at most 100 prompts.');
    const duplicate = state.automationByName.get(name.toLocaleLowerCase());
    if (duplicate && duplicate.id !== state.editingAutomationId) return toast(`!${name} is already in your library.`);
    const old = state.editingAutomationId ? state.automationById.get(state.editingAutomationId) : null;
    const automation = {
      ...(old || {}),
      id: old?.id || shortId(), name, nameLower: name.toLocaleLowerCase(), description,
      timeoutMinutes, nodes, connections, createdAt: old?.createdAt || Date.now(), updatedAt: Date.now(),
    };
    try {
      await dbRequest('readwrite', (store) => store.put(automation), AUTOMATION_STORE_NAME);
      await loadAutomations();
      closeWorkflowDesigner();
      toast(`Saved !${name}`);
    } catch (error) {
      console.error('[Prompt Forge] Workflow save failed', error);
      toast('Could not save the workflow.');
    }
  }

  function renderAutomationLibrary() {
    const grid = document.querySelector('#cim-automation-grid');
    if (!grid) return;
    document.querySelector('#cim-automation-count').textContent = `${state.automations.length} saved`;
    if (!state.automations.length) {
      grid.innerHTML = '<div class="cim-empty">Build a graph, then type its !name followed by your idea.</div>';
      return;
    }
    grid.innerHTML = state.automations.map((automation) => {
      const promptCount = automationPromptRunCount(automation);
      return `<article class="cim-card cim-automation-card" data-id="${automation.id}">
        <div class="cim-card-actions"><button type="button" data-edit-automation aria-label="Edit !${escapeHtml(automation.name)}">${ICONS.edit}</button><button type="button" data-delete-automation aria-label="Delete !${escapeHtml(automation.name)}">${ICONS.trash}</button></div>
        <div class="cim-card-name">!${escapeHtml(automation.name)}</div><div class="cim-card-note">${escapeHtml(automation.description || truncatePreview((automation.nodes || []).find((node) => ['prompt', 'foreach'].includes(node.type))?.template || '', 180))}</div>
        <div class="cim-automation-badge">${(automation.nodes || []).length} nodes · ${promptCount} prompt${promptCount === 1 ? '' : 's'}</div>
      </article>`;
    }).join('');
    grid.querySelectorAll('[data-edit-automation]').forEach((button) => button.addEventListener('click', () => editAutomation(button.closest('.cim-automation-card').dataset.id)));
    grid.querySelectorAll('[data-delete-automation]').forEach((button) => button.addEventListener('click', () => deleteAutomation(button.closest('.cim-automation-card').dataset.id)));
  }

  function editAutomation(id) {
    openWorkflowDesigner(id);
  }

  async function deleteAutomation(id) {
    const automation = state.automationById.get(id);
    if (!automation || !confirm(`Delete !${automation.name} and its workflow?`)) return;
    await dbRequest('readwrite', (store) => store.delete(id), AUTOMATION_STORE_NAME);
    await loadAutomations();
    if (state.editingAutomationId === id) resetAutomationEditor();
    renderAutomationLibrary();
    toast(`Deleted !${automation.name}`);
  }

  function ensureComposerButton() {
    const plus = document.querySelector('#composer-plus-btn, [data-testid="composer-plus-btn"]');
    if (!plus || document.querySelector('.cim-library-button')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${plus.className || 'composer-btn'} cim-library-button`;
    button.setAttribute('aria-label', 'Open mentions library');
    button.title = 'Prompt Forge files, prompt tags, and workflows';
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
    const match = text.match(/(?:^|\s)([@#!])([A-Za-z0-9_-]*)$/);
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

  function getAutomationTemplateContext(textarea) {
    if (!textarea || textarea.selectionStart == null) return null;
    const caret = textarea.selectionStart;
    const match = textarea.value.slice(0, caret).match(/(?:^|\s)([@#])([A-Za-z0-9_-]*)$/);
    return match ? { trigger: match[1], query: match[2], start: caret - match[2].length - 1, end: caret } : null;
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
    const kind = context.trigger === '#' ? 'tags' : context.trigger === '!' ? 'automations' : 'files';
    const matches = kind === 'tags'
      ? state.tags.filter((tag) => tag.nameLower.includes(query))
      : kind === 'automations'
        ? state.automations.filter((automation) => automation.nameLower.includes(query))
        : state.records.filter((record) => record.nicknameLower.includes(query));
    const items = (query
      ? (kind === 'tags' ? sortedTags(matches) : kind === 'automations' ? matches : sortedRecords(matches))
      : mostRecentlyUsed(matches, (item) => kind === 'files' ? item.nickname : item.name)).slice(0, 3);
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

  function updateAutomationTemplateAutocomplete(textarea) {
    const context = getAutomationTemplateContext(textarea);
    if (!context) return closeAutocomplete();
    const query = context.query.toLocaleLowerCase();
    const kind = context.trigger === '#' ? 'tags' : 'files';
    const matches = kind === 'tags'
      ? state.tags.filter((tag) => tag.nameLower.includes(query))
      : state.records.filter((record) => record.nicknameLower.includes(query));
    const items = (query
      ? (kind === 'tags' ? sortedTags(matches) : sortedRecords(matches))
      : mostRecentlyUsed(matches, (item) => kind === 'tags' ? item.name : item.nickname)).slice(0, 3);
    if (!items.length) return closeAutocomplete();
    state.autocomplete = {
      open: true, items, selected: 0, query: context.query, kind,
      source: 'automationTemplate', textarea,
    };
    renderAutocomplete(null);
  }

  function renderAutocomplete(range) {
    createFloatingUi();
    const menu = document.querySelector('.cim-autocomplete');
    if (!menu) return;
    const isTags = state.autocomplete.kind === 'tags';
    const isAutomations = state.autocomplete.kind === 'automations';
    menu.innerHTML = isAutomations ? `
      <div class="cim-tag-menu-title">${state.autocomplete.query ? 'Matching workflows' : 'Recent & available workflows'}</div>
      <div class="cim-options">${state.autocomplete.items.map((automation, index) => `
        <button type="button" class="cim-option" data-index="${index}" aria-selected="${index === state.autocomplete.selected}">
          <span class="cim-automation-glyph">!</span><span><strong>!${escapeHtml(automation.name)}</strong><small>${escapeHtml(automation.description || `${(automation.nodes || []).length} linked workflow nodes`)}</small></span>
        </button>`).join('')}</div>` : isTags ? `
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
    const libraryTextarea = state.autocomplete.source === 'automationTemplate'
      ? state.autocomplete.textarea
      : document.querySelector(state.autocomplete.source === 'fileNote' ? '#cim-note' : '#cim-tag-text');
    let anchor;
    let surfaceRect;
    if (['tagEditor', 'fileNote', 'automationTemplate'].includes(state.autocomplete.source) && libraryTextarea) {
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
        else if (state.autocomplete.source === 'automationTemplate') updateAutomationTemplateAutocomplete(state.autocomplete.textarea);
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
        else if (state.autocomplete.source === 'automationTemplate') updateAutomationTemplateAutocomplete(state.autocomplete.textarea);
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
    const isAutomation = state.autocomplete.kind === 'automations';
    if (['tagEditor', 'fileNote', 'automationTemplate'].includes(state.autocomplete.source)) {
      const isFileNote = state.autocomplete.source === 'fileNote';
      const isAutomationTemplate = state.autocomplete.source === 'automationTemplate';
      const textarea = isAutomationTemplate
        ? state.autocomplete.textarea
        : document.querySelector(isFileNote ? '#cim-note' : '#cim-tag-text');
      const context = isAutomationTemplate
        ? getAutomationTemplateContext(textarea)
        : isFileNote ? getFileNoteContext(textarea) : getTagEditorContext(textarea);
      if (!item || !textarea || !context) return closeAutocomplete();
      const replacement = context.trigger === '#' ? `#${item.name} ` : `@${item.nickname} `;
      textarea.setRangeText(replacement, context.start, context.end, 'end');
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: replacement }));
      closeAutocomplete();
      textarea.focus();
      return;
    }
    const editor = getEditor();
    const context = editor && getCaretContext(editor);
    if (!item || !context) return closeAutocomplete();
    const trigger = isTag ? '#' : isAutomation ? '!' : '@';
    const name = isTag || isAutomation ? item.name : item.nickname;
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
        return node.parentElement?.closest('.cim-mention, .cim-tag-mention, .cim-automation-mention, .cim-sent-mention, .cim-sent-tag')
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
        const isAutomation = match[2] === '!';
        const item = isTag
          ? state.tagByName.get(match[3].toLocaleLowerCase())
          : isAutomation
            ? state.automationByName.get(match[3].toLocaleLowerCase())
            : state.recordByNickname.get(match[3].toLocaleLowerCase());
        if (!item) continue;
        const start = match.index + match[1].length;
        replacements.push({ node, start, end: start + match[2].length + match[3].length, isTag, isAutomation, item });
      }
    }
    for (const replacement of replacements.reverse()) {
      if (!replacement.node.isConnected) continue;
      const range = document.createRange();
      range.setStart(replacement.node, replacement.start);
      range.setEnd(replacement.node, replacement.end);
      range.deleteContents();
      const chip = document.createElement('span');
      chip.className = replacement.isTag ? 'cim-tag-mention' : replacement.isAutomation ? 'cim-automation-mention' : 'cim-mention';
      chip.contentEditable = 'false';
      if (replacement.isTag) {
        chip.dataset.cimTagId = replacement.item.id;
        chip.textContent = `#${replacement.item.name}`;
      } else if (replacement.isAutomation) {
        chip.dataset.cimAutomationId = replacement.item.id;
        chip.textContent = `!${replacement.item.name}`;
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
      if (state.automationRun && !state.internalSubmit) {
        event.preventDefault(); event.stopImmediatePropagation();
        toast('Stop the active workflow before sending another prompt.');
        return;
      }
      const text = getEditor()?.innerText || '';
      if (hasComposerActions(text)) {
        event.preventDefault(); event.stopImmediatePropagation();
        submitComposerActions();
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

  function collectMentionedAutomations(text) {
    const found = new Map();
    for (const match of text.matchAll(AUTOMATION_RE)) {
      const automation = state.automationByName.get(match[2].toLocaleLowerCase());
      if (automation) found.set(automation.id, automation);
    }
    return [...found.values()];
  }

  function hasComposerActions(text) {
    return hasStoredMentions(text) || collectMentionedAutomations(text).length > 0;
  }

  function submitComposerActions() {
    const text = getEditor()?.innerText || '';
    if (collectMentionedAutomations(text).length) runAutomationFromComposer();
    else prepareAndSend();
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
      editor.querySelectorAll('.cim-mention, .cim-tag-mention, .cim-automation-mention').forEach((chip) => {
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
      const send = composerSendButton(form);
      if (send && !send.disabled && send.getAttribute('aria-disabled') !== 'true') return send;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('ChatGPT did not enable the send button after expanding the prompt.');
  }

  function composerSendButton(form) {
    if (!form) return null;
    return [...form.querySelectorAll('button')].find((button) => {
      const label = turnButtonLabel(button);
      const knownSelector = button.matches('#composer-submit-button, [data-testid="send-button"], [data-testid="composer-submit-button"], .composer-submit-button-color');
      const sendLabel = /\b(?:send|submit)(?:\s+(?:prompt|message))?\b/i.test(label);
      const wrongControl = /\b(?:stop|voice|dictation|cancel)\b/i.test(label);
      return (knownSelector || button.type === 'submit' || sendLabel) && !wrongControl;
    }) || null;
  }

  function countAttachmentTiles(form) {
    return form.querySelectorAll([
      'button[aria-label*="Remove file" i]',
      'button[aria-label*="Remove image" i]',
      'button[aria-label*="Remove attachment" i]',
      'button[data-testid*="remove"][data-testid*="attachment"]',
      'button[data-testid*="remove"][data-testid*="file"]',
    ].join(',')).length;
  }

  async function attachRecords(form, records, extraFiles = []) {
    const input = form.querySelector('#upload-files, input[type="file"][multiple]');
    if (!input) throw new Error('ChatGPT file input was not found.');
    const before = countAttachmentTiles(form);
    const transfer = new DataTransfer();
    // ChatGPT keeps accepted attachments in composer state, while its hidden file
    // input can still expose the files from an earlier selection. Re-dispatching
    // those stale File objects uploads them again and triggers the duplicate-image
    // warning. A fresh selection should contain only the files being added now.
    for (const record of records) {
      if (!record?.blob || typeof record.blob.arrayBuffer !== 'function') {
        throw new Error(`The saved file @${record?.nickname || 'unknown'} is unavailable. Re-add it to the library and try again.`);
      }
      transfer.items.add(new File([record.blob], attachmentFileName(record), {
        type: record.mimeType || record.blob.type || 'application/octet-stream', lastModified: Date.now(),
      }));
    }
    for (const file of extraFiles) transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const expected = before + records.length + extraFiles.length;
    const deadline = Date.now() + 20000;
    try {
      while (Date.now() < deadline) {
        const send = composerSendButton(form);
        if (countAttachmentTiles(form) >= expected && send && !send.disabled) return;
        await new Promise((resolve) => setTimeout(resolve, 160));
      }
      throw new Error('Timed out while ChatGPT was attaching the saved file.');
    } finally {
      // The change handler has already copied this selection into ChatGPT's
      // composer state. Clearing the native input prevents Prompt Forge files
      // from leaking into a later web-app upload or being treated as duplicates.
      try { input.value = ''; } catch (error) { console.warn('[Prompt Forge] Could not clear the upload input', error); }
    }
  }

  function conversationTurns(role) {
    const turns = [...document.querySelectorAll(`[data-turn="${role}"]`)];
    if (turns.length) return turns;
    return [...document.querySelectorAll(`[data-message-author-role="${role}"]`)];
  }

  function assistantTurns() {
    return conversationTurns('assistant');
  }

  function userTurns() {
    return conversationTurns('user');
  }

  function conversationTurnId(turn) {
    return turn?.dataset.turnId
      || turn?.closest('[data-turn-id]')?.dataset.turnId
      || turn?.closest('[data-turn-id-container]')?.dataset.turnIdContainer
      || '';
  }

  function generationIsBusy() {
    return Boolean(document.querySelector(
      '[data-scroll-root][data-stream-active], #composer-stop-button, [data-testid="stop-button"], button[data-testid*="stop"], button[aria-label="Stop"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"]',
    ));
  }

  function automationOutputText(turn) {
    if (!turn) return '';
    const clone = turn.cloneNode(true);
    clone.querySelectorAll('button, [aria-hidden="true"], .sr-only').forEach((node) => node.remove());
    return (clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function automationTurnSignature(turn) {
    if (!turn) return '';
    const generatedImages = turn.querySelectorAll('img[alt^="Generated image"], [data-testid="image-gen-overlay-actions"]').length;
    return `${automationOutputText(turn)}|images:${turn.querySelectorAll('img').length}|generated:${generatedImages}|videos:${turn.querySelectorAll('video').length}`;
  }

  function automationImageIsReady(turn) {
    if (!turn) return false;
    if (turn.querySelector('[data-testid="image-gen-overlay-actions"]')) return true;
    const image = turn.querySelector('img[alt^="Generated image"]');
    return Boolean(image && image.complete && image.naturalWidth > 0);
  }

  function automationTurnHasContent(turn) {
    return Boolean(automationOutputText(turn) || automationImageIsReady(turn) || turn?.querySelector('video, canvas'));
  }

  function automationGeneratedImage(turn) {
    const image = turn?.querySelector('img[alt^="Generated image"]');
    if (!image?.currentSrc && !image?.src) return null;
    const turnId = turn.dataset.turnId || turn.closest('[data-turn-id]')?.dataset.turnId || shortId();
    return {
      src: image.currentSrc || image.src,
      alt: image.alt || 'Generated image',
      fileName: `generated-${String(turnId).slice(0, 12)}.png`,
    };
  }

  function isTemporaryImageGenerationError(result) {
    if (!result || result.image) return false;
    if (imageGenerationFailure(result.turn)) return true;
    const text = String(result.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return false;
    if (/\b(?:content\s+policy|polic(?:y|ies)|safety|guidelines?|not able to help with|can(?:not|['’]?t) help with)\b/i.test(text)) return false;
    const discussesImageGeneration = /(?:\b(?:generat|creat|produc|render|mak)\w*\b.{0,100}\b(?:images?|pictures?|illustrations?|visuals?)\b|\b(?:images?|pictures?|illustrations?|visuals?)\b.{0,100}\b(?:generat|creat|produc|render)\w*\b)/i.test(text);
    const reportsFailure = /\b(?:couldn['’]?t|could not|cannot|can['’]?t|unable|wasn['’]?t able|was not able|failed|failure|error|something went wrong)\b/i.test(text);
    const soundsTemporary = /\b(?:error|failed|failure|something went wrong|technical (?:issue|problem)|temporar\w*|try again|went wrong)\b/i.test(text);
    return discussesImageGeneration && reportsFailure && soundsTemporary;
  }

  async function waitForAutomationGeneration(beforeTurns, timeoutMs, run) {
    const before = new Set(beforeTurns);
    const beforeSignatures = new Map(beforeTurns.map((turn) => [turn, automationTurnSignature(turn)]));
    const changedTurns = new Set();
    const deadline = Date.now() + timeoutMs;
    let candidate = null;
    let signature = '';
    let stableSince = 0;
    let candidateSeenAt = 0;
    while (Date.now() < deadline) {
      if (run.cancelled) throw new Error('Workflow stopped. The current ChatGPT generation may continue.');
      const turns = assistantTurns();
      const last = turns.at(-1);
      const lastSignature = automationTurnSignature(last);
      if (last && before.has(last) && lastSignature !== beforeSignatures.get(last)) changedTurns.add(last);
      const isNew = last && (
        !before.has(last)
        || turns.length > beforeTurns.length
        || changedTurns.has(last)
      );
      if (isNew) {
        if (candidate !== last) {
          candidate = last;
          candidateSeenAt = Date.now();
        }
        const nextSignature = automationTurnSignature(candidate);
        if (nextSignature !== signature) {
          signature = nextSignature;
          stableSince = Date.now();
        }
        const turnIsStreaming = Boolean(candidate.querySelector('[data-is-streaming="true"], .result-streaming, [class*="streaming"]'));
        if (!generationIsBusy() && !turnIsStreaming && automationTurnHasContent(candidate)
          && Date.now() - candidateSeenAt >= 2000 && Date.now() - stableSince >= 1500) {
          return {
            text: automationOutputText(candidate),
            image: automationGeneratedImage(candidate),
            turnId: candidate.dataset.turnId || '',
            turn: candidate,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`ChatGPT did not finish within ${Math.round(timeoutMs / 60000)} minute(s).`);
  }

  function renderAutomationTemplate(template, context) {
    return String(template || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, token) => {
      const key = token.trim().toLocaleLowerCase();
      if (key === 'input') return context.input;
      if (key === 'last') return context.outputs.at(-1) || '';
      if (key === 'lastimage') return context.lastImage?.fileName || '';
      if (key === 'item') return context.item ?? '';
      if (key === 'index') return String(context.index ?? '');
      if (key === 'itemtotal') return String(context.itemTotal ?? '');
      if (key === 'iteration') return String(context.iteration);
      if (key === 'repeattotal') return String(context.repeatTotal);
      if (key === 'step') return String(context.step);
      const outputMatch = key.match(/^output:(\d+)$/);
      if (outputMatch) return context.outputs[Number(outputMatch[1]) - 1] || '';
      const variableMatch = key.match(/^var:([a-z0-9_-]+)$/);
      if (variableMatch) {
        const value = context.variables?.get(variableMatch[1]);
        return value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
      }
      const imageMatch = key.match(/^image:([a-z0-9_-]+)$/);
      if (imageMatch) return context.images?.get(imageMatch[1])?.fileName || '';
      return whole;
    });
  }

  function automationPromptRunCount(automation) {
    return (automation.nodes || []).reduce((total, node) => {
      if (node.type === 'prompt') return total + Math.min(50, Math.max(1, Number(node.repeat) || 1));
      if (node.type === 'foreach' || node.type === 'subflow') return total + 1;
      return total;
    }, 0);
  }

  function showAutomationRunStatus(run, detail, completed = 0, total = 1) {
    let panel = document.querySelector('.cim-run-status');
    if (!panel) {
      panel = document.createElement('section');
      panel.className = 'cim-run-status';
      panel.innerHTML = '<header><span class="cim-automation-glyph">!</span><strong></strong><button type="button" class="cim-run-stop">Stop</button></header><p></p><div class="cim-run-progress"><span></span></div>';
      panel.querySelector('.cim-run-stop').addEventListener('click', () => {
        if (!state.automationRun) return;
        state.automationRun.cancelled = true;
        panel.querySelector('p').textContent = 'Stopping workflow. The current ChatGPT generation may continue.';
        panel.querySelector('.cim-run-stop').disabled = true;
        state.automationRun.approvalResolve?.({ action: 'stop' });
      });
      document.body.appendChild(panel);
    }
    panel.querySelector('strong').textContent = `Running !${run.automation.name}`;
    panel.querySelector('p').textContent = detail;
    panel.querySelector('.cim-run-stop').disabled = false;
    panel.querySelector('.cim-approval-actions')?.remove();
    panel.querySelector('.cim-run-progress span').style.width = `${Math.min(100, Math.max(0, (completed / Math.max(1, total)) * 100))}%`;
  }

  function waitForAutomationApproval(run, message) {
    showAutomationRunStatus(run, message, run.completed, run.total);
    const panel = document.querySelector('.cim-run-status');
    const actions = document.createElement('div');
    actions.className = 'cim-approval-actions';
    actions.innerHTML = '<button type="button" data-approval="continue">Continue</button><button type="button" data-approval="retry">Retry last</button><button type="button" data-approval="edit">Edit output</button>';
    panel.appendChild(actions);
    return new Promise((resolve) => {
      let finished = false;
      const finish = (result) => {
        if (finished) return;
        finished = true;
        run.approvalResolve = null;
        actions.remove();
        resolve(result);
      };
      run.approvalResolve = finish;
      actions.addEventListener('click', (event) => {
        const action = event.target.closest('[data-approval]')?.dataset.approval;
        if (!action) return;
        if (action === 'edit') {
          const edited = prompt('Edit the latest output used by later nodes:', run.outputs.at(-1) || '');
          if (edited == null) return;
          finish({ action, value: edited });
          return;
        }
        finish({ action });
      });
    });
  }

  async function waitAutomationDelay(seconds, run) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      if (run.cancelled) throw new Error('Workflow stopped.');
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
    }
  }

  function referencedAutomationImages(template, run) {
    const found = new Map();
    for (const match of String(template || '').matchAll(/\{\{\s*(lastImage|image:([A-Za-z0-9_-]+))\s*\}\}/gi)) {
      const image = match[1].toLocaleLowerCase() === 'lastimage'
        ? run.lastImage
        : run.images.get((match[2] || '').toLocaleLowerCase());
      if (!image) throw new Error(`${match[0]} does not have a captured generated image yet.`);
      found.set(image.src, image);
    }
    return [...found.values()];
  }

  async function materializeAutomationImage(image) {
    if (image.file) return image.file;
    try {
      const response = await fetch(image.src, { credentials: 'include' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      image.file = new File([blob], image.fileName, {
        type: blob.type || 'image/png',
        lastModified: Date.now(),
      });
      return image.file;
    } catch (error) {
      throw new Error(`Could not attach ${image.fileName}. ChatGPT did not expose the generated image for reuse (${error.message}).`);
    }
  }

  async function prepareAutomationPrompt(promptText, imageReferences = []) {
    const dependencies = resolvePromptDependencies(promptText);
    const expansion = expandedPrompt(promptText, dependencies.records, dependencies.tags, dependencies.randomSelections);
    if (!normalizedEditorText(expansion.text)) throw new Error('A Prompt node expanded to empty text.');
    const generatedFiles = await Promise.all(imageReferences.map(materializeAutomationImage));
    return { promptText, dependencies, expansion, generatedFiles, imageReferences };
  }

  async function sendPreparedAutomationPrompt(sendPackage, automation, run) {
    if (run.sentCount >= 100) throw new Error('Workflow stopped at the 100-prompt runtime safety limit.');
    const editor = getEditor();
    const form = editor?.closest('form');
    if (!editor || !form) throw new Error('ChatGPT composer was not found.');
    const { dependencies, expansion, generatedFiles } = sendPackage;
    const beforeTurns = assistantTurns();
    const beforeUserTurnIds = new Set(userTurns().map(conversationTurnId).filter(Boolean));
    if (!setEditorText(editor, expansion.text)) throw new Error('ChatGPT rejected a workflow prompt.');
    if (dependencies.records.length || generatedFiles.length) await attachRecords(form, dependencies.records, generatedFiles);
    if (run.cancelled) throw new Error('Workflow stopped before the prompt was sent.');
    let send = await waitForSendButton(form);
    if (!editorTextMatches(editor, expansion.text) && !setEditorText(editor, expansion.text)) {
      throw new Error('ChatGPT reset the composer before the workflow prompt could be sent.');
    }
    send = await waitForSendButton(form);
    const restoration = { expandedText: expansion.text, restorations: expansion.restorations, turnId: '', expiresAt: Date.now() + 10000 };
    state.pendingPlainRestoration = restoration;
    state.internalSubmit = true;
    send.click();
    run.sentCount += 1;
    const sent = await markMentionsUsedAfterSend(editor, dependencies.records, dependencies.tags);
    state.internalSubmit = false;
    if (!sent) throw new Error('ChatGPT did not accept the workflow prompt.');
    const sentTurn = [...userTurns()].reverse().find((turn) => {
      const id = conversationTurnId(turn);
      return id && !beforeUserTurnIds.has(id);
    }) || userTurns().at(-1);
    restoration.turnId = conversationTurnId(sentTurn);
    if (expansion.restorations.length) rememberHistoryRestoration(restoration);
    setTimeout(processSentMarkers, 250);
    return waitForAutomationGeneration(beforeTurns, (automation.timeoutMinutes || 15) * 60000, run);
  }

  function turnButtonLabel(button) {
    return `${button?.getAttribute('aria-label') || ''} ${button?.dataset.testid || ''} ${button?.textContent || ''}`.replace(/\s+/g, ' ').trim();
  }

  function imageGenerationFailure(turn = assistantTurns().at(-1)) {
    if (!turn) return null;
    const outerTurn = turn.matches?.('[data-turn="assistant"]')
      ? turn
      : turn.closest?.('[data-turn="assistant"]') || turn;
    const failureTitle = [...outerTurn.querySelectorAll('span, p, div')].find((node) =>
      /^image generation failed$/i.test((node.textContent || '').replace(/\s+/g, ' ').trim()));
    if (!failureTitle) return null;
    const retryButton = [...outerTurn.querySelectorAll('button.btn-secondary.btn-small, button')].find((button) =>
      !button.disabled
      && button.getAttribute('aria-disabled') !== 'true'
      && /^try again$/i.test((button.textContent || '').replace(/\s+/g, ' ').trim()));
    return { turn: outerTurn, title: failureTitle, retryButton: retryButton || null };
  }

  async function retryNativeImageGeneration(timeoutMs, run = null) {
    if (run?.sentCount >= 100) throw new Error('Workflow stopped at the 100-prompt runtime safety limit.');
    const failure = imageGenerationFailure();
    const retry = failure?.retryButton;
    if (!failure || !retry) return null;
    const beforeTurns = assistantTurns();
    retry.click();
    if (run) run.sentCount += 1;
    return waitForAutomationGeneration(beforeTurns, timeoutMs, run || { cancelled: false });
  }

  function setTurnEditorText(editor, text) {
    if (!editor) return false;
    if (editor.matches('textarea, input')) {
      const prototype = editor.matches('textarea') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(editor, String(text ?? ''));
      else editor.value = String(text ?? '');
      dispatchEditorInput(editor, text);
      return normalizedEditorText(editor.value) === normalizedEditorText(text);
    }
    return setEditorText(editor, text);
  }

  async function retryPromptByEditing(promptText, timeoutMs, run = null) {
    if (run?.sentCount >= 100) throw new Error('Workflow stopped at the 100-prompt runtime safety limit.');
    const turn = userTurns().at(-1);
    const edit = turn?.querySelector('button[aria-label="Edit message" i], button[data-testid*="edit" i]');
    if (!turn || !edit) return null;
    const beforeTurns = assistantTurns();
    edit.click();
    const deadline = Date.now() + 4000;
    let submit = null;
    let editor = null;
    while (Date.now() < deadline) {
      const buttons = [...turn.querySelectorAll('button')];
      submit = buttons.find((button) =>
        !button.disabled
        && /(?:^|\s)(?:send|submit|save\s*(?:&|and)?\s*submit)(?:\s|$)/i.test(turnButtonLabel(button))
        && !/\bcancel\b/i.test(turnButtonLabel(button)));
      editor = turn.querySelector('textarea, [contenteditable="true"]');
      if (submit && editor) break;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    if (!submit || !editor || !setTurnEditorText(editor, promptText)) {
      const cancel = [...turn.querySelectorAll('button')].find((button) => /\bcancel\b/i.test(turnButtonLabel(button)));
      cancel?.click();
      return null;
    }
    state.internalSubmit = true;
    try {
      submit.click();
      if (run) run.sentCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 120));
    } finally {
      state.internalSubmit = false;
    }
    return waitForAutomationGeneration(beforeTurns, timeoutMs, run || { cancelled: false });
  }

  async function sendAutomationPromptWithErrorRetry(promptText, automation, run, imageReferences = [], preparedPackage = null) {
    const sendPackage = preparedPackage || await prepareAutomationPrompt(promptText, imageReferences);
    let result = await sendPreparedAutomationPrompt(sendPackage, automation, run);
    if (!isTemporaryImageGenerationError(result)) return { result, sendPackage };
    if (!state.retryOnError) {
      throw new Error('ChatGPT reported a temporary image-generation error. Enable Retry on error in Options to resend failed workflow prompts automatically.');
    }
    for (let attempt = 1; attempt <= AUTOMATIC_ERROR_RETRY_LIMIT; attempt += 1) {
      showAutomationRunStatus(
        run,
        `ChatGPT reported an image-generation error. Retrying the same prompt (${attempt}/${AUTOMATIC_ERROR_RETRY_LIMIT})…`,
        run.completed,
        run.total,
      );
      const timeoutMs = (automation.timeoutMinutes || 15) * 60000;
      result = await retryNativeImageGeneration(timeoutMs, run);
      if (!result) result = await retryPromptByEditing(sendPackage.expansion.text, timeoutMs, run);
      if (!result) result = await sendPreparedAutomationPrompt(sendPackage, automation, run);
      if (!isTemporaryImageGenerationError(result)) return { result, sendPackage };
    }
    throw new Error('ChatGPT reported another image-generation error after Prompt Forge retried the same prompt.');
  }

  function scheduleStandaloneRetryMonitor(beforeTurns, promptText) {
    if (!state.retryOnError) return;
    const active = state.standaloneRetry;
    if (active && active.promptText === promptText && Date.now() - active.startedAt < 1000) return;
    const monitor = { beforeTurns, promptText, startedAt: Date.now() };
    state.standaloneRetry = monitor;
    void monitorStandaloneImageGeneration(monitor);
  }

  async function monitorStandaloneImageGeneration(monitor) {
    try {
      const result = await waitForAutomationGeneration(
        monitor.beforeTurns,
        STANDALONE_RETRY_TIMEOUT_MS,
        { cancelled: false },
      );
      if (state.standaloneRetry !== monitor || !state.retryOnError || !isTemporaryImageGenerationError(result)) return;
      toast('Image generation failed. Retrying once…');
      let retryResult = await retryNativeImageGeneration(STANDALONE_RETRY_TIMEOUT_MS);
      if (!retryResult) retryResult = await retryPromptByEditing(monitor.promptText, STANDALONE_RETRY_TIMEOUT_MS);
      if (!retryResult) {
        toast('Image generation failed, and ChatGPT did not expose a retry control.');
        return;
      }
      if (isTemporaryImageGenerationError(retryResult)) {
        toast('Image generation failed again after one retry.');
      }
    } catch (error) {
      console.warn('[Prompt Forge] Regular-send retry monitor ended without a completed response', error);
    } finally {
      if (state.standaloneRetry === monitor) state.standaloneRetry = null;
    }
  }

  function automationContext(run, input, extra = {}) {
    return {
      input, outputs: run.outputs, variables: run.variables, images: run.images,
      lastImage: run.lastImage, iteration: 1, repeatTotal: 1, step: run.promptStep + 1,
      ...extra,
    };
  }

  function rememberAutomationResult(run, result, replaceLast = false) {
    if (replaceLast && run.outputs.length) run.outputs[run.outputs.length - 1] = result.text || '';
    else run.outputs.push(result.text || '');
    if (result.image) run.lastImage = result.image;
    run.lastResult = result;
  }

  async function executeAutomationPrompt(template, automation, run, input, extra = {}, replaceLast = false) {
    if (run.completed >= 100) throw new Error('Workflow stopped at the 100-prompt safety limit.');
    const context = automationContext(run, input, extra);
    const promptText = renderAutomationTemplate(template, context);
    const imageReferences = referencedAutomationImages(template, run);
    showAutomationRunStatus(run, `Generating prompt ${run.completed + 1}${run.total ? ` of about ${run.total}` : ''}…`, run.completed, run.total);
    const { result, sendPackage } = await sendAutomationPromptWithErrorRetry(promptText, automation, run, imageReferences);
    run.lastPrompt = { promptText, automation, imageReferences, sendPackage };
    rememberAutomationResult(run, result, replaceLast);
    run.completed += 1;
    showAutomationRunStatus(run, `Completed ${run.completed} prompt${run.completed === 1 ? '' : 's'}.`, run.completed, run.total);
    return result;
  }

  async function retryLastAutomationPrompt(run, replaceLast = true) {
    if (!run.lastPrompt) throw new Error('There is no previous prompt to retry.');
    if (run.completed >= 100) throw new Error('Workflow stopped at the 100-prompt safety limit.');
    run.total += 1;
    showAutomationRunStatus(run, `Retrying the previous prompt…`, run.completed, run.total);
    const { result, sendPackage } = await sendAutomationPromptWithErrorRetry(
      run.lastPrompt.promptText, run.lastPrompt.automation, run, run.lastPrompt.imageReferences, run.lastPrompt.sendPackage,
    );
    run.lastPrompt.sendPackage = sendPackage;
    rememberAutomationResult(run, result, replaceLast);
    run.completed += 1;
    return result;
  }

  function automationConditionMatches(value, operator, expected, run) {
    const text = String(value ?? '');
    if (operator === 'image_exists') {
      const namedImage = [run.lastImage, ...run.images.values()].filter(Boolean)
        .some((image) => image.fileName === text.trim());
      return Boolean(run.lastResult?.image || namedImage);
    }
    if (operator === 'not_empty') return Boolean(text.trim());
    if (operator === 'contains') return text.toLocaleLowerCase().includes(String(expected || '').toLocaleLowerCase());
    if (operator === 'not_contains') return !text.toLocaleLowerCase().includes(String(expected || '').toLocaleLowerCase());
    if (operator === 'equals') return text.trim().toLocaleLowerCase() === String(expected || '').trim().toLocaleLowerCase();
    if (operator === 'regex') {
      try { return new RegExp(expected, 'i').test(text); } catch (error) { throw new Error(`Invalid validation regular expression: ${error.message}`); }
    }
    return false;
  }

  function automationListItems(value) {
    const text = String(value || '').trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).filter(Boolean);
    } catch (error) {
      // Plain line-based lists are the common case.
    }
    return text.split(/\r?\n/).map((item) => item.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim()).filter(Boolean);
  }

  function valueAtJsonPath(value, path) {
    const cleaned = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(cleaned);
    return String(path || '').split('.').filter(Boolean).reduce((current, part) => current?.[part], parsed);
  }

  function extractAutomationValue(node, source) {
    if (node.mode === 'regex') {
      let match;
      try { match = new RegExp(node.pattern, 'is').exec(source); } catch (error) { throw new Error(`Invalid extraction regular expression: ${error.message}`); }
      if (!match) throw new Error(`Extract Variable could not match /${node.pattern}/.`);
      return match[1] ?? match[0];
    }
    if (node.mode === 'json') {
      try {
        const value = valueAtJsonPath(source, node.pattern);
        if (value === undefined) throw new Error('path was not found');
        return value;
      } catch (error) {
        throw new Error(`Extract Variable could not read JSON path "${node.pattern}": ${error.message}`);
      }
    }
    return source;
  }

  async function executeAutomationNodes(automation, run, input, depth = 0) {
    const nodes = Array.isArray(automation.nodes) ? automation.nodes : [];
    const graphMode = Array.isArray(automation.connections);
    const connections = graphMode ? sanitizeWorkflowConnections(automation.connections, nodes) : [];
    const connectionBySlot = new Map(connections.map((connection) => [`${connection.from}:${connection.branch}`, connection]));
    const nodeIndexById = new Map(nodes.map((node, index) => [node.id, index]));
    const incoming = new Set(connections.map((connection) => connection.to));
    let nodeIndex = graphMode ? nodes.findIndex((node) => !incoming.has(node.id)) : 0;
    if (nodeIndex < 0 && nodes.length) throw new Error('This workflow has no starting node. Remove a connection to break the cycle.');
    let transitions = 0;
    while (nodeIndex >= 0 && nodeIndex < nodes.length) {
      if (++transitions > 500) throw new Error('Workflow stopped after 500 node transitions. Check the graph for an endless loop.');
      const node = nodes[nodeIndex];
      if (run.cancelled) throw new Error('Workflow stopped.');
      let branch = 'next';
      let legacyAdvance = 1;
      if (node.type === 'delay') {
        const seconds = Math.min(3600, Math.max(1, Number(node.seconds) || 1));
        showAutomationRunStatus(run, `Node ${nodeIndex + 1}: waiting ${seconds} second${seconds === 1 ? '' : 's'}…`, run.completed, run.total);
        await waitAutomationDelay(seconds, run);
      } else if (node.type === 'image') {
        if (!run.lastImage) throw new Error('Generated Image needs a completed image prompt before it.');
        run.images.set(String(node.name || 'image').toLocaleLowerCase(), run.lastImage);
        showAutomationRunStatus(run, `Captured ${run.lastImage.fileName} as {{image:${node.name || 'image'}}}.`, run.completed, run.total);
      } else if (node.type === 'condition') {
        const source = renderAutomationTemplate(node.source || '{{last}}', automationContext(run, input));
        const passed = automationConditionMatches(source, node.operator, node.expected, run);
        branch = passed ? 'true' : 'false';
        if (graphMode) {
          showAutomationRunStatus(run, `Condition ${passed ? 'passed' : 'failed'} · following ${branch} connection.`, run.completed, run.total);
        } else {
          const action = passed ? node.trueAction : node.falseAction;
          const skip = passed ? node.trueSkip : node.falseSkip;
          showAutomationRunStatus(run, `Condition ${passed ? 'passed' : 'failed'} · ${action || 'continue'}.`, run.completed, run.total);
          if (action === 'stop') return { stopped: true };
          if (action === 'skip') legacyAdvance += Math.min(50, Math.max(1, Number(skip) || 1));
        }
      } else if (node.type === 'approval') {
        const message = renderAutomationTemplate(node.message || 'Review the latest result before continuing.', automationContext(run, input));
        const decision = await waitForAutomationApproval(run, message);
        if (decision.action === 'stop' || run.cancelled) throw new Error('Workflow stopped at an approval checkpoint.');
        if (decision.action === 'retry') await retryLastAutomationPrompt(run);
        if (decision.action === 'edit' && run.outputs.length) run.outputs[run.outputs.length - 1] = decision.value;
      } else if (node.type === 'extract') {
        const source = renderAutomationTemplate(node.source || '{{last}}', automationContext(run, input));
        const extracted = extractAutomationValue(node, source);
        run.variables.set(String(node.name || 'result').toLocaleLowerCase(), extracted);
        showAutomationRunStatus(run, `Saved {{var:${node.name || 'result'}}}.`, run.completed, run.total);
      } else if (node.type === 'validate') {
        let source = renderAutomationTemplate(node.source || '{{last}}', automationContext(run, input));
        let passed = automationConditionMatches(source, node.operator, node.expected, run);
        const retries = Math.min(10, Math.max(1, Number(node.retries) || 1));
        for (let attempt = 1; !passed && attempt <= retries; attempt += 1) {
          await retryLastAutomationPrompt(run);
          source = renderAutomationTemplate(node.source || '{{last}}', automationContext(run, input));
          passed = automationConditionMatches(source, node.operator, node.expected, run);
        }
        if (!passed) throw new Error(`Validation failed after ${retries} retr${retries === 1 ? 'y' : 'ies'}.`);
      } else if (node.type === 'foreach') {
        const source = renderAutomationTemplate(node.source || '{{input}}', automationContext(run, input));
        const items = automationListItems(source);
        if (!items.length) throw new Error('For Each did not receive any list items.');
        if (items.length > 50) throw new Error('For Each supports at most 50 items per node.');
        run.total += Math.max(0, items.length - 1);
        for (let index = 0; index < items.length; index += 1) {
          run.promptStep += 1;
          await executeAutomationPrompt(node.template, automation, run, input, {
            item: items[index], index: index + 1, itemTotal: items.length,
            iteration: index + 1, repeatTotal: items.length, step: run.promptStep,
          });
        }
      } else if (node.type === 'subflow') {
        const target = state.automationById.get(node.automationId);
        if (!target) throw new Error('A Run Workflow node points to a workflow that no longer exists.');
        if (depth >= 5) throw new Error('Nested workflows are limited to five levels.');
        if (run.stack.has(target.id)) throw new Error(`Recursive workflow loop detected at !${target.name}.`);
        const subInput = renderAutomationTemplate(node.input || '{{input}}', automationContext(run, input));
        run.total += Math.max(0, automationPromptRunCount(target) - 1);
        run.stack.add(target.id);
        try {
          const outcome = await executeAutomationNodes(target, run, subInput, depth + 1);
          if (outcome?.stopped) return outcome;
          await markAutomationUsed(target);
        } finally {
          run.stack.delete(target.id);
        }
      } else {
        run.promptStep += 1;
        const repeatTotal = Math.min(50, Math.max(1, Number(node.repeat) || 1));
        for (let iteration = 1; iteration <= repeatTotal; iteration += 1) {
          await executeAutomationPrompt(node.template, automation, run, input, {
            iteration, repeatTotal, step: run.promptStep,
          });
        }
      }
      if (!graphMode) {
        nodeIndex += legacyAdvance;
        continue;
      }
      const connection = connectionBySlot.get(`${node.id}:${branch}`);
      if (!connection) return { stopped: false };
      const nextIndex = nodeIndexById.get(connection.to);
      if (nextIndex === undefined) return { stopped: false };
      nodeIndex = nextIndex;
    }
    return { stopped: false };
  }

  async function markAutomationUsed(automation) {
    try {
      let order = Number(localStorage.getItem('cim-usage-sequence')) || 0;
      automation.lastUsedOrder = ++order;
      automation.lastUsedAt = Date.now();
      localStorage.setItem('cim-usage-sequence', String(order));
      await dbRequest('readwrite', (store) => store.put(automation), AUTOMATION_STORE_NAME);
    } catch (error) {
      console.error('[Prompt Forge] Could not save automation usage', error);
    }
  }

  async function runAutomationFromComposer() {
    if (state.automationRun || state.sending) return toast('Another Prompt Forge workflow is already running.');
    const editor = getEditor();
    const originalText = (editor?.innerText || editor?.textContent || '').replace(/\u00a0/g, ' ').trim();
    const automations = collectMentionedAutomations(originalText);
    if (!editor || automations.length !== 1) return toast(automations.length > 1 ? 'Use one !workflow chip at a time.' : 'Choose a saved !workflow.');
    const automation = automations[0];
    let removedTrigger = false;
    const input = originalText.replace(AUTOMATION_RE, (whole, prefix, name) => {
      if (removedTrigger || name.toLocaleLowerCase() !== automation.nameLower) return whole;
      removedTrigger = true;
      return prefix;
    }).replace(/[ \t]{2,}/g, ' ').trim();
    const nodes = Array.isArray(automation.nodes) ? automation.nodes : [];
    if (!nodes.some((node) => ['prompt', 'foreach', 'subflow'].includes(node.type))) return toast(`!${automation.name} has no prompt-producing nodes.`);
    const run = {
      automation, cancelled: false, outputs: [], variables: new Map(), images: new Map(),
      lastImage: null, lastResult: null, lastPrompt: null, sentCount: 0,
      completed: 0, total: automationPromptRunCount(automation), promptStep: 0,
      stack: new Set([automation.id]), approvalResolve: null,
    };
    state.automationRun = run;
    closeAutocomplete();
    document.querySelectorAll('.cim-library-button').forEach((button) => button.classList.add('cim-sending'));
    setEditorText(editor, '');
    if (run.total > 100) {
      state.automationRun = null;
      document.querySelectorAll('.cim-sending').forEach((node) => node.classList.remove('cim-sending'));
      setEditorText(editor, originalText);
      return toast('This workflow exceeds the 100-prompt safety limit. Edit it before running.');
    }
    try {
      showAutomationRunStatus(run, 'Starting workflow…', run.completed, run.total);
      await executeAutomationNodes(automation, run, input);
      await markAutomationUsed(automation);
      toast(`!${automation.name} completed ${run.completed} prompt${run.completed === 1 ? '' : 's'}`);
    } catch (error) {
      console.error('[Prompt Forge] Workflow stopped', error);
      if (!run.sentCount && editor.isConnected) setEditorText(editor, originalText);
      toast(error.message || `!${automation.name} stopped.`);
    } finally {
      state.internalSubmit = false;
      state.automationRun = null;
      document.querySelector('.cim-run-status')?.remove();
      document.querySelectorAll('.cim-sending').forEach((node) => node.classList.remove('cim-sending'));
    }
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
      const beforeAssistantTurns = assistantTurns();
      const beforeUserTurnIds = new Set(userTurns().map(conversationTurnId).filter(Boolean));
      const restoration = {
        expandedText: expansion.text,
        restorations: expansion.restorations,
        turnId: '',
        expiresAt: Date.now() + 10000,
      };
      state.pendingPlainRestoration = restoration;
      state.internalSubmit = true;
      send.click();
      scheduleStandaloneRetryMonitor(beforeAssistantTurns, expansion.text);
      void markMentionsUsedAfterSend(editor, records, tags)
        .then((sent) => {
          if (sent) {
            const sentTurn = [...userTurns()].reverse().find((turn) => {
              const id = conversationTurnId(turn);
              return id && !beforeUserTurnIds.has(id);
            }) || userTurns().at(-1);
            restoration.turnId = conversationTurnId(sentTurn);
            rememberHistoryRestoration(restoration);
          }
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
    const clickedButton = event.target.closest?.('button');
    const form = clickedButton?.closest('form');
    const send = composerSendButton(form);
    if (!send || clickedButton !== send || state.internalSubmit) return;
    if (state.automationRun) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toast('Stop the active workflow before sending another prompt.');
      return;
    }
    const editor = getEditor();
    const text = editor?.innerText || '';
    if (!hasComposerActions(text)) {
      if (state.retryOnError && !send.disabled) scheduleStandaloneRetryMonitor(assistantTurns(), text);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    submitComposerActions();
  }

  function interceptSubmit(event) {
    if (state.internalSubmit || !event.target.matches?.('form')) return;
    if (state.automationRun) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toast('Stop the active workflow before sending another prompt.');
      return;
    }
    const editor = event.target.querySelector('#prompt-textarea[contenteditable="true"], div.ProseMirror[contenteditable="true"]');
    if (!editor) return;
    const text = editor.innerText || '';
    if (!hasComposerActions(text)) {
      if (state.retryOnError) scheduleStandaloneRetryMonitor(assistantTurns(), text);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    submitComposerActions();
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
    const messages = userTurns().filter((turn) => root === document || root.contains(turn));
    const message = pending.turnId
      ? messages.find((turn) => conversationTurnId(turn) === pending.turnId)
      : messages.at(-1);
    if (!message || !findPlainText(readRestorableText(message), pending.expandedText)) return;
    pending.turnId = pending.turnId || conversationTurnId(message);
    rememberHistoryRestoration(pending);
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
    const messages = userTurns().filter((turn) => root === document || root.contains(turn));
    for (const message of messages) {
      if (message.dataset.cimEditingExpanded === 'true') continue;
      const editables = [
        ...(message.matches('[contenteditable="true"]') ? [message] : []),
        ...message.querySelectorAll('[contenteditable="true"]'),
      ];
      for (const editable of editables) {
        if (editable.querySelector('.cim-sent-mention, .cim-sent-tag')) continue;
        restoreHistoryIntoElement(editable, message);
      }
      if (editables.length || message.querySelector('.cim-sent-mention, .cim-sent-tag')) continue;
      restoreHistoryIntoElement(message, message);
    }
  }

  function restoreHistoryIntoElement(element, message) {
    const turnId = conversationTurnId(message);
    if (!turnId) return false;
    const text = readRestorableText(element);
    const restoration = state.historyRestorations.find((entry) =>
      entry.turnId === turnId && findPlainText(text, entry.expandedText));
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
    if (target.matches('.cim-automation-mention')) {
      const automation = state.automationById.get(target.dataset.cimAutomationId)
        || state.automationByName.get(target.textContent.replace(/^!/, '').toLocaleLowerCase());
      const tooltip = document.querySelector('.cim-tooltip');
      if (!tooltip) return;
      const promptCount = automation ? automationPromptRunCount(automation) : 0;
      tooltip.innerHTML = `<strong>!${escapeHtml(automation?.name || target.textContent.replace(/^!/, ''))}</strong><p>${escapeHtml(automation?.description || 'Saved workflow')}${automation ? `\n\n${automation.nodes.length} linked nodes · ${promptCount} prompt run${promptCount === 1 ? '' : 's'}` : ''}</p>`;
      tooltip.classList.remove('cim-hidden');
      positionTooltip(tooltip, target);
      return;
    }
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
      } else if (event.target.matches?.('#cim-automation-nodes [data-node-template]')) {
        clearTimeout(state.autocompleteTimer);
        state.autocompleteTimer = setTimeout(() => { state.autocompleteTimer = null; updateAutomationTemplateAutocomplete(event.target); }, 20);
      }
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.target.matches?.('#cim-tag-text')) { handleLibraryTextareaKeydown(event, 'tagEditor'); return; }
      if (event.target.matches?.('#cim-note')) { handleLibraryTextareaKeydown(event, 'fileNote'); return; }
      if (event.target.matches?.('#cim-automation-nodes [data-node-template]')) { handleLibraryTextareaKeydown(event, 'automationTemplate'); return; }
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
      const mention = event.target.closest?.('.cim-mention, .cim-sent-mention, .cim-tag-mention, .cim-sent-tag, .cim-automation-mention');
      if (mention) showTooltip(mention);
    });
    document.addEventListener('mouseout', (event) => {
      const mention = event.target.closest?.('.cim-mention, .cim-sent-mention, .cim-tag-mention, .cim-sent-tag, .cim-automation-mention');
      if (mention && !mention.contains(event.relatedTarget)) scheduleHideTooltip();
    });
    document.addEventListener('scroll', () => { scheduleHideTooltip(); }, true);
    window.addEventListener('resize', () => { closeAutocomplete(); scheduleHideTooltip(); });
  }

  async function init() {
    ensureUserscriptUi();
    bindGlobalEvents();
    loadHistoryRestorations();
    try { await Promise.all([loadRecords(), loadTags(), loadAutomations()]); } catch (error) { console.error('[Prompt Forge] Storage initialization failed', error); toast('Prompt Forge could not open browser storage.'); }
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
