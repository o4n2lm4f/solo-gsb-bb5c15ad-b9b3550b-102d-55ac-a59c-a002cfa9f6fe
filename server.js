/**
 * 舞台排练口令同步 —— 服务端
 *
 * 职责：
 *  1. 维护本场唯一状态：岗位、口令序列、当前口令、确认集合、超时/迟到标记、事件日志
 *  2. 通过 WebSocket 广播状态快照与定向提示（error / notice / toast）
 *  3. 强约束：
 *     - 只有当前口令的目标岗位能确认；非目标 / 重复 / 旧口令一律拒绝
 *     - 全部目标确认 -> 口令自动关闭（completed），但仍由导演手动“发出下一条”推进
 *     - 超时只打标（timedOutAt），不关闭口令；超时后的确认记为迟到（late）
 *     - 任何确认都携带 cueId，旧 cueId 不会串入下一条
 *     - 新连接（含断线重连）立即收到完整快照，恢复当前口令与确认状态
 */
'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '3000', 10);
const LOG_LIMIT = 2000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

/* ------------------------------- 本场状态 ------------------------------- */

let idSeq = 0;
const genId = (p) => `${p}_${Date.now().toString(36)}_${(idSeq++).toString(36)}`;

const state = {
  positions: [],                 // string[]，岗位名唯一
  cues: [],                      // 未发出 + 已发出的所有口令（按序号）
  activeId: null,                // 当前口令 id（发出后 -> 关闭前）
  cursor: 0,                     // 已发出条数 / 下一条默认索引
  logs: []                       // 本场事件日志 {id, t, type, text}
};

// id -> cue 快速索引随快照重建即可，规模小直接 find。
// 在线连接跟踪：{ ws: { role, name } }。岗位可先用未登记名称连接（待命），
// 导演登记该岗位后自动计入在线名单。
const clients = new Map();
// 已登记岗位的在线计数（多标签页也计入），由 syncPresence 依据 clients 重算
const presence = Object.create(null);

/* -------------------------------- 日志 ---------------------------------- */

function addLog(type, text) {
  state.logs.push({ id: genId('log'), t: Date.now(), type, text });
  if (state.logs.length > LOG_LIMIT) state.logs.splice(0, state.logs.length - LOG_LIMIT);
}

/* ------------------------------ 口令快照 -------------------------------- */

// 去掉服务端私有字段（定时器）后下发
function publicCue(cue) {
  if (!cue) return null;
  return {
    id: cue.id,
    seq: cue.seq,
    command: cue.command,
    targets: cue.targets,
    timeoutMs: cue.timeoutMs,
    emittedAt: cue.emittedAt,
    deadlineAt: cue.deadlineAt,
    timedOutAt: cue.timedOutAt,
    confirmedAt: cue.confirmedAt,          // { 岗位: 时间戳 }
    lateAt: cue.lateAt,                    // { 岗位: 时间戳 }（超时后的确认）
    pendingTimedOut: cue.pendingTimedOut,  // { 岗位: 超时时间点 }（超时仍未确认）
    status: cue.status,                    // pending | active | completed
    closedAt: cue.closedAt,
    closeReason: cue.closeReason           // all_confirmed | forced
  };
}

function snapshot() {
  return {
    type: 'snapshot',
    positions: state.positions.slice(),
    presence: { ...presence },
    cursor: state.cursor,
    activeId: state.activeId,
    cues: state.cues.map(publicCue),
    logs: state.logs.slice(),
    serverTime: Date.now()
  };
}

/* ------------------------------ WebSocket ------------------------------- */

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function broadcastSnapshot() {
  broadcast(snapshot());
}

function refreshPresence() {
  broadcast({ type: 'presence', presence: snapshot().presence });
}

// 依据当前连接重算已登记岗位的在线计数，并对上线/下线变化写日志
function syncPresence() {
  const counts = Object.create(null);
  for (const me of clients.values()) {
    if (me.role === 'position' && state.positions.includes(me.name)) {
      counts[me.name] = (counts[me.name] || 0) + 1;
    }
  }
  const all = new Set([...Object.keys(presence), ...Object.keys(counts)]);
  for (const name of all) {
    const wasOn = (presence[name] || 0) > 0;
    const nowOn = (counts[name] || 0) > 0;
    if (!wasOn && nowOn) addLog('presence', `岗位「${name}」上线`);
    else if (wasOn && !nowOn) addLog('presence', `岗位「${name}」离线`);
  }
  for (const k of Object.keys(presence)) delete presence[k];
  Object.assign(presence, counts);
}

/* ------------------------------- 定时器 --------------------------------- */

