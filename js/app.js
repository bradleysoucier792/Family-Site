import { auth, db } from "./firebase.js";
import {
  GoogleAuthProvider, onAuthStateChanged, signInWithPopup,
  signInWithRedirect, signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection,
  query, where, orderBy, onSnapshot, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

/* ── helpers ─────────────────────────────────────────── */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const COLORS = ["#ef4444","#f97316","#eab308","#22c55e","#14b8a6","#3b82f6","#8b5cf6","#ec4899"];
const pickColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];
const initials = (n) => (n || "?").trim().slice(0, 1).toUpperCase();

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2200);
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copied`);
  } catch {
    prompt("Copy this:", text);
  }
}

/* ── state ───────────────────────────────────────────── */
const state = {
  user: null,
  familyId: null,
  family: null,
  member: null,
  members: [],
  shopping: [],
  tasks: [],
  view: "home"
};
let unsubs = [];

function clearSubs() {
  unsubs.forEach((u) => { try { u(); } catch {} });
  unsubs = [];
}

/* ── screens ─────────────────────────────────────────── */
function show(name) {
  ["loading", "signin", "onboarding", "app"].forEach((s) =>
    $(`#screen-${s}`).classList.toggle("hidden", s !== name));
}
const showError = (sel, msg) => {
  const el = $(sel);
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
};

/* ── theme ───────────────────────────────────────────── */
const THEME_KEY = "fh:theme";
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $("#btn-theme").textContent = t === "dark" ? "🌙" : "☀️";
  localStorage.setItem(THEME_KEY, t);
}
applyTheme(localStorage.getItem(THEME_KEY) ||
  (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
$("#btn-theme").onclick = () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

/* ── auth ────────────────────────────────────────────── */
const provider = new GoogleAuthProvider();

$("#btn-google").onclick = async () => {
  showError("#signin-error", "");
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    // Popups are blocked on some mobile browsers — fall back to redirect.
    if (["auth/popup-blocked", "auth/popup-closed-by-user",
         "auth/operation-not-supported-in-this-environment"].includes(err.code)) {
      try { await signInWithRedirect(auth, provider); return; } catch {}
    }
    showError("#signin-error",
      err.code === "auth/unauthorized-domain"
        ? "This domain isn't authorized in Firebase Auth settings."
        : err.message);
  }
};

const doSignOut = async () => { clearSubs(); await signOut(auth); };
$("#btn-signout").onclick = doSignOut;
$("#btn-signout-ob").onclick = doSignOut;

onAuthStateChanged(auth, async (user) => {
  clearSubs();
  state.user = user;

  if (!user) {
    state.familyId = state.family = state.member = null;
    show("signin");
    return;
  }

  show("loading");
  const snap = await getDoc(doc(db, "users", user.uid));
  const familyId = snap.exists() ? snap.data().familyId : null;

  if (!familyId) {
    // Prefill join code if arriving via an invite link.
    const code = new URLSearchParams(location.search).get("join");
    if (code) {
      switchTab("join");
      $("#join-code").value = code.toUpperCase().slice(0, 8);
      $("#join-display").value = user.displayName?.split(" ")[0] || "";
    }
    show("onboarding");
    return;
  }

  await enterFamily(familyId);
});

/* ── onboarding ──────────────────────────────────────── */
function switchTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $("#form-create").classList.toggle("hidden", name !== "create");
  $("#form-join").classList.toggle("hidden", name !== "join");
}
$$(".tab").forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));

async function createFamily(familyName, displayName) {
  const uid = state.user.uid;
  const familyRef = doc(collection(db, "families"));
  const fid = familyRef.id;

  await setDoc(familyRef, {
    name: familyName,
    ownerUid: uid,
    createdAt: serverTimestamp()
  });

  await setDoc(doc(db, "families", fid, "members", uid), {
    displayName,
    email: state.user.email || "",
    role: "admin",
    color: pickColor(),
    joinedAt: serverTimestamp()
  });

  await setDoc(doc(db, "users", uid), { familyId: fid, displayName });

  return fid;
}

