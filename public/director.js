/**
 * 导演控制端
 */
'use strict';

const state = {
  positions: [],
  presence: {},
  cues: [],
  activeId: null,
  logs: [],
  serverTime: Date.now(),
  selectedTargets: new Set()
};

let net = null;

/* ------------------------------ 渲染：岗位 ------------------------------ */

function renderPositions() {
  const box = $('#posChips');
  box.innerHTML = '';
  if (state.positions.length === 0) {
    box.appendChild(el('span', { class: 'muted' }, '尚无岗位，请先添加。'));
    return;
  }
  for (const name of state.positions) {
    const online = (state.presence[name] || 0) > 0;
    const chip = el('span', { class: `chip ${online ? 'online' : ''}`, title: online ? '在线' : '离线' }, [
      el('span', { class: 'pdot' }),
      document.createTextNode(name + (online ? ` (${state.presence[name]})` : '')),
      el('span', {
        class: 'x',
        title: '删除岗位',
        onclick: () => net.send({ type: 'remove_position', name })
      }, '✕')
    ]);
    box.appendChild(chip);
  }
}

/* --------------------------- 渲染：编排目标选择 -------------------------- */

function renderTargetSelector() {
  const box = $('#cueTargets');
  box.innerHTML = '';
  if (state.positions.length === 0) {
    box.appendChild(el('span', { class: 'muted' }, '请先在左侧创建岗位。'));
    return;
  }
  for (const name of state.positions) {
    const selected = state.selectedTargets.has(name);
    const chip = el('span', {
      class: `chip ${selected ? 'selected' : ''}`,
      onclick: () => {
        if (state.selectedTargets.has(name)) state.selectedTargets.delete(name);
        else state.selectedTargets.add(name);
        renderTargetSelector();
      }
    }, [selected ? '☑ ' : '☐ ', name]);
    box.appendChild(chip);
  }
}

/* ------------------------------ 渲染：序列 ------------------------------ */

function renderCueList() {
  const box = $('#cueList');
  box.innerHTML = '';
  $('#cueCount').textContent = state.cues.length ? `共 ${state.cues.length} 条` : '';
  if (state.cues.length === 0) {
    box.appendChild(el('div', { class: 'muted', style: 'padding:8px' }, '序列为空，请在上方编排口令。'));
    return;
  }
  state.cues.forEach((cue) => {
    const isActive = cue.id === state.activeId;
    const done = cue.status === 'completed' && !isActive;
    const item = el('div', { class: `cue-item ${isActive ? 'active' : ''} ${done ? 'done' : ''}` });

    item.appendChild(el('div', { class: 'num' }, String(cue.seq)));

    const metaParts = [`→ ${cue.targets.join('、')}`];
    metaParts.push(cue.timeoutMs ? `时限 ${cue.timeoutMs / 1000}s` : '不计时');
    if (isActive) {
      const n = Object.keys(cue.confirmedAt).length;
      metaParts.push(`确认 ${n}/${cue.targets.length}`);
    }
    if (done) {
      metaParts.push(cue.closeReason === 'all_confirmed' ? '已全部确认' : '强制推进');
    }
    const body = el('div', { class: 'body' }, [
      el('div', { class: 'cmd' }, cue.command),
      el('div', { class: 'meta' }, metaParts.join('　·　'))
    ]);
    item.appendChild(body);

    if (cue.status === 'pending') {
      item.appendChild(el('button', {
        class: 'sm ghost danger',
        title: '删除此待发口令',
        onclick: () => net.send({ type: 'delete_cue', cueId: cue.id })
      }, '删除'));
    }
    box.appendChild(item);
  });
}

/* ---------------------------- 渲染：当前口令 ---------------------------- */

let tickTimer = null;

function targetChip(cue, p) {
  const confirmed = p in cue.confirmedAt;
  const late = p in (cue.lateAt || {});
  const pendingTo = (cue.pendingTimedOut || {})[p];
  let cls = 'chip';
  let prefix = '○ ';
  if (confirmed) { cls += late ? ' late' : ' confirmed'; prefix = late ? '◔ 迟到 ' : '● 已确认 '; }
  else if (pendingTo) { cls += ' timeout'; prefix = '✕ 超时 '; }
  return el('span', { class: cls }, prefix + p);
}

