const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Hand } = require('pokersolver');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

function createDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const deck = [];
  for (const s of suits) {
    for (const r of ranks) {
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

function formatCardForSolver(card) {
  // 'As' for Ace of spades, 'Td' for Ten diamonds, etc.
  let r = card.rank === '10' ? 'T' : card.rank[0];
  let s = { '♠':'s', '♥':'h', '♦':'d', '♣':'c' }[card.suit];
  return (r + s).toUpperCase();
}

function evaluateHands(players, community) {
  const hands = players.map(p => {
    const cards = p.hand.concat(community);
    const formatted = cards.map(formatCardForSolver);
    return { player: p, hand: Hand.solve(formatted) };
  });
  const winners = Hand.winners(hands.map(h => h.hand));
  // Find which players have winning hands
  const winnersPlayers = hands.filter(h => winners.includes(h.hand)).map(h => h.player.id);
  return { hands, winnersPlayers };
}

// Game state
let room = {
  players: [], // { id, name, chips, hand, folded, isDealer, isSmallBlind, isBigBlind, currentBet }
  deck: [],
  community: [],
  pot: 0,
  currentBets: {}, // playerId -> current bet this round
  phase: 'waiting', // waiting, preflop-betting, flop-discard, flop-betting, turn-discard, turn-betting, river-discard, river-betting, showdown
  turnIndex: 0, // index in players array
  dealerIndex: 0,
  smallBlind: 1,
  bigBlind: 2,
  minRaise: 2,
  currentBetToCall: 0,
};

function resetForNewHand() {
  room.deck = createDeck();
  shuffle(room.deck);
  room.community = [];
  room.pot = 0;
  room.currentBets = {};
  room.phase = 'preflop-betting';
  room.turnIndex = (room.dealerIndex + 1) % room.players.length; // small blind acts after dealer
  room.currentBetToCall = room.bigBlind;
  room.minRaise = room.bigBlind;

  // Reset player states and deal 5 cards
  for (const p of room.players) {
    p.folded = false;
    p.hand = [];
    p.currentBet = 0;
  }

  // Deal 5 cards to each player
  for (let i=0; i < 5; i++) {
    for (const p of room.players) {
      p.hand.push(room.deck.pop());
    }
  }

  // Assign blinds
  const sbIndex = (room.dealerIndex + 1) % room.players.length;
  const bbIndex = (room.dealerIndex + 2) % room.players.length;

  room.players.forEach((p,i) => {
    p.isDealer = (i === room.dealerIndex);
    p.isSmallBlind = (i === sbIndex);
    p.isBigBlind = (i === bbIndex);
    p.currentBet = 0;
  });

  // Post blinds from chips and update current bets
  const sbPlayer = room.players[sbIndex];
  const bbPlayer = room.players[bbIndex];

  sbPlayer.chips -= room.smallBlind;
  sbPlayer.currentBet = room.smallBlind;

  bbPlayer.chips -= room.bigBlind;
  bbPlayer.currentBet = room.bigBlind;

  room.currentBets[sbPlayer.id] = room.smallBlind;
  room.currentBets[bbPlayer.id] = room.bigBlind;

  room.pot = room.smallBlind + room.bigBlind;
}

function nextActivePlayer(startIndex) {
  const n = room.players.length;
  let i = startIndex;
  for (let count=0; count < n; count++) {
    i = (i + 1) % n;
    if (!room.players[i].folded && room.players[i].chips > 0) {
      return i;
    }
  }
  return -1; // no active players found
}

function allPlayersCalledOrFolded() {
  // Betting round ends when all active players have matched currentBetToCall or folded
  return room.players.every(p => 
    p.folded || p.currentBet === room.currentBetToCall || p.chips === 0
  );
}

function proceedToNextPhase() {
  // Reset bets for next betting round and add currentBets to pot
  const roundBetsSum = Object.values(room.currentBets).reduce((a,b) => a+b,0);
  room.pot += roundBetsSum;
  room.currentBets = {};
  room.players.forEach(p => p.currentBet = 0);

  if (room.phase === 'preflop-betting') {
    room.phase = 'flop-discard';
    room.community.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
  } else if (room.phase === 'flop-discard') {
    room.phase = 'flop-betting';
  } else if (room.phase === 'flop-betting') {
    room.phase = 'turn-discard';
    room.community.push(room.deck.pop());
  } else if (room.phase === 'turn-discard') {
    room.phase = 'turn-betting';
  } else if (room.phase === 'turn-betting') {
    room.phase = 'river-discard';
    room.community.push(room.deck.pop());
  } else if (room.phase === 'river-discard') {
    room.phase = 'river-betting';
  } else if (room.phase === 'river-betting') {
    room.phase = 'showdown';
    handleShowdown();
    return;
  }
  room.turnIndex = (room.dealerIndex + 1) % room.players.length; // turn starts after dealer again
  room.currentBetToCall = 0;
  room.minRaise = room.bigBlind;
  emitGameState();
}

function handleShowdown() {
  const activePlayers = room.players.filter(p => !p.folded);
  if (activePlayers.length === 1) {
    // Only one player left, he wins pot
    const winner = activePlayers[0];
    winner.chips += room.pot;
    io.emit('message', `${winner.name} wins the pot of ${room.pot} chips!`);
    room.pot = 0;
    startNewHand();
    return;
  }
  // Evaluate hands with pokersolver
  const { hands, winnersPlayers } = evaluateHands(activePlayers, room.community);

  let winnersNames = winnersPlayers.map(id => {
    const p = room.players.find(pl => pl.id === id);
    return p ? p.name : 'Unknown';
  });

  io.emit('message', `Showdown! Winner(s): ${winnersNames.join(', ')}`);

  // Split pot evenly
  const share = Math.floor(room.pot / winnersPlayers.length);
  winnersPlayers.forEach(id => {
    const p = room.players.find(pl => pl.id === id);
    if (p) p.chips += share;
  });
  room.pot = 0;

  startNewHand();
}

function startNewHand() {
  // Move dealer to next player who has chips
  let nextDealer = room.dealerIndex;
  for (let i = 1; i <= room.players.length; i++) {
    const idx = (room.dealerIndex + i) % room.players.length;
    if (room.players[idx].chips > 0) {
      nextDealer = idx;
      break;
    }
  }
  room.dealerIndex = nextDealer;

  // Remove players with zero chips from game
  room.players = room.players.filter(p => p.chips > 0);

  if (room.players.length < 2) {
    io.emit('message', 'Game over! Not enough players with chips.');
    room.phase = 'waiting';
    emitGameState();
    return;
  }

  resetForNewHand();
  emitGameState();
}

function emitGameState() {
  io.emit('gameState', {
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      chips: p.chips,
      hand: p.hand,
      folded: p.folded,
      isDealer: p.isDealer,
      isSmallBlind: p.isSmallBlind,
      isBigBlind: p.isBigBlind,
      currentBet: p.currentBet,
    })),
    community: room.community,
    pot: room.pot,
    currentBets: room.currentBets,
    phase: room.phase,
    turnId: room.players[room.turnIndex]?.id || null,
  });
}

