// poker-logic.js
// Pure functions for chip-tracking poker logic. No Firebase, no DOM.
// A "room" is a plain object matching the Firestore document shape (see app.js).

export function activeSeatOrder(room) {
  // Players still seated for future hands: not busted, not sitting out.
  return Object.entries(room.players)
    .filter(([, p]) => p.status !== "busted" && !p.sittingOut)
    .sort((a, b) => a[1].seat - b[1].seat)
    .map(([uid, p]) => ({ uid, ...p }));
}

export function nextSeatUid(order, fromUid, predicate) {
  // Walk the seat order starting after fromUid, return the first uid matching predicate.
  const n = order.length;
  if (n === 0) return null;
  const startIdx = fromUid ? order.findIndex((p) => p.uid === fromUid) : -1;
  for (let i = 1; i <= n; i++) {
    const p = order[(startIdx + i + n) % n];
    if (predicate(p)) return p.uid;
  }
  return null;
}

export function startHand(room) {
  const order = activeSeatOrder(room);
  if (order.length < 2) throw new Error("Need at least 2 players still seated to start a hand.");

  const players = {};
  for (const p of order) {
    players[p.uid] = {
      ...room.players[p.uid],
      status: "active",
      streetContributed: 0,
      handContributed: 0,
      hasActedThisStreet: false,
      isDealer: false,
      isSB: false,
      isBB: false,
    };
  }
  // Carry over busted/sitting-out players, but clear their leftover per-hand
  // numbers so a stale contribution from a hand they're no longer in can't
  // leak into this hand's pot total or side-pot math.
  for (const [uid, p] of Object.entries(room.players)) {
    if (!players[uid]) {
      players[uid] = {
        ...p,
        streetContributed: 0,
        handContributed: 0,
        hasActedThisStreet: false,
        isDealer: false,
        isSB: false,
        isBB: false,
      };
    }
  }

  // Rotate dealer among active seats.
  let dealerUid;
  if (room.handNumber === 0 || !room.players[room._lastDealerUid]) {
    dealerUid = order[0].uid;
  } else {
    dealerUid = nextSeatUid(order, room._lastDealerUid, () => true) || order[0].uid;
  }
  players[dealerUid].isDealer = true;

  const headsUp = order.length === 2;
  let sbUid, bbUid;
  if (headsUp) {
    sbUid = dealerUid;
    bbUid = nextSeatUid(order, dealerUid, () => true);
  } else {
    sbUid = nextSeatUid(order, dealerUid, () => true);
    bbUid = nextSeatUid(order, sbUid, () => true);
  }
  players[sbUid].isSB = true;
  players[bbUid].isBB = true;

  postBlind(players[sbUid], room.smallBlind);
  postBlind(players[bbUid], room.bigBlind);

  const currentBet = players[bbUid].streetContributed;
  const firstToAct = headsUp
    ? dealerUid
    : nextSeatUid(order, bbUid, (p) => players[p.uid].status === "active");

  return {
    ...room,
    players,
    status: "playing",
    street: "preflop",
    handNumber: (room.handNumber || 0) + 1,
    currentBet,
    minRaise: room.bigBlind,
    turnUid: firstToAct,
    pots: [],
    lastHandResult: null,
    _lastDealerUid: dealerUid,
  };
}

function postBlind(player, amount) {
  const paid = Math.min(amount, player.stack);
  player.stack -= paid;
  player.streetContributed = paid;
  player.handContributed = paid;
  if (player.stack === 0) player.status = "allin";
}

// Shared tail logic: given the players map after some status change, figure out
// whether the hand just ended (fold-out), whether the betting round just
// completed, and if not, who acts next (falling back to whatever the caller
// says makes sense if nobody in particular just took a turn).
function resolveRound(room, players, currentBet, minRaise, fallbackTurnUid) {
  const order = activeSeatOrder({ ...room, players });
  const contenders = order.filter((p) => players[p.uid].status !== "folded");

  if (contenders.length === 1) {
    return {
      ...room,
      players,
      currentBet,
      minRaise,
      turnUid: null,
      status: "hand_complete",
      pots: computeSidePots(players),
      lastHandResult: `${players[contenders[0].uid].name} wins, everyone else folded.`,
      _autoWinnerUid: contenders[0].uid,
    };
  }

  const stillActing = contenders.filter((p) => players[p.uid].status === "active");
  const roundDone =
    stillActing.length === 0 ||
    stillActing.every((p) => players[p.uid].streetContributed === currentBet && players[p.uid].hasActedThisStreet);

  return { ...room, players, currentBet, minRaise, turnUid: roundDone ? null : fallbackTurnUid, status: "playing" };
}