function renderStage() {
  const cue = state.cues.find((c) => c.id === state.activeId) || null;
  const stage = $('#stage');
  const tag = $('#stageTag');
  const seq = $('#stageSeq');
  const cmd = $('#stageCommand');
  const targets = $('#stageTargets');
  const meta = $('#stageMeta');
  const bar = $('#progressBar');
  const btnEmit = $('#btnEmit');

  targets.innerHTML = '';
  meta.innerHTML = '';

  if (!cue) {
    stage.classList.add('idle');
    $('#btnForceClose').style.display = 'none';
    const next = state.cues.find((c) => c.status === 'pending');
    if (next) {
      tag.textContent = '上一条已关闭';
      seq.textContent = `待发出 第 ${next.seq} 条`;
      cmd.textContent = next.command;
      next.targets.forEach((p) => targets.appendChild(el('span', { class: 'chip' }, '○ ' + p)));
      btnEmit.textContent = `发出第 ${next.seq} 条`;
      btnEmit.disabled = false;
      $('#emitHint').textContent = '';
    } else {
      tag.textContent = '空闲';
      seq.textContent = state.cues.length ? '本场序列已全部发出' : '尚未发出任何口令';
      cmd.textContent = state.cues.length ? '— 演出序列结束 —' : '等待导演发令';
      btnEmit.textContent = '发出下一条';
      btnEmit.disabled = true;
      $('#emitHint').textContent = state.cues.length ? '可在日志中回顾整场过程，或开启新场次。' : '请先创建岗位并编排口令。';
    }
    bar.style.width = '0%';
    return;
  }

  stage.classList.remove('idle');
  cue.targets.forEach((p) => targets.appendChild(targetChip(cue, p)));

  const n = Object.keys(cue.confirmedAt).length;
  const total = cue.targets.length;
  const all = n === total;
  const timedOut = cue.timedOutAt != null;
  const pending = cue.targets.filter((p) => !(p in cue.confirmedAt));

  tag.innerHTML = '';
  tag.appendChild(el('span', { class: 'badge active' }, '进行中'));
  seq.textContent = `第 ${cue.seq} 条 / 目标 ${total} 个岗位`;
  cmd.textContent = cue.command;

  meta.appendChild(el('span', {}, ['确认进度：', el('b', {}, `${n}/${total}`)]));
  if (timedOut) {
    meta.appendChild(el('span', { style: `color:var(--red)` }, [`⏱ 已超时（${fmtTime(cue.timedOutAt)}），未确认：${pending.join('、') || '无'}`]));
  }
  const lateN = Object.keys(cue.lateAt || {}).length;
  if (lateN) meta.appendChild(el('span', { style: `color:var(--orange)` }, `迟到确认 ${lateN} 人次`));
  if (all) meta.appendChild(el('span', { style: `color:var(--green)` }, '✔ 全部已确认'));

  // 按钮
  if (all) {
    const next = state.cues.find((c) => c.status === 'pending');
    btnEmit.textContent = next ? `全部确认 ✔ 发出第 ${next.seq} 条` : '全部确认 ✔ 序列结束';
    btnEmit.className = 'go';
    btnEmit.disabled = !next;
    $('#emitHint').textContent = next ? '全部目标已确认，可以推进。' : '全部目标已确认，序列中没有更多口令。';
    $('#btnForceClose').style.display = 'none';
  } else {
    const next = state.cues.find((c) => c.status === 'pending');
    btnEmit.textContent = '强制推进到下一条（记入日志）';
    btnEmit.className = 'danger';
    btnEmit.disabled = !next;
    $('#emitHint').textContent = next
      ? '按规则仅全部确认后才能正常推进；强制推进会把缺失岗位写入日志。'
      : '这是本场最后一条且尚未全部确认，可强制关闭。';
    $('#btnForceClose').style.display = next ? 'none' : '';
    $('#btnForceClose').textContent = '强制关闭本条（记入日志）';
  }

  updateProgress(cue);
}

function updateProgress(cue) {
  const bar = $('#progressBar');
  if (!cue || !cue.timeoutMs) { bar.style.width = '0%'; return; }
  const now = Date.now();
  if (cue.timedOutAt != null) {
    bar.style.width = '100%';
    bar.className = 'progress-bar over';
    return;
  }
  const elapsed = now - cue.emittedAt;
  const pct = Math.max(0, Math.min(100, (elapsed / cue.timeoutMs) * 100));
  bar.style.width = pct + '%';
  bar.className = 'progress-bar' + (pct > 80 ? ' warn' : '');
}

