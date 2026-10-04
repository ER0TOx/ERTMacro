const canvas = document.getElementById('grid-canvas');
const ctx = canvas.getContext('2d');

// Pan & Zoom Camera Matrix
let camera = {
  x: window.innerWidth / 2,
  y: window.innerHeight / 2,
  zoom: 1
};

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3.5;
const BASE_GRID_SIZE = 24;

let nodes = [];
let connections = [];
let nextNodeId = 1;

// Interaction States
let isPanning = false;
let isDraggingNode = false;
let draggedNode = null;
let dragStartPos = { x: 0, y: 0 };
let dragNodeInitPos = { x: 0, y: 0 };
let lastMousePos = { x: 0, y: 0 };

// Wire Connection States
let isConnecting = false;
let connectStartNode = null;
let connectStartPort = null;
let tempWireCurrentPos = { x: 0, y: 0 };

// Context Menu & Selection
let contextTargetNode = null;
let activeSettingsNode = null;
const contextMenu = document.getElementById('retro-context-menu');
const renameModal = document.getElementById('rename-dialog-overlay');
const renameInput = document.getElementById('rename-input');
const settingsModal = document.getElementById('settings-dialog-overlay');
const settingsBody = document.getElementById('settings-dialog-body');
const settingsTitle = document.getElementById('settings-dialog-title');

// Playback State
let isPlaying = false;
const playBtn = document.getElementById('playback-btn');
const svgPlay = document.getElementById('svg-play');
const svgPause = document.getElementById('svg-pause');
const audioProcess = document.getElementById('audio-process');
const audioDrag = document.getElementById('audio-drag');
const audioClick = document.getElementById('audio-click');
const audioPlug = document.getElementById('audio-plug');

function playSound(audioEl) {
  audioEl.pause();
  audioEl.currentTime = 0;
  audioEl.play().catch(e => console.warn(audioEl.id + ' error:', e));
}

function playClickSound() { playSound(audioClick); }
function playPlugSound() { playSound(audioPlug); }

// ---- Macro Backend (WebSocket) ----
// ต่อ WebSocket ไปที่ server ตัวเดียวกับที่เปิดหน้านี้ (รองรับ port ที่เปลี่ยนได้ตอนเป็น .exe)
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
let ws = null;
let wsRetryTimer = null;

function connectBackend() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    console.warn('WebSocket init error:', err);
    return;
  }

  ws.onopen = () => console.log('Connected to Macro Backend');

  ws.onerror = () => console.warn('WebSocket error - is the backend running at ' + WS_URL + '?');

  ws.onclose = () => {
    console.warn('WebSocket disconnected');
    ws = null;
    if (!wsRetryTimer) {
      wsRetryTimer = setTimeout(() => {
        wsRetryTimer = null;
        connectBackend();
      }, 3000);
    }
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (err) {
      console.warn('Invalid message from backend:', err);
      return;
    }
    // ปิดสถานะเล่นเมื่อ Backend ทำงานจนจบลูป (ไม่ส่ง STOP กลับ)
    if (msg && msg.status === 'STOPPED' && isPlaying) {
      stopPlayback(false);
    }

    // error ระหว่างรัน (ตัวแปรผิด, API ล้มเหลว, ไม่ได้ต่อภาพ ฯลฯ)
    if (msg && msg.status === 'ERROR') {
      notify(msg.message);
    }

    // ข้อความจาก Debug node ระหว่างรัน
    if (msg && msg.status === 'LOG') {
      const target = nodes.find(n => n.id === msg.nodeId);
      if (target) {
        logDebug(target, msg.message);
        draw();
      }
    }
  };
}

function isBackendReady() {
  return !!ws && ws.readyState === WebSocket.OPEN;
}

function sendToBackend(payload) {
  if (!isBackendReady()) {
    console.warn('Backend not connected - command "' + payload.action + '" not sent');
    return false;
  }
  ws.send(JSON.stringify(payload));
  return true;
}

function buildGraphPayload() {
  return {
    nodes: nodes.map(n => ({
      id: n.id,
      type: n.type,
      name: n.name || n.type,
      x: n.x,
      y: n.y,
      params: n.params || {}
    })),
    connections: connections.map(c => ({
      fromNodeId: c.fromNodeId,
      fromPort: c.fromPort || 'out',
      toNodeId: c.toNodeId,
      toPort: c.toPort || 'in'
    })),
    camera: { x: camera.x, y: camera.y, zoom: camera.zoom }
  };
}

function startPlayback() {
  isPlaying = true;
  svgPlay.style.display = 'none';
  svgPause.style.display = 'block';
  playBtn.classList.add('pressed');
  playSound(audioProcess);
  nodes.forEach(n => {
    n.log = [];
    refreshDebugNode(n);
  });
  sendToBackend({ action: 'START', graph: buildGraphPayload() });
}

function stopPlayback(notifyBackend = true) {
  isPlaying = false;
  svgPlay.style.display = 'block';
  svgPause.style.display = 'none';
  playBtn.classList.remove('pressed');
  playSound(audioDrag);
  if (notifyBackend) sendToBackend({ action: 'STOP' });
}

function togglePlayback() {
  if (playBtn.disabled) return;
  if (isPlaying) {
    stopPlayback();
  } else {
    startPlayback();
  }
}

playBtn.addEventListener('click', togglePlayback);

// Canvas Resize
function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  draw();
}
window.addEventListener('resize', resizeCanvas);

function screenToWorld(sx, sy) {
  return {
    x: (sx - camera.x) / camera.zoom,
    y: (sy - camera.y) / camera.zoom
  };
}

function worldToScreen(wx, wy) {
  return {
    x: wx * camera.zoom + camera.x,
    y: wy * camera.zoom + camera.y
  };
}

// Node Type Helpers
const TERMINAL_TYPES = ['Start', 'End'];
function isTerminalType(type) { return TERMINAL_TYPES.includes(type); }
function isTerminalNode(node) { return isTerminalType(node.type); }
function hasNodeType(type) { return nodes.some(n => n.type === type); }

const LOGIC_COLOR = '#000080';
const LOGIC_GLYPHS = {
  Function: 'ƒ'
};

// โหนดสี่เหลี่ยมแบ่งตามหมวด (สีของกล่องตามหมวดใน palette)
const CONSOLE_TYPES = ['Debug', 'Alert', 'Confirm', 'Text'];                  // Message: เขียว
const PROGRAM_RECT_TYPES = ['Delay', 'If', 'LoopFor', 'LoopInf', 'While',
                            'Var', 'SetVar', 'Math'];                          // Program: น้ำเงิน
const ACTION_RECT_TYPES = ['Click', 'MousePosition', 'Keyboard', 'Agent',
                           'URL', 'File'];                                     // Action: ม่วง
const IMAGE_RECT_TYPES = ['Screenshot', 'FeatureMatching'];                    // Image Processing: แดง
const RECT_TYPES = [...CONSOLE_TYPES, ...PROGRAM_RECT_TYPES, ...ACTION_RECT_TYPES, ...IMAGE_RECT_TYPES];

// Node types that hide the name badge below the dial
const NO_BADGE_TYPES = ['Start', 'End', ...RECT_TYPES];
function hasNameBadge(node) { return !NO_BADGE_TYPES.includes(node.type); }

// Retro Console Colors
const DEBUG_BG = '#0b1a0b';
const DEBUG_FG = '#33ff66';
const DEBUG_FG_DIM = '#1f7a3a';
const FILE_BG = '#2a0f45';
const FILE_FG = '#e0b3ff';
const FILE_FG_DIM = '#8b5fb8';
const RECT_WIDTH = 176;
const RECT_HEIGHT = 100;
const DEBUG_MAX_LINES = 7;

// ขนาดกล่องที่ไม่ใช่ค่ามาตรฐาน
const RECT_SIZES = {
  Agent: { w: 190, h: 100 },
  FeatureMatching: { w: 190, h: 132 },
  Screenshot: { w: 176, h: 84 }
};

