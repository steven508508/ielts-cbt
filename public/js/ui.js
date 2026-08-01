/* 小工具：DOM、提示、對話框、時間格式 */
const UI = (() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  /**
   * 把子節點放進容器。
   * 和原生的 replaceChildren 不同，這裡會自動攤平陣列、忽略 null/false，
   * 所以可以直接寫 render(box, el(...), list.map(...), cond && el(...))
   */
  function render(target, ...children) {
    const flat = [];
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false || c === true || c === '') continue;
      flat.push(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    target.replaceChildren(...flat);
    return target;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** 只留下安全的排版標籤，避免題目內容注入腳本 */
  const ALLOWED = /^(p|br|b|strong|i|em|u|ul|ol|li|h1|h2|h3|h4|h5|table|thead|tbody|tr|td|th|span|div|sub|sup|hr|blockquote|img|small|figure|figcaption)$/i;
  function sanitize(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html ?? '');
    const walk = (node) => {
      for (const child of [...node.children]) {
        if (!ALLOWED.test(child.tagName)) { child.replaceWith(...child.childNodes); continue; }
        for (const attr of [...child.attributes]) {
          const n = attr.name.toLowerCase();
          const okAttr = (n === 'colspan' || n === 'rowspan' || n === 'class' ||
            (child.tagName === 'IMG' && (n === 'src' || n === 'alt')));
          if (!okAttr || /^javascript:/i.test(attr.value)) child.removeAttribute(attr.name);
        }
        walk(child);
      }
    };
    walk(tpl.content);
    return tpl.innerHTML;
  }

  function toast(msg, kind = '') {
    const t = el('div', { class: `toast ${kind}` }, msg);
    $('#toasts').append(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 3200);
    setTimeout(() => t.remove(), 3600);
  }

  function modal({ title, body, actions = [], width, dismissable = true }) {
    return new Promise((resolve) => {
      const back = el('div', { class: 'modal-back' });
      const close = (v) => { back.remove(); resolve(v); };
      const box = el('div', { class: 'modal', style: width ? { maxWidth: width } : {} },
        title && el('header', {}, title),
        el('div', { class: 'body' }, typeof body === 'string' ? el('div', { html: body }) : body),
        actions.length && el('footer', {}, actions.map((a) =>
          el('button', { class: `btn ${a.class || ''}`, onclick: () => { if (a.onClick) { const r = a.onClick(box); if (r === false) return; } close(a.value); } }, a.label)
        ))
      );
      back.append(box);
      if (dismissable) back.addEventListener('click', (e) => { if (e.target === back) close(null); });
      document.body.append(back);
      const first = box.querySelector('input,textarea,select');
      if (first) setTimeout(() => first.focus(), 30);
    });
  }

  const confirm = (msg, okLabel = '確定') => modal({
    title: '請確認', body: el('p', {}, msg),
    actions: [{ label: '取消', value: false }, { label: okLabel, class: 'primary', value: true }],
  });

  const alert = (msg, title = '提示') => modal({
    title, body: typeof msg === 'string' ? el('p', {}, msg) : msg,
    actions: [{ label: '知道了', class: 'primary', value: true }],
  });

  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function fmtDate(v) {
    if (!v) return '—';
    const d = new Date(String(v).replace(' ', 'T'));
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  const band = (v) => (v == null ? '—' : Number(v).toFixed(1));

  function debounce(fn, ms = 400) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function download(filename, content, mime = 'application/json') {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const a = el('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  const MODULE_LABEL = { listening: '聽力 Listening', reading: '閱讀 Reading', writing: '寫作 Writing', speaking: '口說 Speaking' };

  /* ── 狀態元件 ────────────────────────────────────────────
     以前「載入中」「沒有資料」「載入失敗」長得一模一樣，
     都是一行灰字，而且失敗時連重試的按鈕都沒有。 */

  /** 骨架畫面。rows = 幾條假的內容列 */
  function skeleton(rows = 3) {
    return el('div', { class: 'skeleton' },
      Array.from({ length: rows }, (_, i) => el('div', {
        class: 'sk-line', style: { width: `${[100, 82, 91, 74, 88][i % 5]}%` },
      })));
  }

  /** 載入中 */
  function loading(text = '載入中…', rows = 3) {
    return el('div', { class: 'state state-loading' },
      el('div', { class: 'state-msg' }, el('span', { class: 'spinner' }), text),
      skeleton(rows));
  }

  /** 載入失敗，一定要給重試 */
  function errorState(message, onRetry) {
    return el('div', { class: 'state state-error' },
      el('div', { class: 'state-icon' }, '⚠'),
      el('div', { class: 'state-title' }, '載入失敗'),
      el('div', { class: 'state-msg' }, message || '發生未預期的錯誤'),
      onRetry ? el('button', { class: 'btn sm', onclick: onRetry }, '重新載入') : null);
  }

  /** 真的沒有資料。action = { label, href } 或 { label, onclick } */
  function emptyState(message, action, hint) {
    return el('div', { class: 'state state-empty' },
      el('div', { class: 'state-icon' }, '📭'),
      el('div', { class: 'state-title' }, message),
      hint ? el('div', { class: 'state-msg' }, hint) : null,
      action
        ? (action.href
            ? el('a', { class: 'btn primary sm', href: action.href }, action.label)
            : el('button', { class: 'btn primary sm', onclick: action.onclick }, action.label))
        : null);
  }

  /**
   * 資料表格。外面一定要包一層可橫向捲動的容器，不然手機上直接爆版。
   * 用法和原本的 el('table', { class: 'data' }, thead, tbody) 一樣，
   * 只是換成 UI.dataTable(thead, tbody)。
   */
  function dataTable(...children) {
    return el('div', { class: 'table-wrap' }, el('table', { class: 'data' }, ...children));
  }

  return {
    $, $$, el, render, esc, sanitize, toast, modal, confirm, alert,
    fmtTime, fmtDate, band, debounce, download, MODULE_LABEL,
    skeleton, loading, errorState, emptyState, dataTable,
  };
})();