async function joinFamily(code, displayName) {
  const uid = state.user.uid;

  const inviteSnap = await getDoc(doc(db, "invites", code));
  if (!inviteSnap.exists()) throw new Error("That invite code doesn't exist.");
  const { familyId } = inviteSnap.data();

  await setDoc(doc(db, "families", familyId, "members", uid), {
    displayName,
    email: state.user.email || "",
    role: "adult",
    color: pickColor(),
    inviteCode: code,      // required by security rules to prove the join
    joinedAt: serverTimestamp()
  });

  await setDoc(doc(db, "users", uid), { familyId, displayName });

  return familyId;
}

$("#form-create").onsubmit = async (e) => {
  e.preventDefault();
  showError("#ob-error", "");
  const btn = e.submitter; btn.disabled = true;
  try {
    const fid = await createFamily(
      $("#create-name").value.trim(),
      $("#create-display").value.trim()
    );
    await enterFamily(fid);
  } catch (err) {
    showError("#ob-error", err.message);
    btn.disabled = false;
  }
};

$("#form-join").onsubmit = async (e) => {
  e.preventDefault();
  showError("#ob-error", "");
  const btn = e.submitter; btn.disabled = true;
  try {
    const fid = await joinFamily(
      $("#join-code").value.trim().toUpperCase(),
      $("#join-display").value.trim()
    );
    history.replaceState({}, "", location.pathname);
    await enterFamily(fid);
  } catch (err) {
    showError("#ob-error", err.message);
    btn.disabled = false;
  }
};

/* ── enter family + live subscriptions ───────────────── */
async function enterFamily(fid) {
  state.familyId = fid;
  show("loading");

  const [familySnap, memberSnap] = await Promise.all([
    getDoc(doc(db, "families", fid)),
    getDoc(doc(db, "families", fid, "members", state.user.uid))
  ]);

  if (!familySnap.exists() || !memberSnap.exists()) {
    await setDoc(doc(db, "users", state.user.uid), { familyId: null });
    show("onboarding");
    return;
  }

  state.family = { id: fid, ...familySnap.data() };
  state.member = memberSnap.data();

  renderShell();
  show("app");
  subscribe(fid);
}

function subscribe(fid) {
  const famCol = collection(db, "families", fid);

  unsubs.push(onSnapshot(collection(famCol, "members"), (snap) => {
    state.members = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    renderMembers();
    renderStats();
    renderTaskAssigneeOptions();
  }, (e) => console.error("members:", e)));

  unsubs.push(onSnapshot(
    query(collection(famCol, "shoppingItems"), orderBy("createdAt", "desc")),
    (snap) => {
      state.shopping = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderShopping();
      renderStats();
    }, (e) => console.error("shopping:", e)));

  unsubs.push(onSnapshot(
    query(collection(famCol, "tasks"), orderBy("createdAt", "desc")),
    (snap) => {
      state.tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderTasks();
      renderStats();
    }, (e) => console.error("tasks:", e)));
}

/* ── rendering ───────────────────────────────────────── */
function renderShell() {
  $("#family-name").textContent = state.family.name;
  const n = state.members.length || 1;
  $("#family-sub").textContent = `${n} member${n === 1 ? "" : "s"}`;

  const av = $("#me-avatar");
  av.textContent = initials(state.member.displayName);
  av.style.background = state.member.color || "#4f8cff";
  av.title = state.member.displayName;

  const now = new Date();
  const h = now.getHours();
  const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  $("#greeting").textContent = `${part}, ${state.member.displayName}!`;
  $("#today").textContent = now.toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric", year: "numeric"
  });

  renderInviteCode();
}

function renderStats() {
  const openShop = state.shopping.filter((i) => !i.checked).length;
  const openTasks = state.tasks.filter((t) => !t.done).length;
  const mine = state.tasks.filter((t) => !t.done && t.assigneeUid === state.user.uid).length;
  const doneToday = state.tasks.filter((t) => t.done).length;

  $("#stats").innerHTML = [
    ["To buy", openShop],
    ["Open tasks", openTasks],
    ["Assigned to me", mine],
    ["Completed", doneToday]
  ].map(([l, n]) =>
    `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`
  ).join("");
}