function isDebugNode(node) { return node.type === 'Debug'; }
function isFileNode(node) { return node.type === 'File'; }
function isRectType(type) { return RECT_TYPES.includes(type); }
function isRectNode(node) { return RECT_TYPES.includes(node.type); }

function initRectNode(node) {
  const size = RECT_SIZES[node.type] || { w: RECT_WIDTH, h: RECT_HEIGHT };
  node.width = size.w;
  node.height = size.h;
  node.log = node.type === 'Debug' ? ['> waiting for input...'] : [];
}

function getNodeHalfSize(node) {
  if (isRectNode(node)) {
    return { w: (node.width || RECT_WIDTH) / 2, h: (node.height || RECT_HEIGHT) / 2 };
  }
  return { w: node.radius, h: node.radius };
}

const RECT_THEMES = {
  console: { bg: DEBUG_BG, fg: DEBUG_FG, dim: DEBUG_FG_DIM, scan: 'rgba(51, 255, 102, 0.06)' },
  action:  { bg: FILE_BG, fg: FILE_FG, dim: FILE_FG_DIM, scan: 'rgba(224, 179, 255, 0.07)' },
  program: { bg: '#0a1a33', fg: '#7dbfff', dim: '#2f6aa8', scan: 'rgba(77, 166, 255, 0.07)' },
  image:   { bg: '#2a0b0b', fg: '#ff7777', dim: '#9a3a3a', scan: 'rgba(255, 85, 85, 0.07)' }
};

function getRectTheme(node) {
  if (PROGRAM_RECT_TYPES.includes(node.type)) return RECT_THEMES.program;
  if (ACTION_RECT_TYPES.includes(node.type)) return RECT_THEMES.action;
  if (IMAGE_RECT_TYPES.includes(node.type)) return RECT_THEMES.image;
  return RECT_THEMES.console;
}

// ตัดข้อความให้พอดีความกว้าง (ใช้ font ที่ตั้งไว้บน ctx ตอนเรียก)
function fitText(text, maxWidth) {
  text = String(text);
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

// เนื้อหาที่แสดงใน Console ของแต่ละชนิดโหนด
function getRectContent(node) {
  const p = node.params || {};
  switch (node.type) {
    case 'Text': {
      const text = (p.text || '').trim();
      if (!text) return ['(empty text)'];
      return text.split('\n');
    }
    case 'Alert':
    case 'Confirm': {
      const msg = (p.message || '').trim();
      return msg ? [msg] : ['(no message set)'];
    }
    case 'File': {
      const files = Array.isArray(p.files) ? p.files : [];
      if (!files.length) return ['(no file)'];
      return files.map(f => f.name + '  ' + formatFileSize(f.size));
    }
    case 'Delay':
      return ['Wait', (p.ms ?? 1000) + ' ms'];
    case 'Click':
      return [p.button || 'LeftClick', 'x ' + (p.count ?? 1)];
    case 'MousePosition': {
      if (connections.some(c => c.toNodeId === node.id && c.toPort === 'pos_in')) {
        return ['X, Y from', 'Position input'];
      }
      const blank = String(p.x ?? '').trim() === '' && String(p.y ?? '').trim() === '';
      return blank ? ['(position from input)'] : ['X: ' + (p.x ?? 0), 'Y: ' + (p.y ?? 0)];
    }
    case 'Keyboard':
      return ['"' + (p.text || '') + '"', (p.interval ?? 50) + ' ms / char'];
    case 'Agent': {
      const isLocal = /local/i.test(p.mode || '');
      const lines = [isLocal ? 'Local Agent' : 'Cloud Agent - ' + (p.provider || 'Gemini')];
      if (isLocal && p.apiUrl) lines.push(p.apiUrl);
      const prompt = (p.prompt || '').trim().split('\n')[0];
      lines.push(prompt ? '> ' + prompt : '(no prompt)');
      return lines;
    }
    case 'URL':
      return [p.url || '(no url)'];
    case 'If':
    case 'While': {
      const kw = node.type === 'If' ? 'if  ' : 'while  ';
      const a = p.a || '(input)';
      // B ว่าง = ตรวจ boolean ว่า A เป็น true หรือไม่
      if (String(p.b ?? '').trim() === '') {
        return [kw + a + (p.op === '~' ? ' is not true' : ' is true')];
      }
      return [kw + a + ' ' + (p.op || '=') + ' ' + p.b];
    }
    case 'LoopFor':
      return ['Repeat ' + (p.count ?? 1) + ' times'];
    case 'LoopInf':
      return ['Repeat forever', '(press Pause to stop)'];
    case 'Var':
      return ['$' + (p.varName || '?') + ' = ' + (p.value ?? ''), 'type: ' + (p.vtype || 'text')];
    case 'SetVar':
      return ['$' + (p.varName || '?') + ' <- ' + (String(p.value ?? '').trim() === '' ? '(input)' : p.value)];
    case 'Math':
      return [(p.a ?? '') + ' ' + (p.op || '+') + ' ' + (p.b ?? ''),
              p.target ? '-> $' + p.target : '(result not stored)'];
    case 'Screenshot':
      return ['Capture screen', '(primary monitor)'];
    case 'FeatureMatching':
      return ['accuracy >= ' + (p.threshold ?? 0.8), 'out: bool, x, y'];
    default:
      return Array.isArray(node.log) ? node.log : [];
  }
}

function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return (i === 0 ? size : size.toFixed(1)) + ' ' + units[i];
}

// ข้อความที่แสดงใน Console: ใช้ชื่อชนิดโหนดก่อนหน้า เช่น Click -> "Click"
function describeNode(node) {
  if (!node) return '';
  return node.name || node.type;
}

function logDebug(node, message) {
  if (!isDebugNode(node)) return;
  if (!Array.isArray(node.log)) node.log = [];
  node.log.push(String(message));
  while (node.log.length > DEBUG_MAX_LINES) node.log.shift();
}

// ดึงชื่อโหนดก่อนหน้าจาก wire ที่เข้ามาที่ Debug node
function getUpstreamNode(node) {
  const conn = connections.find(c => c.toNodeId === node.id);
  if (!conn) return null;
  return nodes.find(n => n.id === conn.fromNodeId) || null;
}

function refreshDebugNode(node) {
  if (!isDebugNode(node)) return;
  const upstream = getUpstreamNode(node);
  logDebug(node, upstream ? '> ' + describeNode(upstream) : '> waiting for input...');
}

// Sub-label rendered inside the node dial (e.g. Click button type)
function getNodeSubLabel(node) {
  const p = node.params || {};
  if (node.type === 'Function') return (p.mode === 'Async' ? 'ASYNC' : 'SYNC');
  return '';
}

function getNodeStyle(node) {
  if (isTerminalNode(node)) {
    return {
      color: '#c06000',
      font: `bold ${Math.max(8, 12 * camera.zoom)}px Tahoma, sans-serif`,
      glyph: node.type
    };
  }
  return {
    color: LOGIC_COLOR,
    font: `italic bold ${Math.max(10, 18 * camera.zoom)}px Georgia, serif`,
    glyph: LOGIC_GLYPHS[node.type] || 'ƒ'
  };
}

function updateLockStates() {
  TERMINAL_TYPES.forEach(type => {
    const item = document.getElementById('node-item-' + type.toLowerCase());
    if (item) {
      const used = hasNodeType(type);
      item.classList.toggle('locked', used);
      item.title = used ? type + ' already exists in flow' : '';
    }
  });

  const canPlay = hasNodeType('Start') && hasNodeType('End');
  playBtn.disabled = !canPlay;
  playBtn.classList.toggle('disabled', !canPlay);
  playBtn.title = canPlay ? 'Toggle Play / Pause' : 'Flow requires a Start and an End node';
}

// Default parameters for each node type
const CLICK_BUTTON_OPTIONS = ['LeftClick', 'RightClick', 'MiddleClick'];

