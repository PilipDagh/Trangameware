// main.js — SPA client for Steam & Sabotage: 1870s Train Survival Game

const socket = io();

let myPlayerId = null, myRole = null, isTraitor = false;
let myLobbyId = null, myName = '';
let lobby = null, players = [], world = [], train = {}, distance = 0;
let gameState = 'LOBBY'; // LOBBY, ROLE, GAME, VICTORY

// --- DOM ---
const el = s => document.querySelector(s);
const $ = s => document.getElementById(s.replace('#',''));
const canvas = $('game-canvas'), ctx = canvas.getContext('2d');

// --- UI SETUP / SPA LOGIC ---
function showOverlay(id) {
  for (const v of document.querySelectorAll('.overlay')) v.classList.remove('visible');
  if ($(id)) $(id).classList.add('visible');
}
function hideOverlay(id) { if ($(id)) $(id).classList.remove('visible'); }

// Lobby/crud
$('create-lobby').onclick = () => {
  let name = $('name-input').value || 'Cowpoke';
  let priv = $('private-toggle').checked;
  let pass = priv ? $('lobby-password').value : null;
  let traitor = $('traitor-toggle').checked;
  socket.emit('createLobby', { name, isPrivate: priv, password: pass, traitorMode: traitor }, res => {
    if (!res.error) joinLobby(res.lobbyId, name, pass);
  });
};
$('join-lobby').onclick = () => {
  let code = $('lobby-code').value.trim();
  let name = $('name-input').value || 'Cowpoke';
  let pass = $('lobby-password').style.display==='block' ? $('lobby-password').value : null;
  if (code) joinLobby(code, name, pass);
};
$('refresh-lobbies').onclick = () => socket.emit('requestLobbies');

$('private-toggle').onchange = e => { $('lobby-password').style.display = e.target.checked ? 'inline' : 'none'; };

// Lobby list UI auto
socket.on('lobbyList', lobbies => {
  let cont = $('lobby-list');
  cont.innerHTML = '';
  for (let l of lobbies) {
    let li = document.createElement('li');
    li.innerHTML = `${l.name} <span>(${l.count}/6)</span> ${l.isPrivate ? '🔒' : ''}`;
    li.onclick = () => {
      let name = $('name-input').value || 'Cowpoke';
      joinLobby(l.id, name, null);
    };
    cont.appendChild(li);
  }
});

// --- In-lobby view ---
function joinLobby(lobbyId, playerName, password) {
  socket.emit('joinLobby', { lobbyId, playerName, password }, res => {
    if (res.error) return alert(res.error);
    myLobbyId = lobbyId;
    myPlayerId = res.playerId;
    myRole = res.role;
    isTraitor = res.isTraitor;
    hideOverlay('lobby-view');
    $('in-lobby').style.display = '';
    $('current-lobby-title').innerText = 'In Lobby: ' + (res.lobby?.name || '');
    $('start-game').style.display = 'block';
    gameState = 'LOBBY';
  });
}
$('start-game').onclick = () => socket.emit('startGame');

$('leave-lobby').onclick = () => {
  location.reload();
};

// In-lobby playerlist update
socket.on('playerList', list => {
  players = list;
  let ul = $('player-list');
  ul.innerHTML = '';
  for (let p of list) {
    let li = document.createElement('li');
    li.innerText = p.name + (p.isTraitor ? " (??)" : "") + (p.role ? " - " + p.role : "");
    ul.appendChild(li);
  }
});

// --- Role Reveal, start game ---
socket.on('roleReveal', ({ role, isTraitor: traitor }) => {
  myRole = role;
  isTraitor = traitor;
  hideOverlay('lobby-view');
  showOverlay('role-reveal');
  gameState = 'ROLE';
  $('role-reveal-inner').innerHTML = `
    <h2>${traitor ? "YOU ARE THE TRAITOR" : "YOU ARE THE " + role.toUpperCase()}</h2>
    <p>${traitor ?
      "Sabotage the crew. Your actions will not alert the AI Marshals or wildlife!" :
      getRoleFlavor(role)
    }</p>
  `;
  // Hide reveal after 2.8s and start game view
  setTimeout(() => {
    hideOverlay('role-reveal');
    startGameView();
  }, 2800);
});
function getRoleFlavor(role) {
  return {
    Sharpshooter: "Deal more damage with guns.",
    Engineer: "Train uses less fuel.",
    Prospector: "Mine ores faster.",
    Medic: "Heal more from items.",
    Trapper: "Sell animal skins for more $.",
    Soldier: "Carry extra ammo.",
    Blacksmith: "Start with a knife.",
  }[role] || "";
}