function memberName(uid) {
  if (uid === state.user.uid) return state.member?.displayName || "You";
  return state.members.find((m) => m.uid === uid)?.displayName || "Someone";
}

/* shopping */
function renderShopping() {
  const list = $("#shopping-list");
  if (!state.shopping.length) {
    list.innerHTML = `<p class="empty">Nothing on the list yet.</p>`;
    return;
  }

  const open = state.shopping.filter((i) => !i.checked);
  const done = state.shopping.filter((i) => i.checked);
  const groups = {};
  open.forEach((i) => (groups[i.category || "Other"] ||= []).push(i));

  let html = "";
  for (const [cat, items] of Object.entries(groups).sort()) {
    html += `<div class="group-title">${esc(cat)} · ${items.length}</div>`;
    html += items.map(shoppingRow).join("");
  }
  if (done.length) {
    html += `<div class="group-title">Checked · ${done.length}</div>`;
    html += done.map(shoppingRow).join("");
  }
  list.innerHTML = html;
}

function shoppingRow(i) {
  return `
    <div class="item ${i.checked ? "done" : ""}" data-id="${i.id}">
      <input type="checkbox" ${i.checked ? "checked" : ""} data-act="toggle">
      <div class="grow">
        <div class="title">${esc(i.name)}${i.qty ? ` <span class="muted">· ${esc(i.qty)}</span>` : ""}</div>
        <div class="meta">${esc(memberName(i.createdBy))}</div>
      </div>
      <button class="del" data-act="delete" title="Delete">×</button>
    </div>`;
}

$("#form-shopping").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("#shop-name").value.trim();
  if (!name) return;
  const qty = $("#shop-qty").value.trim();
  const category = $("#shop-cat").value;
  $("#shop-name").value = "";
  $("#shop-qty").value = "";
  $("#shop-name").focus();

  await addDoc(collection(db, "families", state.familyId, "shoppingItems"), {
    name, qty, category, checked: false,
    createdBy: state.user.uid,
    createdAt: serverTimestamp()
  });
};

$("#shopping-list").addEventListener("click", async (e) => {
  const row = e.target.closest(".item");
  if (!row) return;
  const ref = doc(db, "families", state.familyId, "shoppingItems", row.dataset.id);
  if (e.target.dataset.act === "toggle") {
    await updateDoc(ref, { checked: e.target.checked });
  } else if (e.target.dataset.act === "delete") {
    await deleteDoc(ref);
  }
});

$("#btn-clear-checked").onclick = async () => {
  const checked = state.shopping.filter((i) => i.checked);
  if (!checked.length) return toast("Nothing checked");
  const batch = writeBatch(db);
  checked.forEach((i) =>
    batch.delete(doc(db, "families", state.familyId, "shoppingItems", i.id)));
  await batch.commit();
  toast(`Cleared ${checked.length} item${checked.length === 1 ? "" : "s"}`);
};

/* tasks */
function renderTaskAssigneeOptions() {
  const sel = $("#task-assignee");
  const cur = sel.value;
  sel.innerHTML = `<option value="">Anyone</option>` +
    state.members.map((m) =>
      `<option value="${m.uid}">${esc(m.displayName)}${m.uid === state.user.uid ? " (me)" : ""}</option>`
    ).join("");
  if (cur) sel.value = cur;
}

function renderTasks() {
  const list = $("#task-list");
  if (!state.tasks.length) {
    list.innerHTML = `<p class="empty">No tasks yet. Add one above.</p>`;
    return;
  }
  const open = state.tasks.filter((t) => !t.done);
  const done = state.tasks.filter((t) => t.done);
  list.innerHTML = open.map(taskRow).join("") +
    (done.length ? `<div class="group-title">Done · ${done.length}</div>` + done.map(taskRow).join("") : "");
}