function getDefaultParams(type) {
  switch (type) {
    case 'Function':
      return { mode: 'Sync' };
    case 'Delay':
      return { ms: '1000' };
    case 'Click':
      return { button: 'LeftClick', count: '1' };
    case 'MousePosition':
      return { x: '0', y: '0' };
    case 'Keyboard':
      return { text: '', interval: '50' };
    case 'Agent':
      return { mode: 'Cloud Agent', provider: 'Gemini', apiKey: '', apiUrl: '', model: '', prompt: '' };
    case 'URL':
      return { url: '' };
    case 'If':
    case 'While':
      return { a: '', op: '=', b: '' };
    case 'LoopFor':
      return { count: '3' };
    case 'Var':
      return { varName: '', value: '0', vtype: 'int' };
    case 'SetVar':
      return { varName: '', value: '' };
    case 'Math':
      return { a: '0', op: '+', b: '0', target: '' };
    case 'FeatureMatching':
      return { threshold: '0.8' };
    case 'Alert':
      return { message: 'Alert' };
    case 'Confirm':
      return { message: 'Confirm?' };
    case 'Text':
      return { text: '' };
    case 'File':
      return { files: [] };
    default:
      return {};
  }
}

function defaultPortsForType(type) {
  if (type === 'Start') {
    return [{ type: 'out', id: 'exec_out' }];
  }
  if (type === 'End' || type === 'Debug') {
    return [{ type: 'in', id: 'exec_in' }];
  }
  if (type === 'Confirm') {
    // Confirm มี output 2 ทาง: ทาง Confirm และทาง Decline
    return [
      { type: 'in', id: 'exec_in' },
      { type: 'out', id: 'out_confirm' },
      { type: 'out', id: 'out_decline' }
    ];
  }
  if (type === 'If') {
    return [
      { type: 'in', id: 'exec_in' },
      { type: 'out', id: 'out_true' },
      { type: 'out', id: 'out_false' }
    ];
  }
  if (type === 'LoopFor' || type === 'LoopInf' || type === 'While') {
    // Loop = ทำซ้ำสิ่งที่ต่ออยู่, Done = ทำต่อหลังลูปจบ
    return [
      { type: 'in', id: 'exec_in' },
      { type: 'out', id: 'out_loop' },
      { type: 'out', id: 'out_done' }
    ];
  }
  if (type === 'FeatureMatching') {
    return [
      { type: 'in', id: 'img_src' },
      { type: 'in', id: 'img_tgt' },
      { type: 'in', id: 'activate' },
      { type: 'out', id: 'out_found' },
      { type: 'out', id: 'out_position' },
      { type: 'out', id: 'out_x' },
      { type: 'out', id: 'out_y' }
    ];
  }
  if (type === 'Screenshot') {
    // exec_out = สั่งงานต่อ, out_image = ส่งข้อมูลภาพไปยังโหนดหมวด Image Processing
    return [
      { type: 'in', id: 'exec_in' },
      { type: 'out', id: 'exec_out' },
      { type: 'out', id: 'out_image' }
    ];
  }
  if (type === 'MousePosition') {
    // pos_in = รับตำแหน่งจาก FeatureMatching (ถ้าต่อสายนี้ จะใช้แทนค่า X/Y)
    return [
      { type: 'in', id: 'exec_in' },
      { type: 'in', id: 'pos_in' },
      { type: 'out', id: 'exec_out' }
    ];
  }
  return [
    { type: 'in', id: 'exec_in' },
    { type: 'out', id: 'exec_out' }
  ];
}

// ช่องข้อมูล (ภาพ / ตำแหน่ง): ต่อได้เฉพาะ [ชนิดโหนด, ช่อง] ที่กำหนด และเป็นสายข้อมูล ไม่ใช่สายสั่งรัน
const IMAGE_SOURCES = [['File', 'exec_out'], ['Screenshot', 'out_image']];
const IMAGE_MSG = 'Source Img / Target Img รับภาพจากโหนด File หรือช่อง Image ของ Screenshot เท่านั้น';
const DATA_PORT_RULES = {
  img_src: { from: IMAGE_SOURCES, msg: IMAGE_MSG },
  img_tgt: { from: IMAGE_SOURCES, msg: IMAGE_MSG },
  pos_in: {
    from: [['FeatureMatching', 'out_position']],
    msg: 'ช่อง Position รับได้เฉพาะ Position ของ FeatureMatching'
  }
};
// ช่องออกที่ส่งข้อมูลเฉพาะทาง ห้ามต่อเข้าช่องสั่งรันทั่วไป
const DATA_ONLY_OUTPUTS = {
  out_image: 'ช่อง Image ต่อได้เฉพาะ Source Img / Target Img ของ FeatureMatching',
  out_position: 'ช่อง Position ต่อได้เฉพาะช่อง Position ของ MousePosition'
};
const WIRE_COLORS = { img_src: '#ff8888', img_tgt: '#ff8888', pos_in: '#ffd24d' };

function wireProblem(fromNode, fromPort, toPort) {
  const rule = DATA_PORT_RULES[toPort];
  if (rule) {
    return rule.from.some(([t, p]) => t === fromNode.type && p === fromPort) ? null : rule.msg;
  }
  return DATA_ONLY_OUTPUTS[fromPort] || null;
}

function spawnNode(type, silent) {
  if (isTerminalType(type) && nodes.some(n => n.type === type)) return;
  if (!silent) playClickSound();
  const centerWorld = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
  const offset = (nodes.length % 8) * 16;

  const node = {
    id: nextNodeId++,
    type: type,
    name: type,
    x: centerWorld.x + offset,
    y: centerWorld.y + offset,
    radius: 36,
    ports: defaultPortsForType(type),
    params: getDefaultParams(type)
  };

  if (isRectType(type)) initRectNode(node);

  nodes.push(node);
  if (!silent) markDirty();
  updateLockStates();
  draw();
}

const PORT_LABELS = {
  out_confirm: 'Confirm',
  out_decline: 'Decline',
  out_true: 'True',
  out_false: 'False',
  out_loop: 'Loop',
  out_done: 'Done',
  img_src: 'Source Img',
  img_tgt: 'Target Img',
  activate: 'Activate',
  out_found: 'isFound',
  out_position: 'Position',
  out_x: 'X',
  out_y: 'Y',
  out_image: 'Image',
  pos_in: 'Position'
};

const PORT_COLORS = {
  out_confirm: '#33ff66',
  out_decline: '#ff5555',
  out_true: '#33ff66',
  out_false: '#ff5555',
  out_loop: '#4da6ff',
  out_done: '#ff9100',
  img_src: '#ff8888',
  img_tgt: '#ff8888',
  out_found: '#33ff66',
  out_position: '#ffd24d',
  out_x: '#ffd24d',
  out_y: '#ffd24d',
  out_image: '#ff8888',
  pos_in: '#ffd24d'
};

// หา port object จาก port object / id / type
function resolvePort(node, portRef) {
  const list = node.ports || [];
  if (!portRef) return null;
  if (typeof portRef === 'object') {
    return list.find(p => p === portRef) || list.find(p => p.id === portRef.id) || null;
  }
  return list.find(p => p.id === portRef) || list.find(p => p.type === portRef) || null;
}

function getPortPosition(node, portRef) {
  const half = getNodeHalfSize(node);
  const port = resolvePort(node, portRef);
  const type = (port ? port.type : portRef) === 'in' ? 'in' : 'out';

  // ช่องชนิดเดียวกันหลายช่อง: กระจายตามจำนวน port ในแนวตั้ง (ช่องเดียว = กึ่งกลาง)
  const siblings = (node.ports || []).filter(p => p.type === type);
  const idx = Math.max(0, siblings.findIndex(p => port && p.id === port.id));
  const step = (half.h * 2) / (siblings.length + 1);
  const y = node.y - half.h + step * (idx + 1);

  return { x: type === 'in' ? node.x - half.w : node.x + half.w, y: y };
}

function getPortAt(wx, wy) {
  const portRadiusThreshold = 12 / camera.zoom;
  for (const node of nodes) {
    for (const port of node.ports) {
      const pos = getPortPosition(node, port);
      const dist = Math.hypot(pos.x - wx, pos.y - wy);
      if (dist <= portRadiusThreshold) {
        return { node, port };
      }
    }
  }
  return null;
}

