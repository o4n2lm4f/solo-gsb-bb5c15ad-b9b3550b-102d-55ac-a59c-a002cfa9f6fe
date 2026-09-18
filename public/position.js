/**
 * 岗位执行端
 *
 * 关键约束（与服务端双重保障）：
 *  - 只有当前口令 targets 包含本岗位时，确认按钮才可用
 *  - 确认时携带当前 cueId；重连后以服务端快照中的 activeId 为准，旧口令确认不会串入
 *  - 已确认则按钮锁定为“已确认”，重复点击立即本地拦截；服务端拒绝时再做强提示（抖动+红框）
 *  - 断线重连后由快照恢复：当前口令、确认状态、超时标记、迟到状态
 */
'use strict';

const params = new URLSearchParams(location.search);
let myName = (params.get('name') || '').trim();

const local = {
  positions: [],
  activeCue: null,
  handshaken: false,
  registered: false
};

let net = null;

function setConn(online, text) {
  const c = $('#conn');
  c.className = 'conn ' + (online === true ? 'online' : online === 'connecting' ? 'reconnect' : '');
  $('#connText').textContent = text;
}

function chipFor(cue, p) {
  const me = p === myName;
  const confirmed = p in cue.confirmedAt;
  const late = p in (cue.lateAt || {});
  const timedOut = !confirmed && (cue.pendingTimedOut || {})[p];
  let cls = 'chip';
  let prefix = '○ ';
  if (confirmed) { cls += late ? ' late' : ' confirmed'; prefix = late ? '◔ 迟到 ' : '● '; }
  else if (timedOut) { cls += ' timeout'; prefix = '✕ 超时 '; }
  if (me) cls += ' selected';
  return el('span', { class: cls }, prefix + p + (me ? '（我）' : ''));
}

function setStatus(text, level = '') {
  const line = $('#statusLine');
  line.textContent = text;
  line.className = 'status-line' + (level ? ' ' + level : '');
}

function render() {
  const cue = local.activeCue;
  const stage = $('#stage');
  const btn = $('#btnConfirm');

  $('#myName').textContent = myName;
  $('#stageTargets').innerHTML = '';
  $('#stageMeta').innerHTML = '';

  if (!cue) {
    stage.classList.add('idle');
    $('#stageSeq').textContent = '当前无进行中的口令';
    $('#stageCommand').textContent = '—';
    $('#cueCounter').textContent = '';
    $('#progressBar').style.width = '0%';
    btn.disabled = true;
    btn.classList.remove('done');
    btn.textContent = '确　认';
    if (!local.registered) {
      setStatus('已连接，等待导演登记本岗位（页面可先开着，登记后自动生效）。', 'late');
    } else {
      setStatus('等待导演发令…');
    }
    return;
  }

  stage.classList.remove('idle');
  $('#stageSeq').textContent = `第 ${cue.seq} 条口令`;
  $('#stageCommand').textContent = cue.command;
  cue.targets.forEach((p) => $('#stageTargets').appendChild(chipFor(cue, p)));

  const isTarget = cue.targets.includes(myName);
  const iConfirmed = isTarget && myName in cue.confirmedAt;
  const iLate = isTarget && myName in (cue.lateAt || {});
  const iTimedOut = isTarget && !iConfirmed && (cue.pendingTimedOut || {})[myName];
  const n = Object.keys(cue.confirmedAt).length;
  $('#cueCounter').textContent = `整体确认 ${n}/${cue.targets.length}`;

  $('#stageMeta').appendChild(el('span', {}, ['目标岗位：', el('b', {}, cue.targets.join('、'))]));
  if (cue.timedOutAt) {
    $('#stageMeta').appendChild(el('span', { style: 'color:var(--red)' }, '⏱ 本条口令已超过确认时限'));
  }

  btn.classList.toggle('done', !!iConfirmed);
  btn.disabled = !isTarget || iConfirmed;

  if (iConfirmed) {
    btn.textContent = iLate ? '已迟到确认' : '✔ 已确认';
    setStatus(iLate
      ? '你在超时后完成确认，已标记为“迟到确认”。本条不会串入下一条。'
      : '你已确认本条口令。请等待导演发出下一条，重复确认无效。', iLate ? 'late' : '');
  } else if (!isTarget) {
    btn.textContent = '非本岗位口令';
    setStatus('本条口令不针对本岗位，无需操作。');
  } else if (iTimedOut) {
    btn.textContent = '超时确认';
    setStatus('已超时！请立即确认，系统将标记为“迟到确认”。', 'err');
  } else {
    btn.textContent = '确　认';
    setStatus('本条口令指向你，请在时限内确认。');
  }

  updateProgress(cue);
}

function updateProgress(cue) {
  const bar = $('#progressBar');
  if (!cue || !cue.timeoutMs) { bar.style.width = '0%'; return; }
  if (cue.timedOutAt != null) { bar.style.width = '100%'; bar.className = 'progress-bar over'; return; }
  const pct = Math.max(0, Math.min(100, ((Date.now() - cue.emittedAt) / cue.timeoutMs) * 100));
  bar.style.width = pct + '%';
  bar.className = 'progress-bar' + (pct > 80 ? ' warn' : '');
}

