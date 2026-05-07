// server.js - Node.js + Socket.io Multiplayer Survival Game Server

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

const LOBBY_SIZE = 6;
const BIOMES = [
  { name: 'forest', start: 0, end: 974 },
  { name: 'desert', start: 975, end: 1521 },
  { name: 'tundra', start: 1522, end: 1908 }
];

// --- STATE ---
const lobbies = {}; // lobbyId -> { name, players, settings, state, world, ... }
const players = {}; // socket.id -> { lobbyId, playerId, ... }
const roles = ['Sharpshooter', 'Engineer', 'Prospector', 'Medic', 'Trapper', 'Soldier', 'Blacksmith'];

// --- UTILITIES ---
function pickRandom(arr, exclude = []) {
  let filtered = arr.filter(x => !exclude.includes(x));
  return filtered[Math.floor(Math.random() * filtered.length)];
}

// --- SOCKET.IO EVENTS ---
io.on('connection', (socket) => {
  // --- Lobby Handling ---
  socket.on('createLobby', ({ name, isPrivate, password, traitorMode }, cb) => {
    const lobbyId = uuidv4().slice(0, 6);
    lobbies[lobbyId] = {
      name: name || `Train #${lobbyId}`,
      isPrivate: !!isPrivate,
      password: isPrivate ? password : null,
      traitorMode: !!traitorMode,
      players: [],
      state: 'WAITING',
      hasSpawnedItems: false,
      train: createTrainState(),
      world: [],
      biome: 0,
      distance: 0,
      marshalsCooldown: 3,
      traitor: null,
      timers: {},
    };
    cb({ lobbyId });
    updateLobbyList();
  });

  socket.on('joinLobby', ({ lobbyId, playerName, password }, cb) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) return cb({ error: "Not found." });
    if (lobby.isPrivate && lobby.password !== password) return cb({ error: 'Wrong password' });
    if (lobby.players.length >= LOBBY_SIZE) return cb({ error: "Full lobby" });

    const playerId = uuidv4();
    const role = pickRandom(roles, lobby.players.map(p => p.role));
    let isTraitor = false;
    if (lobby.traitorMode && lobby.players.length === LOBBY_SIZE - 1) {
      isTraitor = true;
      lobby.traitor = playerId;
    }
    const playerData = {
      playerId,
      name: playerName,
      role,
      isTraitor,
      seat: lobby.players.length,
      inventory: { gold: 0, silver: 0, coal: 0, watches: 0, meat: 0 },
      alive: true,
      x: 0, y: 0, onTrain: true,
      kills: 0, sips: 0, coalMined: 0
    };
    lobby.players.push(playerData);
    players[socket.id] = { lobbyId, playerId };
    socket.join(lobbyId);

    cb({ success: true, lobby, playerId, role, isTraitor });
    io.to(lobbyId).emit('playerList', lobby.players);
  });

  // --- Lobby Controls ---
  socket.on('startGame', () => {
    const { lobbyId } = players[socket.id] || {};
    const lobby = lobbies[lobbyId];
    if (!lobby || lobby.state !== 'WAITING') return;
    assignTraitor(lobby);
    lobby.state = 'STOPPED';
    lobby.hasSpawnedItems = false;
    io.to(lobbyId).emit('gameStart', { players: lobby.players });
    emitRoleReveal(lobby);
    setTimeout(() => gameTick(lobbyId), 100); // Kick off game loop
  });

  socket.on('action', (data) => handlePlayerAction(socket, data));
  socket.on('disconnect', () => handleDisconnect(socket));

  // --- Lobby List Update ---
  socket.on('requestLobbies', () => updateLobbyList(socket));
});

function updateLobbyList(targetSocket = null) {
  let simple = Object.entries(lobbies).map(([id, l]) => ({
    id, name: l.name, count: l.players.length, isPrivate: l.isPrivate
  }));
  if (targetSocket) targetSocket.emit('lobbyList', simple);
  else io.emit('lobbyList', simple);
}

// --- Game Mechanics ---
function createTrainState() {
  // 1 Engine, 1 Coal, 2 Passenger, 1 Kitchen, 1 Gambling, 1 Caboose, Storage*0
  return {
    cars: [
      { type: 'engine' }, { type: 'coal' },
      { type: 'passenger' }, { type: 'passenger' },
      { type: 'kitchen' }, { type: 'gambling' }, { type: 'caboose' }
    ],
    fuel: 1003, // max
    steam: 0,
    speed: 0,
    storage: [] // { carIdx, ores: {...} }
  };
}

function assignTraitor(lobby) {
  if (!lobby.traitorMode) return;
  let nonTraitors = lobby.players.filter(p => !p.isTraitor);
  let selected = pickRandom(nonTraitors);
  selected.isTraitor = true;
  lobby.traitor = selected.playerId;
}

function emitRoleReveal(lobby) {
  lobby.players.forEach(p => {
    io.to(getSocketId(lobby, p.playerId)).emit('roleReveal', {
      role: p.role, isTraitor: p.isTraitor
    });
  });
}