function startTicker() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    const cue = state.cues.find((c) => c.id === state.activeId);
    if (cue) updateProgress(cue);
  }, 250);
}

/* ------------------------------- 渲染日志 ------------------------------- */

function renderLogs(prepend = false) {
  const box = $('#logBox');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  box.innerHTML = '';
  for (const l of state.logs) {
    box.appendChild(el('div', { class: `log-line log-${l.type}` }, [
      el('span', { class: 'log-time' }, fmtTime(l.t)),
      el('span', { class: 'log-text' }, l.text)
    ]));
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/* -------------------------------- 主渲染 -------------------------------- */

function renderAll() {
  renderPositions();
  renderTargetSelector();
  renderCueList();
  renderStage();
  renderLogs();
}

/* -------------------------------- 事件 ---------------------------------- */

function bindUI() {
  $('#btnAddPos').addEventListener('click', () => {
    const input = $('#posName');
    const name = input.value.trim();
    if (!name) return toast('请输入岗位名称', 'warn');
    net.send({ type: 'add_position', name });
    input.value = '';
    input.focus();
  });
  $('#posName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnAddPos').click(); });

  $('#btnAddCue').addEventListener('click', () => {
    const command = $('#cueCommand').value.trim();
    const targets = Array.from(state.selectedTargets);
    const timeoutMs = Math.round(Number($('#cueTimeout').value) * 1000);
    if (!command) return toast('请输入口令内容', 'warn');
    if (!targets.length) return toast('请至少选择一个目标岗位', 'warn');
    net.send({ type: 'add_cue', cue: { command, targets, timeoutMs } });
    $('#cueCommand').value = '';
    state.selectedTargets.clear();
    renderTargetSelector();
  });

  $('#btnEmit').addEventListener('click', () => {
    const cue = state.cues.find((c) => c.id === state.activeId);
    // 未全部确认时客户端直接标记为强制推进；服务端仍会独立校验
    const force = cue && cue.targets.some((p) => !(p in cue.confirmedAt));
    net.send({ type: 'emit_cue', reason: force ? 'force' : undefined });
  });

  $('#btnForceClose').addEventListener('click', () => {
    if (!confirm('强制关闭当前口令？未确认的岗位将记入日志，且不会自动打开下一条。')) return;
    net.send({ type: 'emit_cue', reason: 'force', closeOnly: true });
  });

  $('#btnReset').addEventListener('click', () => {
    if (!confirm('确定开启新场次？将清空所有口令、确认状态与日志（岗位保留）。')) return;
    net.send({ type: 'reset' });
  });

  $('#btnExport').addEventListener('click', () => {
    const text = state.logs.map((l) => `[${new Date(l.t).toLocaleString()}] ${l.text}`).join('\n');
    const blob = new Blob([text + '\n'], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cue-sync-log-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

/* -------------------------------- 启动 ---------------------------------- */

function applySnapshot(snap) {
  state.positions = snap.positions;
  state.presence = snap.presence || {};
  state.cues = snap.cues;
  state.activeId = snap.activeId;
  state.logs = snap.logs;
  state.serverTime = snap.serverTime;
  // 清理已不存在的岗位选择
  state.selectedTargets = new Set(Array.from(state.selectedTargets).filter((n) => state.positions.includes(n)));
  renderAll();
}

function setConn(online, text) {
  const c = $('#conn');
  c.className = 'conn ' + (online === true ? 'online' : online === 'connecting' ? 'reconnect' : '');
  $('#connText').textContent = text;
}

net = connectWS((msg) => {
  switch (msg.type) {
    case 'hello_ok':
      break;
    case 'snapshot':
      applySnapshot(msg);
      break;
    case 'presence':
      state.presence = msg.presence;
      renderPositions();
      break;
    case 'toast':
      toast(msg.message, msg.level || 'error', '操作被拒绝');
      break;
    case 'error':
      toast(msg.message, 'error', '服务端错误');
      break;
    case 'cue_timeout':
      toast(`未确认：${msg.pending.join('、') || '无'}`, 'warn', '口令超时');
      break;
    default:
      // confirmed 等事件之后都跟随快照，无需单独处理
      break;
  }
}, (status) => {
  if (status === 'online') {
    setConn(true, '已连接');
    net.send({ type: 'hello', role: 'director' });
  } else if (status === 'connecting') {
    setConn('connecting', '连接中…');
  } else {
    setConn(false, '断线，自动重连中…');
  }
});

bindUI();
startTicker();
