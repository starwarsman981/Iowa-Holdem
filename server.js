const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

function createDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  let deck = [];
  for (let s of suits) {
    for (let r of ranks) {
      deck.push({ rank: r, suit: s });
    }
  }
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length -1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

const PHASES = ['pre-flop', 'flop', 'turn', 'river', 'showdown'];

const rooms = {}; // roomId: { players, deck, community, pot, phase, turnIndex, currentBet, foldedPlayers, bets, discards }

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('joinRoom', ({ roomId, name }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: [],
        deck: [],
        community: [],
        pot: 0,
        phase: null,
        turnIndex: 0,
        currentBet: 0,
        foldedPlayers: new Set(),
        bets: {}, // playerId -> bet this round
        discards: {}, // playerId -> number discarded this round
      };
    }

    const room = rooms[roomId];
    if (room.players.length >= 5) {
      socket.emit('roomFull');
      return;
    }

    if (room.players.find(p => p.id === socket.id)) {
      // Already in room, ignore
      return;
    }

    room.players.push({ id: socket.id, name: name || 'Anon', hand: [], chips: 1000, folded: false });
    socket.join(roomId);
    console.log(`${socket.id} (${name}) joined room ${roomId}`);

    // Send players list and their chips/hands (hands only to self)
    for (let p of room.players) {
      io.to(p.id).emit('gameState', {
        players: room.players.map(pl => ({
          id: pl.id,
          name: pl.name,
          chips: pl.chips,
          folded: pl.folded,
          hand: pl.id === p.id ? pl.hand : Array(pl.hand.length).fill(null),
          bet: room.bets[pl.id] || 0,
        })),
        community: room.community,
        pot: room.pot,
        phase: room.phase,
        turnId: room.players[room.turnIndex]?.id,
        currentBet: room.currentBet,
      });
    }

    if (room.players.length >= 2 && !room.phase) {
      startGame(roomId);
    }
  });

  socket.on('playerAction', ({ roomId, action, amount, discardIndices }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.players[room.turnIndex].id !== socket.id) {
      socket.emit('errorMessage', 'Not your turn');
      return;
    }
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.folded) return;

    if (action === 'fold') {
      player.folded = true;
      room.foldedPlayers.add(player.id);
      room.bets[player.id] = 0;
      nextTurn(roomId);
    }
    else if (action === 'call') {
      const toCall = room.currentBet - (room.bets[player.id] || 0);
      if (player.chips < toCall) {
        socket.emit('errorMessage', 'Not enough chips to call');
        return;
      }
      player.chips -= toCall;
      room.pot += toCall;
      room.bets[player.id] = room.currentBet;
      nextTurn(roomId);
    }
    else if (action === 'raise') {
      if (amount <= room.currentBet) {
        socket.emit('errorMessage', 'Raise must be higher than current bet');
        return;
      }
      const toPut = amount - (room.bets[player.id] || 0);
      if (player.chips < toPut) {
        socket.emit('errorMessage', 'Not enough chips to raise');
        return;
      }
      player.chips -= toPut;
      room.pot += toPut;
      room.currentBet = amount;
      room.bets[player.id] = amount;
      nextTurn(roomId);
    }
    else if (action === 'check') {
      if (room.currentBet > (room.bets[player.id] || 0)) {
        socket.emit('errorMessage', 'Cannot check when there is a bet');
        return;
      }
      nextTurn(roomId);
    }
    else if (action === 'discard') {
      if (!discardIndices || !Array.isArray(discardIndices)) {
        socket.emit('errorMessage', 'Discard indices required');
        return;
      }
      if (!room.discards[player.id]) room.discards[player.id] = 0;

      if (discardIndices.length !== 1) {
        socket.emit('errorMessage', 'Must discard exactly one card');
        return;
      }

      discardIndices.sort((a,b) => b - a).forEach(idx => {
        if (idx < 0 || idx >= player.hand.length) return;
        player.hand.splice(idx,1);
      });

      room.discards[player.id] = (room.discards[player.id] || 0) + discardIndices.length;
      nextTurn(roomId);
    }
    else {
      socket.emit('errorMessage', 'Unknown action');
    }

    emitGameState(roomId);
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    for (let roomId in rooms) {
      const room = rooms[roomId];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        room.foldedPlayers.delete(socket.id);
        delete room.bets[socket.id];
        delete room.discards[socket.id];
        if (room.players.length === 0) {
          delete rooms[roomId];
        } else {
          if (room.turnIndex >= room.players.length) room.turnIndex = 0;
          emitGameState(roomId);
        }
      }
    }
  });
});

function startGame(roomId) {
  const room = rooms[roomId];
  room.phase = PHASES[0];
  room.deck = createDeck();
  shuffle(room.deck);
  room.community = [];
  room.pot = 0;
  room.currentBet = 0;
  room.foldedPlayers = new Set();
  room.bets = {};
  room.discards = {};
  room.turnIndex = 0;

  for (let p of room.players) {
    p.hand = room.deck.splice(0,5);
    p.folded = false;
    room.bets[p.id] = 0;
  }

  emitGameState(roomId);
  promptPlayerAction(roomId);
}

function nextTurn(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  let nextIndex = room.turnIndex;
  let attempts = 0;
  do {
    nextIndex = (nextIndex + 1) % room.players.length;
    attempts++;
    if (attempts > room.players.length) break;
  } while (room.players[nextIndex].folded);

  room.turnIndex = nextIndex;

  const activePlayers = room.players.filter(p => !p.folded);
  const bets = activePlayers.map(p => room.bets[p.id] || 0);
  const maxBet = Math.max(...bets);
  const allEqual = bets.every(b => b === maxBet);

  if (allEqual && room.turnIndex === room.players.findIndex(p => !p.folded)) {
    advancePhase(roomId);
  } else {
    promptPlayerAction(roomId);
  }
}

function advancePhase(roomId) {
  const room = rooms[roomId];
  const currentPhaseIndex = PHASES.indexOf(room.phase);
  if (currentPhaseIndex === PHASES.length -1) {
    room.phase = 'showdown';
    io.to(roomId).emit('showdown', room);
  } else {
    room.phase = PHASES[currentPhaseIndex + 1];
    room.currentBet = 0;
    room.bets = {};
    room.discards = {};

    if (room.phase === 'flop') {
      room.community = room.deck.splice(0,3);
    } else if (room.phase === 'turn' || room.phase === 'river') {
      room.community.push(room.deck.shift());
    }

    room.turnIndex = 0;
    promptPlayerAction(roomId);
  }

  emitGameState(roomId);
}

function promptPlayerAction(roomId) {
  const room = rooms[roomId];
  const currentPlayer = room.players[room.turnIndex];
  io.to(roomId).emit('turn', currentPlayer.id);
  io.to(currentPlayer.id).emit('yourTurn', { phase: room.phase, currentBet: room.currentBet });
}

function emitGameState(roomId) {
  const room = rooms[roomId];
  for (let p of room.players) {
    io.to(p.id).emit('gameState', {
      players: room.players.map(pl => ({
        id: pl.id,
        name: pl.name,
        chips: pl.chips,
        folded: pl.folded,
        hand: pl.id === p.id ? pl.hand : Array(pl.hand.length).fill(null),
        bet: room.bets[pl.id] || 0,
      })),
      community: room.community,
      pot: room.pot,
      phase: room.phase,
      turnId: room.players[room.turnIndex]?.id,
      currentBet: room.currentBet,
    });
  }
}

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