function getNodeAt(wx, wy) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (isRectNode(n)) {
      const half = getNodeHalfSize(n);
      if (Math.abs(wx - n.x) <= half.w && Math.abs(wy - n.y) <= half.h) {
        return n;
      }
      continue;
    }
    const dist = Math.hypot(n.x - wx, n.y - wy);
    if (dist <= n.radius) {
      return n;
    }
  }
  return null;
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#1c2f2f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const step = BASE_GRID_SIZE * camera.zoom;
  const startX = ((camera.x % step) + step) % step;
  const startY = ((camera.y % step) + step) % step;
  const dotSize = Math.max(1, Math.min(2.5, 1.5 * camera.zoom));

  ctx.fillStyle = '#416565';
  for (let x = startX; x < canvas.width; x += step) {
    for (let y = startY; y < canvas.height; y += step) {
      ctx.fillRect(x - dotSize / 2, y - dotSize / 2, dotSize, dotSize);
    }
  }

  for (const conn of connections) {
    const fromNode = nodes.find(n => n.id === conn.fromNodeId);
    const toNode = nodes.find(n => n.id === conn.toNodeId);
    if (fromNode && toNode) {
      const p1 = worldToScreen(...Object.values(getPortPosition(fromNode, conn.fromPort)));
      const p2 = worldToScreen(...Object.values(getPortPosition(toNode, conn.toPort)));
      drawWire(p1.x, p1.y, p2.x, p2.y, WIRE_COLORS[conn.toPort] || '#00ffcc');
    }
  }

  if (isConnecting && connectStartNode) {
    const p1 = worldToScreen(...Object.values(getPortPosition(connectStartNode, connectStartPort)));
    drawWire(p1.x, p1.y, tempWireCurrentPos.x, tempWireCurrentPos.y, '#ffff00', true);
  }

  for (const node of nodes) {
    const s = worldToScreen(node.x, node.y);
    const r = node.radius * camera.zoom;

    if (isRectNode(node)) {
      drawConsoleNode(node, s);
      drawNodePorts(node);
      continue;
    }

    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#c0c0c0';
    ctx.fill();

    ctx.lineWidth = Math.max(1.5, 2 * camera.zoom);
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(s.x, s.y, r - Math.max(1, 1.5 * camera.zoom), 0, Math.PI * 2);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = Math.max(1, 1.5 * camera.zoom);
    ctx.stroke();

    const style = getNodeStyle(node);
    ctx.beginPath();
    ctx.arc(s.x, s.y, r * 0.72, 0, Math.PI * 2);
    ctx.fillStyle = style.color;
    ctx.fill();

    // Sub-label (เช่น SYNC / ASYNC ของ Function) ดันตัวอักษรหลักขึ้นเพื่อไม่ให้ทับกัน
    const subLabel = getNodeSubLabel(node);
    ctx.fillStyle = '#ffffff';
    ctx.font = style.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(style.glyph, s.x, s.y - (subLabel ? 6 * camera.zoom : 0));
    if (subLabel) {
      ctx.font = `bold ${Math.max(6, 8 * camera.zoom)}px Tahoma, sans-serif`;
      ctx.fillText(subLabel, s.x, s.y + (13 * camera.zoom));
    }

    drawNodePorts(node);

    if (hasNameBadge(node)) {      const tagY = s.y + r + (11 * camera.zoom);
      const displayName = node.name || node.type;
      ctx.font = `${Math.max(9, 10 * camera.zoom)}px Tahoma, sans-serif`;
      const textMetrics = ctx.measureText(displayName.toUpperCase());
      const tagW = Math.max(50 * camera.zoom, textMetrics.width + (14 * camera.zoom));
      const tagH = 15 * camera.zoom;

      ctx.fillStyle = '#c0c0c0';
      ctx.fillRect(s.x - tagW / 2, tagY - tagH / 2, tagW, tagH);

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.strokeRect(s.x - tagW / 2, tagY - tagH / 2, tagW, tagH);

      ctx.strokeStyle = '#000000';
      ctx.strokeRect(s.x - tagW / 2 + 1, tagY - tagH / 2 + 1, tagW - 1, tagH - 1);

      ctx.fillStyle = '#000000';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(displayName.toUpperCase(), s.x, tagY + (0.5 * camera.zoom));
    }
  }
}

function drawNodePorts(node) {
  for (const port of node.ports) {
    const pPos = worldToScreen(...Object.values(getPortPosition(node, port)));
    const pr = Math.max(4, 5.5 * camera.zoom);

    ctx.beginPath();
    ctx.arc(pPos.x, pPos.y, pr, 0, Math.PI * 2);
    ctx.fillStyle = PORT_COLORS[port.id] || (port.type === 'in' ? '#00e5ff' : '#ff9100');
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // ป้ายชื่อช่อง: ขาออกเขียนด้านขวา, ขาเข้าเขียนด้านซ้าย (ไม่ให้ทับเนื้อหาในกล่อง)
    const label = PORT_LABELS[port.id];
    if (label) {
      ctx.font = `bold ${Math.max(8, 10 * camera.zoom)}px Tahoma, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = PORT_COLORS[port.id] || '#00e5ff';
      if (port.type === 'in') {
        ctx.textAlign = 'right';
        ctx.fillText(label, pPos.x - pr - 4, pPos.y);
      } else {
        ctx.textAlign = 'left';
        ctx.fillText(label, pPos.x + pr + 4, pPos.y);
      }
    }
  }
}

// Retro Rect Node (Debug / Alert / Confirm / Text / File)
function drawConsoleNode(node, s) {
  const theme = getRectTheme(node);
  const half = getNodeHalfSize(node);
  const w = half.w * 2 * camera.zoom;
  const h = half.h * 2 * camera.zoom;
  const x = s.x - w / 2;
  const y = s.y - h / 2;
  const border = Math.max(2, 3 * camera.zoom);

  // Outer Beveled Frame
  ctx.fillStyle = '#c0c0c0';
  ctx.fillRect(x, y, w, h);

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = border;
  ctx.strokeRect(x, y, w, h);

  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + border, y + border, w - border * 2, h - border * 2);

  // Inner Screen
  const pad = 6 * camera.zoom;
  const screenX = x + pad;
  const screenY = y + pad;
  const screenW = w - pad * 2;
  const screenH = h - pad * 2;

  ctx.fillStyle = theme.bg;
  ctx.fillRect(screenX, screenY, screenW, screenH);

  ctx.save();
  ctx.beginPath();
  ctx.rect(screenX, screenY, screenW, screenH);
  ctx.clip();

  // CRT Scanlines
  ctx.fillStyle = theme.scan;
  const lineGap = Math.max(2, 3 * camera.zoom);
  for (let ly = screenY; ly < screenY + screenH; ly += lineGap * 2) {
    ctx.fillRect(screenX, ly, screenW, lineGap);
  }

  // Title
  const titleFont = Math.max(7, 9 * camera.zoom);
  ctx.font = `bold ${titleFont}px 'Courier New', monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = theme.dim;
  const title = node.type === 'Debug' ? 'DEBUG CONSOLE' : (node.name || node.type).toUpperCase();
  ctx.fillText(title, screenX + 5 * camera.zoom, screenY + 4 * camera.zoom);

  // Content Lines
  const bodyFont = Math.max(7, 11 * camera.zoom);
  const lineHeight = bodyFont + 3 * camera.zoom;
  ctx.font = `${bodyFont}px 'Courier New', monospace`;
  const maxLines = Math.max(1, Math.floor((screenH - 20 * camera.zoom) / lineHeight));
  const lines = getRectContent(node);
  const visible = lines.slice(Math.max(0, lines.length - maxLines));
  visible.forEach((line, i) => {
    const ly = screenY + (18 * camera.zoom) + i * lineHeight;
    ctx.fillStyle = theme.fg;
    ctx.fillText(fitText(line, screenW - 10 * camera.zoom), screenX + 5 * camera.zoom, ly);
  });

  ctx.restore();

  // Screen Border
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.strokeRect(screenX, screenY, screenW, screenH);
}

function drawWire(x1, y1, x2, y2, color, isDashed = false) {
  const dx = Math.abs(x2 - x1) * 0.55;
  const cp1x = x1 + Math.max(dx, 40);
  const cp1y = y1;
  const cp2x = x2 - Math.max(dx, 40);
  const cp2y = y2;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, 2.5 * camera.zoom);
  if (isDashed) {
    ctx.setLineDash([6, 4]);
  }
  ctx.stroke();
  ctx.restore();
}

// Double-Click Node -> Rename (ทุกโหนด) / เปิด Properties (โหนดที่มี settings)
canvas.addEventListener('dblclick', (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const wPos = screenToWorld(sx, sy);

  const hitNode = getNodeAt(wPos.x, wPos.y);
  if (!hitNode) return;

  e.preventDefault();
  contextTargetNode = hitNode;
  hideContextMenu();

  const RENAME_ONLY_TYPES = ['Start', 'End', 'LoopInf', 'Screenshot'];
  if (RENAME_ONLY_TYPES.includes(hitNode.type)) {
    openRenameModal();
    return;
  }
  openSettingsModal(hitNode);
});

canvas.addEventListener('mousedown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const wPos = screenToWorld(sx, sy);

  hideContextMenu();
  lastMousePos = { x: sx, y: sy };

  if (e.button === 0) {
    const hitPort = getPortAt(wPos.x, wPos.y);
    if (hitPort) {
      isConnecting = true;
      connectStartNode = hitPort.node;
      connectStartPort = hitPort.port.id || hitPort.port.type;
      tempWireCurrentPos = { x: sx, y: sy };
      return;
    }

    const hitNode = getNodeAt(wPos.x, wPos.y);
    if (hitNode) {
      isDraggingNode = true;
      draggedNode = hitNode;
      dragStartPos = { x: sx, y: sy };
      dragNodeInitPos = { x: hitNode.x, y: hitNode.y };

      nodes = nodes.filter(n => n !== hitNode);
      nodes.push(hitNode);
      draw();
      return;
    }

    isPanning = true;
    canvas.style.cursor = 'grabbing';
  }
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const wPos = screenToWorld(sx, sy);

  const hitNode = getNodeAt(wPos.x, wPos.y);
  if (hitNode) {
    contextTargetNode = hitNode;
    contextMenu.style.left = `${e.clientX}px`;
    contextMenu.style.top = `${e.clientY}px`;
    contextMenu.style.display = 'block';
    playClickSound();
  } else {
    hideContextMenu();
  }
});