function clearCueTimer(cue) {
  if (cue._timer) {
    clearTimeout(cue._timer);
    cue._timer = null;
  }
}

function armCueTimer(cue) {
  clearCueTimer(cue);
  if (!cue.timeoutMs || cue.status !== 'active') return;
  cue._timer = setTimeout(() => {
    if (state.activeId !== cue.id || cue.status !== 'active') return;
    const pending = cue.targets.filter((p) => !(p in cue.confirmedAt));
    cue.timedOutAt = Date.now();
    cue.pendingTimedOut = {};
    for (const p of pending) cue.pendingTimedOut[p] = cue.timedOutAt;
    addLog('warn', `第 ${cue.seq} 条「${cue.command}」超时：未确认岗位 ${pending.join('、') || '（无）'}`);
    broadcast({ type: 'cue_timeout', cueId: cue.id, timedOutAt: cue.timedOutAt, pending });
    broadcastSnapshot();
  }, cue.deadlineAt - Date.now());
}

/* ------------------------------- 业务操作 ------------------------------- */

const getActiveCue = () => state.cues.find((c) => c.id === state.activeId) || null;

function emitCueAtCursor(options) {
  options = options || {};

  // 1) 处理当前仍在进行的口令
  const prev = getActiveCue();
  if (prev && prev.status === 'active') {
    const missing = prev.targets.filter((p) => !(p in prev.confirmedAt));
    const forced = missing.length > 0;

    if (forced && options.reason !== 'force') {
      // 硬规则：未全部确认不得推进
      return { error: `尚有 ${missing.length} 个岗位未确认（${missing.join('、')}），全部目标确认后才允许推进` };
    }
    if (options.closeOnly && !forced) {
      return { error: '本条已全部确认，直接发出下一条即可' };
    }

    clearCueTimer(prev);
    prev.status = 'completed';
    prev.closedAt = Date.now();
    prev.closeReason = forced ? 'forced' : 'all_confirmed';
    state.activeId = null;
    if (forced) {
      addLog('warn', `第 ${prev.seq} 条「${prev.command}」被导演强制${options.closeOnly ? '关闭' : '推进'}，缺失确认：${missing.join('、')}`);
    }
    if (options.closeOnly) {
      state.cursor = state.cues.filter((c) => c.status !== 'pending').length;
      return { ok: true, closedOnly: true };
    }
  } else if (options.closeOnly) {
    return { error: '当前没有进行中的口令' };
  }

  // 2) 打开下一条待发口令
  let cue;
  if (options.cueId) {
    cue = state.cues.find((c) => c.id === options.cueId && c.status === 'pending');
    if (!cue) return { error: '指定的口令不存在或已发出' };
  } else {
    cue = state.cues.find((c) => c.status === 'pending');
    if (!cue) {
      // 最后一条且已通过 force 关闭：视为成功（没有下一条可发）
      if (options.reason === 'force') return { ok: true, closedOnly: true };
      return { error: '序列中没有待发出的口令' };
    }
  }

  cue.status = 'active';
  cue.emittedAt = Date.now();
  cue.deadlineAt = cue.emittedAt + (cue.timeoutMs || 0);
  cue.confirmedAt = {};
  cue.lateAt = {};
  cue.timedOutAt = null;
  cue.pendingTimedOut = {};
  cue.closedAt = null;
  cue.closeReason = null;
  state.activeId = cue.id;
  state.cursor = state.cues.filter((c) => c.status !== 'pending').length;

  armCueTimer(cue);
  addLog('emit', `发出第 ${cue.seq} 条口令「${cue.command}」→ 目标岗位：${cue.targets.join('、')}（时限 ${cue.timeoutMs ? cue.timeoutMs / 1000 + ' 秒' : '无'}）`);
  return { ok: true };
}