function getSocketId(lobby, playerId) {
  return Object.entries(players).find(([, p]) => p.lobbyId === lobby && p.playerId === playerId)?.[0];
}

// --- Game Loop ---
function gameTick(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;

  // Handle STOPPED state
  if (lobby.state === 'STOPPED' && !lobby.hasSpawnedItems) {
    spawnWorldItems(lobby);
    lobby.hasSpawnedItems = true;
    // Begin countdown for departure after N seconds
    lobby.timers.departure = setTimeout(() => {
      teleportLaggers(lobby);
      lobby.state = 'DEPARTING';
      lobby.train.speed = 4;
      lobby.hasSpawnedItems = false; // Reset when train moves
      tickTrain(lobbyId);
    }, 8000);
  }
}

function spawnWorldItems(lobby) {
  // Spawn ores, trees, wildlife based on biome
  lobby.world = [];
  let biome = getBiome(lobby.distance);
  // For brevity, simulate some spawn points
  for (let i = 0; i < 6; ++i)
    lobby.world.push({
      type: pickRandom(['ore', 'tree', 'building', 'enemy']),
      x: Math.random() * 1400 - 700,
      y: Math.random() * 400 - 200
    });
  io.to(lobby.name).emit('worldUpdate', lobby.world);
}

function getBiome(distance) {
  return BIOMES.find(b => distance >= b.start && distance <= b.end) || BIOMES[0];
}

function teleportLaggers(lobby) {
  lobby.players.forEach(p => {
    if (!p.onTrain) {
      p.x = 0; p.y = getCabooseY();
      p.onTrain = true;
      io.to(getSocketId(lobby, p.playerId)).emit('teleport', {
        x: p.x, y: p.y, message: "You were left behind! Returned to caboose."
      });
    }
  });
}

function getCabooseY() { return 0; }

// --- Train Movement & Physics ---
function tickTrain(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;

  if (lobby.state === 'DEPARTING') {
    // Train moves, world scrolls left (-dx)
    lobby.train.speed = Math.min(lobby.train.speed + 0.15, 7);

    // Physics: Decrement all world X by dx
    let dx = lobby.train.speed;
    lobby.world.forEach(o => { o.x -= dx; });

    // Teleport/trap players that try to leave train
    lobby.players.forEach(p => {
      if (p.onTrain && p.x < -getTrainBoundary()) {
        p.x = -getTrainBoundary();
      } else if (!p.onTrain && p.x > getTrainBoundary()) {
        p.onTrain = true; // snap them in case of unrealistic client desync
      }
    });

    // Fuel, Steam, Biome logic
    lobby.train.fuel -= 17 * 0.1;
    if (lobby.train.fuel <= 0) {
      lobby.train.fuel = 0;
      lobby.state = 'STOPPED';
      lobby.train.speed = 0;
      return setTimeout(() => gameTick(lobbyId), 300);
    }

    lobby.distance += lobby.train.speed * 0.25;
    if (lobby.distance >= 1908) {
      // Victory screen
      io.to(lobbyId).emit('victory', summary(lobby));
      return;
    }

    // Special events (Tunnel, Bridge Out, Marshals)
    maybeTriggerEvent(lobby);

    io.to(lobbyId).emit('sync', {
      train: lobby.train,
      distance: lobby.distance,
      world: lobby.world,
      players: lobby.players.map(({ playerId, x, y, alive }) => ({ playerId, x, y, alive }))
    });

    setTimeout(() => tickTrain(lobbyId), 80);
  }
}

function getTrainBoundary() { return 210; /* px, half train car width */ }

function maybeTriggerEvent(lobby) {
  // Tunnels, Marshals, Bridge Out (logic skeleton)
}

function summary(lobby) {
  // Return HoF stats for victory screen.
  let mostKills = pickRandom(lobby.players);
  let mostSips = pickRandom(lobby.players);
  return {
    winners: lobby.players.map(p => ({ name: p.name, role: p.role })),
    leadSlinger: mostKills.name,
    drunkard: mostSips.name,
    snake: lobby.players.find(p => p.isTraitor)?.name
  }
}

// --- Actions (Movement, Inventory, Combat) ---
function handlePlayerAction(socket, data) {
  const { lobbyId, playerId } = players[socket.id] || {};
  const lobby = lobbies[lobbyId];
  if (!lobby) return;

  // Example: { type: 'move', x, y, ... }
  if (data.type === 'move') {
    let player = lobby.players.find(p => p.playerId === playerId && p.alive);
    if (!player) return;
    player.x = data.x;
    player.y = data.y;
    player.onTrain = Math.abs(data.x) < getTrainBoundary();
  }

  // Other action types: interact, attack, inventory, etc.
}

function handleDisconnect(socket) {
  const { lobbyId, playerId } = players[socket.id] || {};
  if (!lobbyId) return;
  let lobby = lobbies[lobbyId];
  if (!lobby) return;

  lobby.players = lobby.players.filter(p => p.playerId !== playerId);
  delete players[socket.id];
  io.to(lobbyId).emit('playerList', lobby.players);

  if (!lobby.players.length) delete lobbies[lobbyId];
}

// --- START SERVER ---
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