window.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  if (isConnecting) {
    tempWireCurrentPos = { x: sx, y: sy };
    draw();
  } else if (isDraggingNode && draggedNode) {
    const dx = (sx - dragStartPos.x) / camera.zoom;
    const dy = (sy - dragStartPos.y) / camera.zoom;
    draggedNode.x = dragNodeInitPos.x + dx;
    draggedNode.y = dragNodeInitPos.y + dy;
    draw();
  } else if (isPanning) {
    camera.x += sx - lastMousePos.x;
    camera.y += sy - lastMousePos.y;
    lastMousePos = { x: sx, y: sy };
    draw();
  }
});

window.addEventListener('mouseup', (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const wPos = screenToWorld(sx, sy);

  if (isConnecting) {
    const hitPort = getPortAt(wPos.x, wPos.y);
    const startPort = resolvePort(connectStartNode, connectStartPort);
    const endPort = hitPort ? resolvePort(hitPort.node, hitPort.port.id || hitPort.port.type) : null;

    // ต่อได้เฉพาะ input <-> output ของคนละโหนด
    if (hitPort && startPort && endPort &&
        hitPort.node !== connectStartNode && startPort.type !== endPort.type) {
      const fromIsStart = startPort.type === 'out';
      const fromNode = fromIsStart ? connectStartNode : hitPort.node;
      const toNode = fromIsStart ? hitPort.node : connectStartNode;
      const fromPort = (fromIsStart ? startPort : endPort).id || (fromIsStart ? 'out' : 'in');
      const toPort = (fromIsStart ? endPort : startPort).id || (fromIsStart ? 'in' : 'out');

      // ช่องรับภาพของ Feature Matching รับเฉพาะ File/Screenshot และ 1 สายต่อ 1 ช่อง
      const problem = wireProblem(fromNode, fromPort, toPort);
      if (problem) {
        notify(problem);
      } else {
        if (DATA_PORT_RULES[toPort]) {
          connections = connections.filter(c => !(c.toNodeId === toNode.id && c.toPort === toPort));
        }
        const exists = connections.some(c =>
          c.fromNodeId === fromNode.id && c.toNodeId === toNode.id &&
          (c.fromPort || 'out') === fromPort && (c.toPort || 'in') === toPort
        );
        if (!exists) {
          connections.push({
            id: `edge_${fromNode.id}_${fromPort}_${toNode.id}_${toPort}`,
            fromNodeId: fromNode.id,
            fromPort: fromPort,
            toNodeId: toNode.id,
            toPort: toPort
          });
          playPlugSound();
          refreshDebugNode(toNode);
          markDirty();
        }
      }
    }
    isConnecting = false;
    connectStartNode = null;
    connectStartPort = null;
    draw();
  } else if (isDraggingNode) {
    markDirty();
  }

  isPanning = false;
  isDraggingNode = false;
  draggedNode = null;
  canvas.style.cursor = 'crosshair';
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
  const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom * zoomFactor));

  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  camera.x = mouseX - (mouseX - camera.x) * (newZoom / camera.zoom);
  camera.y = mouseY - (mouseY - camera.y) * (newZoom / camera.zoom);
  camera.zoom = newZoom;

  draw();
}, { passive: false });

function hideContextMenu() {
  contextMenu.style.display = 'none';
}

window.addEventListener('click', (e) => {
  if (!contextMenu.contains(e.target)) {
    hideContextMenu();
  }
});

function deleteTargetNode() {
  if (!contextTargetNode) return;
  playClickSound();

  connections = connections.filter(
    c => c.fromNodeId !== contextTargetNode.id && c.toNodeId !== contextTargetNode.id
  );

  nodes = nodes.filter(n => n !== contextTargetNode);
  contextTargetNode = null;
  hideContextMenu();
  updateLockStates();
  markDirty();
  draw();
}

function openRenameModal() {
  if (!contextTargetNode) return;
  renameInput.value = contextTargetNode.name || contextTargetNode.type;
  renameModal.style.display = 'flex';
  hideContextMenu();
  setTimeout(() => renameInput.focus(), 50);
}

function closeRenameModal() {
  renameModal.style.display = 'none';
}

function saveNodeRename() {
  if (contextTargetNode && renameInput.value.trim() !== '') {
    contextTargetNode.name = renameInput.value.trim();
    playClickSound();
    markDirty();
    draw();
  }
  closeRenameModal();
}

renameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveNodeRename();
  if (e.key === 'Escape') closeRenameModal();
});

// Node Properties Modal Handling
const COMPARE_OPTIONS = ['=', '~', '<', '>', '<=', '>='];
const MATH_OPTIONS = ['+', '-', '*', '/'];
const VAR_TYPES = ['int', 'float', 'text', 'bool'];
const FUNCTION_MODES = ['Sync', 'Async'];
const AGENT_MODES = ['Cloud Agent', 'Local Agent'];
const AGENT_PROVIDERS = ['Gemini', 'GPT', 'Claude'];

