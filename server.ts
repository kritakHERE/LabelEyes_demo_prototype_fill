import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  type AuthedRequest,
  attachCurrentUser,
  clearSessionCookie,
  rateLimit,
  requireAdmin,
  requireAuth,
  setSessionCookie,
} from './server/auth.ts';
import {
  getAllIngredients,
  getCurrentYearMonth,
  getIngredientIndex,
  getStore,
  getSubscriptionSummary,
  hashPassword,
  isUserPremium,
  logEvent,
  saveStore,
  seedInteractions,
  seedProducts,
  seedQuiz,
  seedRetailers,
  seedTips,
  verifyPassword,
} from './server/store.ts';
import { generateGroundedExplanation } from './server/ai.ts';
import { verifyFirebaseBearerToken } from './server/firebaseAdmin.ts';
import {
  DEFAULT_GUEST_PROFILE,
  INGREDIENT_GROUPS,
  analyzeIngredientText,
  checkRoutineInteractions,
  computeMatchScore,
} from './shared/engine.ts';
import { parseIngredients } from './shared/parser.ts';
import { scoreQuiz } from './shared/quizScorer.ts';
import type { AllergenEntry, AllergenSeverity, SkinProfile } from './shared/types.ts';

const FREE_OCR_SCANS_LIMIT = Number(process.env.FREE_OCR_SCANS_PER_MONTH || 3);
const FREE_ALLERGEN_LIMIT = 3;
const FREE_HISTORY_LIMIT = 5;
const FREE_DISCOVER_LIMIT = 3;
const DEMO_MODE = process.env.DEMO_MODE !== 'false';

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return Number((R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(2));
}

