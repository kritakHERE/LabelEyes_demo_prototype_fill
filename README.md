# LabelEyes — Skincare Ingredient Companion

LabelEyes is a mobile-first, offline-capable Progressive Web App (PWA) for shoppers in Kathmandu, Nepal. It reads cosmetic ingredient lists on-device, evaluates ingredients deterministically against a user's Skin Lab profile and personal allergens, and displays fictional demo products and Kathmandu Valley demo shops.

## Quick Start

### Prerequisites
- Node.js 22+
- npm 10+

### Local Development
```bash
npm install
cp .env.example .env
npm run seed
npm run dev
```
The Express + Vite dev server listens on **port 3000** (`http://localhost:3000`).

### Production Build & Run
```bash
npm run build
NODE_ENV=production npm start
```

### Tests & Type Checking
```bash
npm run check
```
Runs `tsc --noEmit` and `vitest run` across parser/matcher, compatibility engine, Skin Lab quiz scoring, and REST API tests.

## Demo Accounts
Run `npm run seed` (also seeded automatically on first boot):
- **Demo Shopper**: `demo@labeleyes.example` / `LabelEyesDemo2026!`
- **Demo Steward (Admin)**: `admin@labeleyes.example` / `LabelEyesAdmin2026!`

### Activating Demo Premium
Sign in as any user (or `demo@labeleyes.example`), open **Profile → Plans & billing**, and click **Activate Demo Premium (NPR 149 · 30 days)**, or trigger any paywall (e.g. 4th allergen or 4th OCR scan).

## Environment Variables (`.env.example`)
- `GEMINI_API_KEY`: Optional server-side key for opt-in **Explain Deeper** (`gemini-4-hydrogen` with `ThinkingLevel.HIGH`). Falls back to deterministic curated summaries when absent.
- `VITE_GOOGLE_MAPS_API_KEY`: Google Maps Platform JavaScript API key for Kathmandu Valley shop map.
- `DEMO_MODE`: Enables sandbox checkout & Demo Premium toggle (`true` by default).
- `FREE_OCR_SCANS_PER_MONTH`: Monthly free OCR scan limit (`3`).
- `SESSION_SECRET`: HMAC signing key for `httpOnly` `SameSite=Lax` session cookies.
- `OBF_USER_AGENT`: User-Agent header for Open Beauty Facts barcode lookup (`https://world.openbeautyfacts.org`).

## Repository Map
- `shared/` — Pure deterministic TypeScript parser (`parser.ts`), OCR healer/fuzzy matcher (`matcher.ts`), compatibility engine (`engine.ts`), and 60-question Skin Lab scorer (`quizScorer.ts`).
- `seed/` — Curated INCI ingredient database (`ingredients.json`), 60-question quiz bank (`quiz.json`), 30 fictional demo products (`products.json`), 12 fictional Kathmandu shops (`retailers.json`), interaction rules (`interactions.json`), and non-medical tips (`tips.json`).
- `server/` & `server.ts` — Express REST API, Firebase Admin token verification, file-backed store (`data/store.json`), OBF barcode proxy, and grounded Gemini High Thinking helper.
- `src/` — React + Tailwind CSS + VitePWA frontend with self-hosted Tesseract.js worker (`/public/tessdata`), Google Maps (`@vis.gl/react-google-maps`), and Cloud Firestore sync.
- `tests/` — Vitest unit and REST API test suites.
- `docs/` — Architecture decisions, API reference, privacy notes, licenses, demo script, and QA report.