// ฟอร์มของโหนดที่ตั้งค่าในกล่อง (ช่องตัวเลขเป็น text เพื่อใส่ $ตัวแปร ได้)
// row = ช่องที่อยู่แถวเดียวกัน, showIf = [key, [ค่า...]] แสดงเมื่อช่อง key มีค่าตรง, raw = ไม่ trim ช่องว่าง
const NODE_FIELDS = {
  Function: [
    { key: 'mode', label: 'Mode:', type: 'select', options: FUNCTION_MODES }
  ],
  Delay: [
    { key: 'ms', label: 'Delay (ms):', placeholder: '1000  หรือ  $wait' }
  ],
  Click: [
    { key: 'button', label: 'Mouse Button:', type: 'select', options: CLICK_BUTTON_OPTIONS },
    { key: 'count', label: 'Click Count:', placeholder: '1' }
  ],
  MousePosition: [
    { key: 'x', label: 'X Coord:', row: 'xy', placeholder: '0' },
    { key: 'y', label: 'Y Coord:', row: 'xy', placeholder: '0' }
  ],
  Keyboard: [
    { key: 'text', label: 'Text to Type:', raw: true },
    { key: 'interval', label: 'Type Speed / Interval (ms):', placeholder: '50' }
  ],
  Agent: [
    { key: 'mode', label: 'Mode:', type: 'select', options: AGENT_MODES },
    { key: 'provider', label: 'Provider:', type: 'select', options: AGENT_PROVIDERS,
      showIf: ['mode', ['Cloud Agent']] },
    { key: 'apiKey', label: 'API Key:', type: 'password',
      showIf: ['mode', ['Cloud Agent']], placeholder: 'key ของ Gemini / OpenAI / Anthropic' },
    { key: 'apiUrl', label: 'API URL (OpenAI-compatible):', showIf: ['mode', ['Local Agent']],
      placeholder: 'http://localhost:11434/v1/chat/completions' },
    { key: 'model', label: 'Model (ไม่บังคับ):', placeholder: 'ว่าง = ใช้ค่าเริ่มต้นของ provider' },
    { key: 'prompt', label: 'Prompt:', type: 'textarea', raw: true,
      placeholder: 'พิมพ์คำสั่ง  ใช้ $ตัวแปร ได้' }
  ],
  URL: [
    { key: 'url', label: 'URL:', placeholder: 'https://example.com' }
  ],
  If: [
    { key: 'a', label: 'A:', raw: true, placeholder: '(ว่าง = ใช้ข้อมูลจากโหนดก่อนหน้า)' },
    { key: 'op', label: 'Option:', type: 'select', options: COMPARE_OPTIONS },
    { key: 'b', label: 'B:', raw: true }
  ],
  While: [
    { key: 'a', label: 'A:', raw: true, placeholder: '(ว่าง = ใช้ข้อมูลจากโหนดก่อนหน้า)' },
    { key: 'op', label: 'Option:', type: 'select', options: COMPARE_OPTIONS },
    { key: 'b', label: 'B:', raw: true }
  ],
  LoopFor: [
    { key: 'count', label: 'Loop Count:', placeholder: '3  หรือ  $times' }
  ],
  Var: [
    { key: 'varName', label: 'Variable Name:', placeholder: 'myvar' },
    { key: 'value', label: 'Initial Value:', raw: true },
    { key: 'vtype', label: 'Type:', type: 'select', options: VAR_TYPES }
  ],
  SetVar: [
    { key: 'varName', label: 'Variable Name:', placeholder: 'myvar' },
    { key: 'value', label: 'New Value:', raw: true, placeholder: '$input = ข้อมูลจากโหนดก่อนหน้า' }
  ],
  Math: [
    { key: 'a', label: 'A:' },
    { key: 'op', label: 'Operation:', type: 'select', options: MATH_OPTIONS },
    { key: 'b', label: 'B:' },
    { key: 'target', label: 'Store result in variable (ไม่บังคับ):', placeholder: 'myvar' }
  ],
  FeatureMatching: [
    { key: 'threshold', label: 'Accuracy (0 - 1):', placeholder: '0.8' }
  ]
};

const NODE_HINTS = {
  Function: 'Sync = รอให้สายงานที่ต่อจาก Function นี้จบก่อนค่อยไปต่อ<br>Async = ปล่อยสายงานไปทำเบื้องหลัง แล้วไปรันโหนดอื่นต่อทันที<br>(Function ชื่อเดียวกันยังรันพร้อมกันเหมือนเดิม / เปลี่ยนชื่อได้จากเมนูคลิกขวา)',
  MousePosition: 'ถ้าต่อ Position จาก FeatureMatching เข้าช่อง Position จะใช้ตำแหน่งนั้นแทน X/Y<br>(ยังไม่เจอภาพ = ข้ามการเลื่อนเมาส์)',
  Var: 'bool ใส่ได้เฉพาะ true / false  (แสดงผลเป็น true / false)',
  SetVar: 'ช่องค่าว่าง = ใช้ค่าที่ส่งมาจากโหนดก่อนหน้า เช่น X, Y, isFound ของ FeatureMatching',
  If: 'ใช้ $ชื่อตัวแปร ได้ / ถ้าไม่มีตัวแปรนั้นจะแสดงเป็นข้อความ $ชื่อ ตามเดิม<br>~ คือ ไม่เท่ากับ<br>ตรวจ boolean: เว้น B ว่างไว้ = ตรวจว่า A เป็น true (ต่อ isFound เข้า If แล้วเว้น A, B ว่างได้เลย)',
  While: 'ตรวจเงื่อนไขทุกรอบ แล้วทำซ้ำสิ่งที่ต่อที่ช่อง Loop / เว้น B ว่าง = ตรวจว่า A เป็น true',
  Math: 'ผลลัพธ์ส่งต่อให้โหนดถัดไปได้ และเก็บลงตัวแปรได้ถ้าใส่ชื่อ',
  FeatureMatching: 'ต่อภาพเข้า Source Img / Target Img จาก File หรือช่อง Image ของ Screenshot<br>แล้วสั่งงานที่ช่อง Activate<br>isFound = boolean / Position ต่อเข้า MousePosition / X, Y ส่งเข้า SetVar เพื่อเก็บลงตัวแปร',
  Agent: 'ผลตอบกลับของ Agent ส่งไปยังโหนดหมวด Message หรือ If ที่ต่ออยู่'
};