export function createApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));

  // Security headers + Request ID + Privacy-safe JSON logging (never logs emails or ingredient text)
  app.use((req: Request, res: Response, next: NextFunction) => {
    const reqId = randomUUID().slice(0, 8);
    (req as AuthedRequest).requestId = reqId;
    res.setHeader('X-Request-Id', reqId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    const started = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/api')) {
        console.log(
          JSON.stringify({
            reqId,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            ms: Date.now() - started,
          })
        );
      }
    });
    next();
  });

  app.use(attachCurrentUser);

  // Health & OpenAPI
  app.get('/api/health', (_req: Request, res: Response) => {
    const store = getStore();
    res.json({
      ok: true,
      service: 'labeleyes-api',
      demoMode: DEMO_MODE,
      ingredientsCount: getAllIngredients().length,
      productsCount: seedProducts.length,
      retailersCount: seedRetailers.length,
      usersCount: Object.keys(store.users).length,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/openapi.json', (_req: Request, res: Response) => {
    res.json({
      openapi: '3.0.3',
      info: { title: 'LabelEyes API', version: '1.0.0' },
      paths: {
        '/api/health': { get: { summary: 'Health check' } },
        '/api/auth/register': { post: { summary: 'Email registration' } },
        '/api/auth/login': { post: { summary: 'Email login' } },
        '/api/analyze': { post: { summary: 'Deterministic compatibility analysis' } },
        '/api/quiz': { get: { summary: 'Skin Lab quiz bank (60 questions, 8 modules)' } },
        '/api/products': { get: { summary: 'Ranked demo products' } },
        '/api/retailers': { get: { summary: 'Kathmandu Valley demo shops' } },
        '/api/ai/explain': { post: { summary: 'Opt-in Gemini High Thinking grounded explanation' } },
      },
    });
  });

  app.get('/api/tips', (_req: Request, res: Response) => {
    res.json({ tips: seedTips });
  });

  app.get('/api/samples', (_req: Request, res: Response) => {
    const samplesPath = resolve(process.cwd(), 'public/samples/samples.json');
    if (!existsSync(samplesPath)) {
      res.json({ samples: [] });
      return;
    }
    const samples = JSON.parse(readFileSync(samplesPath, 'utf8'));
    res.json({ samples });
  });

  // Auth endpoints
  app.get('/api/auth/providers', (_req: Request, res: Response) => {
    res.json({
      google: true,
      email: true,
      guest: true,
      demoMode: DEMO_MODE,
    });
  });

  app.post('/api/auth/register', rateLimit('auth', 10), (req: Request, res: Response) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const displayName = String(req.body?.displayName || '').trim().slice(0, 80);

    if (!email || !email.includes('@') || email.length > 254) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters long.' });
      return;
    }

    const store = getStore();
    const exists = Object.values(store.users).some((u) => u.email.toLowerCase() === email);
    if (exists) {
      res.status(409).json({ error: 'An account with this email already exists.' });
      return;
    }

    const id = `usr_${randomUUID().slice(0, 12)}`;
    const nowIso = new Date().toISOString();
    store.users[id] = {
      id,
      email,
      passwordHash: hashPassword(password),
      displayName: displayName || email.split('@')[0],
      role: 'user',
      googleLinked: false,
      sensitiveConsent: false,
      consentGrantedAt: null,
      createdAt: nowIso,
    };
    store.profiles[id] = { ...DEFAULT_GUEST_PROFILE, updatedAt: nowIso };
    store.subscriptions[id] = { plan: 'free', status: 'active' };
    saveStore();
    setSessionCookie(res, id);

    res.status(201).json({
      user: {
        id,
        email,
        displayName: store.users[id].displayName,
        role: 'user',
        googleLinked: false,
        sensitiveConsent: false,
        consentGrantedAt: null,
      },
    });
  });

  app.post('/api/auth/login', rateLimit('auth', 10), (req: Request, res: Response) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const store = getStore();
    const user = Object.values(store.users).find((u) => u.email.toLowerCase() === email);

    if (!user || !verifyPassword(password, user.passwordHash)) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    setSessionCookie(res, user.id);
    res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        googleLinked: Boolean(user.googleLinked),
        sensitiveConsent: Boolean(user.sensitiveConsent),
        consentGrantedAt: user.consentGrantedAt || null,
      },
    });
  });

  app.post('/api/auth/logout', (_req: Request, res: Response) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.post('/api/auth/google/link', requireAuth, async (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const idToken = String(req.body?.idToken || '');
    const decoded = await verifyFirebaseBearerToken(idToken);
    if (!decoded || !decoded.uid || decoded.email_verified === false) {
      res.status(400).json({ error: 'Valid verified Google credential required to link.' });
      return;
    }
    const store = getStore();
    const conflict = Object.values(store.users).find(
      (u) => u.firebaseUid === decoded.uid && u.id !== areq.currentUser!.id
    );
    if (conflict) {
      res.status(409).json({ error: 'This Google account is already linked to another profile.' });
      return;
    }
    areq.currentUser!.firebaseUid = decoded.uid;
    areq.currentUser!.googleLinked = true;
    saveStore();
    res.json({ ok: true, googleLinked: true });
  });

  app.delete('/api/auth/identities/google', requireAuth, (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    if (!areq.currentUser!.passwordHash) {
      res.status(400).json({ error: 'Set a password before unlinking Google sign-in.' });
      return;
    }
    areq.currentUser!.firebaseUid = null;
    areq.currentUser!.googleLinked = false;
    saveStore();
    res.json({ ok: true, googleLinked: false });
  });

  app.get('/api/me', (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    if (!areq.currentUser) {
      res.json({
        authenticated: false,
        user: null,
        subscription: { plan: 'free', status: 'active' },
        usage: { ocrScansUsed: 0, ocrScansLimit: FREE_OCR_SCANS_LIMIT },
      });
      return;
    }
    const u = areq.currentUser;
    const store = getStore();
    const ym = getCurrentYearMonth();
    const used = store.usageCounters[u.id]?.[ym] || 0;
    const sub = getSubscriptionSummary(u.id);
    const premium = isUserPremium(u.id);

    res.json({
      authenticated: true,
      user: {
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        role: u.role,
        googleLinked: Boolean(u.googleLinked),
        sensitiveConsent: Boolean(u.sensitiveConsent),
        consentGrantedAt: u.consentGrantedAt || null,
        createdAt: u.createdAt,
      },
      subscription: sub,
      usage: {
        ocrScansUsed: used,
        ocrScansLimit: premium ? null : FREE_OCR_SCANS_LIMIT,
        allergensUsed: (store.allergens[u.id] || []).length,
        allergensLimit: premium ? null : FREE_ALLERGEN_LIMIT,
      },
    });
  });

  app.post('/api/consent', requireAuth, (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const granted = Boolean(req.body?.granted);
    const sensitiveConsent = Boolean(req.body?.sensitiveConsent);
    const user = areq.currentUser!;
    user.consentGrantedAt = granted ? new Date().toISOString() : null;
    user.sensitiveConsent = granted ? sensitiveConsent : false;
    saveStore();
    res.json({
      consentGrantedAt: user.consentGrantedAt,
      sensitiveConsent: user.sensitiveConsent,
    });
  });

  app.get('/api/me/export', requireAuth, (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const uid = areq.currentUser!.id;
    const store = getStore();
    const userCopy = { ...areq.currentUser!, passwordHash: undefined };
    res.json({
      exportedAt: new Date().toISOString(),
      user: userCopy,
      profile: store.profiles[uid] || null,
      profileHistory: store.profileHistory[uid] || [],
      allergens: store.allergens[uid] || [],
      scans: store.scans[uid] || [],
      routines: store.routines[uid] || [],
      subscription: getSubscriptionSummary(uid),
      payments: store.payments[uid] || [],
    });
  });

  app.delete('/api/me', requireAuth, (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const uid = areq.currentUser!.id;
    const store = getStore();
    delete store.users[uid];
    delete store.profiles[uid];
    delete store.profileHistory[uid];
    delete store.quizStates[uid];
    delete store.allergens[uid];
    delete store.scans[uid];
    delete store.usageCounters[uid];
    delete store.routines[uid];
    delete store.subscriptions[uid];
    delete store.payments[uid];
    store.ingredientReports = store.ingredientReports.filter((r) => r.userId !== uid);
    store.events = store.events.filter((e) => e.userId !== uid);
    saveStore();
    clearSessionCookie(res);
    res.json({ ok: true, deleted: true });
  });

  // Profile & Quiz endpoints
  app.get('/api/quiz', (_req: Request, res: Response) => {
    res.json(seedQuiz);
  });

  app.get('/api/quiz/state', (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    if (!areq.currentUser) {
      res.json({
        answers: {},
        skippedIds: [],
        completedModules: [],
        customAllergenText: '',
      });
      return;
    }
    const store = getStore();
    const state = store.quizStates[areq.currentUser.id] || {
      answers: {},
      skippedIds: [],
      completedModules: [],
      customAllergenText: '',
      updatedAt: new Date().toISOString(),
    };
    res.json(state);
  });

  app.put('/api/quiz/answers', requireAuth, (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const uid = areq.currentUser!.id;
    const store = getStore();
    const existing = store.quizStates[uid] || {
      answers: {},
      skippedIds: [],
      completedModules: [],
      updatedAt: new Date().toISOString(),
    };

    const incomingAnswers = req.body?.answers;
    if (incomingAnswers && typeof incomingAnswers === 'object') {
      for (const [qId, vals] of Object.entries(incomingAnswers)) {
        if (Array.isArray(vals)) {
          existing.answers[qId] = vals.map(String);
        }
      }
    }
    if (Array.isArray(req.body?.skippedIds)) {
      existing.skippedIds = Array.from(new Set(req.body.skippedIds.map(String)));
    }
    if (typeof req.body?.customAllergenText === 'string') {
      existing.customAllergenText = req.body.customAllergenText.slice(0, 120);
    }
    existing.updatedAt = new Date().toISOString();
    store.quizStates[uid] = existing;
    saveStore();
    res.json(existing);
  });

  app.post('/api/quiz/modules/:id/complete', requireAuth, (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const uid = areq.currentUser!.id;
    const modId = req.params.id;
    const store = getStore();

    const state = store.quizStates[uid] || {
      answers: {},
      skippedIds: [],
      completedModules: [],
      updatedAt: new Date().toISOString(),
    };
    if (!state.completedModules.includes(modId)) {
      state.completedModules.push(modId);
    }
    if (req.body?.answers && typeof req.body.answers === 'object') {
      for (const [qId, vals] of Object.entries(req.body.answers)) {
        if (Array.isArray(vals)) state.answers[qId] = vals.map(String);
      }
    }
    if (Array.isArray(req.body?.skippedIds)) {
      state.skippedIds = Array.from(new Set(req.body.skippedIds.map(String)));
    }
    if (typeof req.body?.customAllergenText === 'string') {
      state.customAllergenText = req.body.customAllergenText.slice(0, 120);
    }
    state.updatedAt = new Date().toISOString();
    store.quizStates[uid] = state;

    const existingOverrides = store.profiles[uid]?.overrides;
    const scored = scoreQuiz(seedQuiz, state.answers, {
      skippedQuestionIds: state.skippedIds,
      overrides: existingOverrides,
      customAllergenText: state.customAllergenText,
    });

    store.profiles[uid] = scored.profile;
    const hist = store.profileHistory[uid] || [];
    hist.unshift({
      id: randomUUID(),
      skinType: scored.profile.skinType,
      sensitivity: scored.profile.sensitivity,
      concerns: scored.profile.concerns,
      confidence: scored.profile.confidence,
      createdAt: scored.profile.updatedAt,
    });
    store.profileHistory[uid] = hist.slice(0, 20);
    saveStore();

    logEvent(uid, 'quiz_module_completed', { module: modId });
    if (modId === 'core') {
      logEvent(uid, 'quiz_completed', { confidence: scored.profile.confidence });
    }

    res.json({
      profile: scored.profile,
      suggestions: scored.suggestions,
      completedModules: state.completedModules,
      history: store.profileHistory[uid],
    });
  });

  app.get('/api/quiz/suggestions', requireAuth, (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const uid = areq.currentUser!.id;
    const store = getStore();
    const state = store.quizStates[uid];
    if (!state) {
      res.json({ suggestions: [] });
      return;
    }
    const scored = scoreQuiz(seedQuiz, state.answers, {
      skippedQuestionIds: state.skippedIds,
      customAllergenText: state.customAllergenText,
    });
    res.json({ suggestions: scored.suggestions });
  });

  app.get('/api/profile', (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    if (!areq.currentUser) {
      res.json({ profile: DEFAULT_GUEST_PROFILE, history: [] });
      return;
    }
    const store = getStore();
    const uid = areq.currentUser.id;
    res.json({
      profile: store.profiles[uid] || DEFAULT_GUEST_PROFILE,
      history: store.profileHistory[uid] || [],
    });
  });

  app.put('/api/profile', requireAuth, (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const uid = areq.currentUser!.id;
    const store = getStore();
    const current = store.profiles[uid] || { ...DEFAULT_GUEST_PROFILE };

    const overrides: SkinProfile['overrides'] = req.body?.clearOverrides
      ? undefined
      : {
          ...(current.overrides || {}),
          ...(req.body?.skinType ? { skinType: req.body.skinType } : {}),
          ...(req.body?.sensitivity ? { sensitivity: req.body.sensitivity } : {}),
          ...(Array.isArray(req.body?.concerns) ? { concerns: req.body.concerns.slice(0, 5) } : {}),
        };

    const state = store.quizStates[uid];
    let updated: SkinProfile;
    if (state && Object.keys(state.answers).length > 0) {
      updated = scoreQuiz(seedQuiz, state.answers, {
        skippedQuestionIds: state.skippedIds,
        overrides,
        customAllergenText: state.customAllergenText,
      }).profile;
    } else {
      updated = {
        ...current,
        skinType: overrides?.skinType || current.skinType,
        sensitivity: overrides?.sensitivity || current.sensitivity,
        concerns: overrides?.concerns || current.concerns,
        overrides,
        hasProfile: true,
        updatedAt: new Date().toISOString(),
      };
    }

    store.profiles[uid] = updated;
    saveStore();
    res.json({ profile: updated });
  });

  app.get('/api/profile/traits', requireAuth, (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const uid = areq.currentUser!.id;
    const store = getStore();
    const profile = store.profiles[uid] || DEFAULT_GUEST_PROFILE;
    res.json({
      flags: profile.flags,
      confidence: profile.confidence,
      reasons: profile.reasons,
      notes: profile.notes,
    });
  });

  app.get('/api/profile/history', requireAuth, (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const store = getStore();
    res.json({ history: store.profileHistory[areq.currentUser!.id] || [] });
  });

  app.post('/api/profile/import', requireAuth, (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const uid = areq.currentUser!.id;
    const store = getStore();

    const answers = (req.body?.answers || {}) as Record<string, string[]>;
    const skippedIds = Array.isArray(req.body?.skippedIds) ? req.body.skippedIds.map(String) : [];
    const completedModules = Array.isArray(req.body?.completedModules)
      ? req.body.completedModules.map(String)
      : [];
    const customAllergenText = typeof req.body?.customAllergenText === 'string' ? req.body.customAllergenText : undefined;
    const guestAllergens = Array.isArray(req.body?.allergens) ? (req.body.allergens as AllergenEntry[]) : [];

    store.quizStates[uid] = {
      answers,
      skippedIds,
      completedModules,
      customAllergenText,
      updatedAt: new Date().toISOString(),
    };

    const scored = scoreQuiz(seedQuiz, answers, {
      skippedQuestionIds: skippedIds,
      overrides: req.body?.overrides,
      customAllergenText,
    });
    store.profiles[uid] = scored.profile;
    store.profileHistory[uid] = [
      {
        id: randomUUID(),
        skinType: scored.profile.skinType,
        sensitivity: scored.profile.sensitivity,
        concerns: scored.profile.concerns,
        confidence: scored.profile.confidence,
        createdAt: scored.profile.updatedAt,
      },
      ...(store.profileHistory[uid] || []),
    ].slice(0, 20);

    // Import guest allergens up to plan limit
    const existingAllergens = store.allergens[uid] || [];
    const limit = isUserPremium(uid) ? 100 : FREE_ALLERGEN_LIMIT;
    for (const ga of guestAllergens) {
      if (existingAllergens.length >= limit) break;
      const dup = existingAllergens.some(
        (ea) =>
          (ga.ingredientId && ea.ingredientId === ga.ingredientId) ||
          (ga.groupId && ea.groupId === ga.groupId) ||
          (ga.customText && ea.customText?.toLowerCase() === ga.customText.toLowerCase())
      );
      if (!dup) {
        existingAllergens.push({
          ...ga,
          id: `alg_${randomUUID().slice(0, 10)}`,
          createdAt: ga.createdAt || new Date().toISOString(),
        });
      }
    }
    store.allergens[uid] = existingAllergens;
    if (!areq.currentUser!.consentGrantedAt) {
      areq.currentUser!.consentGrantedAt = new Date().toISOString();
    }
    saveStore();
    res.json({ profile: scored.profile, allergens: existingAllergens, suggestions: scored.suggestions });
  });

  // Allergen & Ingredient search endpoints
  app.get('/api/ingredient-groups', (_req: Request, res: Response) => {
    res.json({ groups: INGREDIENT_GROUPS });
  });

  app.get('/api/ingredients/search', (req: Request, res: Response) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const all = getAllIngredients();
    if (!q) {
      res.json({ items: all.slice(0, 20) });
      return;
    }
    const matches = all
      .filter(
        (ing) =>
          ing.inci.toLowerCase().includes(q) ||
          ing.aliases.some((a) => a.toLowerCase().includes(q)) ||
          ing.id.toLowerCase().includes(q)
      )
      .slice(0, 20);
    res.json({ items: matches });
  });

  app.get('/api/allergens', (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    if (!areq.currentUser) {
      res.json({ items: [], limit: FREE_ALLERGEN_LIMIT });
      return;
    }
    const uid = areq.currentUser.id;
    const store = getStore();
    const premium = isUserPremium(uid);
    res.json({
      items: store.allergens[uid] || [],
      limit: premium ? null : FREE_ALLERGEN_LIMIT,
    });
  });

  app.post('/api/allergens', requireAuth, (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const uid = areq.currentUser!.id;
    const store = getStore();
    const list = store.allergens[uid] || [];
    const premium = isUserPremium(uid);

    if (!premium && list.length >= FREE_ALLERGEN_LIMIT) {
      res.status(402).json({
        error: 'Free accounts can save up to 3 allergens. Upgrade to Premium for unlimited allergen warnings.',
        paywall: true,
        trigger: 'allergen_limit',
      });
      return;
    }

    const ingredientId = req.body?.ingredientId ? String(req.body.ingredientId) : null;
    const groupId = req.body?.groupId ? String(req.body.groupId) : null;
    const customText = req.body?.customText ? String(req.body.customText).trim().slice(0, 120) : null;
    const severity: AllergenSeverity = req.body?.severity === 'allergy' ? 'allergy' : 'sensitivity';

    if (!ingredientId && !groupId && (!customText || customText.length < 2)) {
      res.status(400).json({ error: 'Choose an ingredient, group, or custom name (at least 2 characters).' });
      return;
    }

    let label = customText || '';
    if (ingredientId) {
      const rec = getAllIngredients().find((i) => i.id === ingredientId);
      if (!rec) {
        res.status(400).json({ error: 'Ingredient not found.' });
        return;
      }
      label = rec.inci;
    } else if (groupId) {
      const grp = INGREDIENT_GROUPS.find((g) => g.id === groupId);
      if (!grp) {
        res.status(400).json({ error: 'Ingredient group not found.' });
        return;
      }
      label = grp.label;
    }

    const dup = list.find(
      (a) =>
        (ingredientId && a.ingredientId === ingredientId) ||
        (groupId && a.groupId === groupId) ||
        (customText && a.customText?.toLowerCase() === customText.toLowerCase())
    );
    if (dup) {
      dup.severity = severity;
      saveStore();
      res.json({ item: dup, items: list });
      return;
    }

    const entry: AllergenEntry = {
      id: `alg_${randomUUID().slice(0, 10)}`,
      ingredientId,
      groupId: groupId as AllergenEntry['groupId'],
      customText,
      label,
      severity,
      createdAt: new Date().toISOString(),
    };
    list.push(entry);
    store.allergens[uid] = list;
    saveStore();
    logEvent(uid, 'allergen_added', { kind: groupId ? 'group' : ingredientId ? 'ingredient' : 'custom', severity });
    res.status(201).json({ item: entry, items: list });
  });

  app.delete('/api/allergens/:id', requireAuth, (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const uid = areq.currentUser!.id;
    const store = getStore();
    const list = store.allergens[uid] || [];
    store.allergens[uid] = list.filter((a) => a.id !== req.params.id);
    saveStore();
    res.json({ items: store.allergens[uid] });
  });

  // Parse & Analyze endpoints
  app.post('/api/parse', (req: Request, res: Response) => {
    const text = String(req.body?.text || '');
    res.json({ tokens: parseIngredients(text) });
  });

  app.post('/api/analyze', rateLimit('analyze', 30), (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const text = String(req.body?.text || '').trim();
    const source = (req.body?.source || 'manual') as 'ocr' | 'manual' | 'sample' | 'barcode';
    const productName = String(req.body?.productName || 'Scanned product').trim().slice(0, 140);
    const ocrConfidence = typeof req.body?.ocr_confidence === 'number' ? req.body.ocr_confidence : undefined;
    const saveHistory = req.body?.save !== false;

    if (!text) {
      res.status(400).json({ error: 'Please paste or scan an ingredient list first.' });
      return;
    }

    const store = getStore();
    const uid = areq.currentUser?.id || null;
    const premium = uid ? isUserPremium(uid) : false;

    // Server-side OCR scan quota enforcement for authenticated free users
    if (uid && source === 'ocr' && !premium) {
      const ym = getCurrentYearMonth();
      const used = store.usageCounters[uid]?.[ym] || 0;
      if (used >= FREE_OCR_SCANS_LIMIT) {
        logEvent(uid, 'paywall_viewed', { trigger: 'ocr_limit' });
        res.status(402).json({
          error: `You have used all ${FREE_OCR_SCANS_LIMIT} free OCR label scans this month. Upgrade to Premium for unlimited scans, or paste ingredient text anytime.`,
          paywall: true,
          trigger: 'ocr_limit',
        });
        return;
      }
      store.usageCounters[uid] = store.usageCounters[uid] || {};
      store.usageCounters[uid][ym] = used + 1;
    }

    const profile: SkinProfile = uid
      ? store.profiles[uid] || DEFAULT_GUEST_PROFILE
      : (req.body?.guestProfile as SkinProfile) || DEFAULT_GUEST_PROFILE;
    const allergens: AllergenEntry[] = uid
      ? store.allergens[uid] || []
      : Array.isArray(req.body?.guestAllergens)
        ? (req.body.guestAllergens as AllergenEntry[])
        : [];

    const allIngredients = getAllIngredients();
    const result = analyzeIngredientText(text, profile, allergens, allIngredients, {
      ocrConfidence,
      index: getIngredientIndex(),
    });

    let savedScan = null;
    if (uid && saveHistory) {
      const scanItem = {
        id: `scan_${randomUUID().slice(0, 12)}`,
        source,
        productName,
        rawText: text,
        ocrConfidence,
        result,
        createdAt: new Date().toISOString(),
      };
      store.scans[uid] = [scanItem, ...(store.scans[uid] || [])].slice(0, 200);
      savedScan = scanItem;
    }
    saveStore();

    logEvent(uid, 'analysis_completed', {
      verdict: result.verdict.level,
      unknown_share: result.unknown_share,
    });

    const ym = getCurrentYearMonth();
    res.json({
      result,
      scan: savedScan,
      usage: uid
        ? {
            ocrScansUsed: store.usageCounters[uid]?.[ym] || 0,
            ocrScansLimit: premium ? null : FREE_OCR_SCANS_LIMIT,
          }
        : undefined,
    });
  });

  // Scans history
  app.get('/api/scans', requireAuth, (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const uid = areq.currentUser!.id;
    const store = getStore();
    const allScans = store.scans[uid] || [];
    const premium = isUserPremium(uid);
    const items = premium ? allScans : allScans.slice(0, FREE_HISTORY_LIMIT);

    res.json({
      items,
      totalCount: allScans.length,
      limited: !premium && allScans.length > FREE_HISTORY_LIMIT,
      limit: premium ? null : FREE_HISTORY_LIMIT,
    });
  });

  app.get('/api/scans/:id', requireAuth, (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const uid = areq.currentUser!.id;
    const store = getStore();
    const allScans = store.scans[uid] || [];
    const idx = allScans.findIndex((s) => s.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Scan not found.' });
      return;
    }
    if (!isUserPremium(uid) && idx >= FREE_HISTORY_LIMIT) {
      res.status(402).json({
        error: 'Older scan history beyond your last 5 scans requires Premium.',
        paywall: true,
        trigger: 'history_limit',
      });
      return;
    }
    res.json({ item: allScans[idx] });
  });

  app.delete('/api/scans/:id', requireAuth, (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const uid = areq.currentUser!.id;
    const store = getStore();
    store.scans[uid] = (store.scans[uid] || []).filter((s) => s.id !== req.params.id);
    saveStore();
    res.json({ ok: true });
  });

  // Open Beauty Facts Barcode Proxy (with cache, 8s timeout, ODbL attribution, and local demo barcode fallback)
  app.get('/api/barcode/:ean', rateLimit('barcode', 20), async (req: Request, res: Response) => {
    const ean = String(req.params.ean || '').replace(/[^0-9]/g, '');
    if (ean.length < 8 || ean.length > 14) {
      res.status(400).json({ error: 'Invalid EAN barcode format.' });
      return;
    }

    // Check demo products first
    const demoMatch = seedProducts.find((p) => p.barcode === ean);
    if (demoMatch) {
      res.json({
        found: true,
        source: 'demo_catalog',
        barcode: ean,
        productName: `${demoMatch.brand} ${demoMatch.name}`,
        ingredientsText: demoMatch.ingredientsText,
        attribution: 'Demo catalog entry',
      });
      return;
    }

    const store = getStore();
    const cached = store.obfCache[ean];
    if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < 1000 * 60 * 60 * 24) {
      res.json({
        ...cached,
        source: 'open_beauty_facts',
        attribution: 'Product data © Open Beauty Facts (ODbL)',
      });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const ua = process.env.OBF_USER_AGENT || 'LabelEyes/1.0 (https://labeleyes.example)';
      const resp = await fetch(`https://world.openbeautyfacts.org/api/v2/product/${ean}.json`, {
        headers: { 'User-Agent': ua },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        res.status(404).json({ found: false, error: 'Barcode not found in Open Beauty Facts.' });
        return;
      }
      const data = (await resp.json()) as {
        status?: number;
        product?: { product_name?: string; brands?: string; ingredients_text?: string };
      };
      if (data.status !== 1 || !data.product?.ingredients_text) {
        store.obfCache[ean] = { barcode: ean, found: false, fetchedAt: new Date().toISOString() };
        saveStore();
        res.status(404).json({
          found: false,
          error: 'Product found without an ingredient list. Please scan or paste the back label.',
        });
        return;
      }
      const entry = {
        barcode: ean,
        found: true,
        productName: [data.product.brands, data.product.product_name].filter(Boolean).join(' ') || `Product ${ean}`,
        brand: data.product.brands || '',
        ingredientsText: data.product.ingredients_text,
        fetchedAt: new Date().toISOString(),
      };
      store.obfCache[ean] = entry;
      saveStore();
      res.json({
        ...entry,
        source: 'open_beauty_facts',
        attribution: 'Product data © Open Beauty Facts (ODbL)',
      });
    } catch {
      clearTimeout(timer);
      res.status(504).json({
        found: false,
        error: 'Open Beauty Facts is temporarily unavailable. Scan or paste the label text instead.',
      });
    }
  });

  // Discover: Products & Kathmandu Retailers
  app.get('/api/products', (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const store = getStore();
    const uid = areq.currentUser?.id || null;
    const premium = uid ? isUserPremium(uid) : false;

    const profile: SkinProfile = uid ? store.profiles[uid] || DEFAULT_GUEST_PROFILE : DEFAULT_GUEST_PROFILE;
    const allergens: AllergenEntry[] = uid ? store.allergens[uid] || [] : [];
    const allIngredients = getAllIngredients();
    const index = getIngredientIndex();

    const category = String(req.query.category || '');
    const fragranceFreeOnly = req.query.fragranceFree === 'true';
    const maxPrice = req.query.maxPrice ? Number(req.query.maxPrice) : null;
    const includeRed = req.query.includeRed === 'true';
    const userLat = req.query.lat ? Number(req.query.lat) : null;
    const userLng = req.query.lng ? Number(req.query.lng) : null;
    const maxKm = req.query.maxKm ? Number(req.query.maxKm) : null;

    let ranked = seedProducts.map((p) => {
      const analysis = analyzeIngredientText(p.ingredientsText, profile, allergens, allIngredients, { index });
      const match = computeMatchScore(analysis, profile, allIngredients);
      const stockedAt = seedRetailers
        .filter((r) => r.stock.some((s) => s.productId === p.id))
        .map((r) => {
          const st = r.stock.find((s) => s.productId === p.id)!;
          return {
            retailerId: r.id,
            name: r.name,
            area: r.area,
            priceNpr: st.priceNpr,
            sponsored: r.sponsored,
            distanceKm: userLat !== null && userLng !== null ? haversineKm(userLat, userLng, r.lat, r.lng) : null,
          };
        });
      return {
        ...p,
        analysisSummary: {
          verdict: analysis.verdict,
          counts: analysis.counts,
        },
        matchScore: match.score,
        matchLabel: match.label,
        stockedAt,
      };
    });

    if (category) ranked = ranked.filter((p) => p.category === category);
    if (fragranceFreeOnly) ranked = ranked.filter((p) => p.fragranceFree);
    if (maxPrice !== null && Number.isFinite(maxPrice)) ranked = ranked.filter((p) => p.priceNpr <= maxPrice);
    if (!includeRed) ranked = ranked.filter((p) => p.analysisSummary.counts.red === 0);
    if (maxKm !== null && Number.isFinite(maxKm) && userLat !== null && userLng !== null) {
      ranked = ranked.filter((p) => p.stockedAt.some((s) => s.distanceKm !== null && s.distanceKm <= maxKm));
    }

    ranked.sort((a, b) => b.matchScore - a.matchScore || a.priceNpr - b.priceNpr);

    const totalCount = ranked.length;
    const visibleItems = premium ? ranked : ranked.slice(0, FREE_DISCOVER_LIMIT);

    res.json({
      items: visibleItems,
      totalCount,
      limited: !premium && totalCount > FREE_DISCOVER_LIMIT,
      limit: premium ? null : FREE_DISCOVER_LIMIT,
      isPremium: premium,
    });
  });

  app.get('/api/products/:id', (req: Request, res: Response) => {
    const prod = seedProducts.find((p) => p.id === req.params.id);
    if (!prod) {
      res.status(404).json({ error: 'Product not found.' });
      return;
    }
    const areq = req as AuthedRequest;
    const store = getStore();
    const uid = areq.currentUser?.id || null;
    const premium = uid ? isUserPremium(uid) : false;
    const profile = uid ? store.profiles[uid] || DEFAULT_GUEST_PROFILE : DEFAULT_GUEST_PROFILE;
    const allergens = uid ? store.allergens[uid] || [] : [];
    const allIngredients = getAllIngredients();
    const analysis = analyzeIngredientText(prod.ingredientsText, profile, allergens, allIngredients, {
      index: getIngredientIndex(),
    });
    const match = computeMatchScore(analysis, profile, allIngredients);

    const stockedAt = seedRetailers
      .filter((r) => r.stock.some((s) => s.productId === prod.id))
      .map((r) => {
        const st = r.stock.find((s) => s.productId === prod.id)!;
        return {
          retailerId: r.id,
          name: r.name,
          area: r.area,
          address: r.address,
          lat: r.lat,
          lng: r.lng,
          phone: r.phone,
          hoursText: r.hoursText,
          sponsored: r.sponsored,
          isDemo: r.isDemo,
          priceNpr: premium ? st.priceNpr : null,
        };
      });

    res.json({
      product: prod,
      analysis,
      matchScore: match.score,
      matchLabel: match.label,
      stockedAt,
      isPremium: premium,
    });
  });

  app.get('/api/retailers', (req: Request, res: Response) => {
    const userLat = req.query.lat ? Number(req.query.lat) : null;
    const userLng = req.query.lng ? Number(req.query.lng) : null;
    const type = String(req.query.type || '');
    const area = String(req.query.area || '');

    let items = seedRetailers.map((r) => ({
      ...r,
      distanceKm: userLat !== null && userLng !== null ? haversineKm(userLat, userLng, r.lat, r.lng) : null,
    }));

    if (type) items = items.filter((r) => r.type === type);
    if (area) items = items.filter((r) => r.area.toLowerCase().includes(area.toLowerCase()));
    if (userLat !== null && userLng !== null) {
      items.sort((a, b) => (a.distanceKm || 0) - (b.distanceKm || 0));
    }
    res.json({ items });
  });

  app.get('/api/retailers/:id', (req: Request, res: Response) => {
    const retailer = seedRetailers.find((r) => r.id === req.params.id);
    if (!retailer) {
      res.status(404).json({ error: 'Shop not found.' });
      return;
    }
    const areq = req as AuthedRequest;
    const uid = areq.currentUser?.id || null;
    const store = getStore();
    const profile = uid ? store.profiles[uid] || DEFAULT_GUEST_PROFILE : DEFAULT_GUEST_PROFILE;
    const allergens = uid ? store.allergens[uid] || [] : [];
    const allIngredients = getAllIngredients();
    const index = getIngredientIndex();

    const stockedProducts = retailer.stock
      .map((st) => {
        const prod = seedProducts.find((p) => p.id === st.productId);
        if (!prod) return null;
        const analysis = analyzeIngredientText(prod.ingredientsText, profile, allergens, allIngredients, { index });
        const match = computeMatchScore(analysis, profile, allIngredients);
        return {
          ...prod,
          shopPriceNpr: st.priceNpr,
          matchScore: match.score,
          matchLabel: match.label,
          verdictLevel: analysis.verdict.level,
        };
      })
      .filter(Boolean);

    if (uid) logEvent(uid, 'shop_opened', { retailerId: retailer.id });
    res.json({ retailer, stockedProducts });
  });

  // Routines & Interaction check (Premium)
  app.get('/api/routines', requireAuth, (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const uid = areq.currentUser!.id;
    const store = getStore();
    const routines = store.routines[uid] || [];
    const allIngredients = getAllIngredients();

    const enriched = routines.map((r) => {
      const prods = r.productIds
        .map((pid) => seedProducts.find((p) => p.id === pid))
        .filter((p): p is NonNullable<typeof p> => Boolean(p));
      const interactions = checkRoutineInteractions(prods, allIngredients, seedInteractions);
      return { ...r, products: prods, interactions };
    });

    res.json({ items: enriched, isPremium: isUserPremium(uid) });
  });

  app.post('/api/routines', requireAuth, (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const uid = areq.currentUser!.id;
    if (!isUserPremium(uid)) {
      logEvent(uid, 'paywall_viewed', { trigger: 'routines' });
      res.status(402).json({
        error: 'Saving AM/PM routines and checking active overlaps is a Premium feature.',
        paywall: true,
        trigger: 'routines',
      });
      return;
    }
    const name = String(req.body?.name || '').trim().slice(0, 100);
    const period = req.body?.period === 'PM' ? 'PM' : 'AM';
    const productIds = Array.isArray(req.body?.productIds) ? req.body.productIds.map(String).slice(0, 12) : [];
    if (!name) {
      res.status(400).json({ error: 'Routine name is required.' });
      return;
    }

    const store = getStore();
    const item = {
      id: `rtn_${randomUUID().slice(0, 10)}`,
      name,
      period: period as 'AM' | 'PM',
      productIds,
      createdAt: new Date().toISOString(),
    };
    store.routines[uid] = [item, ...(store.routines[uid] || [])];
    saveStore();
    res.status(201).json({ item });
  });

  app.put('/api/routines/:id', requireAuth, (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const uid = areq.currentUser!.id;
    if (!isUserPremium(uid)) {
      res.status(402).json({ error: 'Premium required.', paywall: true, trigger: 'routines' });
      return;
    }
    const store = getStore();
    const list = store.routines[uid] || [];
    const target = list.find((r) => r.id === req.params.id);
    if (!target) {
      res.status(404).json({ error: 'Routine not found.' });
      return;
    }
    if (req.body?.name) target.name = String(req.body.name).trim().slice(0, 100);
    if (req.body?.period === 'AM' || req.body?.period === 'PM') target.period = req.body.period;
    if (Array.isArray(req.body?.productIds)) target.productIds = req.body.productIds.map(String).slice(0, 12);
    saveStore();
    res.json({ item: target });
  });

  app.delete('/api/routines/:id', requireAuth, (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const uid = areq.currentUser!.id;
    const store = getStore();
    store.routines[uid] = (store.routines[uid] || []).filter((r) => r.id !== req.params.id);
    saveStore();
    res.json({ ok: true });
  });

  // Plans, Checkout, Idempotent Callbacks & Demo Premium
  app.get('/api/plans', (_req: Request, res: Response) => {
    res.json({
      freeCopy: 'Skin quiz, 3 label scans a month, up to 3 allergens, last 5 scans, top 3 product matches.',
      premiumCopy:
        'Unlimited scans, unlimited allergens and extended alerts, full scan history, saved routines and comparison, advanced product insights, full local recommendations with shop prices.',
      allergenGuarantee: 'Your core allergen warnings are always free.',
      priceNpr: 149,
      durationDays: 30,
      demoMode: DEMO_MODE,
    });
  });

  app.get('/api/subscription', requireAuth, (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const uid = areq.currentUser!.id;
    const store = getStore();
    res.json({
      subscription: getSubscriptionSummary(uid),
      receipts: store.payments[uid] || [],
    });
  });

  app.post('/api/checkout', requireAuth, rateLimit('payments', 10), (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const uid = areq.currentUser!.id;
    const provider = String(req.body?.provider || 'mock');
    if (!['mock', 'khalti', 'esewa'].includes(provider)) {
      res.status(400).json({ error: 'Unsupported payment provider.' });
      return;
    }
    const idempotencyKey = String(req.body?.idempotencyKey || randomUUID());
    const store = getStore();
    const existingRef = store.paymentIdempotency[idempotencyKey];
    if (existingRef) {
      const existingReceipt = (store.payments[uid] || []).find((p) => p.providerRef === existingRef);
      res.json({ receipt: existingReceipt, subscription: getSubscriptionSummary(uid), duplicate: true });
      return;
    }

    const providerRef = `${provider.toUpperCase()}-${randomUUID().slice(0, 10).toUpperCase()}`;
    store.paymentIdempotency[idempotencyKey] = providerRef;

    const receipt = {
      id: `pay_${randomUUID().slice(0, 10)}`,
      provider,
      providerRef,
      amountNpr: 149,
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
    };
    store.payments[uid] = [receipt, ...(store.payments[uid] || [])];
    saveStore();
    logEvent(uid, 'checkout_started', { provider, amountNpr: 149 });

    res.status(201).json({
      receipt,
      checkoutUrl: `/api/payments/callback/${provider}`,
      providerRef,
      amountNpr: 149,
    });
  });

  app.post('/api/payments/callback/:provider', requireAuth, rateLimit('payments', 10), (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const uid = areq.currentUser!.id;
    const provider = req.params.provider;
    const providerRef = String(req.body?.providerRef || '');
    const outcome = req.body?.outcome === 'failed' ? 'failed' : 'succeeded';
    const store = getStore();
    const list = store.payments[uid] || [];
    const receipt = list.find((p) => p.providerRef === providerRef && p.provider === provider);
    if (!receipt) {
      res.status(404).json({ error: 'Payment reference not found.' });
      return;
    }

    // Idempotent replay safety (FR-64)
    if (receipt.status === 'succeeded') {
      res.json({ receipt, subscription: getSubscriptionSummary(uid), replayed: true });
      return;
    }

    receipt.status = outcome;
    if (outcome === 'succeeded') {
      const now = new Date();
      const ends = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      store.subscriptions[uid] = {
        plan: 'premium',
        status: 'active',
        startsAt: now.toISOString(),
        endsAt: ends.toISOString(),
        provider,
        amountNpr: 149,
      };
      logEvent(uid, 'payment_succeeded', { provider, amountNpr: 149 });
    }
    saveStore();

    res.json({ receipt, subscription: getSubscriptionSummary(uid) });
  });

  app.post('/api/demo/activate-premium', requireAuth, (req: Request, res: Response) => {
    if (!DEMO_MODE) {
      res.status(403).json({ error: 'Demo mode is disabled.' });
      return;
    }
    const areq = req as AuthedRequest;
    const uid = areq.currentUser!.id;
    const store = getStore();
    const now = new Date();
    const ends = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    store.subscriptions[uid] = {
      plan: 'premium',
      status: 'active',
      startsAt: now.toISOString(),
      endsAt: ends.toISOString(),
      provider: 'demo',
      amountNpr: 149,
    };
    const receipt = {
      id: `pay_${randomUUID().slice(0, 10)}`,
      provider: 'demo',
      providerRef: `DEMO-${randomUUID().slice(0, 8).toUpperCase()}`,
      amountNpr: 149,
      status: 'succeeded' as const,
      createdAt: now.toISOString(),
    };
    store.payments[uid] = [receipt, ...(store.payments[uid] || [])];
    saveStore();
    logEvent(uid, 'payment_succeeded', { provider: 'demo', amountNpr: 149 });
    res.json({ subscription: getSubscriptionSummary(uid), receipt });
  });

  // Ingredient reports & Admin analytics
  app.post('/api/ingredient-reports', (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const rawName = String(req.body?.rawName || '').trim().slice(0, 160);
    const context = String(req.body?.context || '').trim().slice(0, 300);
    if (!rawName) {
      res.status(400).json({ error: 'Ingredient name is required.' });
      return;
    }
    const store = getStore();
    const rec = {
      id: `rep_${randomUUID().slice(0, 10)}`,
      userId: areq.currentUser?.id || null,
      rawName,
      context,
      status: 'open' as const,
      createdAt: new Date().toISOString(),
    };
    store.ingredientReports.unshift(rec);
    saveStore();
    logEvent(areq.currentUser?.id || null, 'ingredient_reported', {});
    res.status(201).json({ report: rec });
  });

  app.get('/api/admin/analytics', requireAuth, requireAdmin, (_req: Request, res: Response) => {
    const store = getStore();
    const countsByEvent: Record<string, number> = {};
    for (const ev of store.events) {
      countsByEvent[ev.name] = (countsByEvent[ev.name] || 0) + 1;
    }
    const totalUsers = Object.keys(store.users).length;
    const premiumUsers = Object.keys(store.users).filter((id) => isUserPremium(id)).length;
    const conversionRate = totalUsers > 0 ? Number(((premiumUsers / totalUsers) * 100).toFixed(1)) : 0;

    res.json({
      totalUsers,
      premiumUsers,
      conversionRatePercent: conversionRate,
      countsByEvent,
      reports: store.ingredientReports.slice(0, 50),
    });
  });

  app.post('/api/events', (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const name = String(req.body?.name || '').trim().slice(0, 64);
    if (!name) {
      res.status(400).json({ error: 'Event name required.' });
      return;
    }
    const props = req.body?.props && typeof req.body.props === 'object' ? req.body.props : {};
    logEvent(areq.currentUser?.id || null, name, props);
    res.json({ ok: true });
  });

  // Opt-in Deeper Explain (Gemini High Thinking, strictly grounded)
  app.post('/api/ai/explain', rateLimit('ai', 15), async (req: Request, res: Response) => {
    const areq = req as AuthedRequest;
    const store = getStore();
    const uid = areq.currentUser?.id || null;
    const profile: SkinProfile = uid
      ? store.profiles[uid] || DEFAULT_GUEST_PROFILE
      : (req.body?.guestProfile as SkinProfile) || DEFAULT_GUEST_PROFILE;

    const mode = req.body?.mode === 'interaction' ? 'interaction' : 'ingredient';
    if (mode === 'interaction') {
      const ruleId = String(req.body?.interactionId || '');
      const interaction = seedInteractions.find((r) => r.id === ruleId);
      if (!interaction) {
        res.status(404).json({ error: 'Interaction rule not found.' });
        return;
      }
      const out = await generateGroundedExplanation({ mode: 'interaction', interaction, profile });
      res.json(out);
      return;
    }

    const ingredientId = String(req.body?.ingredientId || '');
    const ingredient = getAllIngredients().find((i) => i.id === ingredientId);
    if (!ingredient) {
      res.status(404).json({ error: 'Ingredient not in curated database.' });
      return;
    }
    const out = await generateGroundedExplanation({
      mode: 'ingredient',
      ingredient,
      deterministicStatus: String(req.body?.status || 'neutral'),
      deterministicWhy: String(req.body?.why || ''),
      profile,
    });
    res.json(out);
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(JSON.stringify({ error: err.message }));
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}

async function startServer() {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(resolve(distDir, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`LabelEyes server running on http://0.0.0.0:${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
