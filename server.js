const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function createDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ rank: r, suit: s });
    }
  }
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

const PHASES = [
  'pre-flop-betting',
  'flop-deal',
  'flop-discard',
  'flop-betting',
  'turn-deal',
  'turn-discard',
  'turn-betting',
  'river-deal',
  'river-discard',
  'river-betting',
  'showdown'
];

const SMALL_BLIND = 1;
const BIG_BLIND = 2;
const STARTING_CHIPS = 200;

const rooms = {}; // roomId -> room state

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
        bets: {},
        discards: {},
        dealerIndex: -1,
        startingTurnIndex: 0,
      };
    }
    const room = rooms[roomId];
    if (room.players.length >= 5) {
      socket.emit('roomFull');
      return;
    }
    if (room.players.find(p => p.id === socket.id)) return;

    room.players.push({
      id: socket.id,
      name: name || 'Anon',
      hand: [],
      chips: STARTING_CHIPS,
      folded: false,
    });
    socket.join(roomId);

    io.to(socket.id).emit('status', `Welcome, ${name}! Waiting for players...`);
    emitGameState(roomId);

    if (room.players.length >= 2 && !room.phase) {
      startHand(roomId);
    }
  });

  socket.on('playerAction', ({ roomId, action, amount, discardIndices }) => {
    const room = rooms[roomId];
    if (!room) return;

    if (room.players[room.turnIndex]?.id !== socket.id) {
      socket.emit('errorMessage', 'Not your turn.');
      return;
    }

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.folded) return;

    if (room.phase.endsWith('discard')) {
      if (action !== 'discard') {
        socket.emit('errorMessage', 'You must discard a card now.');
        return;
      }
      if (!discardIndices || discardIndices.length !== 1) {
        socket.emit('errorMessage', 'Must discard exactly one card.');
        return;
      }
      discardIndices.sort((a, b) => b - a).forEach(i => {
        if (i >= 0 && i < player.hand.length) player.hand.splice(i, 1);
      });
      room.discards[player.id] = true;

      const allDiscarded = room.players.filter(p => !p.folded).every(p => room.discards[p.id]);
      if (allDiscarded) {
        advancePhase(roomId);
      } else {
        do {
          room.turnIndex = (room.turnIndex + 1) % room.players.length;
        } while (room.players[room.turnIndex].folded);
        promptDiscard(roomId);
      }
      emitGameState(roomId);
      return;
    }

    // Betting
    switch (action) {
      case 'fold':
        player.folded = true;
        room.bets[player.id] = room.bets[player.id] || 0;
        room.pot += room.bets[player.id];
        room.bets[player.id] = 0;
        nextTurn(roomId);
        break;

      case 'check':
        if ((room.bets[player.id] || 0) < room.currentBet) {
          socket.emit('errorMessage', 'Cannot check, you must call or raise.');
          return;
        }
        nextTurn(roomId);
        break;

      case 'call': {
        const toCall = room.currentBet - (room.bets[player.id] || 0);
        if (player.chips < toCall) {
          socket.emit('errorMessage', 'Not enough chips to call.');
          return;
        }
        player.chips -= toCall;
        room.pot += toCall;
        room.bets[player.id] = room.currentBet;
        nextTurn(roomId);
        break;
      }

      case 'raise': {
        if (!amount || amount <= room.currentBet) {
          socket.emit('errorMessage', 'Raise must be higher than current bet.');
          return;
        }
        const toPut = amount - (room.bets[player.id] || 0);
        if (player.chips < toPut) {
          socket.emit('errorMessage', 'Not enough chips to raise.');
          return;
        }
        player.chips -= toPut;
        room.pot += toPut;
        room.currentBet = amount;
        room.bets[player.id] = amount;
        nextTurn(roomId);
        break;
      }

      default:
        socket.emit('errorMessage', 'Unknown action.');
    }
    emitGameState(roomId);
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
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

function startHand(roomId) {
  const room = rooms[roomId];
  room.phase = null;
  room.deck = createDeck();
  shuffle(room.deck);
  room.community = [];
  room.pot = 0;
  room.bets = {};
  room.discards = {};
  room.currentBet = 0;

  // Rotate dealer
  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;

  // Reset folded state and deal 5 cards
  for (const p of room.players) {
    p.folded = false;
    p.hand = room.deck.splice(0, 5);
  }

  // Post blinds
  const smallBlindIndex = (room.dealerIndex + 1) % room.players.length;
  const bigBlindIndex = (room.dealerIndex + 2) % room.players.length;

  const smallBlindPlayer = room.players[smallBlindIndex];
  const bigBlindPlayer = room.players[bigBlindIndex];

  smallBlindPlayer.chips -= SMALL_BLIND;
  bigBlindPlayer.chips -= BIG_BLIND;

  room.pot = SMALL_BLIND + BIG_BLIND;

  room.bets[smallBlindPlayer.id] = SMALL_BLIND;
  room.bets[bigBlindPlayer.id] = BIG_BLIND;

  room.currentBet = BIG_BLIND;
  room.turnIndex = (bigBlindIndex + 1) % room.players.length;
  room.startingTurnIndex = room.turnIndex;

  room.phase = 'pre-flop-betting';

  emitGameState(roomId);
  promptPlayerAction(roomId);
}

function advancePhase(roomId) {
  const room = rooms[roomId];
  let idx = PHASES.indexOf(room.phase);
  idx++;
  if (idx >= PHASES.length) {
    room.phase = 'showdown';
    io.to(roomId).emit('showdown', room);
    emitGameState(roomId);
    return;
  }
  room.phase = PHASES[idx];

  switch (room.phase) {
    case 'flop-deal':
      room.community.push(...room.deck.splice(0, 3));
      room.turnIndex = 0;
      room.discards = {};
      emitGameState(roomId);
      promptDiscard(roomId);
      break;

    case 'flop-discard':
    case 'turn-discard':
    case 'river-discard':
      // Waiting on players to discard - turn set in promptDiscard
      break;

    case 'flop-betting':
    case 'turn-betting':
    case 'river-betting':
      room.currentBet = 0;
      room.bets = {};
      room.discards = {};
      room.startingTurnIndex = room.turnIndex; // Important!
      emitGameState(roomId);
      promptPlayerAction(roomId);
      break;

    case 'turn-deal':
      room.community.push(room.deck.shift());
      room.turnIndex = 0;
      room.discards = {};
      emitGameState(roomId);
      promptDiscard(roomId);
      break;

    case 'river-deal':
      room.community.push(room.deck.shift());
      room.turnIndex = 0;
      room.discards = {};
      emitGameState(roomId);
      promptDiscard(roomId);
      break;

    case 'showdown':
      io.to(roomId).emit('showdown', room);
      emitGameState(roomId);
      break;
  }
}

function promptDiscard(roomId) {
  const room = rooms[roomId];
  const player = room.players[room.turnIndex];
  io.to(roomId).emit('status', `Player ${player.name}, discard one card.`);
  io.to(player.id).emit('yourTurn', { phase: 'discard' });
}

function promptPlayerAction(roomId) {
  const room = rooms[roomId];
  const player = room.players[room.turnIndex];
  io.to(roomId).emit('status', `Player ${player.name}, it's your turn.`);
  io.to(player.id).emit('yourTurn', { phase: room.phase, currentBet: room.currentBet });
}

function nextTurn(roomId) {
  const room = rooms[roomId];
  const prevIndex = room.turnIndex;
  let nextIndex = room.turnIndex;
  let attempts = 0;

  do {
    nextIndex = (nextIndex + 1) % room.players.length;
    attempts++;
    if (attempts > room.players.length) break;
  } while (room.players[nextIndex].folded);

  room.turnIndex = nextIndex;

  const activePlayers = room.players.filter(p => !p.folded);
  if (activePlayers.length <= 1) {
    io.to(room.players[0].id).emit('status', 'You win! Others folded.');
    setTimeout(() => startHand('iowa-room'), 5000);
    return;
  }

  const bets = activePlayers.map(p => room.bets[p.id] || 0);
  const maxBet = Math.max(...bets);
  const allEqual = bets.every(b => b === maxBet);

  if (
    allEqual &&
    maxBet === room.currentBet &&
    room.turnIndex === room.startingTurnIndex
  ) {
    advancePhase(roomId);
  } else {
    promptPlayerAction(roomId);
  }
}

function emitGameState(roomId) {
  const room = rooms[roomId];
  for (const p of room.players) {
    io.to(p.id).emit('gameState', {
      players: room.players.map(pl => ({
        id: pl.id,
        name: pl.name,
        chips: pl.chips,
        folded: pl.folded,
        hand: pl.id === p.id ? pl.hand : Array(pl.hand.length).fill(null),
        bet: room.bets[pl.id] || 0,
        isDealer: room.dealerIndex === room.players.indexOf(pl),
        isSmallBlind: room.dealerIndex !== -1 && (room.players.indexOf(pl) === (room.dealerIndex + 1) % room.players.length),
        isBigBlind: room.dealerIndex !== -1 && (room.players.indexOf(pl) === (room.dealerIndex + 2) % room.players.length),
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
