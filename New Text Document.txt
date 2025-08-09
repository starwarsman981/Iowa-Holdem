// server.js
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static('public')); // serve frontend files from /public

// Basic deck creation and shuffle
const ranks = '23456789TJQKA';
const suits = 'cdhs';
function createDeck() {
  const deck = [];
  for (const r of ranks) {
    for (const s of suits) {
      deck.push(r + s);
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

// Rooms storage
const rooms = {};

function dealCards(numPlayers) {
  const deck = createDeck();
  shuffle(deck);
  // deal 5 hole cards per player
  const playersHole = [];
  for(let i=0; i<numPlayers; i++) {
    playersHole.push(deck.splice(0,5));
  }
  // deal 5 board cards (flop+turn+river)
  const board = deck.splice(0,5);
  return { playersHole, board };
}

// Game state management simplified
function createRoom(roomId) {
  rooms[roomId] = {
    players: [],
    board: [],
    holeCards: {}, // socketId -> [cards]
    discards: {}, // socketId -> array of discarded cards in order
    currentStage: 'waiting', // waiting, flop, turn, river, showdown
    turnIndex: 0,
  };
}

io.on('connection', (socket) => {
  console.log('User connected', socket.id);

  socket.on('joinRoom', ({ roomId, name }) => {
    if (!rooms[roomId]) createRoom(roomId);
    if (rooms[roomId].players.length >= 6) {
      socket.emit('roomFull');
      return;
    }
    socket.join(roomId);
    rooms[roomId].players.push({ id: socket.id, name, discarded: [] });
    console.log(`${name} joined room ${roomId}`);

    io.to(roomId).emit('playersUpdate', rooms[roomId].players);

    if (rooms[roomId].players.length >= 2) {
      // start game immediately for demo purposes
      const { playersHole, board } = dealCards(rooms[roomId].players.length);
      rooms[roomId].board = board;
      rooms[roomId].currentStage = 'flop';
      rooms[roomId].turnIndex = 0;
      rooms[roomId].players.forEach((p, i) => {
        rooms[roomId].holeCards[p.id] = playersHole[i];
        rooms[roomId].discards[p.id] = [];
      });
      io.to(roomId).emit('gameStarted', { board, stage: 'flop' });
      sendTurn(roomId);
    }
  });

  socket.on('discardCard', ({ roomId, card }) => {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    if (room.players[room.turnIndex].id !== socket.id) return;

    // Remove card from player's hole cards and add to discards
    const hole = room.holeCards[socket.id];
    const idx = hole.indexOf(card);
    if (idx === -1) return;

    hole.splice(idx,1);
    room.discards[socket.id].push(card);

    // Advance turn
    room.turnIndex++;
    if (room.turnIndex >= room.players.length) {
      // End of this discard round - advance stage
      if (room.currentStage === 'flop') room.currentStage = 'turn';
      else if (room.currentStage === 'turn') room.currentStage = 'river';
      else if (room.currentStage === 'river') room.currentStage = 'showdown';

      room.turnIndex = 0;
      io.to(roomId).emit('stageChanged', room.currentStage);
      if(room.currentStage === 'showdown'){
        // Show hole cards for all players (for demo)
        const showdownHands = room.players.map(p => ({
          id: p.id,
          name: p.name,
          holeCards: room.holeCards[p.id],
          discards: room.discards[p.id],
        }));
        io.to(roomId).emit('showdown', { showdownHands, board: room.board });
      } else {
        sendTurn(roomId);
      }
    } else {
      sendTurn(roomId);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected', socket.id);
    // Remove player from all rooms they were in
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        delete room.holeCards[socket.id];
        delete room.discards[socket.id];
        io.to(roomId).emit('playersUpdate', room.players);
        if(room.players.length === 0) {
          delete rooms[roomId]; // clean up empty rooms
        }
      }
    }
  });

  function sendTurn(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const currentPlayer = room.players[room.turnIndex];
    io.to(roomId).emit('turn', currentPlayer.id);
  }
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