setInterval(() => { if (local.activeCue) updateProgress(local.activeCue); }, 250);

/* ----------------------------- 岗位选择面板 ----------------------------- */

function showPicker() {
  $('#pickPanel').style.display = '';
  $('#mainPanel').style.display = 'none';
  const box = $('#pickChips');
  box.innerHTML = '';
  if (!local.positions.length) {
    box.appendChild(el('span', { class: 'muted' }, '导演尚未创建任何岗位，可在此输入名称进入待命。'));
  }
  local.positions.forEach((name) => {
    box.appendChild(el('span', {
      class: 'chip',
      onclick: () => enterAs(name)
    }, name));
  });
}

function enterAs(name) {
  name = name.trim();
  if (!name) return toast('请输入岗位名称', 'warn');
  myName = name;
  history.replaceState(null, '', `?name=${encodeURIComponent(name)}`);
  local.handshaken = false;
  $('#pickPanel').style.display = 'none';
  $('#mainPanel').style.display = '';
  net.send({ type: 'hello', role: 'position', name });
}

/* -------------------------------- 连接 ---------------------------------- */

net = connectWS((msg) => {
  switch (msg.type) {
    case 'hello_ok':
      local.handshaken = true;
      local.registered = !!msg.registered;
      $('#pickPanel').style.display = 'none';
      $('#mainPanel').style.display = '';
      render();
      break;

    case 'snapshot':
      local.positions = msg.positions;
      const nowRegistered = local.positions.includes(myName);
      if (local.handshaken && nowRegistered !== local.registered) {
        local.registered = nowRegistered;
      }
      local.activeCue = msg.cues.find((c) => c.id === msg.activeId) || null;
      if (local.handshaken) render();
      // 未进入岗位、选择面板可见时，导演新建岗位后实时刷新可选列表
      if (!local.handshaken && $('#pickPanel').style.display !== 'none') showPicker();
      break;

    case 'error':
      // 仅“缺少岗位名称”等致命握手错误才回到选择面板；待命状态不弹错误
      if (!local.handshaken && /岗位名称/.test(msg.message)) {
        toast(msg.message, 'error', '无法进入岗位');
        showPicker();
      } else if (local.handshaken) {
        toast(msg.message, 'error', '服务端错误');
      }
      break;

    case 'cue_timeout':
      if (local.activeCue && msg.cueId === local.activeCue.id) {
        // 快照马上到达，这里只做即时提醒
        if (msg.pending.includes(myName)) {
          setStatus('已超时！请立即确认（将标记迟到）。', 'err');
        }
      }
      break;

    case 'confirm_ack':
      if (msg.late) toast('已确认，但本条已超时，记为“迟到确认”。', 'warn', '迟到确认');
      else toast('确认成功。', 'ok', '已确认');
      break;

    case 'confirm_rejected': {
      // 非目标 / 重复 / 旧口令：强提示且绝不影响当前口令
      const btn = $('#btnConfirm');
      btn.classList.remove('shake');
      void btn.offsetWidth; // 重启动画
      btn.classList.add('shake', 'flash');
      setTimeout(() => btn.classList.remove('flash'), 850);
      setStatus(msg.message, 'err');
      toast(msg.message, 'error', msg.duplicate ? '重复确认' : '确认被拒绝');
      break;
    }
    default:
      break;
  }
}, (status) => {
  if (status === 'online') {
    setConn(true, '已连接');
    if (myName) {
      local.handshaken = false;
      net.send({ type: 'hello', role: 'position', name: myName });
    }
  } else if (status === 'connecting') {
    setConn('connecting', '连接中…');
  } else {
    setConn(false, '断线，自动重连中…状态将自动恢复');
  }
});

/* -------------------------------- UI ------------------------------------ */

$('#pickGo').addEventListener('click', () => enterAs($('#pickName').value));
$('#pickName').addEventListener('keydown', (e) => { if (e.key === 'Enter') enterAs(e.target.value); });

$('#btnConfirm').addEventListener('click', () => {
  const cue = local.activeCue;
  if (!cue) return; // 本地拦截
  if (!cue.targets.includes(myName)) { setStatus('本条口令不针对本岗位。', 'err'); return; }
  if (myName in cue.confirmedAt) {
    // 本地重复拦截；服务端仍会再次拒绝（权威）
    const btn = $('#btnConfirm');
    btn.classList.remove('shake'); void btn.offsetWidth; btn.classList.add('shake');
    setStatus('请勿重复确认：你已确认过本条口令。', 'err');
    return;
  }
  // 携带 cueId：服务端据此判定是否属于当前口令，防止串入下一条
  net.send({ type: 'confirm', cueId: cue.id });
});

if (!myName) {
  showPicker();
}
