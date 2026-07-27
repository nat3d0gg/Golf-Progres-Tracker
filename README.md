# RangeLog — Golf Range & Lesson Tracker

A mobile-first golf tracker that connects lessons to range practice: lessons
produce homework drills, range sessions log reps against them, and the Prep
screen summarizes everything to show your coach. Now with **live shared sync** —
log on your phone at the range, see it on any other device within seconds.

## Tech

- **`index.html`** — the whole app (HTML/CSS/JS), vanilla, no build step.
- **`api/data.js`** — a single Vercel serverless function:
  - `GET /api/data` → `{ lessons: [...], sessions: [...] }`
  - `POST /api/data` with `{ action }`:
    - `upsert-lesson` `{ lesson }` — create/update
    - `delete-lesson` `{ id }`
    - `add-session` `{ session }` — create (upsert by id, so retried offline
      writes never duplicate)
    - `delete-session` `{ id }`
    - `replace-all` `{ data }` — used by Import
  - All mutations are **server-side read-modify-write**, so two devices editing
    at once never clobber each other.
- **Storage** — Upstash Redis (`@upstash/redis`), one key `rangelog_v1`.

## Live sync & offline

- The client paints instantly from a `localStorage` cache, then reconciles with
  the server and **polls every 15s** (paused when the tab is hidden; also
  refreshes on focus / regained connectivity).
- Every write is **optimistic** and queued in an **outbox** in `localStorage`.
  If the connection drops mid-session (common at a range), the write is applied
  locally and flushed automatically when you're back online — nothing is lost.
- A status pill in the header shows **Live / Saving… / Offline**.
- With no backend configured the app still works fully **local-only** (it just
  stays "Offline"), so `localStorage` remains the fallback.

## Deploy on Vercel

1. Import this repo into Vercel (framework preset: **Other** — no build needed).
2. In the project's **Storage** tab, add **Upstash Redis** (Marketplace). Vercel
   injects the credentials automatically — the function reads either
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` or the
   `KV_REST_API_URL` / `KV_REST_API_TOKEN` names, so no manual env setup.
3. Redeploy. That's it.

> **Note:** the dataset is a single shared log (no accounts), like a shared
> notebook — everyone who knows the password reads and writes the same data.
> That's ideal for one golfer across their own devices.

## Password

The app is gated by a shared password (**default `golf`**). The client sends it
on every request in the `x-rangelog-pass` header; the serverless function checks
it against `RANGELOG_PASSWORD` and rejects anything else with `401`, so the
Upstash data isn't open to the world. To change it, set `RANGELOG_PASSWORD` in
Vercel's environment variables (and update `OFFLINE_PASS` in `index.html` if you
want the local-only fallback to match). It's a lightweight gate for a personal
tracker, not bank-grade auth.

## Data model

```jsonc
{
  "lessons": [
    { "id": "…", "date": "2026-07-10", "focus": "…", "swingThought": "…",
      "drills": [ { "id": "…", "name": "Tempo drill" } ] }
  ],
  "sessions": [
    { "id": "…", "date": "2026-07-15",
      "clubGroups": [ { "group": "Mid Irons", "contact": 4, "flights": ["Pull","Fat"] } ],
      "drillsDone": ["<drillId>"], "note": "…" }
  ]
}
```

## Cost

Vercel Hobby + Upstash free tier. ~4 reads/min per open tab (15s poll), writes
only when you log something — effectively $0.