export function applyAction(room, uid, action, raiseTo) {
  if (room.turnUid !== uid) throw new Error("Not your turn.");
  const players = { ...room.players, [uid]: { ...room.players[uid] } };
  const player = players[uid];
  if (player.status !== "active") throw new Error("You cannot act right now.");

  let currentBet = room.currentBet;
  let minRaise = room.minRaise;

  if (action === "fold") {
    player.status = "folded";
    player.hasActedThisStreet = true;
  } else if (action === "check") {
    if (player.streetContributed !== currentBet) throw new Error("You cannot check, there is a bet to call.");
    player.hasActedThisStreet = true;
  } else if (action === "call") {
    const owed = currentBet - player.streetContributed;
    const pay = Math.min(owed, player.stack);
    player.stack -= pay;
    player.streetContributed += pay;
    player.handContributed += pay;
    if (player.stack === 0) player.status = "allin";
    player.hasActedThisStreet = true;
  } else if (action === "raise" || action === "allin") {
    const target = action === "allin" ? player.streetContributed + player.stack : raiseTo;
    const addAmount = target - player.streetContributed;
    if (addAmount <= 0 || addAmount > player.stack) throw new Error("Invalid raise amount.");
    const increment = target - currentBet;
    const isAllIn = addAmount === player.stack;
    if (!isAllIn && increment < minRaise) throw new Error(`Raise must be at least ${minRaise} more than the current bet.`);
    player.stack -= addAmount;
    player.streetContributed = target;
    player.handContributed += addAmount;
    if (player.stack === 0) player.status = "allin";
    player.hasActedThisStreet = true;
    if (target > currentBet) {
      if (increment >= minRaise) minRaise = increment;
      currentBet = target;
      // Everyone else who already acted now owes the new amount; the
      // round-complete check naturally reopens their turn since their
      // streetContributed no longer matches currentBet.
    }
  } else {
    throw new Error("Unknown action: " + action);
  }

  const order = activeSeatOrder({ ...room, players });
  const fallbackTurnUid = nextSeatUid(order, uid, (p) => players[p.uid].status === "active");
  return resolveRound(room, players, currentBet, minRaise, fallbackTurnUid);
}

// A player leaves the table. If a hand is in progress and they were still in
// it, this folds them out first so pots stay correct, then benches them so
// future hands skip their seat. Their stack and buy-in total are untouched,
// so they still show up correctly in the summary.
export function leaveGame(room, uid) {
  if (!room.players[uid]) return room;
  const players = { ...room.players, [uid]: { ...room.players[uid] } };
  const player = players[uid];
  player.sittingOut = true;

  if (room.status === "playing" && player.status === "active") {
    const wasTheirTurn = room.turnUid === uid;
    player.status = "folded";
    player.hasActedThisStreet = true;

    if (wasTheirTurn) {
      const order = activeSeatOrder({ ...room, players });
      const fallbackTurnUid = nextSeatUid(order, uid, (p) => players[p.uid].status === "active");
      return resolveRound(room, players, room.currentBet, room.minRaise, fallbackTurnUid);
    }
    // Not their turn: leave the current turn where it is, unless this fold
    // happens to end the hand or complete the round on its own.
    return resolveRound(room, players, room.currentBet, room.minRaise, room.turnUid);
  }

  return { ...room, players };
}

export function endSession(room) {
  return { ...room, status: "ended", turnUid: null };
}