function fieldHtml(f, p, inRow) {
  const val = p[f.key] ?? '';
  const id = 'prop-' + f.key;
  const show = f.showIf
    ? ` data-show-key="${f.showIf[0]}" data-show-vals="${f.showIf[1].join('|')}"`
    : '';
  const style = inRow ? ' style="flex: 1;"' : '';
  const ph = escapeHtml(f.placeholder || '');
  let control;
  if (f.type === 'select') {
    control = `<select id="${id}" class="bevel-sunken search-input">${
      f.options.map(o => `<option value="${escapeHtml(o)}" ${String(val) === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')
    }</select>`;
  } else if (f.type === 'textarea') {
    control = `<textarea id="${id}" class="bevel-sunken search-input" placeholder="${ph}">${escapeHtml(val)}</textarea>`;
  } else {
    control = `<input type="${f.type === 'password' ? 'password' : 'text'}" id="${id}" class="bevel-sunken search-input" value="${escapeHtml(val)}" placeholder="${ph}" autocomplete="off">`;
  }
  return `<div class="dialog-row"${style}${show}><label style="font-weight: bold;">${escapeHtml(f.label)}</label>${control}</div>`;
}

function renderNodeFields(type, p) {
  const fields = NODE_FIELDS[type];
  let html = '';
  let i = 0;
  while (i < fields.length) {
    const f = fields[i];
    if (f.row) {
      const group = [];
      while (i < fields.length && fields[i].row === f.row) group.push(fields[i++]);
      html += `<div class="dialog-row-flex">${group.map(g => fieldHtml(g, p, true)).join('')}</div>`;
    } else {
      html += fieldHtml(f, p, false);
      i++;
    }
  }
  if (NODE_HINTS[type]) html += `<div class="dialog-hint">${NODE_HINTS[type]}</div>`;
  return html;
}

// ซ่อน/แสดงช่องที่ขึ้นกับค่าของช่องอื่น (เช่น Agent: Cloud vs Local)
function refreshFieldVisibility() {
  settingsBody.querySelectorAll('[data-show-key]').forEach(row => {
    const ctl = document.getElementById('prop-' + row.dataset.showKey);
    const vals = row.dataset.showVals.split('|');
    row.style.display = ctl && vals.includes(ctl.value) ? '' : 'none';
  });
}
settingsBody.addEventListener('change', refreshFieldVisibility);

function openSettingsModal(node) {
  activeSettingsNode = node;
  settingsTitle.textContent = `${node.name || node.type} PROPERTIES`;
  settingsBody.innerHTML = '';
  const p = node.params || {};

  switch (node.type) {
    case 'Alert':
    case 'Confirm':
      settingsBody.innerHTML = `
        <div class="dialog-row">
          <label style="font-weight: bold;">Message:</label>
          <textarea id="prop-popup-message" class="bevel-sunken search-input" placeholder="Type the message to show...">${escapeHtml(p.message || '')}</textarea>
        </div>
        <div class="dialog-hint">ถ้ามีข้อมูลส่งมาจากโหนดก่อนหน้า (เช่น Agent) จะแสดงข้อมูลนั้นแทน / ใช้ $ตัวแปร ได้</div>
      `;
      break;
    case 'Text':
      settingsBody.innerHTML = `
        <div class="dialog-row">
          <label style="font-weight: bold;">Text (รับจาก File หรือส่งให้ Agent):</label>
          <textarea id="prop-text-value" class="bevel-sunken search-input" style="height: 140px;" placeholder="Type or paste a long text...">${escapeHtml(p.text || '')}</textarea>
        </div>
      `;
      break;
    case 'File':
      settingsBody.innerHTML = `
        <div class="dialog-row">
          <label style="font-weight: bold;">Upload File (any type):</label>
          <input type="file" id="prop-file-input" class="bevel-sunken search-input" multiple>
        </div>
        <div class="dialog-row">
          <label style="font-weight: bold;">Selected:</label>
          <div id="prop-file-list" style="max-height: 110px; overflow: auto; font-family: 'Courier New', monospace; font-size: 11px;">
            ${renderFileList(p.files)}
          </div>
        </div>
      `;
      pendingFiles = Array.isArray(p.files) ? p.files.slice() : [];
      document.getElementById('prop-file-input').addEventListener('change', onFilePicked);
      break;
    default:
      if (NODE_FIELDS[node.type]) {
        settingsBody.innerHTML = renderNodeFields(node.type, p);
        refreshFieldVisibility();
      } else {
        settingsBody.innerHTML = `<div style="padding: 10px; color: #555;">No configurable properties for this node.</div>`;
      }
      break;
  }

  settingsModal.style.display = 'flex';
  playClickSound();
}

// ---- File node upload ----
let pendingFiles = [];
const MAX_TEXT_FILE_BYTES = 200 * 1024;
const MAX_IMAGE_FILE_BYTES = 6 * 1024 * 1024; // ภาพสำหรับ Feature Matching

function fileLimit(file) {
  return (file.type && file.type.startsWith('image/')) ? MAX_IMAGE_FILE_BYTES : MAX_TEXT_FILE_BYTES;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderFileList(files) {
  if (!Array.isArray(files) || !files.length) {
    return '<div style="color: #666;">(no file)</div>';
  }
  return files
    .map(f => `<div>${escapeHtml(f.name)} &mdash; ${formatFileSize(f.size)}</div>`)
    .join('');
}

function onFilePicked(e) {
  const picked = Array.from(e.target.files || []);
  const listEl = document.getElementById('prop-file-list');

  const finish = () => {
    if (listEl) listEl.innerHTML = renderFileList(pendingFiles);
  };

  // ไฟล์ข้อความขนาดเล็ก: อ่านเป็นข้อความจริง / ไฟล์ใหญ่หรือไบนารี: เก็บ metadata อย่างเดียว
  const readable = picked.filter(f => f.size <= fileLimit(f));
  let loaded = 0;

  readable.forEach(file => {
    const reader = new FileReader();
    const entry = { name: file.name, size: file.size, type: file.type };

    reader.onload = () => {
      if (isTextLikeFile(file)) {
        entry.content = String(reader.result || '');
      } else {
        entry.dataUrl = String(reader.result || '');
      }
      pendingFiles.push(entry);
      loaded++;
      if (loaded === readable.length) finish();
    };
    reader.onerror = () => {
      pendingFiles.push(entry);
      loaded++;
      if (loaded === readable.length) finish();
    };

    if (isTextLikeFile(file)) {
      reader.readAsText(file);
    } else {
      reader.readAsDataURL(file);
    }
  });

  picked.filter(f => f.size > fileLimit(f)).forEach(f => {
    pendingFiles.push({ name: f.name, size: f.size, type: f.type });
  });

  if (!readable.length) finish();
}

function isTextLikeFile(file) {
  const TEXT_EXT = /\.(txt|md|json|csv|tsv|log|ini|cfg|conf|ya?ml|toml|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|cpp|h|hpp|cs|php|sh|bat|ps1|sql)$/i;
  if (file.type && (file.type.startsWith('text/') || file.type === 'application/json')) return true;
  return TEXT_EXT.test(file.name);
}

function closeSettingsModal() {
  settingsModal.style.display = 'none';
  activeSettingsNode = null;
}

function saveNodeSettings() {
  if (!activeSettingsNode) return;
  if (!activeSettingsNode.params) activeSettingsNode.params = {};

  switch (activeSettingsNode.type) {
    case 'Alert':
    case 'Confirm':
      activeSettingsNode.params.message = document.getElementById('prop-popup-message').value;
      break;
    case 'Text':
      activeSettingsNode.params.text = document.getElementById('prop-text-value').value;
      break;
    case 'File':
      activeSettingsNode.params.files = pendingFiles;
      pendingFiles = [];
      break;
    default: {
      const fields = NODE_FIELDS[activeSettingsNode.type] || [];
      fields.forEach(f => {
        const el = document.getElementById('prop-' + f.key);
        if (!el) return;
        activeSettingsNode.params[f.key] = f.raw ? el.value : el.value.trim();
      });
    }
  }

  playClickSound();
  closeSettingsModal();
  markDirty();
  draw();
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const tab = document.getElementById('sidebar-toggle-tab');
  sidebar.classList.toggle('hidden');
  const isHidden = sidebar.classList.contains('hidden');
  tab.style.display = isHidden ? 'block' : 'none';

  if (isHidden) {
    playSound(audioDrag);
  } else {
    playSound(audioClick);
  }
}

function handleSearch() {
  const val = document.getElementById('search-box').value.toLowerCase().trim();
  const items = document.querySelectorAll('#palette-list .palette-item');
  items.forEach(item => {
    const name = item.querySelector('.palette-item-text').textContent.toLowerCase();
    item.style.display = name.includes(val) ? 'flex' : 'none';
  });
  // ตอนค้นหาไม่ต้องแสดงเส้นแยกหมวดหมู่
  document.querySelectorAll('#palette-list .palette-divider').forEach(div => {
    div.style.display = val ? 'none' : 'flex';
  });
}

// ============================================================
// Flow Save / Load (SQLite ฝั่ง server ผ่าน REST API)
// ============================================================
let currentFlowId = null;
let currentFlowName = null;
let isFlowDirty = false;
const saveBtn = document.getElementById('save-btn');
const folderDialog = document.getElementById('folder-dialog-overlay');
const saveAsDialog = document.getElementById('saveas-dialog-overlay');
const flowGrid = document.getElementById('flow-grid');

function markDirty() {
  isFlowDirty = true;
  updateSaveButton();
}

function updateSaveButton() {
  // ปุ่ม save แสดงเฉพาะตอนที่ flow ถูกแก้ไข
  if (saveBtn) saveBtn.style.display = isFlowDirty ? 'flex' : 'none';
}

function sanitizeFileName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

async function apiRequest(url, options) {
  const res = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {}));
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    const err = new Error((data && (data.detail || data.error)) || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

function notify(message) {
  let el = document.getElementById('flow-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'flow-toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.style.display = 'block';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.display = 'none'; }, 2600);
}

function saveCurrentFlow() {
  if (currentFlowId) {
    return doSave(currentFlowId, currentFlowName);
  }
  openSaveAsDialog();
  return Promise.resolve();
}

function openSaveAsDialog() {
  const input = document.getElementById('saveas-name');
  input.value = currentFlowName || suggestFlowName();
  saveAsDialog.style.display = 'flex';
  setTimeout(() => { input.focus(); input.select(); }, 50);
}

function closeSaveAsDialog() {
  saveAsDialog.style.display = 'none';
}

function suggestFlowName() {
  const start = nodes.find(n => n.type === 'Start');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return start && start.name ? `${start.name} ${stamp}` : `flow-${stamp}`;
}

async function confirmSaveFlow() {
  const input = document.getElementById('saveas-name');
  const name = sanitizeFileName(input.value);
  if (!name) {
    notify('ต้องใส่ชื่อไฟล์');
    return;
  }
  closeSaveAsDialog();
  await doSave(null, name);
}

async function doSave(flowId, name) {
  try {
    const body = JSON.stringify({ id: flowId || null, name: name, graph: buildGraphPayload() });
    const data = await apiRequest('/api/flows', { method: 'POST', body: body });
    currentFlowId = data.id;
    currentFlowName = data.name;
    isFlowDirty = false;
    updateSaveButton();
    updateFolderHint();
    notify('บันทึกไฟล์ "' + data.name + '" แล้ว');
  } catch (err) {
    if (err.status === 409) {
      if (confirm('มีไฟล์ชื่อ "' + name + '" อยู่แล้ว ต้องการเขียนทับหรือไม่?')) {
        const body = JSON.stringify({ id: currentFlowId || null, name: name, graph: buildGraphPayload(), overwrite: true });
        const data = await apiRequest('/api/flows', { method: 'POST', body: body });
        currentFlowId = data.id;
        currentFlowName = data.name;
        isFlowDirty = false;
        updateSaveButton();
        updateFolderHint();
        notify('เขียนทับไฟล์ "' + data.name + '" แล้ว');
      }
      return;
    }
    notify('บันทึกไม่สำเร็จ: ' + err.message);
  }
}

function updateFolderHint() {
  const hint = document.getElementById('folder-current');
  if (hint) hint.textContent = currentFlowId ? 'เปิดอยู่: ' + currentFlowName : 'ยังไม่ได้เปิดไฟล์';
}

async function openFolderPopup() {
  folderDialog.style.display = 'flex';
  playClickSound();
  updateFolderHint();
  await refreshFlowGrid();
}

function closeFolderPopup() {
  folderDialog.style.display = 'none';
}

async function refreshFlowGrid() {
  try {
    const data = await apiRequest('/api/flows');
    renderFlowGrid((data && data.flows) || []);
  } catch (err) {
    flowGrid.innerHTML = '<div class="flow-empty">โหลดรายการไฟล์ไม่สำเร็จ: ' + escapeHtml(err.message) + '</div>';
  }
}

function renderFlowGrid(list) {
  if (!list.length) {
    flowGrid.innerHTML = '<div class="flow-empty">ยังไม่มีไฟล์ที่บันทึกไว้</div>';
    return;
  }
  flowGrid.innerHTML = list.map(item => {
    const active = item.id === currentFlowId ? ' active' : '';
    const meta = `${item.node_count || 0} nodes · ${formatDateTime(item.updated_at)}`;
    return '<div class="flow-card' + active + '" onclick="loadFlow(' + item.id + ')">' +
      '<div class="flow-card-del" title="Delete" onclick="event.stopPropagation(); deleteFlow(' + item.id + ')">✕</div>' +
      '<img src="file.svg" alt="">' +
      '<div class="flow-card-name" title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</div>' +
      '<div class="flow-card-meta">' + meta + '</div>' +
      '</div>';
  }).join('');
}

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function loadFlow(id) {
  if (isFlowDirty && !confirm('ยังไม่ได้บันทึกการแก้ไข ต้องการเปิดไฟล์อื่นหรือไม่?')) return;
  try {
    const data = await apiRequest('/api/flows/' + id);
    const flow = (data && data.flow) || data;
    applyGraph(flow.graph || {});
    currentFlowId = flow.id;
    currentFlowName = flow.name;
    isFlowDirty = false;
    updateSaveButton();
    updateFolderHint();
    closeFolderPopup();
    notify('เปิดไฟล์ "' + flow.name + '" แล้ว');
  } catch (err) {
    notify('เปิดไฟล์ไม่สำเร็จ: ' + err.message);
  }
}

function applyGraph(graph) {
  nodes = [];
  connections = [];
  nextNodeId = 1;

  (graph.nodes || []).forEach(n => {
    const type = n.type || 'Function';
    const node = {
      id: typeof n.id === 'number' ? n.id : nextNodeId,
      type: type,
      name: n.name || type,
      x: typeof n.x === 'number' ? n.x : 0,
      y: typeof n.y === 'number' ? n.y : 0,
      radius: 36,
      ports: defaultPortsForType(type),
      params: Object.assign(getDefaultParams(type), n.params || {})
    };
    if (isRectType(type)) initRectNode(node);
    nextNodeId = Math.max(nextNodeId, node.id + 1);
    nodes.push(node);
  });

  (graph.connections || []).forEach(c => {
    const from = nodes.find(n => n.id === c.fromNodeId);
    const to = nodes.find(n => n.id === c.toNodeId);
    if (!from || !to) return;
    let fromPort = c.fromPort || 'out';
    const toPort = c.toPort || 'in';
    if (from.type === 'Screenshot' && fromPort === 'exec_out' && (toPort === 'img_src' || toPort === 'img_tgt')) {
      fromPort = 'out_image'; // flow เก่า: สายภาพเคยออกจากช่อง exec_out
    }
    connections.push({
      id: `edge_${from.id}_${fromPort}_${to.id}_${toPort}`,
      fromNodeId: from.id,
      fromPort: fromPort,
      toNodeId: to.id,
      toPort: toPort
    });
  });

  if (graph.camera) {
    camera.x = graph.camera.x || 0;
    camera.y = graph.camera.y || 0;
    camera.zoom = graph.camera.zoom || 1;
  }

  activeSettingsNode = null;
  contextTargetNode = null;
  hideContextMenu();
  updateLockStates();
  nodes.forEach(n => refreshDebugNode(n));
  draw();
}

async function deleteFlow(id) {
  try {
    const data = await apiRequest('/api/flows/' + id, { method: 'DELETE' });
    if (id === currentFlowId) {
      currentFlowId = null;
      currentFlowName = null;
      isFlowDirty = true;
      updateSaveButton();
      updateFolderHint();
    }
    notify('ลบไฟล์ "' + (data && data.name ? data.name : '') + '" แล้ว');
    await refreshFlowGrid();
  } catch (err) {
    notify('ลบไฟล์ไม่สำเร็จ: ' + err.message);
  }
}

function newFlowFromScratch() {
  if (isFlowDirty && !confirm('ยังไม่ได้บันทึกการแก้ไข ต้องการสร้าง flow ใหม่หรือไม่?')) return;
  currentFlowId = null;
  currentFlowName = null;
  applyGraph({ nodes: [], connections: [] });
  spawnNode('Start', true);
  isFlowDirty = true;
  updateSaveButton();
  updateFolderHint();
  closeFolderPopup();
  notify('สร้าง flow ใหม่แล้ว');
}

document.getElementById('saveas-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') confirmSaveFlow();
  if (e.key === 'Escape') closeSaveAsDialog();
});

folderDialog.addEventListener('click', (e) => {
  if (e.target === folderDialog) closeFolderPopup();
});

saveAsDialog.addEventListener('click', (e) => {
  if (e.target === saveAsDialog) closeSaveAsDialog();
});

window.addEventListener('beforeunload', (e) => {
  if (!isFlowDirty) return;
  e.preventDefault();
  e.returnValue = '';
});

// Initialize Canvas, Default Start Node & Backend Connection
resizeCanvas();
spawnNode('Start', true);
updateSaveButton();
updateFolderHint();
connectBackend();