/**
 * 前端公共工具：自动重连的 WebSocket、DOM 辅助、Toast、时间格式化
 */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function fmtTime(t) {
  if (!t) return '--';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* -------------------------------- Toast --------------------------------- */

function toast(message, level = 'error', title = '') {
  let box = $('#toasts');
  if (!box) {
    box = el('div', { id: 'toasts' });
    document.body.appendChild(box);
  }
  const node = el('div', { class: `toast ${level}` }, [
    title ? el('span', { class: 'tt' }, title) : null,
    document.createTextNode(message)
  ]);
  box.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .3s';
    setTimeout(() => node.remove(), 300);
  }, 4000);
}

/* ------------------------------ WebSocket ------------------------------- */

/**
 * 创建带自动重连的连接。handler 收到每个 JSON 消息。
 * onStatus('connecting'|'online'|'offline')
 */
function connectWS(handler, onStatus) {
  let ws = null;
  let closed = false;
  let retry = 0;
  let timer = null;

  const open = () => {
    onStatus && onStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.addEventListener('open', () => {
      retry = 0;
      onStatus && onStatus('online');
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handler(msg, ws);
    });

    ws.addEventListener('close', () => {
      if (closed) return;
      onStatus && onStatus('offline');
      // 1 秒起步重连，最长 8 秒；重连后服务端会立即下发完整快照
      retry = Math.min(retry + 1, 8);
      timer = setTimeout(open, retry === 1 ? 800 : retry * 500);
    });

    ws.addEventListener('error', () => {
      try { ws.close(); } catch { /* ignore */ }
    });
  };

  open();

  return {
    send(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
      else toast('连接中断，消息未发送，正在重连…', 'warn', '网络');
    },
    close() { closed = true; if (timer) clearTimeout(timer); if (ws) ws.close(); }
  };
}
