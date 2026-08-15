// app.js
import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import * as Poker from "./poker-logic.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let uid = null;
let roomCode = localStorage.getItem("pokerRoomCode") || null;
let room = null; // latest Firestore snapshot data
let unsubRoom = null;

const $ = (sel) => document.querySelector(sel);
const el = (id) => document.getElementById(id);

function showToast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove("show"), 3200);
}

function roomRef(code) {
  return doc(db, "rooms", code);
}

// ---------- Auth ----------
onAuthStateChanged(auth, (user) => {
  if (user) {
    uid = user.uid;
    if (roomCode) attachRoom(roomCode);
    else renderLanding();
  } else {
    signInAnonymously(auth).catch((e) => showToast("Sign-in failed: " + e.message));
  }
});

// ---------- Room lifecycle ----------
function genRoomCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function createRoom({ name, startingStack, smallBlind, bigBlind }) {
  const code = genRoomCode();
  const data = {
    code,
    createdAt: serverTimestamp(),
    adminUid: uid,
    status: "waiting",
    smallBlind,
    bigBlind,
    startingStack,
    handNumber: 0,
    street: null,
    currentBet: 0,
    minRaise: bigBlind,
    turnUid: null,
    pots: [],
    lastHandResult: null,
    _lastDealerUid: null,
    players: {
      [uid]: {
        name,
        seat: 0,
        stack: startingStack,
        totalBuyIn: startingStack,
        status: "active",
        streetContributed: 0,
        handContributed: 0,
        hasActedThisStreet: false,
        isDealer: false,
        isSB: false,
        isBB: false,
        sittingOut: false,
      },
    },
  };
  await setDoc(roomRef(code), data);
  roomCode = code;
  localStorage.setItem("pokerRoomCode", code);
  attachRoom(code);
}

async function joinRoom({ code, name }) {
  code = code.trim().toUpperCase();
  const snap = await getDoc(roomRef(code));
  if (!snap.exists()) return showToast("No room found with that code.");
  const data = snap.data();
  if (data.players[uid]) {
    roomCode = code;
    localStorage.setItem("pokerRoomCode", code);
    return attachRoom(code);
  }
  if (data.status === "playing" || data.status === "showdown") {
    return showToast("A hand is in progress. Wait for it to finish, then try again.");
  }
  await runTransaction(db, async (tx) => {
    const fresh = await tx.get(roomRef(code));
    const players = fresh.data().players;
    players[uid] = {
      name,
      seat: Object.keys(players).length,
      stack: data.startingStack,
      totalBuyIn: data.startingStack,
      status: "active",
      streetContributed: 0,
      handContributed: 0,
      hasActedThisStreet: false,
      isDealer: false,
      isSB: false,
      isBB: false,
      sittingOut: false,
    };
    tx.update(roomRef(code), { players });
  });
  roomCode = code;
  localStorage.setItem("pokerRoomCode", code);
  attachRoom(code);
}

function attachRoom(code) {
  if (unsubRoom) unsubRoom();
  unsubRoom = onSnapshot(
    roomRef(code),
    (snap) => {
      if (!snap.exists()) {
        localStorage.removeItem("pokerRoomCode");
        room = null;
        roomCode = null;
        showToast("This room no longer exists.");
        return renderLanding();
      }
      room = snap.data();
      if (!room.players[uid]) {
        // We're not part of this room (e.g. shared browser). Drop back to landing.
        localStorage.removeItem("pokerRoomCode");
        roomCode = null;
        room = null;
        return renderLanding();
      }
      render();
    },
    (err) => showToast("Sync error: " + err.message)
  );
}

async function mutateRoom(fn) {
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef(roomCode));
      const current = snap.data();
      const next = fn(current);
      tx.set(roomRef(roomCode), next);
    });
  } catch (e) {
    showToast(e.message);
  }
}

// ---------- Game actions ----------
const startHand = () => mutateRoom((r) => Poker.startHand(r));

const act = (action, raiseTo) =>
  mutateRoom((r) => Poker.applyAction(r, uid, action, raiseTo));

const forceEndRound = () => mutateRoom((r) => ({ ...r, turnUid: null }));

const nextStreet = () =>
  mutateRoom((r) => {
    const advanced = Poker.advanceStreet(r);
    return advanced;
  });

const goToShowdownIfNeeded = () =>
  mutateRoom((r) => (r.status === "hand_complete" && r._autoWinnerUid ? Poker.autoAwardSingleWinner(r) : r));

const awardPots = (selections) => mutateRoom((r) => Poker.awardPots(r, selections));

