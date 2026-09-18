/**
 * 端到端测试：通过真实 HTTP + WebSocket 启动服务端并验证核心规则。
 * 运行：npm test
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const PORT = 43219;
let serverProc = null;
let passed = 0;
let failed = 0;

function ok(cond, name) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.error(`  ✘ ${name}`); }
}

async function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let settled = false;
    proc.stdout.on('data', (d) => {
      if (!settled && d.toString().includes('已启动')) { settled = true; serverProc = proc; resolve(); }
    });
    proc.stderr.on('data', (d) => {
      if (!settled) { settled = true; reject(new Error(d.toString())); }
    });
    proc.on('exit', (code) => { if (!settled) reject(new Error('server exited ' + code)); });
    setTimeout(() => { if (!settled) reject(new Error('server start timeout')); }, 5000);
  });
}

function httpJson(pathName) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${pathName}`, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function wsClient(role, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const events = [];
  const waiters = [];
  let helloArgs = null;
  // 只等待“从此刻之后”到达的新事件，避免命中历史快照中的旧状态。
  // 用单调序号判断：注册时记下当前已处理序号，仅评估更新的消息。
  let msgSeq = 0;
  ws.on('message', (data) => {
    msgSeq += 1;
    const seq = msgSeq;
    const msg = JSON.parse(data.toString());
    events.push(msg);
    // 先收集所有命中的等待者再统一移除：
    // 反向 splice 多个等待者会造成索引错位、跳过后续等待者
    const hits = [];
    for (const waiter of waiters) {
      if (seq <= waiter.seq) continue;
      if (waiter.test(msg)) hits.push(waiter);
    }
    for (const waiter of hits) {
      const idx = waiters.indexOf(waiter);
      if (idx >= 0) waiters.splice(idx, 1)[0].resolve(msg);
    }
  });
  // open 可能在 hello() 调用前触发，因此构造时就注册：打开后若已声明握手则自动发送
  ws.on('open', () => { if (helloArgs) ws.send(JSON.stringify(helloArgs)); });
  const send = (obj) => ws.send(JSON.stringify(obj));
  const when = (pred, timeout = 3000) => new Promise((resolve, reject) => {
    const hit = events.find(pred);
    if (hit) return resolve(hit);
    const t = setTimeout(() => reject(new Error('wait event timeout: ' + timeout)), timeout);
    waiters.push({ seq: 0, test: pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
  // 只等待“从此刻之后”到达的新事件，避免命中历史快照中的旧状态
  const next = (pred, timeout = 3000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('wait next event timeout: ' + timeout)), timeout);
    waiters.push({ seq: msgSeq, test: pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
  const nextSnapshot = (pred, timeout = 3000) => next((m) => m.type === 'snapshot' && (pred ? pred(m) : true), timeout);
  const hello = () => {
    helloArgs = { type: 'hello', role, name };
    const waiter = when((m) => m.type === 'hello_ok');
    if (ws.readyState === WebSocket.OPEN) send(helloArgs);
    return waiter;
  };
  const close = () => new Promise((res) => {
    if (ws.readyState === WebSocket.CLOSED) return res();
    ws.once('close', res);
    ws.close();
  });
  return { ws, send, when, next, nextSnapshot, hello, close, events };
}

const waitSnapshot = (c) => c.when((m) => m.type === 'snapshot');
const lastSnapshot = (c) => [...c.events].reverse().find((m) => m.type === 'snapshot');

async function run() {
  await startServer();
  console.log('服务端已启动，端口', PORT);

  const health = await httpJson('/healthz');
  ok(health.ok === true, '健康检查 /healthz 返回 ok');

  // ---------- 组 1：编排 ----------
  const dir = wsClient('director');
  await dir.hello();
  await waitSnapshot(dir);

  const light = wsClient('position', '灯光');
  const sound = wsClient('position', '音响');
  const set = wsClient('position', '布景');
  await light.hello(); await sound.hello(); await set.hello();

  // 岗位可先于导演登记进入待命；登记后自动计入在线名单
  const ghost = wsClient('position', '追光');
  const ghostHello = await ghost.hello();
  ok(ghostHello.registered === false, '未登记岗位可连接待命，hello_ok.registered=false');

  dir.send({ type: 'add_position', name: '灯光' });
  await dir.when((m) => m.type === 'snapshot' && m.positions.includes('灯光'));
  dir.send({ type: 'add_position', name: '音响' });
  await dir.when((m) => m.type === 'snapshot' && m.positions.includes('音响'));
  dir.send({ type: 'add_position', name: '布景' });
  await dir.when((m) => m.type === 'snapshot' && m.positions.length === 3);
  ok(true, '导演创建 3 个岗位');
  const presSnap = lastSnapshot(dir);
  ok(presSnap.presence['灯光'] === 1 && presSnap.presence['音响'] === 1 && presSnap.presence['布景'] === 1,
    '先连接的岗位在登记后自动计入在线名单');
  ok(!('追光' in presSnap.presence), '未登记的待命岗位不计入在线名单');
  ghost.ws.close();

  // 重复岗位
  dir.send({ type: 'add_position', name: '灯光' });
  const dupPos = await dir.when((m) => m.type === 'toast' && /已存在/.test(m.message));
  ok(!!dupPos, '重复岗位被拒绝');

  dir.send({ type: 'add_cue', cue: { command: '黑场', targets: ['灯光', '音响'], timeoutMs: 5000 } });
  await dir.when((m) => m.type === 'snapshot' && m.cues.length === 1);
  dir.send({ type: 'add_cue', cue: { command: '追光主角', targets: ['灯光'], timeoutMs: 5000 } });
  await dir.when((m) => m.type === 'snapshot' && m.cues.length === 2);
  dir.send({ type: 'add_cue', cue: { command: '空目标', targets: [], timeoutMs: 5000 } });
  const badCue = await dir.when((m) => m.type === 'toast' && /至少选择/.test(m.message));
  ok(!!badCue, '无目标岗位的口令被拒绝');

  // ---------- 组 2：发令 + 权限 + 重复 + 推进门槛 ----------
  dir.send({ type: 'emit_cue' });
  const snap1 = await dir.nextSnapshot((s) => !!s.activeId);
  const cue1 = snap1.cues.find((c) => c.id === snap1.activeId);
  ok(cue1.command === '黑场' && cue1.seq === 1, '导演发出第 1 条口令');
  ok(snap1.presence['灯光'] === 1 && snap1.presence['布景'] === 1, '快照包含岗位在线状态');

  // 非目标岗位确认被拒
  set.send({ type: 'confirm', cueId: cue1.id });
  const rejectNonTarget = await set.next((m) => m.type === 'confirm_rejected' && /不是.*目标岗位/.test(m.message));
  ok(!!rejectNonTarget, '非目标岗位（布景）确认被拒绝');

  // 目标 1 确认
  light.send({ type: 'confirm', cueId: cue1.id });
  await light.next((m) => m.type === 'confirm_ack');
  const after1 = await dir.nextSnapshot((s) => {
    const c = s.cues.find((x) => x.id === cue1.id);
    return c && '灯光' in c.confirmedAt;
  });
  const cue1After = after1.cues.find((c) => c.id === cue1.id);
  ok('灯光' in cue1After.confirmedAt, '灯光确认计入当前口令');
  ok(after1.activeId === cue1.id, '单岗位确认后口令仍在进行');

  // 重复确认（客户端主动重发也必须被服务端拒绝）
  light.send({ type: 'confirm', cueId: cue1.id });
  const rejectDup = await light.next((m) => m.type === 'confirm_rejected' && m.duplicate);
  ok(!!rejectDup, '同一岗位重复确认被拒绝并标记 duplicate');

  // 未全部确认，普通推进被拒
  dir.send({ type: 'emit_cue' });
  const rejectAdvance = await dir.next((m) => m.type === 'toast' && /未确认/.test(m.message));
  ok(!!rejectAdvance, '未全部确认时推进被服务端拒绝（且不广播新快照）');
  ok(lastSnapshot(dir).activeId === cue1.id, '拒绝推进后当前口令未变化（未串入下一条）');

  // 目标 2 确认 -> 自动关闭
  sound.send({ type: 'confirm', cueId: cue1.id });
  await sound.next((m) => m.type === 'confirm_ack' && m.completed === true);
  const doneSnap = await dir.nextSnapshot((s) => s.activeId === null);
  const doneCue = doneSnap.cues.find((c) => c.id === cue1.id);
  ok(doneCue.status === 'completed' && doneCue.closeReason === 'all_confirmed', '全部目标确认后口令自动关闭');

  // 旧口令关闭后迟到的确认不能重新打开它
  sound.send({ type: 'confirm', cueId: cue1.id });
  const rejectClosed = await sound.next((m) => m.type === 'confirm_rejected' && /没有进行中的口令/.test(m.message));
  ok(!!rejectClosed, '口令关闭后的确认无效');

  // ---------- 组 3：强制推进 ----------
  dir.send({ type: 'emit_cue' });
  const snap2 = await dir.nextSnapshot((s) => !!s.activeId && s.activeId !== cue1.id);
  const cue2 = snap2.cues.find((c) => c.id === snap2.activeId);
  ok(cue2.seq === 2 && cue2.command === '追光主角', '正常发出第 2 条口令');
  // 不确认，直接强制推进
  dir.send({ type: 'emit_cue', reason: 'force' });
  const forceSnap = await dir.nextSnapshot((s) => s.cues.find((c) => c.id === cue2.id)?.closeReason === 'forced');
  const forcedCue = forceSnap.cues.find((c) => c.id === cue2.id);
  ok(forcedCue.closeReason === 'forced', '强制推进成功并标记 forced');
  const warnLog = forceSnap.logs.some((l) => l.type === 'warn' && /强制推进/.test(l.text) && /灯光/.test(l.text));
  ok(warnLog, '强制推进把缺失岗位写入事件日志');

  // ---------- 组 4：超时 + 迟到 + 防串 ----------
  // 新起一场：重置后重建（也顺带测试 reset）
  dir.send({ type: 'reset' });
  await dir.nextSnapshot((s) => s.cues.length === 0 && s.logs.length === 1);
  dir.send({ type: 'add_cue', cue: { command: '短时限口令', targets: ['灯光', '音响'], timeoutMs: 400 } });
  await dir.nextSnapshot((s) => s.cues.length === 1);
  dir.send({ type: 'emit_cue' });
  const em = await dir.nextSnapshot((s) => !!s.activeId);
  const cueA = em.cues.find((c) => c.id === em.activeId);

  // 超时事件与超时快照几乎同时下发，先并行等待两者再触发确认流程
  const timeoutWait = light.next((m) => m.type === 'cue_timeout' && m.cueId === cueA.id, 2000);
  const toSnapWait = dir.nextSnapshot((s) => s.cues.find((c) => c.id === cueA.id)?.timedOutAt);
  const timeoutEvt = await timeoutWait;
  ok(timeoutEvt.pending.includes('灯光') && timeoutEvt.pending.includes('音响'), '超时事件实时广播未确认岗位');
  const toSnap = await toSnapWait;
  const cueATo = toSnap.cues.find((c) => c.id === cueA.id);
  ok(cueATo.pendingTimedOut['灯光'], '超时在口令上标记，口令仍处于 active（未自动跳过）');

  // 超时后确认 => 迟到
  light.send({ type: 'confirm', cueId: cueA.id });
  const lateAck = await light.next((m) => m.type === 'confirm_ack' && m.late === true);
  ok(!!lateAck, '超时后的确认被接受但标记 late');
  const lateSnap = await dir.nextSnapshot((s) => s.cues.find((c) => c.id === cueA.id)?.lateAt?.['灯光']);
  ok(!!lateSnap, '迟到标记随快照保留');

  // 音响同样迟到确认，全部确认后关闭
  sound.send({ type: 'confirm', cueId: cueA.id });
  await sound.next((m) => m.type === 'confirm_ack' && m.completed === true);
  await dir.nextSnapshot((s) => s.activeId === null);
  ok(true, '含迟到的全部确认也能关闭口令');

  // 防串：再发一条，旧 cueId 确认被拒
  dir.send({ type: 'add_cue', cue: { command: '第二条', targets: ['灯光'], timeoutMs: 5000 } });
  await dir.nextSnapshot((s) => s.cues.length === 2);
  dir.send({ type: 'emit_cue' });
  const em2 = await dir.nextSnapshot((s) => !!s.activeId);
  const cueB = em2.cues.find((c) => c.id === em2.activeId);
  light.send({ type: 'confirm', cueId: cueA.id }); // 故意用上一条 id
  const stale = await light.next((m) => m.type === 'confirm_rejected' && /口令已切换/.test(m.message));
  ok(!!stale, '旧口令 id 的确认被拒绝，不串入当前口令');
  ok(lastSnapshot(dir).activeId === cueB.id, '拒绝后当前口令确认集合不受影响');
  const cueBSnap = lastSnapshot(dir).cues.find((c) => c.id === cueB.id);
  ok(!('灯光' in cueBSnap.confirmedAt), '旧确认未污染新口令的确认状态');

  // ---------- 组 5：断线重连恢复 ----------
  // 保持 cueB 进行中（未确认），灯光断线
  await light.close();
  await new Promise((r) => setTimeout(r, 200));
  const light2 = wsClient('position', '灯光');
  await light2.hello();
  const reconnectSnap = await light2.when((m) => m.type === 'snapshot');
  const restored = reconnectSnap.cues.find((c) => c.id === reconnectSnap.activeId);
  ok(restored && restored.id === cueB.id && restored.command === '第二条', '重连后恢复当前口令');
  ok(JSON.stringify(restored.confirmedAt) === '{}', '重连后恢复确认状态（尚未确认）');
  ok(Array.isArray(reconnectSnap.logs) && reconnectSnap.logs.length > 3, '重连后保留本场事件日志');
  // 重连后的岗位仍能正常确认当前口令
  light2.send({ type: 'confirm', cueId: cueB.id });
  const ack2 = await light2.next((m) => m.type === 'confirm_ack');
  ok(!!ack2 && ack2.cueId === cueB.id, '重连恢复后可正常确认当前口令');

  // 再测一个“已确认一半”场景下的重连
  dir.send({ type: 'reset' });
  await dir.nextSnapshot((s) => s.cues.length === 0);
  dir.send({ type: 'add_cue', cue: { command: '收光', targets: ['灯光', '音响'], timeoutMs: 5000 } });
  await dir.nextSnapshot((s) => s.cues.length === 1);
  dir.send({ type: 'emit_cue' });
  const em3 = await dir.nextSnapshot((s) => !!s.activeId);
  const cueC = em3.cues.find((c) => c.id === em3.activeId);
  light2.send({ type: 'confirm', cueId: cueC.id });
  await light2.next((m) => m.type === 'confirm_ack');
  await light2.close();
  await new Promise((r) => setTimeout(r, 200));
  const light3 = wsClient('position', '灯光');
  await light3.hello();
  const rs3 = await light3.when((m) => m.type === 'snapshot');
  const cueC2 = rs3.cues.find((c) => c.id === rs3.activeId);
  ok('灯光' in cueC2.confirmedAt && !('音响' in cueC2.confirmedAt), '重连后精确恢复“谁已确认/谁未确认”');

  // 非导演发令被拒
  light3.send({ type: 'add_cue', cue: { command: 'x', targets: ['灯光'], timeoutMs: 1000 } });
  const notDir = await light3.next((m) => m.type === 'error' && /仅导演/.test(m.message));
  ok(!!notDir, '岗位端不能执行导演操作');

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  return failed === 0;
}

run()
  .then(async (success) => {
    if (serverProc) serverProc.kill();
    process.exit(success ? 0 : 1);
  })
  .catch((e) => {
    console.error('测试异常：', e);
    if (serverProc) serverProc.kill();
    process.exit(1);
  });
