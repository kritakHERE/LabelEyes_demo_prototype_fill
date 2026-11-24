# LabelEyes — Complete Technical & Architectural Documentation (`docs.md`)

**LabelEyes** is an offline-capable, mobile-first Progressive Web App (PWA) and Express API designed to help shoppers (with local discovery tailored to Kathmandu Valley, Nepal) scan cosmetic ingredient lists on-device, evaluate compatibility deterministically against a personal skin profile and allergen list, and explore local demo products and shops.

---

## Table of Contents
1. [High-Level Architecture & Working Mechanism](#1-high-level-architecture--working-mechanism)
2. [Runtime & Dependency Versions](#2-runtime--dependency-versions)
3. [Core Mechanics](#3-core-mechanics)
4. [Dataflow Walkthroughs](#4-dataflow-walkthroughs)
5. [Storage & Persistence Architecture](#5-storage--persistence-architecture)
6. [Frontend Rendering, Routing & Styling](#6-frontend-rendering-routing--styling)
7. [Environments & Configuration Variables](#7-environments--configuration-variables)
8. [Complete File-by-File Reference](#8-complete-file-by-file-reference)
9. [How to Run Outside This Environment](#9-how-to-run-outside-this-environment)

---

## 1. High-Level Architecture & Working Mechanism

LabelEyes runs as a **unified single-port Node.js application** (`port 3000` by default, or `process.env.PORT`) combining an Express REST backend with a React + Vite Single-Page Application (SPA):

```
┌───────────────────────────────────────────────────────────────────────────┐
│ Browser / Installed PWA (Android Chrome, iOS Safari, Desktop)             │
│                                                                           │
│  React 19 UI (Hash Router) ──► On-Device OCR (Canvas + Tesseract WASM)    │
│       │                        On-Device Barcode (@zxing/browser)         │
│       │                        Guest State (localStorage)                 │
│       │                        Offline Cache (Workbox Service Worker)     │
│       ├──► Firebase Auth (Google Sign-In Popup) + Cloud Firestore Sync    │
│       └──► Google Maps Platform (@vis.gl/react-google-maps)               │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │ HTTP JSON (/api/*) + Bearer Token / Cookie
                                ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ Express Server (server.ts) — Port 3000                                    │
│                                                                           │
│  • Auth Middleware (Firebase ID token verify + HMAC le_session cookie)    │
│  • Shared Deterministic Engine (shared/parser, matcher, engine, quiz)     │
│  • JSON File Store (data/store.json) + Seed Catalogs (seed/*.json)        │
│  • Open Beauty Facts Proxy (/api/barcode/:ean, 24h cache, 8s timeout)     │
│  • Opt-in Gemini High Thinking Proxy (/api/ai/explain -> server/ai.ts)    │
│  • Dev Mode: Vite Middleware (HMR/on-the-fly TSX)                         │
│  • Prod Mode: Static dist/ + SPA fallback                                 │
└───────────────────────────────────────────────────────────────────────────┘
```

### Key Architectural Principles
1. **Determinism Over LLM Guesswork**: Compatibility verdicts (`allergen`, `caution`, `suitable`), ingredient badges (`red`, `amber`, `green`, `neutral`, `unknown`), product match scores, and routine overlap warnings are computed purely by deterministic TypeScript rules in `shared/`. Gemini (`gemini-4-hydrogen` with `ThinkingLevel.HIGH`) is strictly opt-in via **"Explain deeper"** and never alters a verdict.
2. **On-Device Privacy for Photos**: Camera captures and uploaded photos are preprocessed on an HTML5 `<canvas>` and read locally by `tesseract.js` WebAssembly workers served from `/public/tessdata/`. Raw label images are **never** uploaded to the backend or stored in Firestore.
3. **Graceful Degradation (Zero-Key Operation)**: Without `GEMINI_API_KEY`, `VITE_GOOGLE_MAPS_API_KEY`, or Google login, the app still runs completely via deterministic fallback explanations, a synchronized shop list with external Google Maps direction links, email/password accounts, and full Guest Mode.

---

## 2. Runtime & Dependency Versions

### Verified Runtime Environment
| Component | Version in Workspace | Minimum Recommended |
|---|---|---|
| **Node.js** | `v22.23.5` (supports native TypeScript type-stripping in `node server.ts`) | **Node.js 22.18+ / 22.x LTS** (required to execute `.ts` files directly in `npm start`) |
| **npm** | `10.9.9` | **npm 10+** |
| **Module System** | `"type": "module"` (ESM) | ESM |

### Production Dependencies (`package.json`)
| Package | Version | Purpose |
|---|---|---|
| `react` / `react-dom` | `^19.0.1` | Frontend UI rendering & hooks |
| `express` | `^4.21.2` | HTTP API server, cookies, static asset hosting |
| `vite` | `^8.3.0` | Frontend bundler & dev middleware |
| `vite-plugin-pwa` | `^2.0.0` | Workbox service worker & Web App Manifest generation |
| `@tailwindcss/vite` | `^4.3.3` | Tailwind CSS v4 Vite integration |
| `firebase` | `^13.3.0` | Client Google Sign-In & Cloud Firestore persistence |
| `firebase-admin` | `^14.5.1` | Server-side verification of Firebase ID Bearer tokens |
| `@google/genai` | `^3.3.0` | Server-side Gemini High Thinking (`gemini-4-hydrogen`) client |
| `@vis.gl/react-google-maps` | `^1.10.2` | Interactive Google Maps (`AdvancedMarker`, `InfoWindow`) |
| `tesseract.js` | `^7.0.0` | On-device WASM OCR engine |
| `@zxing/browser` | `^0.2.1` | On-device EAN barcode decoding from uploaded images |
| `lucide-react` | `^0.546.0` | Accessible UI icons |
| `motion` | `^12.23.24` | Animation dependency installed in workspace |
| `dotenv` | `^17.2.3` | Loads `.env` into `process.env` at server startup |
| `vitest` | `^5.1.0` | Unit and REST API integration test runner |
| `eslint` | `^10.14.0` | Lints `firestore.rules` with security-rules plugin |
| `@firebase/eslint-plugin-security-rules` | `^0.0.2` | Static security audit for Firestore rules |

### Development Dependencies (`package.json`)
| Package | Version | Purpose |
|---|---|---|
| `typescript` | `^7.0.2` | Type checking (`tsc --noEmit`) |
| `tsx` | `^4.21.0` | Runs `server.ts` (`npm run dev`) & `scripts/seed.ts` (`npm run seed`) |
| `tailwindcss` | `^4.3.3` | Tailwind CSS v4 core |
| `esbuild` | `^0.28.2` | Fast JS/TS bundling for Vite 8 |
| `autoprefixer` | `^10.4.21` | CSS vendor prefixing |
| `@types/node` | `^22.14.0` | Node.js TypeScript definitions |
| `@types/express` | `^4.17.21` | Express TypeScript definitions |
| `@types/react` / `@types/react-dom` | `^19.3.0` | React 19 TypeScript definitions |

---

## 3. Core Mechanics

### 3.1 On-Device OCR (`src/lib/ocr.ts`)
1. Accepts a `File`, `Blob` (from `<video>` camera capture), or URL (bundled `/samples/sample-*.png`).
2. Loads the image into an offscreen HTML5 `<canvas>`, capping the longest edge at **1400 px**.
3. Converts RGB pixels to BT.601 grayscale (`0.299R + 0.587G + 0.114B`) and computes a 256-bin luminance histogram.
4. Applies a **5th-to-95th percentile contrast stretch** to improve legibility on curved or dimly lit bottles.
5. Spawns a `tesseract.js` Web Worker configured to load **100% locally** from `/public/tessdata/` (`worker.min.js`, SIMD/LSTM `.wasm`, and `eng.traineddata.gz`) — zero external CDN dependency.
6. Streams progress events (`10% -> 100%`) and supports mid-run cancellation via `AbortController`.

### 3.2 Ingredient Parsing & Fuzzy Matching (`shared/parser.ts` & `shared/matcher.ts`)
1. **Line-Wrap Repair**: Rejoins hyphenated line breaks (`Sodium Hyalu-\nronate` -> `Sodium Hyaluronate`).
2. **Section Extraction**: Locates headers (`Ingredients:`, `INCI -`, `Composition:`, Nepali `सामग्री:`, or fallback `Contains:`) and discards preceding marketing copy.
3. **Parenthesis-Safe Splitting**: Splits on `,`, `;`, `•`, `·`, `|`, and `\n` only when parenthesis/bracket depth is `0` (preserving names like `Butyrospermum Parkii (Shea) Butter`), while handling `[+/-]` / `May contain` markers and stripping trailing footnotes (`For external use...`, `Batch...`).
4. **Normalization & OCR Healing**: Lowercases text, strips punctuation, normalizes `0 -> o`, `1 -> i`, `\brn -> m`, and heals frequent OCR corruptions (`glycerln -> glycerin`, `niacinamlde -> niacinamide`, `phenoxyethanoi -> phenoxyethanol`, `cetearyi -> cetearyl`, `linalooi -> linalool`).
5. **Candidate Matching**: Checks full token, parentheses-stripped token, and inner-parentheses text against an indexed dictionary (`buildIngredientIndex`) of **330** INCI records + aliases:
   - **Exact match** returns `score: 100`.
   - **Fuzzy match** uses Levenshtein similarity ratio (`>= 88`, length delta `<= 4`). If the runner-up is within `2` points and top score `< 96`, `ambiguous: true` is flagged.

### 3.3 Deterministic Compatibility Engine (`shared/engine.ts`)
Every parsed ingredient is evaluated in a strict priority order:
1. **`RED` (Personal Allergen / Sensitivity)**: Checked against the user's saved `allergens` by `ingredientId`, `groupId` (e.g., `fragrance` catches `Parfum` plus all 26 EU fragrance allergens), or `customText` (substring or word similarity `>= 86`).
   - *Rule*: Guests with no profile and no saved allergens never see `RED`.
2. **`UNKNOWN`**: Token not found in `seed/ingredients.json` + `store.customIngredients`.
3. **Guest Mode (No Quiz Profile)**:
   - Fragrance / EU allergens -> `NEUTRAL` (`Fragrance note`).
   - `irritation_risk === 'none'` and (`benefits_for.length >= 3`, `humectant`, or `ceramide_lipid`) -> `GREEN` (`Generally supportive`).
   - Everything else -> `NEUTRAL`.
4. **`AMBER` (Profile-Matched Caution)**:
   - `sensitivity` is `medium` or `high` AND (`irritation_risk` is `moderate`/`high`, OR ingredient is in `fragrance` / `fragrance_allergen_eu`).
   - `skinType === 'oily'` or `acne_prone` AND `comedogenic_concern` is `moderate`/`high`.
   - `skinType === 'dry'` or `dehydrated` AND `drying_concern` is `moderate`/`high` **EXCEPT** when the ingredient belongs to `fatty_alcohol` (creamy fatty alcohols like `Cetyl Alcohol` and `Cetearyl Alcohol` are explicitly protected from drying flags).
5. **`GREEN` (Supportive)**: `benefits_for` includes `profile.skinType` OR `helps_concerns` overlaps `profile.concerns`.
6. **`NEUTRAL`**: Recognized ingredient with no special flag for this user.

**Overall Product Verdict**:
- `counts.red > 0` -> `allergen` (Red banner)
- Else `counts.amber > 0` -> `caution` (Amber banner)
- Else -> `suitable` (Green banner; labeled `"General ingredient breakdown"` for guests)
- **Low Confidence Banner**: Shown when `tokens.length === 0`, `unknown_share > 0.30`, or `ocrConfidence < 70`.

**Match Score (`computeMatchScore`)**: Starts at `100` (returns `0` immediately if `counts.red > 0`), subtracts `8` per top-5 `amber` or `4` per lower `amber`, adds `+3` per top-10 `green` (`+1` otherwise) and `+4` per distinct user concern covered, clamped to `0–100`.

### 3.4 Skin Lab 60-Question Scoring Engine (`shared/quizScorer.ts`)
- Consists of **8 modules** (`core` = 20 questions + 7 optional modules = 60 questions total).
- Supports conditional branching (`getVisibleQuestions`):
  - `C18` only appears if `C17` wasn't `"No"`.
  - `S04` (sensitivity floor) requires explicit `sensitiveConsent`.
  - `A08` (severity) appears only if earlier answers generated `suggest:` effects.
- Sums 9 numeric axes (`OIL`, `DRY`, `SENS`, `ACNE`, `PIG`, `AGE`, `BAR`, `SUN`, `POLL`) plus flags (`TZONE`, `condition_flag`, `dehydrated_oily`) and human-readable `"Because you said..."` reason strings.
- Calculates confidence: Core module yields up to `60%`, plus `+1%` per answered optional question up to `100%`.
- Manual `overrides` (`skinType`, `sensitivity`, `concerns`) persist even when a user retakes quiz modules until explicitly cleared.
- Trigger suggestions (`suggest:<id>`) are returned to the UI for **explicit user approval** and are never silently added to the allergen list.

### 3.5 Opt-In Grounded AI Explainer (`server/ai.ts`)
- Endpoint: `POST /api/ai/explain` (rate-limited `15/min`).
- Calls Google GenAI SDK (`model: 'gemini-4-hydrogen'`, `thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH }`) grounded solely in the ingredient/interaction record and deterministic status.
- Runs a post-generation regex sanitizer replacing forbidden terms (`safe`, `unsafe`, `toxic`, `harmful`, `dangerous`, `cure`, `cures`, `diagnose`, `treat`, `treats`) with neutral cosmetic phrasing.
- Caches responses in an in-memory `Map` (`aiCache`).
- If `GEMINI_API_KEY` is missing, placeholder, or errors, returns a clean `deterministic_fallback` summary built directly from curated fields.

### 3.6 Freemium Quotas & Idempotent Sandbox Checkout (`server.ts`)
| Feature | Guest | Free Account | Premium (NPR 149 / 30d) |
|---|---|---|---|
| Manual Paste / Sample Scans | Unlimited | Unlimited | Unlimited |
| On-Device OCR Camera/Upload Scans | 1 (tracked in `localStorage`) | 3 / month (tracked server-side in `usageCounters`) | Unlimited |
| Saved Allergens / Sensitivities | 3 | 3 (HTTP `402` on 4th) | Unlimited |
| Scan History | Last 5 (`localStorage`) | Last 5 | Unlimited + Compare |
| Discover Product Matches | Top 3 | Top 3 | Full catalog + per-shop prices |
| AM/PM Routines & Overlap Check | Locked (`402`) | Locked (`402`) | Unlocked |

Checkout (`POST /api/checkout`) enforces an `idempotencyKey` map (`paymentIdempotency`), and callbacks (`POST /api/payments/callback/:provider` for `khalti`, `esewa`, `mock`) are idempotent on replay. When `DEMO_MODE !== 'false'`, `POST /api/demo/activate-premium` immediately grants 30-day Premium.

---

## 4. Dataflow Walkthroughs

### 4.1 Authentication & Identity Resolution (`server/auth.ts` + `src/lib/api.ts`)
Every `apiFetch()` call from the browser automatically attaches:
1. `Authorization: Bearer <firebaseIdToken>` if `auth.currentUser` is signed into Firebase.
2. `credentials: 'include'` so the browser sends the `le_session` `httpOnly`, `SameSite=Lax` cookie if signed in via email/password.

On the server, `attachCurrentUser`:
1. Checks `Authorization: Bearer ...` first via `verifyFirebaseBearerToken()` (`firebase-admin/auth`).
   - Requires `email_verified !== false`.
   - Looks up user by `firebaseUid`. Never auto-links to an existing password account by email alone (prevents account takeover; explicit linking uses `POST /api/auth/google/link`). Creates `fb_<uid>` if new, granting `role: 'admin'` if email is `aethorsolis@gmail.com`.
2. Otherwise verifies the HMAC-SHA256 signature and expiration of the `le_session` cookie using `timingSafeEqual`.
3. Sets `req.currentUser` (or `null` for guests).

### 4.2 End-to-End Label Scan Flow
```
User picks Photo / Camera / Sample / Paste / Barcode
   │
   ├─► [Photo/Camera] ─► Canvas preprocess (1400px, contrast stretch)
   │                        └─► Tesseract WASM (/public/tessdata) ─► rawText + confidence
   ├─► [Barcode] ──────► @zxing/browser or EAN input ─► GET /api/barcode/:ean
   │                        └─► Demo catalog -> 24h obfCache -> Open Beauty Facts API
   └─► [Sample/Paste] ─► rawText ready
           │
           ▼
   Review & Edit Screen (user can fix OCR typos before submitting)
           │
           ▼
   POST /api/analyze (sends text, source, productName, ocr_confidence, + guestProfile/guestAllergens if guest)
           │
           ├─► Checks server OCR quota if authenticated & source === 'ocr' & !premium
           ├─► Runs analyzeIngredientText() using shared/parser + matcher + engine
           ├─► If authenticated: saves scan record to data/store.json & client mirrors metadata to Firestore
           └─► If guest: saves last 5 scans to localStorage (`labeleyes_guest_state_v1`)
                   │
                   ▼
   ResultPage renders VerdictBanner + Low-Confidence Banner + Counts + Filterable List
           │
           └─► Tap Ingredient ─► IngredientDrawer ─► Optional POST /api/ai/explain
```

### 4.3 Guest-to-Account Migration Flow
A guest can complete the Skin Lab quiz and add up to 3 allergens without signing in (stored in `localStorage`). As soon as they sign in with Google or Email/Password, `AppContext.tsx` detects `guestState.profile.hasProfile || guestState.allergens.length > 0` and automatically calls `POST /api/profile/import`, persisting their quiz answers, scored profile, and allergens to the server and clearing guest profile state.

---

## 5. Storage & Persistence Architecture

LabelEyes uses a **hybrid four-layer persistence model**:

### 5.1 Static Curated Seed Files (`/seed/`)
Loaded once at server boot into memory by `server/store.ts`:
- `seed/ingredients.json` — **330** curated cosmetic INCI records (expanded from 130; includes humectants, barrier lipids, peptides, amino acids, modern & classic UV filters, exfoliating acids, retinoids, surfactants, emulsifiers, preservatives, silicones, K-beauty ferments, and South Asian botanicals). Each record includes `id`, `inci`, `aliases`, `functions`, `description`, `groups`, `irritation_risk`, `comedogenic_concern`, `drying_concern`, `benefits_for`, `helps_concerns`, `caution_notes`, `interaction_groups`, and `source_note`.
- `seed/quiz.json` & `seed/quiz.schema.json` — **8** modules and **60** Skin Lab questions (`20` core + `40` optional) with branching rules and effect strings.
- `seed/products.json` — **30** fictional demo products across 7 skincare categories with NPR demo prices and `isDemo: true`.
- `seed/retailers.json` — **12** fictional Kathmandu Valley demo shops (`pharmacy`, `cosmetic_shop`, `supermarket`), 2 marked `sponsored: true`, with GPS coordinates and stock prices.
- `seed/interactions.json` — **4** routine active-overlap rules (`retinoid + exfoliating_acid`, `retinoid + benzoyl_peroxide`, `exfoliating_acid + exfoliating_acid`, `vitamin_c_ascorbic + exfoliating_acid`).
- `seed/tips.json` — **7** rotating non-medical skincare tips.

### 5.2 Server File Store (`/data/store.json` & `/data/session.secret`)
Managed synchronously by `server/store.ts` (`getStore()`, `saveStore()`):
- Stores `users` (with `scrypt` salted password hashes `16B salt : 64B hex`), `profiles`, `profileHistory` (max 20 snapshots/user), `quizStates`, `allergens`, `scans` (max 200/user), `usageCounters` (`YYYY-MM -> count`), `routines`, `subscriptions`, `payments`, `paymentIdempotency`, `ingredientReports`, `events` (ring-capped at 4000–5000), `obfCache` (24h barcode cache), and `customIngredients`.
- Auto-seeds `demo@labeleyes.example` and `admin@labeleyes.example` via `ensureDemoSeeds()`.
- `data/session.secret` stores an auto-generated 32-byte hex HMAC key if `SESSION_SECRET` env var is unset or `< 16` chars.

### 5.3 Cloud Firestore & Firebase Auth (`firebase-applet-config.json`, `firestore.rules`, `firebase-blueprint.json`)
- **Project**: `gen-lang-client-0611771944`
- **Named Firestore Database**: `ai-studio-e6d15a59-cda3-4903-89a3-18620d4eebb2` (configured via `getFirestore(app, firebaseConfig.firestoreDatabaseId)` in `src/lib/firebase.ts`).
- **Firestore Collections**:
  - `/users/{userId}` — `UserAccount` (`uid`, `email`, `displayName`, `role`, `createdAt`)
  - `/users/{userId}/profile/{docId}` — `SkinProfile` (`userId`, `skinType`, `sensitivity`, `concerns`, `conditionFlag`, `confidence`, `updatedAt`)
  - `/users/{userId}/allergens/{allergenId}` — `AllergenEntry`
  - `/users/{userId}/scans/{scanId}` — `ScanRecord` (text/verdict metadata only — **no images**)
  - `/users/{userId}/routines/{routineId}` — `RoutineEntry`
  - `/ingredientReports/{reportId}` — User-submitted missing ingredient reports
  - `/admins/{adminUid}` — Admin lookup collection (plus `request.auth.token.email == 'aethorsolis@gmail.com'`)
- **Security Rules (`firestore.rules`)**: Verified with `@firebase/eslint-plugin-security-rules`. Enforces owner-only reads/writes, `email_verified == true`, strict `keys().hasAll` / `keys().hasOnly` field allowlists, immutable `createdAt == request.time`, and prevents self-escalation to `role: 'admin'`.
- **Important Sync Note**: `src/lib/firestoreSync.ts` mirrors authenticated Firebase users' accounts, profiles, allergens, scans, and routines into Cloud Firestore as non-blocking writes alongside the Express `data/store.json` API store. Express remains the authoritative source for API reads, quotas, email auth, and payments.

### 5.4 Browser Local Storage & PWA Caches
- **`localStorage` keys**:
  - `labeleyes_guest_state_v1` — Onboarding status, consent flags, guest quiz answers, guest profile, up to 3 guest allergens, last 5 guest scans, and `guestOcrScansUsed`.
  - `le_lang` (`'en'` | `'ne'`), `le_dark` (`'true'` | `'false'`), `le_scale` (`1` | `1.12` | `1.25`), `le_motion` (`'true'` | `'false'`).
- **Workbox Service Worker (`vite.config.ts`)**:
  - Precaches app shell (`js`, `css`, `html`, `ico`, `png`, `svg`, `woff2`) up to 4 MB/file, excluding `/tessdata/**`, `/samples/**`, and `/assets/aistudio/**` from upfront precache.
  - Runtime cache `labeleyes-assets-cache`: `CacheFirst` (90 days, 20 entries) for `/tessdata/*` and `/samples/*`.
  - Runtime cache `labeleyes-api-cache`: `NetworkFirst` (7 days, 50 entries) for `/api/(quiz|ingredients|products|retailers|plans)`.

---

## 6. Frontend Rendering, Routing & Styling

- **Boot Sequence**: `index.html` (mobile PWA meta tags, `#2F5D2A` theme color) -> `src/main.tsx` (registers `window.gm_authFailure` and `console.error` listeners to emit `gmp-quota-exceeded` events when Google Maps demo quota is hit, mounts `<StrictMode><App /></StrictMode>`).
- **Error Boundary & Context**: `src/App.tsx` wraps `<AppProvider>` in `<AppErrorBoundary>` so runtime UI errors offer a safe recovery button back to `#/home`.
- **Client-Side Hash Routing**: `AppContext.tsx` manages routes via `window.location.hash` (`#/`, `#/onboarding`, `#/consent`, `#/home`, `#/skin-lab`, `#/skin-lab/quiz/:modId`, `#/skin-lab/results`, `#/scan`, `#/result`, `#/discover`, `#/discover/product/:id`, `#/discover/shop/:id`, `#/profile`, `#/allergens`, `#/history`, `#/routines`, `#/plans`, `#/settings`, `#/admin`, plus static info routes). Hash routing ensures static/PWA offline navigation works without server rewrite failures.
- **Lazy Code Splitting**: `ScanPage`, `DiscoverPage`, `ProductDetailPage`, and `ShopDetailPage` are loaded via `React.lazy()` + `<Suspense fallback={<SkeletonRows count={4} />}>` to keep initial bundle size fast.
- **Responsive Shell**:
  - Mobile (`< md`): Sticky top header (`BrandLogo` + `Skin Lab` shortcut) + single-column `max-w-[680px]` main area + fixed 4-tab bottom navigation (`Home`, `Scan`, `Discover`, `Profile`).
  - Desktop (`>= md`): Adds a persistent `w-56` left navigation rail (`max-w-[1100px]` centered shell).
- **Theming & Accessibility (`src/index.css`)**:
  - Warm cream `#fbf6ec` (`--le-bg`), soft card cream `#f1ebdd` (`--le-surface`), deep olive `#1f2a1c` (`--le-text`), botanical green `#2f5d2a` (`--le-primary`), hibiscus terracotta `#c2452d` (`--le-accent`), with full `.dark` overrides.
  - Self-hosted `.woff2` fonts (`Plus Jakarta Sans` headings, `DM Sans` body, `Noto Sans Devanagari` for Nepali, `JetBrains Mono` tabular figures).
  - Supports text scaling (`100%`, `112%`, `125%`), `reduce-motion`, `prefers-reduced-motion`, skip-to-content link, `aria-live` status banners, and icon+color+label pairing (`StatusIcon` + `StatusPill`) so color is never the sole indicator.
- **Google Maps (`src/components/ui/KathmanduShopMap.tsx`)**:
  - Uses `@vis.gl/react-google-maps` (`APIProvider`, `GoogleMap`, `AdvancedMarker`, `Pin`, `InfoWindow`, `mapId="DEMO_MAP_ID"`).
  - Falls back cleanly to a shop list + Google Maps external directions links if `VITE_GOOGLE_MAPS_API_KEY` is empty or `quotaExceeded` is triggered.

---

## 7. Environments & Configuration Variables

Defined in `.env.example` and read by `server.ts`, `server/auth.ts`, `server/store.ts`, `server/ai.ts`, and `src/components/ui/KathmanduShopMap.tsx`:

| Variable | Side | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | Server | `""` | Google Gemini API key for opt-in `Explain deeper` (`gemini-4-hydrogen`, `ThinkingLevel.HIGH`). Absent/placeholder triggers deterministic fallback. |
| `APP_URL` | Server | `http://localhost:3000` | Public URL reference for hosting environment. |
| `PORT` | Server | `3000` | HTTP listen port (`0.0.0.0:$PORT`). |
| `NODE_ENV` | Server | `development` | `'production'` serves built `dist/` instead of Vite dev middleware and marks `le_session` cookie `Secure`. |
| `VITE_GOOGLE_MAPS_API_KEY` | Client (**Build-time**) | `""` | Google Maps JS API key. **Must be set before `npm run build`** because Vite inlines `VITE_*` vars into static JS bundles. |
| `DEMO_MODE` | Server | `"true"` | Enables `POST /api/demo/activate-premium` and `"Demo"` banner flags (`!== 'false'`). |
| `FREE_OCR_SCANS_PER_MONTH` | Server | `"3"` | Monthly server-enforced OCR scan quota for free authenticated users. |
| `GUEST_OCR_SCANS_LIMIT` | Client/Config | `"1"` | Guest trial OCR limit reference (enforced client-side in `AppContext.tsx` as `1`). |
| `OCR_MODE` | Config | `"local"` | Documents on-device Tesseract OCR mode. |
| `SESSION_SECRET` | Server | Auto-generated file | HMAC-SHA256 secret (`>= 16` chars) for signing `le_session` cookies. Falls back to `data/session.secret`. |
| `OBF_USER_AGENT` | Server | `LabelEyes/1.0 (https://labeleyes.example)` | Required polite `User-Agent` header sent to Open Beauty Facts API v2. |
| `DEMO_USER_PASSWORD` | Server | `LabelEyesDemo2026!` | Optional override for seeded `demo@labeleyes.example` account password. |
| `DEMO_ADMIN_PASSWORD` | Server | `LabelEyesAdmin2026!` | Optional override for seeded `admin@labeleyes.example` steward account password. |
| `DISABLE_HMR` | Vite | `undefined` | When `'true'`, disables Vite HMR & file watching (`vite.config.ts`). |

---

## 8. Complete File-by-File Reference

### 8.1 Root Configuration & Entry Files
| File | Role |
|---|---|
| `package.json` | Defines npm scripts (`dev`, `start`, `build`, `preview`, `clean`, `lint`, `test`, `seed`, `check`) and ESM `"type": "module"` dependencies. |
| `tsconfig.json` | TypeScript config (`ES2022`, `moduleResolution: "bundler"`, `allowImportingTsExtensions: true`, `noEmit: true`, `@/*` alias). |
| `vite.config.ts` | Configures React plugin, Tailwind CSS v4 plugin, `VitePWA` (Workbox precache + runtime caching + Web App Manifest), and conditional HMR. |
| `index.html` | SPA HTML shell with SEO/OpenGraph metadata, iOS/Android PWA tags, `#2F5D2A` theme color, and `/src/main.tsx` script. |
| `metadata.json` | AI Studio applet manifest declaring app name, description, `["camera", "geolocation"]` frame permissions, and server-side Gemini capability. |
| `.env.example` | Template of all supported environment variables without real secrets. |
| `.gitignore` | Ignores `node_modules/`, `dist/`, `build/`, `coverage/`, logs, and `.env*` (preserving `.env.example`). |
| `eslint.config.js` | Flat ESLint config loading `@firebase/eslint-plugin-security-rules` to audit `firestore.rules`. |
| `firebase-applet-config.json` | Public Firebase client project config (`projectId`, `apiKey`, `authDomain`, `firestoreDatabaseId`, `appId`, `oAuthClientId`). |
| `firebase-blueprint.json` | JSON Schema entity definitions and collection path map for Firestore security rule validation. |
| `firestore.rules` | Hardened Firestore Security Rules enforcing verified auth, ownership, schema validation, and anti-escalation guards. |
| `security_spec.md` | Firestore security invariants and "Dirty Dozen" adversarial test matrix. |
| `README.md` | Concise quick-start overview and repository summary. |
| `docs.md` | This comprehensive technical reference document. |
| `eng.traineddata` | Root Tesseract English traineddata artifact (runtime worker uses gzipped `/public/tessdata/eng.traineddata.gz`). |

### 8.2 Backend & Scripts (`/server.ts`, `/server/*`, `/scripts/*`, `/data/*`)
| File | Role |
|---|---|
| `server.ts` | Express application factory (`createApp()`), security headers, privacy-safe request logger, all REST API endpoints (`/api/health`, `/api/auth/*`, `/api/quiz*`, `/api/profile*`, `/api/allergens*`, `/api/analyze`, `/api/scans*`, `/api/barcode/:ean`, `/api/products*`, `/api/retailers*`, `/api/routines*`, `/api/checkout`, `/api/payments/*`, `/api/demo/*`, `/api/admin/analytics`, `/api/ai/explain`), and dev/prod server launcher (`startServer()`). |
| `server/auth.ts` | Session & auth middleware: HMAC-SHA256 `le_session` token signing/verification, `timingSafeEqual`, cookie parsing, `attachCurrentUser` (Firebase Bearer ID token -> cookie fallback), `requireAuth`, `requireAdmin`, and sliding-window in-memory `rateLimit()`. |
| `server/store.ts` | Loads `seed/*.json` into memory, manages `data/store.json` atomic read/write, hashes/verifies passwords via Node `crypto.scryptSync`, evaluates subscription status (`isUserPremium`, `getSubscriptionSummary`), auto-seeds demo/admin users (`ensureDemoSeeds`), and logs funnel events. |
| `server/firebaseAdmin.ts` | Initializes `firebase-admin` app with `firebaseConfig.projectId` and exposes `verifyFirebaseBearerToken()` for verifying client ID tokens. |
| `server/ai.ts` | Grounded explainer calling `@google/genai` (`gemini-4-hydrogen`, `ThinkingLevel.HIGH`), enforcing forbidden-word sanitization, caching results, and falling back to deterministic summaries when offline or keyless. |
| `scripts/seed.ts` | CLI script (`npm run seed`) initializing `data/store.json` with seeded demo & steward accounts and printing demo credentials. |
| `data/store.json` | Runtime JSON database created on first boot/seed (users, profiles, allergens, scans, routines, payments, OBF cache, reports, events). |
| `data/session.secret` | Auto-generated 64-char hex fallback secret for signing session cookies when `SESSION_SECRET` is not set in `.env`. |

### 8.3 Shared Isomorphic Deterministic Engine (`/shared/*`)
Used identically by **both** the Express backend and the React frontend (plus Vitest tests):
| File | Role |
|---|---|
| `shared/types.ts` | All shared TypeScript interfaces and union types (`IngredientRecord`, `SkinProfile`, `AnalysisResult`, `QuizBank`, `DemoProduct`, `DemoRetailer`, `InteractionRule`, etc.). |
| `shared/parser.ts` | Header extractor (`extractIngredientSection`), parenthesis-safe tokenizer (`splitRespectingParens`), and label cleaner (`parseIngredients`). |
| `shared/matcher.ts` | String normalizer, OCR typo healer (`applyOcrHeuristics`), Levenshtein edit distance & similarity ratio, `buildIngredientIndex`, `matchIngredient`, and `matchesCustomAllergen`. |
| `shared/engine.ts` | `INGREDIENT_GROUPS` (13 trigger groups), `DEFAULT_GUEST_PROFILE`, deterministic analyzer (`analyzeIngredientText`), product ranker (`computeMatchScore`), and routine active-overlap checker (`checkRoutineInteractions`). |
| `shared/quizScorer.ts` | Branching evaluator (`getVisibleQuestions`), deterministic 9-axis scorer (`scoreQuiz`), confidence calculator, manual-override applier, allergen suggestion builder, and `diffProfileSnapshots`. |

### 8.4 Frontend Application (`/src/*`)
| File | Role |
|---|---|
| `src/main.tsx` | Mounts React app inside `<StrictMode>` and registers `gm_authFailure` + quota console error hooks for Maps fallback. |
| `src/index.css` | Tailwind CSS v4 import, `@font-face` declarations for 4 self-hosted fonts, CSS theme tokens (`:root` and `.dark`), reduced-motion rules, and scan animation keyframes. |
| `src/App.tsx` | `AppErrorBoundary`, `Shell` layout (sticky banners, top header, desktop rail, mobile bottom nav, toast banner, `<PaywallModal />`), hash-route switcher, and `React.lazy` route splitting. |
| `src/context/AppContext.tsx` | Central state provider (`AppProvider` / `useApp`): auth state, guest-vs-server state routing, quiz progress, scan execution, allergen management, Firestore mirroring triggers, paywall modal state, theme/font/language settings, JSON export, and account deletion. |
| `src/lib/api.ts` | `apiFetch<T>()` wrapper injecting Firebase Bearer token (when signed in) and `credentials: 'include'`, throwing typed `ApiError` (preserving HTTP `402` paywall metadata). |
| `src/lib/firebase.ts` | Initializes Firebase Web SDK (`auth`, `googleProvider`, named Firestore `db`), structured `handleFirestoreError`, and `testFirestoreConnection()`. |
| `src/lib/firestoreSync.ts` | Helper functions (`syncFirebaseUserAccount`, `syncFirebaseProfile`, `syncFirebaseAllergen`, `deleteFirebaseAllergen`, `syncFirebaseScan`, `syncFirebaseRoutine`) writing client-side Firestore documents compliant with `firestore.rules`. |
| `src/lib/guestStorage.ts` | Reads/writes/clears `labeleyes_guest_state_v1` in `localStorage`. |
| `src/lib/ocr.ts` | On-device Canvas preprocessing (`preprocessImageOnCanvas`) and local Tesseract.js worker runner (`runOnDeviceOcr`). |
| `src/i18n/index.ts`, `en.json`, `ne.json` | English & Nepali UI string dictionaries (`getDictionary`). |
| `src/components/ui/Primitives.tsx` | Reusable accessible UI primitives (`Button`, `Card`, `StatusIcon`, `StatusPill`, `VerdictBanner`, `ProgressBar`, `ConfidenceRing`, `EmptyState`, `SkeletonRows`, `BottomSheet`, `DisclaimerFooter`). |
| `src/components/ui/BrandLogo.tsx` | Custom inline SVG `BrandLogo` and `BotanicalLeafMotif`. |
| `src/components/ui/IngredientDrawer.tsx` | Bottom-sheet inspection drawer for a tapped ingredient, featuring opt-in **"Explain deeper"** (`/api/ai/explain`) and **"Report this ingredient"** (`/api/ingredient-reports`). |
| `src/components/ui/KathmanduShopMap.tsx` | Interactive Google Maps component (`APIProvider`, `GoogleMap`, `AdvancedMarker`, `InfoWindow`) with geolocation button and quota/no-key graceful fallback. |
| `src/components/ui/PWAInstallButton.tsx` | Captures `beforeinstallprompt` for one-tap PWA installation (`PWAInstallButton`) and renders offline status notice (`OfflineIndicator`). |
| `src/components/ui/PaywallModal.tsx` | Bottom-sheet upgrade modal displaying free vs NPR 149 Premium benefits, Demo Premium activation, and Khalti/eSewa sandbox checkout buttons. |
| `src/pages/EntryAndOnboarding.tsx` | Welcome/Auth screen (`EntryScreen`: Google Sign-In, Email Register/Login, Demo prefill, Guest entry), 3-slide `OnboardingSlides`, and `ConsentScreen` (including `S04` opt-in). |
| `src/pages/HomePage.tsx` | Main dashboard: greeting, quota summary, guest-profile import banner, Scan CTA, Skin Lab confidence card, last scan card, and rotating tip of the day. |
| `src/pages/ScanPage.tsx` | 5-tab label input (`Camera`, `Upload`, `Paste`, `Samples`, `Barcode`), on-device OCR/barcode runner, and editable Review & Correct screen prior to `/api/analyze`. |
| `src/pages/ResultPage.tsx` | Displays `VerdictBanner`, low-confidence warning, 5-status count summary, filter/sort controls, ingredient rows, and `<IngredientDrawer />`. |
| `src/pages/DiscoverPage.tsx` | Contains `DiscoverPage` (ranked demo products with filters + Kathmandu shop list/map tabs), `ProductDetailPage`, and `ShopDetailPage`. |
| `src/pages/SkinLabPages.tsx` | Contains `SkinLabHub` (core + 7 optional modules), `QuizPlayerPage` (autosaving branched runner with "Why we ask"), and `QuizResultsPage` (profile summary, manual overrides, and allergen suggestion confirmation). |
| `src/pages/ProfileAndAccountPages.tsx` | Contains `ProfileHubPage`, `AllergensPage`, `HistoryAndComparePage`, `RoutinesPage`, `PlansAndReceiptsPage`, `SettingsPage` (theme, text scale, motion, i18n, JSON export, account delete), `AdminAnalyticsPage`, and `StaticContentPage`. |

### 8.5 Seed, Public Assets, Tests & Docs
| Folder / Files | Role |
|---|---|
| `seed/*.json` | Curated datasets (`ingredients.json` [330], `quiz.json` [60 Qs], `quiz.schema.json`, `products.json` [30], `retailers.json` [12], `interactions.json` [4], `tips.json` [7]). |
| `public/tessdata/*` | Self-hosted Tesseract.js worker, WASM binaries (standard/SIMD/LSTM), and `eng.traineddata.gz`. |
| `public/samples/*` | 6 bundled sample label PNGs + `samples.json` metadata (`sample-6.png` is intentionally skewed/noisy for low-confidence testing). |
| `public/fonts/*` | Self-hosted `.woff2` files for offline typography. |
| `public/icon.svg`, `apple-touch-icon.png`, `pwa-*.png` | PWA & iOS home-screen icons. |
| `public/assets/aistudio/*` | Reference specification & uploaded workspace assets. |
| `tests/*.test.ts` | 72 automated Vitest tests across `parser.test.ts` (26), `engine.test.ts` (23), `quiz.test.ts` (19), and `api.test.ts` (4 end-to-end HTTP flows). |
| `docs/*.md` | Focused reference docs: `API.md`, `DECISIONS.md`, `DEMO_SCRIPT.md`, `DESIGN_NOTES.md`, `GOOGLE_OAUTH_SETUP.md`, `LICENSES.md`, `PRIVACY_NOTES.md`, `PROGRESS.md`, `QA_REPORT.md`. |

---

## 9. How to Run Outside This Environment

You can run LabelEyes on any local machine (macOS, Windows, Linux), VPS, or container platform (Cloud Run, Fly.io, Render, Railway, Docker) without depending on Google AI Studio.

### 9.1 Prerequisites
1. **Node.js 22.18+ (or 22.x LTS)** — Check with `node -v`. *(Node 22 LTS is important because `"start": "node server.ts"` relies on Node 22's built-in TypeScript type stripping; if you are on Node 20, use `npx tsx server.ts` instead of `node server.ts`.)*
2. **npm 10+** — Check with `npm -v`.
3. **Optional API Keys** (the app works completely without them):
   - `GEMINI_API_KEY` from Google AI Studio if you want live Gemini High Thinking notes on "Explain deeper".
   - `VITE_GOOGLE_MAPS_API_KEY` from Google Cloud Console (with Maps JavaScript API enabled) if you want the interactive map rendered instead of the shop list fallback.

### 9.2 Local Development (Single Command)
```bash
# 1. Enter the project directory
cd labeleyes

# 2. Install dependencies
npm install

# 3. Create your local .env from the template
cp .env.example .env
# (Optional) Edit .env to set SESSION_SECRET, GEMINI_API_KEY, or VITE_GOOGLE_MAPS_API_KEY

# 4. Seed demo & steward accounts into data/store.json (optional, also auto-runs on boot)
npm run seed

# 5. Start the Express + Vite development server on http://localhost:3000
npm run dev
```
Open **`http://localhost:3000`** in your browser.
- **Demo Shopper**: `demo@labeleyes.example` / `LabelEyesDemo2026!`
- **Demo Steward (Admin)**: `admin@labeleyes.example` / `LabelEyesAdmin2026!`

### 9.3 Running Tests & Type Checks
```bash
npm run check
```
Runs `tsc --noEmit` followed by `vitest run` across all 72 unit and REST API integration tests.

### 9.4 Production Build & Self-Hosting
Because Vite embeds `VITE_*` variables into static JavaScript during `vite build`, set `VITE_GOOGLE_MAPS_API_KEY` in your `.env` (or shell environment) **before** building:

```bash
# Build the React + Tailwind + Workbox PWA bundle into dist/
npm run build

# Run the production Express server on port 3000 (or custom PORT)
NODE_ENV=production PORT=3000 npm start
```
*(Note: `server.ts` enforces `NODE_ENV === 'production'` to serve `dist/` and sets `Secure: true` on the `le_session` cookie. If testing a production build locally over plain `http://localhost` rather than HTTPS, modern browsers treat `localhost` as a secure context, whereas accessing over a plain `http://<LAN-IP>:3000` requires HTTPS for both `Secure` cookies, camera `getUserMedia`, and PWA Service Worker registration.)*

### 9.5 Deploying to a VPS / Docker / Cloud Run
1. **Docker Example (`Dockerfile`)**:
   ```dockerfile
   FROM node:22-slim
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci
   COPY . .
   ARG VITE_GOOGLE_MAPS_API_KEY=""
   ENV VITE_GOOGLE_MAPS_API_KEY=$VITE_GOOGLE_MAPS_API_KEY
   RUN npm run build
   ENV NODE_ENV=production
   ENV PORT=3000
   EXPOSE 3000
   CMD ["npm", "start"]
   ```
   Mount a persistent volume to `/app/data` if you want `data/store.json` and `data/session.secret` to survive container restarts.
2. **Reverse Proxy & HTTPS**: Put Nginx, Caddy, or a managed load balancer in front of port `3000` with TLS enabled. `server.ts` sets `app.set('trust proxy', true)` so rate-limiting and client IP detection work behind proxies.
3. **Firebase Auth on Custom Domains**:
   - The bundled `firebase-applet-config.json` points to project `gen-lang-client-0611771944`.
   - When deploying to a **new domain** (other than `localhost` or the original `.run.app` domains), Google Sign-In (`signInWithPopup`) will reject unauthorized origins unless you either:
     - Add your custom domain under **Firebase Console -> Authentication -> Settings -> Authorized domains**, **OR**
     - Replace `firebase-applet-config.json` and deploy `firestore.rules` to your own Firebase project (`firebase deploy --only firestore:rules`), **OR**
     - Simply use **Email/Password accounts** and **Guest Mode**, which work out of the box on any domain with zero Firebase Console changes.
4. **TypeScript ESM Note**: In Node 22 native execution (`node server.ts`), all type-only imports between `.ts` files must keep the `import { type Foo }` syntax so Node's type-stripping loader does not look for runtime exports of TypeScript interfaces.