function taskRow(t) {
  const due = t.dueDate
    ? new Date(t.dueDate + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "";
  const overdue = t.dueDate && !t.done && t.dueDate < new Date().toISOString().slice(0, 10);
  const who = t.assigneeUid ? memberName(t.assigneeUid) : "Anyone";
  return `
    <div class="item ${t.done ? "done" : ""}" data-id="${t.id}">
      <input type="checkbox" ${t.done ? "checked" : ""} data-act="toggle">
      <div class="grow">
        <div class="title">${esc(t.title)}</div>
        <div class="meta">
          ${esc(who)}${due ? ` · <span style="color:${overdue ? "var(--danger)" : "inherit"}">${due}</span>` : ""}
        </div>
      </div>
      <button class="del" data-act="delete" title="Delete">×</button>
    </div>`;
}

$("#form-task").onsubmit = async (e) => {
  e.preventDefault();
  const title = $("#task-title").value.trim();
  if (!title) return;
  const assigneeUid = $("#task-assignee").value || null;
  const dueDate = $("#task-due").value || null;
  $("#task-title").value = "";
  $("#task-due").value = "";
  $("#task-title").focus();

  await addDoc(collection(db, "families", state.familyId, "tasks"), {
    title, assigneeUid, dueDate, done: false,
    createdBy: state.user.uid,
    createdAt: serverTimestamp()
  });
};

$("#task-list").addEventListener("click", async (e) => {
  const row = e.target.closest(".item");
  if (!row) return;
  const ref = doc(db, "families", state.familyId, "tasks", row.dataset.id);
  if (e.target.dataset.act === "toggle") {
    await updateDoc(ref, { done: e.target.checked });
  } else if (e.target.dataset.act === "delete") {
    await deleteDoc(ref);
  }
});

/* members */
function renderMembers() {
  $("#member-list").innerHTML = state.members.map((m) => `
    <div class="member-row">
      <div class="avatar" style="background:${m.color || "#4f8cff"}">${esc(initials(m.displayName))}</div>
      <div class="grow">
        <div>${esc(m.displayName)}${m.uid === state.user.uid ? " <span class='muted tiny'>(you)</span>" : ""}</div>
        <div class="meta muted tiny">${esc(m.email || "")}</div>
      </div>
      <span class="chip">${esc(m.role || "member")}</span>
    </div>`).join("");
}

/* invites */
async function renderInviteCode() {
  const el = $("#invite-code");
  if (state.member?.role !== "admin") {
    el.textContent = "admin only";
    $("#btn-new-invite").disabled = true;
    return;
  }
  $("#btn-new-invite").disabled = false;
  const q = query(collection(db, "invites"), where("familyId", "==", state.familyId));
  // No list permission — track the code we created locally instead.
  el.textContent = state._inviteCode || "—";
}

async function newInvite() {
  const code = makeCode();
  await setDoc(doc(db, "invites", code), {
    familyId: state.familyId,
    createdBy: state.user.uid,
    createdAt: serverTimestamp()
  });
  state._inviteCode = code;
  $("#invite-code").textContent = code;
  toast("New invite code created");
}

$("#btn-new-invite").onclick = () => newInvite().catch((e) => toast(e.message));

$("#btn-copy-code").onclick = () => {
  const c = $("#invite-code").textContent;
  if (c && c !== "—" && c !== "admin only") copy(c, "Code");
  else toast("Generate a code first");
};

$("#btn-copy-link").onclick = () => {
  const c = $("#invite-code").textContent;
  if (!c || c === "—" || c === "admin only") return toast("Generate a code first");
  const url = `${location.origin}${location.pathname}?join=${c}`;
  copy(url, "Invite link");
};

/* ── nav ─────────────────────────────────────────────── */
$$(".nav-btn").forEach((btn) => {
  btn.onclick = () => {
    state.view = btn.dataset.view;
    $$(".nav-btn").forEach((b) => b.classList.toggle("active", b === btn));
    $$(".view").forEach((v) =>
      v.classList.toggle("hidden", v.dataset.view !== state.view));
  };
});