// --- Game Sync and Drawing ---
socket.on('sync', (data) => {
  train = data.train;
  distance = data.distance || 0;
  world = data.world || [];
  // Map by id for position update:
  const playerMap = {};
  (data.players || []).forEach(p => playerMap[p.playerId] = p);
  players = players.map(p => ({ ...p, ...(playerMap[p.playerId] || {}) }));
});

// World Update
socket.on('worldUpdate', state => {
  world = state;
});
socket.on('teleport', ({x, y, message}) => {
  // Optional: animate teleport effect, show temp banner
});

// Victory screen
socket.on('victory', (result) => {
  showVictory(result);
});
function showVictory(result) {
  gameState = 'VICTORY';
  $('victory-content').innerHTML = `
    <b>Lead-Slinger:</b> ${result.leadSlinger} <br>
    <b>Drunkard:</b> ${result.drunkard} <br>
    <b>Workhorse:</b> ?? <br>
    <b>The Snake:</b> ${result.snake || '--'}
    <hr>
    Survivors: ${result.winners.map(w=>w.name+" ("+w.role+")").join(', ')}
  `;
  $('victory-modal').style.display = 'block';
}
$('close-victory').onclick = () => location.reload();

// --- Game View Switch ---
function startGameView() {
  showGameUI();
  gameState = 'GAME';
  requestAnimationFrame(gameFrame);
}
function showGameUI() {
  $('game-container').style.display = '';
  $('actions').style.display = '';
  $('mobile-controls').style.display = mobileMode ? '' : 'none';
}

// --- Game Drawing Loop ---
let lastFrame = Date.now();
function gameFrame() {
  if (gameState !== 'GAME') return;
  // Clear
  ctx.clearRect(0,0,canvas.width,canvas.height);

  // Scrolling world logic: train stays at (0,0). All else moves left by dx = train.speed.
  // Draw train (centered)
  drawTrain();

  // World objects
  for (let w of world) drawWorldObj(w);

  // Players
  for (let p of players) if (p.alive) drawPlayer(p);

  // UI overlays (biome/distance/bar)
  drawHUD();

  // Next frame
  requestAnimationFrame(gameFrame);
}

// --- Drawing Primitives ---
function drawTrain() {
  const baseY = canvas.height/2 + 0;
  // Each car is 124px long, train centered
  let cars = train?.cars || [{type:'engine'}];
  let totalLen = cars.length * 124;
  let startX = canvas.width/2 - totalLen/2;
  for (let i=0; i<cars.length; ++i) {
    let x = startX + 124 * i, y = baseY;
    ctx.save();
    drawTrainCar(x, y, cars[i].type);
    ctx.restore();
  }
}
function drawTrainCar(x, y, type) {
  // All with primitive style, colored by type
  const palette = {
    engine:   "#55413f",
    coal:     "#30312f",
    passenger:"#718c7b",
    kitchen:  "#ebd6a4",
    gambling: "#854e4b",
    caboose:  "#9b403f",
    storage:  "#c8b573"
  };
  // Car body
  ctx.fillStyle = palette[type] || "#888";
  ctx.strokeStyle = "#241812";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.rect(x, y-37, 112, 67);
  ctx.fill();
  ctx.stroke();
  // Roof
  ctx.fillStyle = "#282219";
  ctx.fillRect(x, y-42, 112, 15);
  // Wheels
  ctx.fillStyle = "#222";
  ctx.beginPath();
  ctx.arc(x+22, y+31, 10, 0, Math.PI*2);
  ctx.arc(x+112-18, y+31, 10, 0, Math.PI*2);
  ctx.fill();
  // Car type label
  ctx.fillStyle = "#fff";
  ctx.font = "bold 17px Segoe UI";
  ctx.fillText(type.toUpperCase(), x+13, y-11);
}

