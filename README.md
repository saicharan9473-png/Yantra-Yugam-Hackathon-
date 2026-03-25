# IteraGen

**IteraGen** is a prompt-to-app studio: describe an idea, generate an interactive HTML scaffold, run a trust-style quality check with charts, compare two saved versions side by side, and keep a gamified library with badges and feedback.

## Tech stack

- **Frontend:** HTML, CSS, vanilla JavaScript (SVG diagrams, animated UI)
- **Backend:** Node.js with Express
- **Database:** MongoDB (Mongoose models for users, prompts, apps, feedback, achievements)

## App flow

1. **Sign in (`/`)** — Register or sign in with email and password. On success you are redirected to the main dashboard. The JWT is stored in **sessionStorage** for this browser tab (cleared when the tab closes or you sign out).
2. **Main dashboard (`/dashboard.html`)** — Prompt, form builder (“Add module”), generate, trust check, charts, and live preview.
3. **Comparison (`/comparison.html`)** — Two interactive previews, flip cards, charts, deploy A/B (calls `POST /deploy`).
4. **Library (`/library.html`)** — App cards with **Explore** (preview), **Pin** / **Unpin** (`POST /togglePinApp`), and **Generate new** (opens the dashboard).
5. **Profile (`/profile.html`)** — Archive table, badges summary, feedback form with success checkmark (requires sign-in; otherwise you are sent to `/`).

## Features

- **Sign-in screen:** Animated inputs, glowing submit buttons, then redirect to the generator
- **Dashboard:** Prompt + form builder, live `iframe` preview, circular trust gauge, radar chart, benchmark bars
- **Comparison mode:** Two flip-card previews (demo + code slice), deploy actions, dual radar and grouped bar metrics
- **Library:** Zoom-in app cards, pins, animated achievement tiles, efficiency trend chart
- **Profile:** Archive table, feedback form with success animation (auth on `/` only)
- **Dummy generation mode:** `/generateApp` returns a fixed demo scaffold (HTML/CSS/JS) for predictable judging/demo behavior
- **Gamification:** Badges such as First Deploy, Speedy Creator, Innovator, Logic Master

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [MongoDB](https://www.mongodb.com/try/download/community) running locally, or a MongoDB Atlas connection string

## Installation

1. Clone or copy this project and open the folder in a terminal.

2. Install dependencies:

   ```bash
   npm install
   ```

3. Create a `.env` file in the project root (see `.env.example`):

   ```env
   PORT=3000
   MONGODB_URI=mongodb://127.0.0.1:27017/iteragen
   JWT_SECRET=use-a-long-random-string-in-production
   TRAE_API_URL=
   TRAE_API_KEY=
   ```

4. Start MongoDB if you use a local URI (for example the default `mongodb://127.0.0.1:27017/iteragen`).  
   If nothing is listening on that address, the server automatically starts an **in-memory** MongoDB for the session (or set `MONGODB_URI=memory` explicitly). For production, use a real MongoDB instance.

5. Start the server:

   ```bash
   npm start
   ```

6. Open **http://localhost:3000** — you land on **Sign in**. Create an account or sign in, then use **Generator** (`/dashboard.html`), **Library**, and **Comparison**.

## API (HTTP)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/register` | — | Create user |
| `POST` | `/login` | — | Issue JWT |
| `GET` | `/me` | Bearer | Profile + app summaries |
| `POST` | `/generateApp` | Bearer | Prompt → **dummy scaffold** (HTML/CSS/JS), save app |
| `POST` | `/validateApp` | Bearer | Trust score + chart payloads |
| `GET` | `/apps` | Bearer | List saved apps (includes `scaffoldHtml` for previews) |
| `POST` | `/compareApps` | Bearer | Two apps → delta + diagrams |
| `POST` | `/togglePinApp` | Bearer | Toggle pinned app for the user (`{ appId }`) |
| `POST` | `/feedback` | Bearer | Store feedback for an app |
| `POST` | `/deploy` | Bearer | Mark app deployed (gamification) |

Send JSON bodies with `Content-Type: application/json`. For protected routes, add:

`Authorization: Bearer <token_from_login_or_register>`

## Project layout

- `server.js` — Express app and routes
- `models/` — Mongoose schemas
- `middleware/` — JWT guard
- `services/` — TRAE client, local scaffold builder, trust scoring, gamification
- `public/` — Static UI (`index.html` sign-in, `dashboard.html` generator, `comparison.html`, `library.html`, `profile.html`, `css/`, `js/`)

## License

Use your own license for production. This sample is provided as a starting point for coursework or prototyping.