function handleConfirm(pos, cueId) {
  const cue = getActiveCue();

  if (!cue) return { error: '当前没有进行中的口令，确认无效' };
  if (cueId !== cue.id) {
    // 关键防串：页面持有的是旧口令 id，拒绝且不影响当前口令
    return { error: `口令已切换：该确认属于旧口令（第 ${(() => {
      const old = state.cues.find((c) => c.id === cueId);
      return old ? old.seq : '?';
    })()} 条），未计入当前口令` };
  }
  if (!cue.targets.includes(pos)) {
    addLog('deny', `岗位「${pos}」尝试确认第 ${cue.seq} 条，但不是目标岗位，已拒绝`);
    return { error: `你不是第 ${cue.seq} 条口令的目标岗位，无法确认` };
  }
  if (pos in cue.confirmedAt) {
    addLog('duplicate', `岗位「${pos}」重复确认第 ${cue.seq} 条，已忽略`);
    return { error: '重复确认：你已确认过本条口令', duplicate: true };
  }

  const now = Date.now();
  const late = cue.timedOutAt != null;
  cue.confirmedAt[pos] = now;
  if (late) cue.lateAt[pos] = now;
  delete cue.pendingTimedOut[pos];

  if (late) {
    addLog('late', `岗位「${pos}」超时后迟到确认第 ${cue.seq} 条「${cue.command}」`);
  } else {
    addLog('confirm', `岗位「${pos}」确认第 ${cue.seq} 条「${cue.command}」（${Object.keys(cue.confirmedAt).length}/${cue.targets.length}）`);
  }

  const all = cue.targets.every((p) => p in cue.confirmedAt);
  if (all && cue.status === 'active') {
    clearCueTimer(cue);
    cue.status = 'completed';
    cue.closedAt = Date.now();
    cue.closeReason = 'all_confirmed';
    state.activeId = null;
    if (late) {
      addLog('warn', `第 ${cue.seq} 条全部确认（含超时迟到），口令关闭，等待导演发出下一条`);
    } else {
      addLog('success', `第 ${cue.seq} 条全部目标按时确认 ✔ 口令关闭，可发出下一条`);
    }
  }
  return { ok: true, late, completed: all };
}

function handleAddPosition(name) {
  name = String(name || '').trim();
  if (!name) return { error: '岗位名称不能为空' };
  if (name.length > 20) return { error: '岗位名称最长 20 字' };
  if (state.positions.includes(name)) return { error: `岗位「${name}」已存在` };
  state.positions.push(name);
  // 若该岗位已有待命连接，登记后立即计入在线名单
  syncPresence();
  addLog('meta', `导演新增岗位「${name}」`);
  return { ok: true };
}

function handleRemovePosition(name) {
  if (!state.positions.includes(name)) return { error: '岗位不存在' };
  const used = state.cues.some((c) => c.targets.includes(name));
  if (used) return { error: `岗位「${name}」已被口令引用，请先调整相关口令` };
  state.positions = state.positions.filter((p) => p !== name);
  syncPresence();
  addLog('meta', `导演删除岗位「${name}」`);
  return { ok: true };
}

function handleAddCue({ command, targets, timeoutMs }) {
  command = String(command || '').trim();
  if (!command) return { error: '口令内容不能为空' };
  if (command.length > 100) return { error: '口令内容最长 100 字' };
  if (!Array.isArray(targets) || targets.length === 0) return { error: '至少选择一个目标岗位' };
  const bad = targets.filter((t) => !state.positions.includes(t));
  if (bad.length) return { error: `岗位不存在：${bad.join('、')}` };
  timeoutMs = Number(timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 3600000) {
    return { error: '时限需在 0–3600 秒之间' };
  }
  // 序号只由“待发出”序列中的位置决定，已发出口令的序号永不改变
  const pendingCount = state.cues.filter((c) => c.status === 'pending').length;
  const emittedCount = state.cues.length - pendingCount;
  const cue = {
    id: genId('cue'),
    seq: emittedCount + pendingCount + 1,
    command,
    targets: targets.slice(),
    timeoutMs,
    status: 'pending',
    emittedAt: null,
    deadlineAt: null,
    timedOutAt: null,
    confirmedAt: {},
    lateAt: {},
    pendingTimedOut: {},
    closedAt: null,
    closeReason: null
  };
  state.cues.push(cue);
  addLog('meta', `导演编排第 ${cue.seq} 条口令「${command}」→ ${targets.join('、')}`);
  return { ok: true, cue: publicCue(cue) };
}

function handleDeleteCue(cueId) {
  const idx = state.cues.findIndex((c) => c.id === cueId);
  if (idx < 0) return { error: '口令不存在' };
  const cue = state.cues[idx];
  if (cue.status !== 'pending') return { error: '只能删除尚未发出的口令' };
  state.cues.splice(idx, 1);
  // 重排剩余待发口令序号
  let n = state.cues.filter((c) => c.status !== 'pending').length;
  state.cues.forEach((c) => {
    if (c.status === 'pending') { n += 1; c.seq = n; }
  });
  addLog('meta', `导演删除待发口令「${cue.command}」`);
  return { ok: true };
}

function handleReset() {
  state.cues.forEach(clearCueTimer);
  state.cues = [];
  state.activeId = null;
  state.cursor = 0;
  state.logs = [];
  addLog('reset', '—— 新场次已开启，序列与确认状态已清空（岗位保留）——');
  return { ok: true };
}

/* --------------------------- WebSocket 连接 ----------------------------- */

