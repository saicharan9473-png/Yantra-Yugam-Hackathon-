require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const User = require('./models/User');
const Prompt = require('./models/Prompt');
const AppModel = require('./models/App');
const Feedback = require('./models/Feedback');

const { requireAuth } = require('./middleware/auth');
const { generateWithTrae, pickName } = require('./services/traeClient');
const {
  dimensionsFromScaffold,
  benchmarkBarsForUserApps,
  compareTrust,
  radarAggregate,
  barCompareMetrics,
} = require('./services/trustEngine');
const gamification = require('./services/gamification');

const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/iteragen';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret';

let memoryServerInstance = null;

function isLocalMongoUri(uri) {
  return /127\.0\.0\.1|localhost/.test(String(uri || ''));
}

async function connectInMemoryMongo() {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  memoryServerInstance = await MongoMemoryServer.create();
  const uri = memoryServerInstance.getUri('iteragen');
  await mongoose.connect(uri);
  console.log('[IteraGen] In-memory MongoDB started (data resets when the server stops).');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function signToken(user) {
  return jwt.sign({ sub: String(user._id), email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

app.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    const existing = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });
    const passwordHash = await bcrypt.hash(String(password), 10);
    const user = await User.create({
      email: String(email).toLowerCase().trim(),
      passwordHash,
      name: name ? String(name).trim() : 'Creator',
    });
    const token = signToken(user);
    res.status(201).json({
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        badges: user.badges,
        xp: user.xp,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });
    const token = signToken(user);
    res.json({
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        badges: user.badges,
        xp: user.xp,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not sign in.' });
  }
});

app.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-passwordHash');
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const apps = await AppModel.find({ userId: user._id }).sort({ createdAt: -1 }).limit(100);
    res.json({
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        badges: user.badges,
        xp: user.xp,
        deployCount: user.deployCount,
        highTrustAppCount: user.highTrustAppCount,
        pinnedAppIds: (user.pinnedApps || []).map((id) => String(id)),
      },
      apps: apps.map((a) => ({
        id: a._id,
        name: a.name,
        trustScore: a.trustScore,
        status: a.status,
        createdAt: a.createdAt,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load profile.' });
  }
});

app.post('/generateApp', requireAuth, async (req, res) => {
  try {
    const { prompt, fields, refinedFromPromptId } = req.body || {};
    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ error: 'Describe your app idea in the prompt field.' });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const promptDoc = await Prompt.create({
      userId: user._id,
      text: String(prompt).trim(),
      fields: Array.isArray(fields) ? fields : [],
      refinedFromPromptId: refinedFromPromptId || null,
    });

    const gen = await generateWithTrae(promptDoc.text, promptDoc.fields);
    const name = pickName(promptDoc.text);

    const appDoc = await AppModel.create({
      userId: user._id,
      promptId: promptDoc._id,
      name,
      scaffoldHtml: gen.scaffoldHtml || gen.html || '',
      scaffoldCss: gen.scaffoldCss || '',
      scaffoldJs: gen.scaffoldJs || '',
      status: 'draft',
      metadata: { generatorSource: gen.source || 'unknown' },
    });

    await gamification.onAppGenerated(user);
    await user.save();

    res.status(201).json({
      app: {
        id: appDoc._id,
        name: appDoc.name,
        status: appDoc.status,
        scaffoldHtml: appDoc.scaffoldHtml,
        createdAt: appDoc.createdAt,
      },
      promptId: promptDoc._id,
      generatorSource: gen.source,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Generation failed. Try again in a moment.' });
  }
});

app.post('/validateApp', requireAuth, async (req, res) => {
  try {
    const { appId, scaffoldHtml, scaffoldCss, scaffoldJs, fields } = req.body || {};
    let appDoc = null;
    let html = scaffoldHtml;
    let css = scaffoldCss;
    let js = scaffoldJs;
    let fld = fields;
    let entropy = '';

    if (appId) {
      appDoc = await AppModel.findOne({ _id: appId, userId: req.userId });
      if (!appDoc) return res.status(404).json({ error: 'App not found.' });
      html = appDoc.scaffoldHtml;
      css = appDoc.scaffoldCss;
      js = appDoc.scaffoldJs;
      const p = await Prompt.findById(appDoc.promptId);
      fld = p ? p.fields : [];
      entropy = `${appDoc._id}|${appDoc.createdAt}|${appDoc.name}|${p && p.text ? p.text : ''}`;
    }

    if (!html && !css && !js) {
      return res.status(400).json({ error: 'No scaffold to validate.' });
    }

    const dims = dimensionsFromScaffold(html || '', css || '', js || '', fld || [], entropy);
    const user = await User.findById(req.userId);

    if (appDoc) {
      appDoc.trustScore = dims.trustScore;
      appDoc.trustDimensions = {
        clarity: dims.clarity,
        logic: dims.logic,
        uiConsistency: dims.uiConsistency,
        reliability: dims.reliability,
      };
      appDoc.validationNotes = dims.notes;
      appDoc.status = 'validated';
      await appDoc.save();
    }

    if (user) {
      await gamification.onAppValidated(user, dims.trustScore);
      await user.save();
    }

    const appsForBench = appDoc
      ? await AppModel.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(8)
      : [];

    res.json({
      trustScore: dims.trustScore,
      dimensions: {
        clarity: dims.clarity,
        logic: dims.logic,
        uiConsistency: dims.uiConsistency,
        reliability: dims.reliability,
      },
      radar: ['clarity', 'logic', 'uiConsistency', 'reliability'].map((k) => ({
        axis: k,
        value: dims[k],
        label:
          k === 'uiConsistency'
            ? 'UI consistency'
            : k.charAt(0).toUpperCase() + k.slice(1),
      })),
      benchmarkBars: benchmarkBarsForUserApps(
        appsForBench.length ? appsForBench : [{ name: 'This app', trustScore: dims.trustScore }]
      ),
      notes: dims.notes,
      app: appDoc
        ? {
            id: appDoc._id,
            trustScore: appDoc.trustScore,
            status: appDoc.status,
            scaffoldHtml: appDoc.scaffoldHtml,
          }
        : null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Validation failed.' });
  }
});

app.get('/apps', requireAuth, async (req, res) => {
  try {
    const apps = await AppModel.find({ userId: req.userId }).sort({ createdAt: -1 });
    res.json({
      apps: apps.map((a) => ({
        id: a._id,
        name: a.name,
        trustScore: a.trustScore,
        status: a.status,
        trustDimensions: a.trustDimensions,
        createdAt: a.createdAt,
        metadata: a.metadata,
        scaffoldHtml: a.scaffoldHtml,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load apps.' });
  }
});

function trustDimsForApp(appDoc) {
  if (appDoc.trustDimensions && appDoc.trustScore != null) return { dims: appDoc.trustDimensions, score: appDoc.trustScore };
  const d = dimensionsFromScaffold(
    appDoc.scaffoldHtml,
    appDoc.scaffoldCss,
    appDoc.scaffoldJs,
    [],
    `${appDoc._id}|${appDoc.createdAt}|${appDoc.name}|${appDoc.promptId}`
  );
  return {
    dims: {
      clarity: d.clarity,
      logic: d.logic,
      uiConsistency: d.uiConsistency,
      reliability: d.reliability,
    },
    score: d.trustScore,
  };
}

app.post('/compareApps', requireAuth, async (req, res) => {
  try {
    const { appIdA, appIdB } = req.body || {};
    if (!appIdA || !appIdB) return res.status(400).json({ error: 'Select two apps to compare.' });
    const [appA, appB] = await Promise.all([
      AppModel.findOne({ _id: appIdA, userId: req.userId }),
      AppModel.findOne({ _id: appIdB, userId: req.userId }),
    ]);
    if (!appA || !appB) return res.status(404).json({ error: 'One or both apps were not found.' });

    const computedA = trustDimsForApp(appA);
    const computedB = trustDimsForApp(appB);
    if (appA.trustScore == null) {
      appA.trustScore = computedA.score;
      appA.trustDimensions = computedA.dims;
    }
    if (appB.trustScore == null) {
      appB.trustScore = computedB.score;
      appB.trustDimensions = computedB.dims;
    }

    const dimAfinal = appA.trustDimensions || computedA.dims;
    const dimBfinal = appB.trustDimensions || computedB.dims;

    const cmp = compareTrust(appA, appB);
    const radar = radarAggregate(dimAfinal, dimBfinal);
    const bars = barCompareMetrics(appA, appB);

    res.json({
      versionA: {
        id: appA._id,
        name: appA.name,
        trustScore: appA.trustScore,
        scaffoldHtml: appA.scaffoldHtml,
      },
      versionB: {
        id: appB._id,
        name: appB.name,
        trustScore: appB.trustScore,
        scaffoldHtml: appB.scaffoldHtml,
      },
      trustDeltaPercent: cmp.deltaPercent,
      stabilityForecast: cmp.forecast,
      favoring: cmp.favor,
      radar,
      barMetrics: bars,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Comparison failed.' });
  }
});

app.post('/togglePinApp', requireAuth, async (req, res) => {
  try {
    const { appId } = req.body || {};
    if (!appId) return res.status(400).json({ error: 'App ID is required.' });
    const appDoc = await AppModel.findOne({ _id: appId, userId: req.userId });
    if (!appDoc) return res.status(404).json({ error: 'App not found.' });
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const list = user.pinnedApps || [];
    const idx = list.findIndex((id) => String(id) === String(appId));
    if (idx >= 0) {
      list.splice(idx, 1);
    } else {
      if (list.length >= 24) return res.status(400).json({ error: 'Unpin an app before pinning another (max 24).' });
      list.push(appDoc._id);
    }
    user.pinnedApps = list;
    await user.save();
    const pinned = idx < 0;
    res.json({
      pinned,
      pinnedAppIds: user.pinnedApps.map((id) => String(id)),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update pin.' });
  }
});

app.post('/feedback', requireAuth, async (req, res) => {
  try {
    const { appId, comments, rating } = req.body || {};
    if (!appId) return res.status(400).json({ error: 'App ID is required.' });
    const appDoc = await AppModel.findOne({ _id: appId, userId: req.userId });
    if (!appDoc) return res.status(404).json({ error: 'App not found.' });
    const fb = await Feedback.create({
      userId: req.userId,
      appId: appDoc._id,
      comments: comments != null ? String(comments) : '',
      rating: rating != null ? Number(rating) : 5,
    });
    res.status(201).json({ id: fb._id, ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save feedback.' });
  }
});

app.post('/deploy', requireAuth, async (req, res) => {
  try {
    const { appId, version } = req.body || {};
    if (!appId) return res.status(400).json({ error: 'App ID is required.' });
    const appDoc = await AppModel.findOne({ _id: appId, userId: req.userId });
    if (!appDoc) return res.status(404).json({ error: 'App not found.' });
    appDoc.status = 'deployed';
    appDoc.metadata = { ...appDoc.metadata, deployedAs: version || 'current', deployedAt: new Date() };
    await appDoc.save();
    const user = await User.findById(req.userId);
    if (user) {
      await gamification.onAppDeployed(user);
      await user.save();
    }
    res.json({ ok: true, status: appDoc.status });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Deploy failed.' });
  }
});

async function start() {
  const forceMemory = process.env.MONGODB_URI === 'memory' || process.env.USE_MEMORY_DB === '1';
  try {
    if (forceMemory) {
      await connectInMemoryMongo();
    } else {
      await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
      console.log('[IteraGen] MongoDB connected');
    }
  } catch (err) {
    const canFallback =
      !forceMemory &&
      isLocalMongoUri(MONGODB_URI) &&
      (err.message.includes('ECONNREFUSED') ||
        err.message.includes('ETIMEDOUT') ||
        err.message.includes('Server selection timed out'));
    if (canFallback) {
      console.warn('[IteraGen] No MongoDB at', MONGODB_URI, '- using in-memory DB for this session.');
      try {
        await connectInMemoryMongo();
      } catch (e) {
        console.error('[IteraGen] In-memory MongoDB failed:', e.message);
        process.exit(1);
      }
    } else {
      console.error('[IteraGen] MongoDB connection failed:', err.message);
      console.error('Install/start MongoDB, set MONGODB_URI in .env, or use MONGODB_URI=memory for a dev-only database.');
      process.exit(1);
    }
  }

  app.listen(PORT, () => {
    console.log(`[IteraGen] http://localhost:${PORT}`);
  });
}

start();
