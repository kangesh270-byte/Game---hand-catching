/* =========================================================================
   CATCH THE BALL WITH YOUR HAND
   -------------------------------------------------------------------------
   A neon-themed browser game where the player slides a basket left/right
   using real-time hand tracking (MediaPipe Hands) to catch falling balls.

   File layout:
     index.html  - DOM structure, MediaPipe CDN scripts
     style.css   - Neon visual theme, layout, animations
     script.js   - (this file) game engine, hand tracking, audio, storage

   Sections in this file:
     1. Constants & configuration
     2. DOM references
     3. Persistent storage (high score)
     4. Audio engine (Web Audio API synthesized SFX - no external files)
     5. Canvas + responsive sizing
     6. Basket (player-controlled paddle)
     7. Falling objects (balls / gold / bombs / hearts)
     8. Particle system
     9. Hand tracking (MediaPipe Hands + camera_utils)
    10. Input fallback (mouse / keyboard)
    11. Game state machine & main loop
    12. UI wiring (buttons, screens, HUD)
   ========================================================================= */

(() => {
  'use strict';

  /* ======================================================================
     1. CONSTANTS & CONFIGURATION
     ====================================================================== */
  const CONFIG = {
    STARTING_LIVES: 3,
    MAX_LIVES: 5,
    BASKET_WIDTH_RATIO: 0.16,   // basket width as a fraction of canvas width
    BASKET_HEIGHT_RATIO: 0.055,
    BASKET_Y_OFFSET_RATIO: 0.03,  // gap from bottom edge
    BASE_FALL_SPEED: 2.2,         // px/frame at score 0 (scaled by dt)
    MAX_FALL_SPEED: 9.5,
    SPEED_SCORE_SCALE: 500,       // higher = slower ramp-up
    BASE_SPAWN_INTERVAL: 1150,    // ms between spawns at score 0
    MIN_SPAWN_INTERVAL: 420,
    GOLD_CHANCE: 0.12,
    BOMB_CHANCE: 0.14,
    HEART_CHANCE: 0.06,
    NORMAL_SCORE: 10,
    GOLD_SCORE: 50,
    HAND_SMOOTHING: 0.28,         // lerp factor for hand position (0-1)
    STORAGE_KEY_HIGHSCORE: 'catchball_highscore_v1',
  };

  const OBJECT_TYPES = {
    NORMAL: 'normal',
    GOLD: 'gold',
    BOMB: 'bomb',
    HEART: 'heart',
  };

  /* ======================================================================
     2. DOM REFERENCES
     ====================================================================== */
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const stage = document.getElementById('stage');

  const videoEl = document.getElementById('inputVideo');
  const handOverlay = document.getElementById('handOverlay');
  const handCtx = handOverlay.getContext('2d');
  const camPreview = document.getElementById('camPreview');

  const scoreValueEl = document.getElementById('scoreValue');
  const livesValueEl = document.getElementById('livesValue');
  const highScoreValueEl = document.getElementById('highScoreValue');

  const pauseBtn = document.getElementById('pauseBtn');
  const restartBtn = document.getElementById('restartBtn');
  const muteBtn = document.getElementById('muteBtn');
  const camToggleBtn = document.getElementById('camToggleBtn');

  const startScreen = document.getElementById('startScreen');
  const pauseScreen = document.getElementById('pauseScreen');
  const gameOverScreen = document.getElementById('gameOverScreen');

  const startBtn = document.getElementById('startBtn');
  const skipCamBtn = document.getElementById('skipCamBtn');
  const camStatus = document.getElementById('camStatus');
  const resumeBtn = document.getElementById('resumeBtn');
  const restartFromPauseBtn = document.getElementById('restartFromPauseBtn');
  const playAgainBtn = document.getElementById('playAgainBtn');
  const finalScoreEl = document.getElementById('finalScore');
  const newHighBadge = document.getElementById('newHighBadge');
  const toastEl = document.getElementById('toast');

  /* ======================================================================
     3. PERSISTENT STORAGE (High Score)
     ====================================================================== */
  const Storage = {
    getHighScore() {
      const raw = localStorage.getItem(CONFIG.STORAGE_KEY_HIGHSCORE);
      const val = parseInt(raw, 10);
      return Number.isFinite(val) ? val : 0;
    },
    setHighScore(value) {
      localStorage.setItem(CONFIG.STORAGE_KEY_HIGHSCORE, String(value));
    },
  };

  /* ======================================================================
     4. AUDIO ENGINE
     Synth SFX generated on the fly with the Web Audio API so the game
     needs zero external audio assets.
     ====================================================================== */
  const Audio_ = {
    ctx: null,
    muted: false,

    init() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
      }
    },

    resume() {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },

    // Simple oscillator "blip" with an exponential decay envelope.
    tone(freq, duration, type = 'sine', volume = 0.18, delay = 0) {
      if (this.muted || !this.ctx) return;
      const t0 = this.ctx.currentTime + delay;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(volume, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    },

    catch() { this.tone(660, 0.12, 'triangle', 0.16); this.tone(880, 0.1, 'triangle', 0.1, 0.05); },
    gold() { this.tone(880, 0.1, 'square', 0.15); this.tone(1180, 0.14, 'square', 0.14, 0.06); this.tone(1568, 0.18, 'square', 0.12, 0.12); },
    bomb() { this.tone(120, 0.35, 'sawtooth', 0.22); this.tone(70, 0.4, 'square', 0.18, 0.05); },
    heart() { this.tone(523, 0.1, 'sine', 0.16); this.tone(659, 0.1, 'sine', 0.14, 0.08); this.tone(784, 0.16, 'sine', 0.14, 0.16); },
    miss() { this.tone(200, 0.2, 'sawtooth', 0.14); },
    gameover() { this.tone(300, 0.2, 'sawtooth', 0.2); this.tone(220, 0.25, 'sawtooth', 0.18, 0.15); this.tone(140, 0.4, 'sawtooth', 0.16, 0.3); },
    click() { this.tone(440, 0.06, 'square', 0.08); },
    speedup() { this.tone(440, 0.08, 'triangle', 0.14); this.tone(660, 0.1, 'triangle', 0.14, 0.06); },
  };

  /* ======================================================================
     5. CANVAS + RESPONSIVE SIZING
     ====================================================================== */
  let DPR = Math.min(window.devicePixelRatio || 1, 2);
  let W = 0, H = 0; // logical (CSS) canvas dimensions

  function resizeCanvas() {
    const rect = stage.getBoundingClientRect();
    W = rect.width;
    H = rect.height;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    // Keep basket within new bounds
    if (basket) {
      basket.width = W * CONFIG.BASKET_WIDTH_RATIO;
      basket.height = H * CONFIG.BASKET_HEIGHT_RATIO;
      basket.y = H - basket.height - H * CONFIG.BASKET_Y_OFFSET_RATIO;
      basket.x = Math.min(Math.max(basket.x, 0), W - basket.width);
      basket.targetX = basket.x;
    }
  }
  window.addEventListener('resize', resizeCanvas);

  /* ======================================================================
     6. BASKET (player paddle)
     ====================================================================== */
  const basket = {
    x: 0, y: 0, width: 0, height: 0, targetX: 0,
    color: '#00f6ff',
    glowPulse: 0,
  };

  function initBasket() {
    basket.width = W * CONFIG.BASKET_WIDTH_RATIO;
    basket.height = H * CONFIG.BASKET_HEIGHT_RATIO;
    basket.x = (W - basket.width) / 2;
    basket.targetX = basket.x;
    basket.y = H - basket.height - H * CONFIG.BASKET_Y_OFFSET_RATIO;
  }

  function drawBasket() {
    const { x, y, width: w, height: h } = basket;
    const cx = x + w / 2;

    ctx.save();
    // Glow
    ctx.shadowColor = '#00f6ff';
    ctx.shadowBlur = 22;

    // Basket body: rounded trapezoid "net" shape
    const topInset = w * 0.06;
    ctx.beginPath();
    ctx.moveTo(x + topInset, y);
    ctx.lineTo(x + w - topInset, y);
    ctx.lineTo(x + w - topInset * 2.4, y + h);
    ctx.lineTo(x + topInset * 2.4, y + h);
    ctx.closePath();

    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, 'rgba(0,246,255,0.35)');
    grad.addColorStop(1, 'rgba(0,246,255,0.08)');
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.lineWidth = 3;
    ctx.strokeStyle = '#00f6ff';
    ctx.stroke();

    // Net cross-lines for texture
    ctx.shadowBlur = 6;
    ctx.strokeStyle = 'rgba(0,246,255,0.5)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const fx = x + topInset + (i / 4) * (w - topInset * 2);
      const fx2 = x + topInset * 2.4 + (i / 4) * (w - topInset * 2 * 2.4);
      ctx.beginPath();
      ctx.moveTo(fx, y);
      ctx.lineTo(fx2, y + h);
      ctx.stroke();
    }

    // Rim highlight
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#e8feff';
    ctx.stroke();

    ctx.restore();
  }

  /* ======================================================================
     7. FALLING OBJECTS
     ====================================================================== */
  let fallingObjects = [];
  let spawnTimer = 0;
  let spawnInterval = CONFIG.BASE_SPAWN_INTERVAL;

  function pickObjectType() {
    const r = Math.random();
    if (r < CONFIG.BOMB_CHANCE) return OBJECT_TYPES.BOMB;
    if (r < CONFIG.BOMB_CHANCE + CONFIG.HEART_CHANCE) return OBJECT_TYPES.HEART;
    if (r < CONFIG.BOMB_CHANCE + CONFIG.HEART_CHANCE + CONFIG.GOLD_CHANCE) return OBJECT_TYPES.GOLD;
    return OBJECT_TYPES.NORMAL;
  }

  function currentFallSpeed() {
    const s = CONFIG.BASE_FALL_SPEED + (score / CONFIG.SPEED_SCORE_SCALE) * (CONFIG.MAX_FALL_SPEED - CONFIG.BASE_FALL_SPEED);
    return Math.min(s, CONFIG.MAX_FALL_SPEED);
  }

  function currentSpawnInterval() {
    const s = CONFIG.BASE_SPAWN_INTERVAL - (score / CONFIG.SPEED_SCORE_SCALE) * (CONFIG.BASE_SPAWN_INTERVAL - CONFIG.MIN_SPAWN_INTERVAL);
    return Math.max(s, CONFIG.MIN_SPAWN_INTERVAL);
  }

  function spawnObject() {
    const type = pickObjectType();
    const radius = W * (type === OBJECT_TYPES.BOMB ? 0.026 : 0.024);
    const x = radius + Math.random() * (W - radius * 2);
    const speed = currentFallSpeed() * (0.85 + Math.random() * 0.3);
    const rotation = Math.random() * Math.PI * 2;
    const rotSpeed = (Math.random() - 0.5) * 0.06;

    fallingObjects.push({
      type, x, y: -radius, radius, speed, rotation, rotSpeed,
      wobble: Math.random() * Math.PI * 2,
    });
  }

  function colorForType(type) {
    switch (type) {
      case OBJECT_TYPES.GOLD: return '#ffd447';
      case OBJECT_TYPES.BOMB: return '#ff3860';
      case OBJECT_TYPES.HEART: return '#39ff88';
      default: return '#00f6ff';
    }
  }

  function drawFallingObjects(dtScale) {
    for (const obj of fallingObjects) {
      obj.wobble += 0.05 * dtScale;
      const wobbleX = Math.sin(obj.wobble) * obj.radius * 0.15;

      ctx.save();
      ctx.translate(obj.x + wobbleX, obj.y);
      ctx.rotate(obj.rotation);

      const color = colorForType(obj.type);
      ctx.shadowColor = color;
      ctx.shadowBlur = 18;

      if (obj.type === OBJECT_TYPES.BOMB) {
        // Bomb: dark sphere + fuse + spark
        ctx.beginPath();
        ctx.arc(0, 0, obj.radius, 0, Math.PI * 2);
        const g = ctx.createRadialGradient(-obj.radius * 0.3, -obj.radius * 0.3, obj.radius * 0.1, 0, 0, obj.radius);
        g.addColorStop(0, '#3a3a3a');
        g.addColorStop(1, '#111');
        ctx.fillStyle = g;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.stroke();
        // fuse
        ctx.beginPath();
        ctx.moveTo(0, -obj.radius);
        ctx.quadraticCurveTo(obj.radius * 0.5, -obj.radius * 1.6, obj.radius * 0.15, -obj.radius * 1.9);
        ctx.strokeStyle = '#c48a3a';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(obj.radius * 0.15, -obj.radius * 1.95, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#ffcf5a';
        ctx.shadowBlur = 10;
        ctx.fill();
      } else if (obj.type === OBJECT_TYPES.HEART) {
        drawHeartShape(ctx, obj.radius, color);
      } else {
        // Normal & gold: glossy sphere
        ctx.beginPath();
        ctx.arc(0, 0, obj.radius, 0, Math.PI * 2);
        const g = ctx.createRadialGradient(-obj.radius * 0.3, -obj.radius * 0.35, obj.radius * 0.15, 0, 0, obj.radius);
        g.addColorStop(0, '#ffffff');
        g.addColorStop(0.25, color);
        g.addColorStop(1, shade(color, -30));
        ctx.fillStyle = g;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = color;
        ctx.stroke();
        if (obj.type === OBJECT_TYPES.GOLD) {
          // small sparkle accents
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.beginPath();
          ctx.arc(-obj.radius * 0.35, -obj.radius * 0.35, obj.radius * 0.14, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.restore();
      obj.rotation += obj.rotSpeed * dtScale;
    }
  }

  function drawHeartShape(ctx2, r, color) {
    ctx2.beginPath();
    const s = r * 0.9;
    ctx2.moveTo(0, s * 0.35);
    ctx2.bezierCurveTo(s, -s * 0.6, s * 1.3, s * 0.55, 0, s * 1.25);
    ctx2.bezierCurveTo(-s * 1.3, s * 0.55, -s, -s * 0.6, 0, s * 0.35);
    ctx2.closePath();
    const g = ctx2.createRadialGradient(0, 0, s * 0.1, 0, 0, s * 1.2);
    g.addColorStop(0, '#eaffef');
    g.addColorStop(0.4, color);
    g.addColorStop(1, shade(color, -25));
    ctx2.fillStyle = g;
    ctx2.fill();
    ctx2.lineWidth = 1.5;
    ctx2.strokeStyle = color;
    ctx2.stroke();
  }

  // Darken/lighten a hex color by `percent` (-100..100)
  function shade(hex, percent) {
    const num = parseInt(hex.slice(1), 16);
    let r = (num >> 16) + Math.round(2.55 * percent);
    let g = ((num >> 8) & 0x00ff) + Math.round(2.55 * percent);
    let b = (num & 0x0000ff) + Math.round(2.55 * percent);
    r = Math.min(255, Math.max(0, r));
    g = Math.min(255, Math.max(0, g));
    b = Math.min(255, Math.max(0, b));
    return `rgb(${r},${g},${b})`;
  }

  /* ======================================================================
     8. PARTICLE SYSTEM (catch bursts / explosions)
     ====================================================================== */
  let particles = [];

  function spawnParticles(x, y, color, count = 16, options = {}) {
    const speed = options.speed || 3.4;
    const life = options.life || 32;
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const spd = speed * (0.5 + Math.random() * 0.7);
      particles.push({
        x, y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd - 1.5,
        life, maxLife: life,
        radius: 2 + Math.random() * 3,
        color,
      });
    }
  }

  function updateAndDrawParticles(dtScale) {
    particles = particles.filter(p => p.life > 0);
    for (const p of particles) {
      p.x += p.vx * dtScale;
      p.y += p.vy * dtScale;
      p.vy += 0.12 * dtScale; // gravity
      p.life -= dtScale;

      const alpha = Math.max(p.life / p.maxLife, 0);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /* ======================================================================
     9. HAND TRACKING (MediaPipe Hands + camera_utils)
     ====================================================================== */
  let handX = null;          // normalized 0..1 (mirrored to match user's view)
  let handDetected = false;
  let mpCamera = null;
  let usingHandTracking = false;

  function onHandResults(results) {
    handOverlay.width = videoEl.videoWidth || handOverlay.width;
    handOverlay.height = videoEl.videoHeight || handOverlay.height;
    handCtx.save();
    handCtx.clearRect(0, 0, handOverlay.width, handOverlay.height);

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      handDetected = true;
      const landmarks = results.multiHandLandmarks[0];

      // Draw skeleton on the small preview for visual feedback
      if (window.drawConnectors && window.drawLandmarks) {
        window.drawConnectors(handCtx, landmarks, window.HAND_CONNECTIONS, { color: '#00f6ff', lineWidth: 2 });
        window.drawLandmarks(handCtx, landmarks, { color: '#ff2ea6', radius: 2 });
      }

      // Use the palm center (average of wrist + middle-finger MCP) for stability
      const wrist = landmarks[0];
      const middleMcp = landmarks[9];
      const rawX = (wrist.x + middleMcp.x) / 2; // 0 (video-left) .. 1 (video-right)

      // Video is displayed mirrored (CSS scaleX(-1)) for intuitive control,
      // so the "visual" left/right the player sees is (1 - rawX).
      handX = 1 - rawX;
    } else {
      handDetected = false;
    }
    handCtx.restore();
  }

  async function initHandTracking() {
    try {
      camStatus.textContent = 'Requesting camera permission…';

      const hands = new Hands({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
      });
      hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 0,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.5,
      });
      hands.onResults(onHandResults);

      mpCamera = new Camera(videoEl, {
        onFrame: async () => {
          await hands.send({ image: videoEl });
        },
        width: 320,
        height: 240,
      });

      await mpCamera.start();
      usingHandTracking = true;
      camStatus.textContent = '✅ Camera ready — move your hand!';
      return true;
    } catch (err) {
      console.warn('Hand tracking unavailable:', err);
      camStatus.textContent = '⚠️ Camera unavailable — using mouse/keyboard instead.';
      usingHandTracking = false;
      camPreview.classList.add('hidden-cam');
      return false;
    }
  }

  /* ======================================================================
     10. INPUT FALLBACK (mouse / touch / keyboard)
     ====================================================================== */
  let mouseX = null;
  const keys = { left: false, right: false };

  stage.addEventListener('mousemove', (e) => {
    const rect = stage.getBoundingClientRect();
    mouseX = e.clientX - rect.left;
  });
  stage.addEventListener('touchmove', (e) => {
    const rect = stage.getBoundingClientRect();
    mouseX = e.touches[0].clientX - rect.left;
  }, { passive: true });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') keys.left = true;
    if (e.key === 'ArrowRight') keys.right = true;
    if (e.key === ' ' || e.key === 'Escape') togglePause();
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft') keys.left = false;
    if (e.key === 'ArrowRight') keys.right = false;
  });

  function updateBasketTarget(dtScale) {
    if (usingHandTracking && handDetected && handX !== null) {
      basket.targetX = handX * W - basket.width / 2;
    } else if (mouseX !== null) {
      basket.targetX = mouseX - basket.width / 2;
    }

    if (keys.left) basket.targetX -= 9 * dtScale;
    if (keys.right) basket.targetX += 9 * dtScale;

    basket.targetX = Math.min(Math.max(basket.targetX, 0), W - basket.width);

    // Smooth toward target (hand tracking jitter reduction)
    const smoothing = usingHandTracking ? CONFIG.HAND_SMOOTHING : 0.45;
    basket.x += (basket.targetX - basket.x) * smoothing * dtScale;
  }

  /* ======================================================================
     11. GAME STATE MACHINE & MAIN LOOP
     ====================================================================== */
  let score = 0;
  let lives = CONFIG.STARTING_LIVES;
  let highScore = Storage.getHighScore();
  let missedInARow = 0;
  let gameState = 'start'; // 'start' | 'playing' | 'paused' | 'gameover'
  let lastTime = 0;
  let lastSpeedMilestone = 0;
  let rafId = null;

  function updateHUD() {
    scoreValueEl.textContent = String(score);
    highScoreValueEl.textContent = String(highScore);
    livesValueEl.textContent = '❤️'.repeat(Math.max(lives, 0)) + '🖤'.repeat(Math.max(CONFIG.STARTING_LIVES - lives, 0) > 0 ? 0 : 0);
    // Show lives as heart icons; extra lives (power-up) simply add more hearts
    livesValueEl.textContent = '❤️'.repeat(Math.max(lives, 0));
  }

  function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.remove('show'), 1200);
  }

  function resetGame() {
    score = 0;
    lives = CONFIG.STARTING_LIVES;
    missedInARow = 0;
    fallingObjects = [];
    particles = [];
    spawnTimer = 0;
    spawnInterval = CONFIG.BASE_SPAWN_INTERVAL;
    lastSpeedMilestone = 0;
    initBasket();
    updateHUD();
  }

  function startGame() {
    resetGame();
    gameState = 'playing';
    startScreen.classList.add('hidden');
    pauseScreen.classList.add('hidden');
    gameOverScreen.classList.add('hidden');
    lastTime = performance.now();
    if (!rafId) rafId = requestAnimationFrame(loop);
  }

  function togglePause() {
    if (gameState === 'playing') {
      gameState = 'paused';
      pauseScreen.classList.remove('hidden');
      pauseBtn.textContent = '▶';
      Audio_.click();
    } else if (gameState === 'paused') {
      gameState = 'playing';
      pauseScreen.classList.add('hidden');
      pauseBtn.textContent = '⏸';
      lastTime = performance.now();
      Audio_.click();
    }
  }

  function endGame() {
    gameState = 'gameover';
    Audio_.gameover();
    finalScoreEl.textContent = String(score);
    if (score > highScore) {
      highScore = score;
      Storage.setHighScore(highScore);
      newHighBadge.classList.remove('hidden');
    } else {
      newHighBadge.classList.add('hidden');
    }
    updateHUD();
    gameOverScreen.classList.remove('hidden');
  }

  function handleCatch(obj) {
    switch (obj.type) {
      case OBJECT_TYPES.NORMAL:
        score += CONFIG.NORMAL_SCORE;
        spawnParticles(obj.x, obj.y, colorForType(obj.type), 14);
        Audio_.catch();
        break;
      case OBJECT_TYPES.GOLD:
        score += CONFIG.GOLD_SCORE;
        spawnParticles(obj.x, obj.y, colorForType(obj.type), 24, { speed: 4.4, life: 42 });
        Audio_.gold();
        showToast('+50 GOLD!');
        break;
      case OBJECT_TYPES.BOMB:
        lives -= 1;
        spawnParticles(obj.x, obj.y, colorForType(obj.type), 26, { speed: 5, life: 36 });
        Audio_.bomb();
        shakeScreen();
        break;
      case OBJECT_TYPES.HEART:
        if (lives < CONFIG.MAX_LIVES) lives += 1;
        spawnParticles(obj.x, obj.y, colorForType(obj.type), 18, { life: 38 });
        Audio_.heart();
        showToast('+1 LIFE');
        break;
    }
    updateHUD();
    if (lives <= 0) endGame();
  }

  function handleMiss(obj) {
    if (obj.type === OBJECT_TYPES.NORMAL || obj.type === OBJECT_TYPES.GOLD) {
      lives -= 1;
      Audio_.miss();
      updateHUD();
      if (lives <= 0) endGame();
    }
    // Missing a bomb or heart has no penalty/benefit — only catching matters for those.
  }

  // Simple screen-shake effect via a transient canvas transform offset
  let shakeFrames = 0;
  function shakeScreen() { shakeFrames = 10; }

  function checkCollisions() {
    const remaining = [];
    for (const obj of fallingObjects) {
      const basketTop = basket.y;
      const basketBottom = basket.y + basket.height;
      const inYRange = obj.y + obj.radius >= basketTop && obj.y - obj.radius <= basketBottom;
      const inXRange = obj.x + obj.radius >= basket.x && obj.x - obj.radius <= basket.x + basket.width;

      if (inYRange && inXRange && obj.y < basketBottom) {
        handleCatch(obj);
        continue; // remove caught object
      }

      if (obj.y - obj.radius > H) {
        handleMiss(obj);
        continue; // remove missed object
      }

      remaining.push(obj);
    }
    fallingObjects = remaining;
  }

  function updateDifficulty() {
    spawnInterval = currentSpawnInterval();
    const milestone = Math.floor(score / 200);
    if (milestone > lastSpeedMilestone) {
      lastSpeedMilestone = milestone;
      showToast('SPEED UP!');
      Audio_.speedup();
    }
  }

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    const dt = Math.min(now - lastTime, 50); // clamp to avoid huge jumps on tab-switch
    lastTime = now;
    const dtScale = dt / (1000 / 60); // normalize to ~60fps steps

    // Clear canvas
    ctx.clearRect(0, 0, W, H);

    // Optional screen shake
    ctx.save();
    if (shakeFrames > 0) {
      const mag = 6 * (shakeFrames / 10);
      ctx.translate((Math.random() - 0.5) * mag, (Math.random() - 0.5) * mag);
      shakeFrames--;
    }

    // Draw falling-object ground shadow line (basket lane guide)
    drawLaneGuide();

    if (gameState === 'playing') {
      updateBasketTarget(dtScale);
      updateDifficulty();

      spawnTimer += dt;
      if (spawnTimer >= spawnInterval) {
        spawnTimer = 0;
        spawnObject();
      }

      for (const obj of fallingObjects) {
        obj.y += obj.speed * dtScale;
      }
      checkCollisions();
    } else {
      // still allow basket to glide even while paused/menu for nice idle motion
    }

    drawFallingObjects(dtScale);
    drawBasket();
    updateAndDrawParticles(dtScale);

    ctx.restore();
  }

  function drawLaneGuide() {
    ctx.save();
    ctx.strokeStyle = 'rgba(0,246,255,0.12)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 10]);
    ctx.beginPath();
    ctx.moveTo(0, basket.y - 6);
    ctx.lineTo(W, basket.y - 6);
    ctx.stroke();
    ctx.restore();
  }

  /* ======================================================================
     12. UI WIRING
     ====================================================================== */
  function setupUI() {
    startBtn.addEventListener('click', async () => {
      Audio_.init();
      Audio_.resume();
      Audio_.click();
      startBtn.disabled = true;
      const ok = await initHandTracking();
      startBtn.disabled = false;
      startGame();
      if (!ok) { /* fallback already messaged */ }
    });

    skipCamBtn.addEventListener('click', () => {
      Audio_.init();
      Audio_.resume();
      Audio_.click();
      usingHandTracking = false;
      camPreview.classList.add('hidden-cam');
      camStatus.textContent = 'Using mouse / keyboard controls.';
      startGame();
    });

    pauseBtn.addEventListener('click', togglePause);
    resumeBtn.addEventListener('click', togglePause);

    restartBtn.addEventListener('click', () => { Audio_.click(); startGame(); });
    restartFromPauseBtn.addEventListener('click', () => { Audio_.click(); startGame(); });
    playAgainBtn.addEventListener('click', () => { Audio_.click(); startGame(); });

    muteBtn.addEventListener('click', () => {
      Audio_.muted = !Audio_.muted;
      muteBtn.textContent = Audio_.muted ? '🔇' : '🔊';
    });

    camToggleBtn.addEventListener('click', () => {
      camPreview.classList.toggle('hidden-cam');
    });

    // Pause automatically when the tab loses visibility
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && gameState === 'playing') togglePause();
    });
  }

  /* ======================================================================
     INITIALIZATION
     ====================================================================== */
  function init() {
    resizeCanvas();
    initBasket();
    highScoreValueEl.textContent = String(highScore);
    updateHUD();
    setupUI();
    // Kick off a static render loop even before Start is pressed, so the
    // basket / background are visible behind the start screen.
    lastTime = performance.now();
    rafId = requestAnimationFrame(loop);
  }

  init();
})();
