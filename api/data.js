import { Redis } from "@upstash/redis";

// Support both the UPSTASH_REDIS_REST_* and KV_REST_API_* names that the
// Vercel Marketplace (Upstash) integration may inject.
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

// One shared dataset lives under a single key — same namespace the client
// used in localStorage, so the concept carries over 1:1.
const KEY = "rangelog_v1";

// Shared-secret gate. Defaults to "golf"; override in Vercel with the
// RANGELOG_PASSWORD environment variable (change the client's fallback to
// match if you want the offline gate to agree). The client sends it in the
// x-rangelog-pass header on every request.
const PASSWORD = process.env.RANGELOG_PASSWORD || "golf";

function isAuthorized(req) {
  const sent = req.headers && (req.headers["x-rangelog-pass"] || req.headers["X-Rangelog-Pass"]);
  return typeof sent === "string" && sent === PASSWORD;
}

// ---- Sanity caps (defensive; the client sends well-formed data) ----
const MAX_LESSONS = 500;
const MAX_SESSIONS = 2000;
const MAX_DRILLS = 3;
const MAX_TEXT = 200;      // focus / swing thought / drill name / note
const MAX_ID = 64;
const MAX_FLIGHTS = 20;    // per club group, and per settings list
const MAX_FLIGHT_LEN = 40;

const CLUB_GROUPS = ["Driver", "Woods/Hybrids", "Long Irons", "Mid Irons", "Wedges"];
const DEFAULT_FLIGHTS = ["Straight", "Pull", "Push", "Slice", "Hook", "Fat", "Thin"];
const SESSION_TYPE_IDS = ["range", "9", "18"];

function sanitizeString(value, max) {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(new RegExp("[\\u0000-\\u001F\\u007F]", "g"), "").trim().slice(0, max);
}

function sanitizeId(value) {
  if (typeof value !== "string" || !value) return "";
  return value.slice(0, MAX_ID);
}

// YYYY-MM-DD only.
function sanitizeDate(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return "";
}