function drawWorldObj(obj) {
  // All positions relative to the "train at center"
  const baseY = canvas.height/2;
  let x = canvas.width/2 + obj.x;
  let y = baseY + (obj.y || 0);
  ctx.save();
  if (obj.type === 'tree') {
    // Trunk
    ctx.fillStyle = "#6e472c";
    ctx.fillRect(x-6, y+12, 12, 44);
    // Foliage
    ctx.beginPath();
    ctx.arc(x, y, 22, 0, Math.PI*2);
    ctx.fillStyle = "#56b954";
    ctx.fill();
  } else if (obj.type === 'ore') {
    ctx.beginPath();
    ctx.moveTo(x-18, y+24);
    ctx.lineTo(x, y-12);
    ctx.lineTo(x+16, y+20);
    ctx.closePath();
    ctx.fillStyle = "#b5b5b5";
    ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle="#999";
    ctx.stroke();
  } else if (obj.type === 'building') {
    ctx.fillStyle="#896a4f";
    ctx.fillRect(x-20, y-28, 40, 54); // body
    ctx.fillStyle="#413921";
    ctx.fillRect(x-16, y-28, 32, 7);
    ctx.strokeStyle="#58412a";
    ctx.strokeRect(x-20, y-28, 40, 54);
  } else if (obj.type === 'enemy') {
    ctx.beginPath();
    ctx.arc(x, y, 22, 0, Math.PI*2);
    ctx.fillStyle = "#a33";
    ctx.fill();
    // Eyes for drama
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(x-8, y-6, 3, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(x+8, y-6, 3, 0, Math.PI*2); ctx.fill();
  }
  ctx.restore();
}

function drawPlayer(p) {
  // Draw as colored circles on top of train, with name
  const centerY = canvas.height/2 - 27;
  let px = canvas.width/2 + (p.x || 0), py = centerY + (p.y || 0);
  ctx.save();
  ctx.beginPath();
  ctx.arc(px, py, 18, 0, Math.PI*2);
  ctx.fillStyle = p.playerId === myPlayerId ? "#fc3" :
    (p.isTraitor ? "#a3cf" : "#37cfc8");
  ctx.strokeStyle = "#1c1813"; ctx.lineWidth = 4;
  ctx.fill(); ctx.stroke();
  // Gun for Sharpshooter: bar on top
  if (p.role === 'Sharpshooter') {
    ctx.beginPath();
    ctx.moveTo(px-14, py-13); ctx.lineTo(px+14, py-13);
    ctx.strokeStyle='#c7c7c7'; ctx.lineWidth=5;
    ctx.stroke();
  }
  // Name
  ctx.fillStyle = "#252";
  ctx.font = "bold 15px Segoe UI";
  ctx.fillText(p.name, px-21, py-22);
  ctx.restore();
}

function drawHUD() {
  // Distance/biome bar, fuel/steam
  ctx.save();
  ctx.fillStyle = "#000c";
  ctx.fillRect(9,9,220,62);
  ctx.font = "bold 16px Arial";
  ctx.fillStyle = "#edd";
  let biome = getBiomeName(distance);
  ctx.fillText(`BIOME: ${biome}`, 21, 33);
  ctx.fillText(`DIST: ${Math.round(distance)} km`, 21, 55);
  // Fuel
  ctx.fillStyle = "#444";
  ctx.fillRect(139,19,73,13);
  ctx.fillStyle = "#e89";
  ctx.fillRect(139,19, Math.min(73, train.fuel/1003*73), 13);
  ctx.strokeStyle = "#fff";
  ctx.strokeRect(139,19,73,13);
  ctx.fillStyle = "#e7e";
  ctx.fillRect(139,36,Math.min(73, train.steam/100*73),11);
  ctx.strokeRect(139,36,73,11);
  ctx.fillStyle="#ecb";
  ctx.fillText("Fuel", 140, 16); ctx.fillText("Steam", 140, 51);
  ctx.restore();
}
function getBiomeName(dist) {
  if (dist < 975) return "FOREST";
  if (dist < 1522) return "DESERT";
  if (dist < 1909) return "TUNDRA";
  return "UNKNOWN";
}

// --- Inputs: Keyboard and Mobile Mode ---
let keys = {}, mobileMode = false;
window.onkeydown = e => { keys[e.key.toLowerCase()] = true; };
window.onkeyup = e => { keys[e.key.toLowerCase()] = false; };

// Simple PC input loop: WASD to move, F=fire, R=reload etc.
setInterval(() => {
  if (gameState!=='GAME' || !myPlayerId) return;
  let dx=0, dy=0;
  if (keys['w']||keys['arrowup']) dy -= 1;
  if (keys['s']||keys['arrowdown']) dy += 1;
  if (keys['a']||keys['arrowleft']) dx -= 1;
  if (keys['d']||keys['arrowright']) dx += 1;
  if (dx||dy) socket.emit('action', { type:'move', x:dx*8, y:dy*8}); // You’d want to track & clamp to train edge.
  if (keys['f']) { socket.emit('action',{type:'fire'}); keys['f']=false;}
  if (keys['r']) { socket.emit('action',{type:'reload'}); keys['r']=false;}
  // Map more as needed (inventory, mine, eat, valve, etc.)
}, 60);

// --- Mobile Mode ---
$('mobile-toggle').onclick = () => {
  mobileMode = !mobileMode;
  $('mobile-toggle').innerText = 'Mobile Mode: ' + (mobileMode ? 'ON':'OFF');
  $('mobile-controls').style.display = mobileMode? '':'none';
};
// Dummy joysticks and touch events (expand to support movement and aim in your full version)
if ('ontouchstart' in window) {
  let lj = $('left-joystick'), rj = $('right-joystick');
  let joy = { lx:0, ly:0, rx:0, ry:0 }, startL = null, startR=null;
  lj && lj.addEventListener('touchstart', e => { startL = getTouchLoc(e); }, false);
  rj && rj.addEventListener('touchstart', e => { startR = getTouchLoc(e); }, false);
  lj && lj.addEventListener('touchmove', e => {
    if (!startL) return;
    let now = getTouchLoc(e);
    joy.lx = (now.x - startL.x)/40, joy.ly = (now.y - startL.y)/40;
    socket.emit('action', { type:'move', x:joy.lx*8, y:joy.ly*8 });
  }, false);
  lj && lj.addEventListener('touchend', e => { joy.lx=joy.ly=0; startL=null; }, false);
  // Right joystick for aiming — pending full combat control implementation
}
function getTouchLoc(e) { let t=e.touches[0]; return {x:t.clientX, y:t.clientY}; }

// --- Action Buttons ("dynamic" text, ready for logic hookup) ---
$('fire-btn').onclick = ()=> socket.emit('action', {type:'fire'});
$('interact-btn').onclick = ()=> socket.emit('action', {type:'interact'});
$('reload-btn').onclick = ()=> socket.emit('action', {type:'reload'});
$('mine-btn').onclick = ()=> socket.emit('action', {type:'mine'});
$('steam-btn').onclick = ()=> socket.emit('action', {type:'valve'});
$('eat-btn').onclick = ()=> socket.emit('action', {type:'eat'});
$('bomb-btn').onclick = ()=> socket.emit('action', {type:'bomb'});
$('barrel-btn').onclick = ()=> socket.emit('action', {type:'barrel'});
$('light-btn').onclick = ()=> socket.emit('action', {type:'light'});

// Inventory and Gambling can be opened from train context UI (to be hooked up as triggered)
$('close-inv') && ($('close-inv').onclick = ()=> {$('inventory-modal').style.display='none';});
$('close-gamble') && ($('close-gamble').onclick = ()=> {$('gamble-modal').style.display='none';});

// --- SPA startup ---
showOverlay('lobby-view');
socket.emit('requestLobbies');
$('actions').style.display = 'none';
$('game-container').style.display = 'none';

// Ready!