// --- SOCKET.IO ---
io.on('connection', socket => {
  console.log('User connected', socket.id);

  socket.on('joinRoom', ({ name }) => {
    if (room.players.find(p => p.id === socket.id)) return; // already joined
    if (room.players.length >= 6) {
      socket.emit('roomFull');
      return;
    }
    room.players.push({
      id: socket.id,
      name,
      chips: 200,
      hand: [],
      folded: false,
      isDealer: false,
      isSmallBlind: false,
      isBigBlind: false,
      currentBet: 0,
    });

    if (room.phase === 'waiting' && room.players.length >= 2) {
      resetForNewHand();
    }

    emitGameState();
  });

  socket.on('playerAction', ({ action, amount, discardIndices }) => {
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex === -1) return;

    const player = room.players[playerIndex];
    if (player.folded) return;

    // Is it player's turn? Only enforce during betting phases (not discards)
    if (room.phase.includes('betting') && room.turnIndex !== playerIndex) return;

    if (action === 'fold') {
      player.folded = true;
      player.currentBet = 0;
      room.currentBets[player.id] = 0;
      // Check if only one player left
      const activePlayers = room.players.filter(p => !p.folded);
      if (activePlayers.length === 1) {
        const winner = activePlayers[0];
        winner.chips += room.pot + Object.values(room.currentBets).reduce((a,b)=>a+b,0);
        room.pot = 0;
        io.emit('message', `${winner.name} wins by fold!`);
        startNewHand();
        return;
      }
      room.turnIndex = nextActivePlayer(room.turnIndex);
      if (allPlayersCalledOrFolded()) proceedToNextPhase();
      else emitGameState();
      return;
    }

    if (action === 'check') {
      // Can only check if currentBetToCall equals player's currentBet
      if (player.currentBet === room.currentBetToCall) {
        room.turnIndex = nextActivePlayer(room.turnIndex);
        if (allPlayersCalledOrFolded()) proceedToNextPhase();
        else emitGameState();
      }
      return;
    }

    if (action === 'call') {
      const toCall = room.currentBetToCall - player.currentBet;
      if (toCall > player.chips) {
        // All-in call
        player.currentBet += player.chips;
        room.currentBets[player.id] = (room.currentBets[player.id] || 0) + player.chips;
        player.chips = 0;
      } else {
        player.chips -= toCall;
        player.currentBet += toCall;
        room.currentBets[player.id] = (room.currentBets[player.id] || 0) + toCall;
      }
      room.turnIndex = nextActivePlayer(room.turnIndex);
      if (allPlayersCalledOrFolded()) proceedToNextPhase();
      else emitGameState();
      return;
    }

    if (action === 'raise') {
      const minRaise = room.minRaise;
      if (amount < minRaise) {
        socket.emit('errorMessage', `Minimum raise is ${minRaise}`);
        return;
      }
      const toCall = room.currentBetToCall - player.currentBet;
      const totalBet = toCall + amount;
      if (totalBet > player.chips) {
        socket.emit('errorMessage', 'Not enough chips to raise');
        return;
      }
      player.chips -= totalBet;
      player.currentBet += totalBet;
      room.currentBets[player.id] = (room.currentBets[player.id] || 0) + totalBet;

      room.currentBetToCall = player.currentBet;
      room.minRaise = amount;
      room.turnIndex = nextActivePlayer(room.turnIndex);
      emitGameState();
      return;
    }

    if (action === 'discard') {
      // Only allowed during discard phases
      if (!room.phase.includes('discard')) {
        socket.emit('errorMessage', 'Not discard phase');
        return;
      }
      if (!discardIndices || discardIndices.length === 0) {
        socket.emit('errorMessage', 'No card selected to discard');
        return;
      }

      // Remove cards from player's hand (by indices)
      discardIndices.sort((a,b) => b - a); // remove from highest index to lowest to avoid reindex issues
      for (const idx of discardIndices) {
        if (idx >= 0 && idx < player.hand.length) {
          player.hand.splice(idx, 1);
        }
      }

      // Draw new cards to replace discarded cards
      for (let i=0; i < discardIndices.length; i++) {
        player.hand.push(room.deck.pop());
      }

      // Mark player as done discarding
      player.hasDiscarded = true;

      // Check if all players have discarded this round
      const allDone = room.players.every(p => p.folded || (p.hasDiscarded || !room.phase.includes('discard')));

      if (allDone) {
        // Reset discard flags
        room.players.forEach(p => p.hasDiscarded = false);

        // Move to next phase betting
        if (room.phase === 'flop-discard') room.phase = 'flop-betting';
        else if (room.phase === 'turn-discard') room.phase = 'turn-betting';
        else if (room.phase === 'river-discard') room.phase = 'river-betting';

        // Reset turn index to after dealer
        room.turnIndex = (room.dealerIndex + 1) % room.players.length;
        room.currentBetToCall = 0;
        room.minRaise = room.bigBlind;

        emitGameState();
        return;
      }
      emitGameState();
      return;
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected', socket.id);
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length < 2) {
      room.phase = 'waiting';
    }
    emitGameState();
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