function newId() {
  try {
    return crypto.randomUUID();
  } catch {
    return "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
}

function validateLesson(input) {
  if (!input || typeof input !== "object") return null;
  const drills = (Array.isArray(input.drills) ? input.drills : [])
    .map((d) => ({ id: sanitizeId(d && d.id) || newId(), name: sanitizeString(d && d.name, MAX_TEXT) }))
    .filter((d) => d.name)
    .slice(0, MAX_DRILLS);
  return {
    id: sanitizeId(input.id) || newId(),
    date: sanitizeDate(input.date) || new Date().toISOString().slice(0, 10),
    focus: sanitizeString(input.focus, MAX_TEXT),
    swingThought: sanitizeString(input.swingThought, MAX_TEXT),
    drills,
  };
}

function validateSession(input) {
  if (!input || typeof input !== "object") return null;
  const clubGroups = (Array.isArray(input.clubGroups) ? input.clubGroups : [])
    .map((cg) => {
      if (!cg || typeof cg !== "object") return null;
      const group = CLUB_GROUPS.includes(cg.group) ? cg.group : null;
      if (!group) return null;
      let contact = Number(cg.contact);
      if (!Number.isFinite(contact) || contact < 0) contact = 0;
      contact = Math.min(5, Math.round(contact));
      let flights = [];
      if (Array.isArray(cg.flights)) flights = cg.flights;
      else if (cg.flight) flights = [cg.flight]; // legacy single value
      // Sanitize as free-form strings (tendencies are user-editable now).
      flights = dedupeFlights(flights);
      return { group, contact, flights };
    })
    .filter(Boolean);

  const drillsDone = (Array.isArray(input.drillsDone) ? input.drillsDone : [])
    .map(sanitizeId)
    .filter(Boolean);

  return {
    id: sanitizeId(input.id) || newId(),
    date: sanitizeDate(input.date) || new Date().toISOString().slice(0, 10),
    type: SESSION_TYPE_IDS.includes(input.type) ? input.type : "range",
    clubGroups,
    drillsDone,
    note: sanitizeString(input.note, MAX_TEXT),
  };
}

// Trim/cap/de-dupe (case-insensitive) a list of tendency strings.
function dedupeFlights(arr) {
  const seen = new Set();
  const out = [];
  for (const f of Array.isArray(arr) ? arr : []) {
    const v = sanitizeString(f, MAX_FLIGHT_LEN);
    const key = v.toLowerCase();
    if (v && !seen.has(key)) { seen.add(key); out.push(v); }
    if (out.length >= MAX_FLIGHTS) break;
  }
  return out;
}

function validateSettings(input) {
  const flights = dedupeFlights(input && input.flights);
  return { flights: flights.length ? flights : DEFAULT_FLIGHTS.slice() };
}

async function readState() {
  const raw = await redis.get(KEY);
  const lessons = raw && Array.isArray(raw.lessons) ? raw.lessons : [];
  const sessions = raw && Array.isArray(raw.sessions) ? raw.sessions : [];
  const settings = validateSettings(raw && raw.settings);
  return { lessons, sessions, settings };
}

async function writeState(state) {
  await redis.set(KEY, state);
  return state;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  // Every request must carry the shared secret.
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    if (req.method === "GET") {
      return res.status(200).json(await readState());
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch {
          return res.status(400).json({ error: "Invalid JSON body" });
        }
      }
      if (!body || typeof body !== "object") {
        return res.status(400).json({ error: "Missing body" });
      }

      const action = body.action;
      const state = await readState(); // read-modify-write so two devices don't clobber

      if (action === "upsert-lesson") {
        const lesson = validateLesson(body.lesson);
        if (!lesson) return res.status(400).json({ error: "Invalid lesson" });
        const idx = state.lessons.findIndex((l) => l && l.id === lesson.id);
        if (idx >= 0) state.lessons[idx] = lesson;
        else {
          if (state.lessons.length >= MAX_LESSONS) return res.status(400).json({ error: "Too many lessons" });
          state.lessons.push(lesson);
        }
        return res.status(200).json(await writeState(state));
      }

      if (action === "delete-lesson") {
        const id = sanitizeId(body.id);
        if (!id) return res.status(400).json({ error: "Missing id" });
        state.lessons = state.lessons.filter((l) => l && l.id !== id);
        return res.status(200).json(await writeState(state));
      }

      if (action === "add-session") {
        const session = validateSession(body.session);
        if (!session) return res.status(400).json({ error: "Invalid session" });
        // Upsert by id so a retried offline write doesn't duplicate.
        const idx = state.sessions.findIndex((s) => s && s.id === session.id);
        if (idx >= 0) state.sessions[idx] = session;
        else {
          if (state.sessions.length >= MAX_SESSIONS) return res.status(400).json({ error: "Too many sessions" });
          state.sessions.push(session);
        }
        return res.status(200).json(await writeState(state));
      }

      if (action === "delete-session") {
        const id = sanitizeId(body.id);
        if (!id) return res.status(400).json({ error: "Missing id" });
        state.sessions = state.sessions.filter((s) => s && s.id !== id);
        return res.status(200).json(await writeState(state));
      }

      if (action === "save-settings") {
        state.settings = validateSettings(body.settings);
        return res.status(200).json(await writeState(state));
      }

      if (action === "replace-all") {
        const data = body.data || {};
        const lessons = (Array.isArray(data.lessons) ? data.lessons : []).map(validateLesson).filter(Boolean).slice(0, MAX_LESSONS);
        const sessions = (Array.isArray(data.sessions) ? data.sessions : []).map(validateSession).filter(Boolean).slice(0, MAX_SESSIONS);
        const settings = validateSettings(data.settings);
        return res.status(200).json(await writeState({ lessons, sessions, settings }));
      }

      return res.status(400).json({ error: "Unknown action" });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("rangelog api error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