export function advanceStreet(room) {
  const streets = ["preflop", "flop", "turn", "river"];
  const idx = streets.indexOf(room.street);
  if (idx === streets.length - 1) {
    // River betting is done, move to showdown.
    return {
      ...room,
      status: "showdown",
      turnUid: null,
      pots: computeSidePots(room.players),
    };
  }
  const nextStreetName = streets[idx + 1];
  const players = {};
  for (const [uid, p] of Object.entries(room.players)) {
    players[uid] = { ...p, streetContributed: 0, hasActedThisStreet: false };
  }
  const order = activeSeatOrder({ ...room, players });
  const dealerUid = Object.entries(players).find(([, p]) => p.isDealer)?.[0];
  const turnUid = nextSeatUid(order, dealerUid, (p) => players[p.uid].status === "active");

  return {
    ...room,
    players,
    street: nextStreetName,
    currentBet: 0,
    minRaise: room.bigBlind,
    turnUid,
  };
}

export function computeSidePots(players) {
  // Classic side-pot layering algorithm. Folded AND busted players can still
  // have chips counted into a pot (their money's still in there), but they
  // can never be eligible to win it back.
  const contributors = Object.entries(players)
    .filter(([, p]) => p.handContributed > 0)
    .map(([uid, p]) => ({
      uid,
      remaining: p.handContributed,
      ineligible: p.status === "folded" || p.status === "busted",
    }));

  const pots = [];
  while (contributors.some((c) => c.remaining > 0)) {
    const layer = Math.min(...contributors.filter((c) => c.remaining > 0).map((c) => c.remaining));
    let amount = 0;
    const eligible = [];
    for (const c of contributors) {
      if (c.remaining > 0) {
        amount += layer;
        c.remaining -= layer;
        if (!c.ineligible) eligible.push(c.uid);
      }
    }
    pots.push({ amount, eligibleUids: eligible });
  }
  return pots;
}

export function awardPots(room, winnerSelections) {
  // winnerSelections: { [potIndex]: [uid, ...] }
  const players = {};
  for (const [uid, p] of Object.entries(room.players)) players[uid] = { ...p };

  room.pots.forEach((pot, i) => {
    // Defensive: ignore any winner uid that somehow isn't a real player anymore.
    const winners = (winnerSelections[i] || []).filter((uid) => players[uid]);
    if (winners.length === 0) return;
    const share = Math.floor(pot.amount / winners.length);
    const remainder = pot.amount - share * winners.length;
    winners.forEach((uid, idx) => {
      players[uid].stack += share + (idx === 0 ? remainder : 0);
    });
  });

  for (const p of Object.values(players)) {
    if (p.stack === 0 && p.status !== "busted") p.status = "busted";
    else if (p.status === "allin" || p.status === "folded") p.status = "active";
  }

  const summary = room.pots
    .map((pot, i) => {
      const names = (winnerSelections[i] || [])
        .filter((uid) => players[uid])
        .map((uid) => players[uid].name)
        .join(" & ");
      return names ? `${names} won ${pot.amount} (${i === 0 ? "main pot" : "side pot " + i})` : null;
    })
    .filter(Boolean)
    .join(". ");

  return { ...room, players, status: "hand_complete", lastHandResult: summary || room.lastHandResult, turnUid: null };
}

export function autoAwardSingleWinner(room) {
  const winnerUid = room._autoWinnerUid;
  if (!winnerUid) return room;
  const winnerSelections = {};
  room.pots.forEach((pot, i) => {
    winnerSelections[i] = pot.eligibleUids.includes(winnerUid) ? [winnerUid] : pot.eligibleUids;
  });
  const result = awardPots(room, winnerSelections);
  delete result._autoWinnerUid;
  return result;
}

export function adjustChips(room, uid, delta) {
  const players = { ...room.players };
  const p = { ...players[uid] };
  p.stack = Math.max(0, p.stack + delta);
  p.totalBuyIn = (p.totalBuyIn || 0) + delta;
  if (p.stack > 0 && p.status === "busted") p.status = "active";
  if (p.stack === 0 && p.status !== "busted" && room.status !== "playing") p.status = "busted";
  players[uid] = p;
  return { ...room, players };
}