const adjustChips = (targetUid, delta) => mutateRoom((r) => Poker.adjustChips(r, targetUid, delta));

async function doLeaveGame() {
  const msg =
    room.adminUid === uid
      ? "Leave this game? You're the admin, so admin controls won't be available until you come back on this device."
      : "Leave this game? If you're mid-hand this counts as a fold.";
  if (!confirm(msg)) return;
  await mutateRoom((r) => Poker.leaveGame(r, uid));
  localStorage.removeItem("pokerRoomCode");
  if (unsubRoom) unsubRoom();
  unsubRoom = null;
  roomCode = null;
  room = null;
  renderLanding();
}

function doEndSession() {
  if (!confirm("End the game for everyone? This closes the room. It can't be undone.")) return;
  mutateRoom((r) => Poker.endSession(r));
}

// ---------- Rendering ----------
function setScreen(name) {
  ["landing", "lobby", "game"].forEach((s) => el("screen-" + s).classList.toggle("hidden", s !== name));
}

function renderLanding() {
  setScreen("landing");
  el("room-badge").classList.add("hidden");
}

function fmt(n) {
  return Number(n).toLocaleString("en-US");
}

function playerRowsHTML() {
  const order = Poker.activeSeatOrder(room);
  return order
    .map((p) => {
      const badges = [];
      if (p.isDealer) badges.push('<span class="chip-badge chip-d" title="Dealer">D</span>');
      if (p.isSB) badges.push('<span class="chip-badge chip-sb" title="Small blind">SB</span>');
      if (p.isBB) badges.push('<span class="chip-badge chip-bb" title="Big blind">BB</span>');
      const isTurn = room.turnUid === p.uid;
      const statusClass =
        p.status === "folded" ? "row-folded" : p.status === "allin" ? "row-allin" : isTurn ? "row-turn" : "";
      const statusTag =
        p.status === "folded"
          ? '<span class="tag">folded</span>'
          : p.status === "allin"
          ? '<span class="tag tag-allin">all-in</span>'
          : "";
      const inThisStreet = room.status === "playing" && p.streetContributed > 0 ? `<span class="in-tag">in: ${fmt(p.streetContributed)}</span>` : "";
      return `<div class="player-row ${statusClass}">
        <div class="player-badges">${badges.join("")}</div>
        <div class="player-name">${escapeHtml(p.name)}${p.uid === uid ? " (you)" : ""}</div>
        <div class="player-meta">${statusTag}${inThisStreet}</div>
        <div class="player-stack">${fmt(p.stack)}</div>
      </div>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function totalPot() {
  return Object.values(room.players).reduce((sum, p) => sum + (p.handContributed || 0), 0);
}

function summaryRowsHTML() {
  return Object.values(room.players)
    .map((p) => ({ ...p, net: p.stack - (p.totalBuyIn || 0) }))
    .sort((a, b) => b.net - a.net)
    .map(
      (p) => `<div class="summary-row">
        <span>${escapeHtml(p.name)}</span>
        <span class="mono">${fmt(p.totalBuyIn || 0)}</span>
        <span class="mono">${fmt(p.stack)}</span>
        <span class="mono ${p.net >= 0 ? "net-pos" : "net-neg"}">${p.net >= 0 ? "+" : ""}${fmt(p.net)}</span>
      </div>`
    )
    .join("");
}

function render() {
  el("room-badge").classList.remove("hidden");
  el("room-code-label").textContent = roomCode;
  const isAdmin = room.adminUid === uid;
  el("btn-end-session").classList.toggle("hidden", !isAdmin || room.status === "ended");

  if (room.status === "ended") {
    setScreen("game");
    el("game-content").innerHTML = `
      <div class="table-header"><div class="street-label">Game over</div></div>
      <div class="hand-result">Final results</div>
      <div class="summary-table">
        <div class="summary-row summary-head"><span>Player</span><span>Buy-in</span><span>Stack</span><span>Net</span></div>
        ${summaryRowsHTML()}
      </div>`;
    return;
  }

  if (room.status === "waiting") {
    setScreen("lobby");
    el("lobby-code").textContent = roomCode;
    el("lobby-players").innerHTML = playerRowsHTML();
    el("lobby-admin-controls").classList.toggle("hidden", !isAdmin);
    el("lobby-start-btn").disabled = Object.keys(room.players).length < 2;
    el("lobby-wait-msg").classList.toggle("hidden", isAdmin);
    return;
  }

  setScreen("game");
  renderGame(isAdmin);
}

function renderGame(isAdmin) {
  const board = el("game-content");

  if (room.status === "showdown") {
    board.innerHTML = renderShowdown(isAdmin);
    wireShowdownEvents();
    return;
  }

  const streetLabel = { preflop: "Preflop", flop: "Flop", turn: "Turn", river: "River" }[room.street] || "";
  const me = room.players[uid];
  const myTurn = room.turnUid === uid;
  const roundOpen = room.status === "playing" && room.turnUid;
  const roundReadyForNext = room.status === "playing" && !room.turnUid;

  let actionHTML = "";
  if (room.status === "hand_complete") {
    const seatedCount = Poker.activeSeatOrder(room).length;
    const canStartNext = isAdmin && seatedCount >= 2;
    actionHTML = `<div class="hand-result">${escapeHtml(room.lastHandResult || "")}</div>
      ${
        canStartNext
          ? `<button id="btn-next-hand" class="btn btn-primary">Start next hand</button>`
          : isAdmin
          ? `<div class="wait-msg">Need at least 2 seated players for another hand.</div>`
          : `<div class="wait-msg">Waiting for admin to start the next hand.</div>`
      }`;
  } else if (myTurn && me.status === "active") {
    const owed = room.currentBet - me.streetContributed;
    const callLabel = owed > 0 ? `Call ${fmt(owed)}` : "Check";
    const minRaiseTo = room.currentBet + room.minRaise;
    actionHTML = `
      <div class="action-bar">
        <button id="btn-fold" class="btn btn-fold">Fold</button>
        <button id="btn-call" class="btn btn-call">${callLabel}</button>
        <button id="btn-allin" class="btn btn-allin">All-in ${fmt(me.stack)}</button>
      </div>
      <div class="raise-row">
        <input id="raise-input" type="number" min="${minRaiseTo}" max="${me.stack + me.streetContributed}" value="${Math.min(minRaiseTo, me.stack + me.streetContributed)}" />
        <button id="btn-raise" class="btn btn-raise">Raise to</button>
      </div>`;
  } else if (roundOpen) {
    const waitingName = room.players[room.turnUid]?.name || "someone";
    actionHTML = `<div class="wait-msg">Waiting for ${escapeHtml(waitingName)}...</div>`;
  } else if (roundReadyForNext && isAdmin) {
    const label = room.street === "river" ? "Go to showdown" : `Deal the ${{ preflop: "flop", flop: "turn", turn: "river" }[room.street]}`;
    actionHTML = `<button id="btn-next-street" class="btn btn-primary">${label}</button>`;
  } else if (roundReadyForNext) {
    actionHTML = `<div class="wait-msg">Waiting for the dealer to continue.</div>`;
  }

  board.innerHTML = `
    <div class="table-header">
      <div class="street-label">${streetLabel || "Hand " + room.handNumber}</div>
      <div class="pot-label">Pot: <span class="mono">${fmt(totalPot())}</span></div>
    </div>
    <div class="player-list">${playerRowsHTML()}</div>
    <div class="action-zone">${actionHTML}</div>
    ${isAdmin ? renderAdminPanel() : ""}
  `;

  wireGameEvents(isAdmin);

  if (isAdmin && room.status === "hand_complete" && room._autoWinnerUid) {
    // Auto-resolve folds-only wins right away so the pot lands without a showdown click.
    // Admin-only so every connected phone isn't racing to write the same update.
    goToShowdownIfNeeded();
  }
}

function renderAdminPanel() {
  const order = Poker.activeSeatOrder(room);
  const chipRows = order
    .map(
      (p) => `<div class="chip-adjust-row">
        <span>${escapeHtml(p.name)}</span>
        <button class="btn-small" data-adjust="-50" data-uid="${p.uid}">-50</button>
        <button class="btn-small" data-adjust="50" data-uid="${p.uid}">+50</button>
      </div>`
    )
    .join("");
  return `<details class="admin-panel">
    <summary>Admin controls</summary>
    ${room.status === "playing" && room.turnUid ? `<button id="btn-force-end" class="btn btn-secondary">Force end betting round</button>` : ""}
    <div class="chip-adjust-list">${chipRows}</div>
  </details>`;
}

function renderShowdown(isAdmin) {
  const totalInPots = room.pots.reduce((s, p) => s + p.amount, 0);
  const potsHTML = room.pots
    .map((pot, i) => {
      const eligible = pot.eligibleUids.map((u) => room.players[u]).filter(Boolean);
      const excluded = Object.entries(room.players)
        .filter(([uid, p]) => p.handContributed > 0 && p.status !== "folded" && !pot.eligibleUids.includes(uid))
        .map(([, p]) => p.name);
      const options = eligible
        .map(
          (p) =>
            `<label class="winner-option"><input type="checkbox" data-pot="${i}" value="${p.uid}" /> ${escapeHtml(p.name)}</label>`
        )
        .join("");
      const explainer =
        i === 0
          ? "Everyone still in the hand can win this one."
          : `Only players who bet beyond the last all-in can win this one.${
              excluded.length ? ` ${excluded.map(escapeHtml).join(", ")} already all-in, not eligible here.` : ""
            }`;
      return `<div class="pot-card">
        <div class="pot-title">${i === 0 ? "Main pot" : "Side pot " + i}: <span class="mono">${fmt(pot.amount)}</span></div>
        <div class="pot-explainer">${explainer}</div>
        ${isAdmin ? `<div class="winner-options">${options}</div>` : `<div class="winner-options-readonly">Eligible: ${eligible.map((p) => escapeHtml(p.name)).join(", ")}</div>`}
      </div>`;
    })
    .join("");
  return `
    <div class="table-header">
      <div class="street-label">Showdown</div>
      <div class="pot-label">Total: <span class="mono">${fmt(totalInPots)}</span></div>
    </div>
    ${
      room.pots.length > 1
        ? `<div class="side-pot-note">Someone went all-in for less than the others bet, so the pot split into layers. Pick a winner for every pot below, chips left unpicked won't be awarded to anyone.</div>`
        : ""
    }
    <div class="pots-list">${potsHTML}</div>
    ${isAdmin ? `<button id="btn-award" class="btn btn-primary">Award pots</button>` : `<div class="wait-msg">Waiting for admin to pick the winners.</div>`}
  `;
}

// ---------- Event wiring ----------
function wireGameEvents(isAdmin) {
  el("btn-fold")?.addEventListener("click", () => act("fold"));
  el("btn-call")?.addEventListener("click", () => act("call"));
  el("btn-allin")?.addEventListener("click", () => act("allin"));
  el("btn-raise")?.addEventListener("click", () => {
    const v = Number(el("raise-input").value);
    if (!v) return showToast("Enter a raise amount.");
    act("raise", v);
  });
  el("btn-next-hand")?.addEventListener("click", () => startHand());
  el("btn-next-street")?.addEventListener("click", () => nextStreet());
  el("btn-force-end")?.addEventListener("click", () => forceEndRound());
  document.querySelectorAll("[data-adjust]").forEach((btn) =>
    btn.addEventListener("click", () => adjustChips(btn.dataset.uid, Number(btn.dataset.adjust)))
  );
}

function wireShowdownEvents() {
  el("btn-award")?.addEventListener("click", () => {
    const selections = {};
    document.querySelectorAll("[data-pot]:checked").forEach((cb) => {
      const potIdx = cb.dataset.pot;
      (selections[potIdx] ||= []).push(cb.value);
    });
    const missing = room.pots
      .map((pot, i) => ({ i, pot }))
      .filter(({ i, pot }) => pot.amount > 0 && (!selections[i] || selections[i].length === 0));
    if (missing.length > 0) {
      const label = missing.map(({ i }) => (i === 0 ? "the main pot" : "side pot " + i)).join(", ");
      return showToast(`Pick a winner for ${label}. Unpicked pots won't be awarded to anyone.`);
    }
    awardPots(selections);
  });
}

// ---------- Landing / lobby form wiring ----------
el("form-create").addEventListener("submit", (e) => {
  e.preventDefault();
  createRoom({
    name: el("create-name").value.trim() || "Admin",
    startingStack: Number(el("create-stack").value) || 500,
    smallBlind: Number(el("create-sb").value) || 5,
    bigBlind: Number(el("create-bb").value) || 10,
  }).catch((err) => showToast(err.message));
});

el("form-join").addEventListener("submit", (e) => {
  e.preventDefault();
  joinRoom({
    code: el("join-code").value,
    name: el("join-name").value.trim() || "Player",
  }).catch((err) => showToast(err.message));
});

el("lobby-start-btn").addEventListener("click", () => startHand());

el("room-code-label").addEventListener("click", () => {
  navigator.clipboard?.writeText(roomCode);
  showToast("Room code copied.");
});

el("btn-summary").addEventListener("click", () => {
  el("summary-modal").classList.remove("hidden");
  el("summary-rows").innerHTML = summaryRowsHTML();
});

el("btn-close-summary").addEventListener("click", () => el("summary-modal").classList.add("hidden"));

el("btn-leave").addEventListener("click", () => doLeaveGame());
el("btn-end-session").addEventListener("click", () => doEndSession());