function heartbeat() {
  this._alive = true;
}

wss.on('connection', (ws) => {
  ws._alive = true;
  ws.on('pong', heartbeat);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: 'error', message: '无法解析消息' });
    }

    // 握手：声明角色（重连后必须重新声明）
    if (msg.type === 'hello') {
      const role = msg.role === 'director' ? 'director' : 'position';
      let name = null;
      let registered = true;
      if (role === 'position') {
        name = String(msg.name || '').trim();
        if (!name) return send(ws, { type: 'error', message: '缺少岗位名称' });
        // 岗位可以先用名称进入待命；导演登记后自动生效
        registered = state.positions.includes(name);
        clients.set(ws, { role, name });
        syncPresence();
      } else {
        clients.set(ws, { role, name });
        addLog('presence', '导演控制端已连接');
      }
      send(ws, { type: 'hello_ok', role, name, registered });
      send(ws, snapshot());
      if (role === 'position' && registered) refreshPresence();
      return;
    }

    const me = clients.get(ws);
    if (!me) return send(ws, { type: 'error', message: '请先发送 hello 完成握手' });

    const reply = (r) => {
      if (r && r.error) send(ws, { type: 'toast', level: 'error', message: r.error });
    };
    let result;

    switch (msg.type) {
      case 'add_position':
        if (me.role !== 'director') return send(ws, { type: 'error', message: '仅导演可操作' });
        result = handleAddPosition(msg.name);
        reply(result);
        if (result.ok) broadcastSnapshot();
        break;

      case 'remove_position':
        if (me.role !== 'director') return send(ws, { type: 'error', message: '仅导演可操作' });
        result = handleRemovePosition(msg.name);
        reply(result);
        if (result.ok) broadcastSnapshot();
        break;

      case 'add_cue':
        if (me.role !== 'director') return send(ws, { type: 'error', message: '仅导演可操作' });
        result = handleAddCue(msg.cue || {});
        reply(result);
        if (result.ok) broadcastSnapshot();
        break;

      case 'delete_cue':
        if (me.role !== 'director') return send(ws, { type: 'error', message: '仅导演可操作' });
        result = handleDeleteCue(msg.cueId);
        reply(result);
        if (result.ok) broadcastSnapshot();
        break;

      case 'emit_cue':
        if (me.role !== 'director') return send(ws, { type: 'error', message: '仅导演可操作' });
        result = emitCueAtCursor({ cueId: msg.cueId, reason: msg.reason, closeOnly: !!msg.closeOnly });
        reply(result);
        if (result.ok) broadcastSnapshot();
        break;

      case 'confirm': {
        if (me.role !== 'position') return send(ws, { type: 'error', message: '仅岗位端可确认' });
        result = handleConfirm(me.name, msg.cueId);
        if (result.ok) {
          send(ws, { type: 'confirm_ack', cueId: msg.cueId, late: !!result.late, completed: !!result.completed });
          broadcast({
            type: 'confirmed',
            cueId: msg.cueId,
            position: me.name,
            at: Date.now(),
            late: !!result.late,
            completed: !!result.completed
          });
          broadcastSnapshot();
        } else {
          send(ws, { type: 'confirm_rejected', cueId: msg.cueId, message: result.error, duplicate: !!result.duplicate });
        }
        break;
      }

      case 'reset':
        if (me.role !== 'director') return send(ws, { type: 'error', message: '仅导演可操作' });
        handleReset();
        broadcastSnapshot();
        break;

      case 'ping':
        send(ws, { type: 'pong', t: Date.now() });
        break;

      default:
        send(ws, { type: 'error', message: `未知消息类型：${msg.type}` });
    }
  });

  ws.on('close', () => {
    const was = clients.has(ws);
    clients.delete(ws);
    if (was) {
      syncPresence();
      refreshPresence();
    }
  });
});

// 死连接检测
const interval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws._alive === false) { ws.terminate(); continue; }
    ws._alive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 15000);
wss.on('close', () => clearInterval(interval));

/* -------------------------------- 启动 ---------------------------------- */

addLog('reset', '—— 排练场次初始化：等待导演编排口令 ——');

server.listen(PORT, () => {
  console.log(`🎭 舞台排练口令同步服务已启动`);
  console.log(`   首页（入口）:   http://localhost:${PORT}/`);
  console.log(`   导演控制端:     http://localhost:${PORT}/director.html`);
  console.log(`   岗位端:         http://localhost:${PORT}/position.html?name=岗位名`);
  console.log(`   健康检查:       http://localhost:${PORT}/healthz`);
});

module.exports = { server, app }; // 供测试使用
