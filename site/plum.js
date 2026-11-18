// Plum, Atrium's character, drawn live in 3D with three.js r128 (site/vendor). The model and its six poses are the
// approved design, ported as-is. A page shows a still image of Plum first (plum/<pose>.webp), so it's complete before
// any WebGL starts; the live Plum fades in over it once three.js has loaded, and the still stays where WebGL can't run.

export const POSES = ["brief", "work", "checks", "ready", "look", "quiet"];

const THREE_URL = new URL("vendor/three-0.128.0.min.js", import.meta.url).href;
let threeLoading;

// One copy of three.js per page, loaded on first use.
export function loadThree() {
  if (globalThis.THREE) return Promise.resolve(globalThis.THREE);
  threeLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = THREE_URL;
    s.onload = () => (globalThis.THREE ? resolve(globalThis.THREE) : reject(new Error("three.js didn't load")));
    s.onerror = () => reject(new Error("three.js didn't load"));
    document.head.appendChild(s);
  });
  return threeLoading;
}

// Whether this browser can draw WebGL at all; when it can't, three.js isn't downloaded.
export function canDrawWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

// The "ready" pose hops once every HOP_SECONDS; the first HOP_RISE of each hop is Plum going up.
export const HOP_SECONDS = 1.8;
const HOP_RISE = 0.32;

// Given the animation clock in seconds, says true once as each hop starts. A hop already past its rise (Plum coming
// back on screen mid-air) doesn't count.
export function hopper(period = HOP_SECONDS) {
  let last = -1;
  return (t) => {
    const n = Math.floor(t / period);
    if (n === last) return false;
    last = n;
    return t - n * period < period * HOP_RISE;
  };
}

export const stillSrc = (pose) => new URL(`plum/${pose}.webp`, import.meta.url).href;

// The page finishes loading before any WebGL starts, and a Plum further down starts about a screen and a half ahead
// of being reached: building one takes a moment, and a still standing in for it would read as Plum frozen.
const loaded = () => (document.readyState === "complete" ? Promise.resolve() : new Promise((r) => addEventListener("load", r, { once: true })));
const near = (el) =>
  new Promise((resolve) => {
    if (typeof IntersectionObserver === "undefined") return resolve();
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        resolve();
      },
      { rootMargin: "150% 0px" },
    );
    io.observe(el);
  });

// Mounts Plum into `el`, which already holds an <img class="plum-still">. Returns a handle whose set() changes the
// pose live, or swaps the still when there's no live Plum. Options: pose, interactive (looks at the pointer, a click
// boops it, a mouse drag turns it), still (holds each pose with no motion; follows the reduced-motion setting, even
// when it changes, unless given), lazy (waits until it's nearly on screen), load (how three.js is fetched, for tests),
// onLive (called once the live Plum is drawing), onHop (called as each "ready" hop starts; where the still image
// stays, on the same cadence), hopOnClick (a "ready" Plum bounces gently and makes its full hop only when clicked or
// pressed with Enter or Space; the still fires onHop on the press). If the browser loses the WebGL context, the still comes back.
export function mountPlum(el, opts = {}) {
  let pose = POSES.includes(opts.pose) ? opts.pose : "quiet";
  const img = el.querySelector("img.plum-still");
  const motion = opts.still === undefined ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  let still = opts.still ?? motion.matches;
  let live = null;
  let gone = false;
  // The still can't hop, so its hops are kept by a timer instead, firing only when a live Plum would be hopping.
  let hopTimer = 0;
  const keepHops = () => {
    if (!opts.onHop || opts.hopOnClick || hopTimer) return;
    hopTimer = setInterval(() => {
      if (!gone && !live && !still && pose === "ready") opts.onHop();
    }, HOP_SECONDS * 1000);
  };
  const showStill = () => {
    el.classList.remove("plum-live");
    if (img) img.src = stillSrc(pose);
    keepHops();
  };
  const onMotion = (e) => {
    still = e.matches;
    live?.still(still);
  };
  motion?.addEventListener?.("change", onMotion);
  const hop = () => {
    if (gone || still || pose !== "ready") return;
    if (live) live.hop();
    else opts.onHop?.();
  };
  const onPress = (e) => {
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    if (e.type === "keydown") e.preventDefault();
    hop();
  };
  if (opts.hopOnClick) {
    el.addEventListener("click", onPress);
    el.addEventListener("keydown", onPress);
  }

  const handle = {
    // Settles once Plum is live, or once it's clear the still stays.
    ready: Promise.resolve(),
    error: null,
    get pose() {
      return pose;
    },
    get live() {
      return live !== null;
    },
    set(next) {
      if (!POSES.includes(next) || next === pose) return;
      pose = next;
      if (live) live.pose(next);
      else if (img) img.src = stillSrc(next);
    },
    destroy() {
      gone = true;
      clearInterval(hopTimer);
      el.removeEventListener("click", onPress);
      el.removeEventListener("keydown", onPress);
      motion?.removeEventListener?.("change", onMotion);
      live?.destroy();
      live = null;
    },
  };
  const load = opts.load ?? (() => (canDrawWebGL() ? loadThree() : Promise.reject(new Error("This browser can't draw WebGL."))));

  handle.ready = loaded()
    .then(() => (opts.lazy ? near(el) : undefined))
    .then(() => load())
    .then((T) => {
      if (gone) return;
      live = build(T, el, {
        still,
        interactive: !!opts.interactive,
        pose: () => pose,
        onHop: opts.onHop,
        hopOnClick: !!opts.hopOnClick,
        lost: () => {
          live?.destroy();
          live = null;
          showStill();
        },
      });
      if (!live) return keepHops();
      el.classList.add("plum-live");
      opts.onLive?.();
    })
    .catch((e) => {
      // No three.js or no WebGL: the still image is Plum.
      handle.error = e;
      if (!gone) keepHops();
    });
  return handle;
}

function build(T, el, opts) {
  let renderer;
  try {
    renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    return null;
  }
  try {
    return draw(T, el, renderer, opts);
  } catch {
    // Half a scene is no Plum: give the context back and keep the still.
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
    return null;
  }
}

function draw(T, el, renderer, { still: startStill, interactive, pose: currentPose, onHop, hopOnClick, lost }) {
  let still = startStill;
  let state = currentPose();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputEncoding = T.sRGBEncoding;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.domElement.className = "plum-canvas";
  renderer.domElement.setAttribute("aria-hidden", "true");
  el.appendChild(renderer.domElement);

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(27, 1, 0.1, 50);
  camera.position.set(0, 0.5, 7.4);
  camera.lookAt(0, 0, 0);

  // A small softbox studio baked into an environment map gives the matte body its soft gradients and the eyes their reflections.
  const pmrem = new T.PMREMGenerator(renderer);
  const studio = new T.Scene();
  studio.add(new T.Mesh(new T.BoxGeometry(10, 10, 10), new T.MeshBasicMaterial({ color: 0x5c566c, side: T.BackSide })));
  const softbox = (w, h, hex, power, pos) => {
    const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: new T.Color(hex).multiplyScalar(power), side: T.DoubleSide }));
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    studio.add(m);
  };
  softbox(6, 3, 0xffffff, 5, [0, 4.8, 1]);
  softbox(3, 4, 0xd8caff, 3.2, [-4.8, 1, 2]);
  softbox(2, 4, 0xffdcec, 2.2, [4.8, 0.4, 1.5]);
  softbox(5, 2, 0xffffff, 1.2, [0, -0.5, 4.8]);
  const envMap = pmrem.fromScene(studio, 0.04).texture;
  scene.environment = envMap;
  pmrem.dispose();
  studio.traverse((o) => {
    o.geometry?.dispose();
    o.material?.dispose();
  });
  const key = new T.DirectionalLight(0xffffff, 0.55);
  key.position.set(-2.5, 5, 3);
  scene.add(key);

  const lin = (hex) => new T.Color(hex).convertSRGBToLinear();
  const skin = new T.MeshPhysicalMaterial({ color: lin("#9A85EE"), roughness: 0.55, clearcoat: 0.22, clearcoatRoughness: 0.4 });
  const limb = new T.MeshPhysicalMaterial({ color: lin("#8E79E6"), roughness: 0.55, clearcoat: 0.2, clearcoatRoughness: 0.4 });
  const eyeMat = new T.MeshPhysicalMaterial({ color: lin("#1C1734"), roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.04 });
  const shine = new T.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const mouthMat = new T.MeshPhysicalMaterial({ color: lin("#2A1E46"), roughness: 0.4 });

  // The egg: a sphere stretched tall, narrower at the crown, a touch flatter front to back.
  const HALF = 1.1;
  const geo = new T.SphereGeometry(1, 160, 120);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), s = 1 - 0.09 * y;
    pos.setXYZ(i, x * s, y * HALF, z * s * 0.93);
  }
  geo.computeVertexNormals();
  const bodyMesh = new T.Mesh(geo, skin);
  bodyMesh.updateMatrixWorld(true);
  const ray = new T.Raycaster();
  const surf = (x, y) => {
    ray.set(new T.Vector3(x, y, 5), new T.Vector3(0, 0, -1));
    const h = ray.intersectObject(bodyMesh)[0];
    return { p: h.point.clone(), n: h.face.normal.clone().normalize() };
  };
  const body = new T.Group();
  body.add(bodyMesh);
  const stick = (obj, x, y, lift) => {
    const { p, n } = surf(x, y);
    obj.position.copy(p).addScaledVector(n, lift);
    obj.lookAt(p.clone().addScaledVector(n, lift + 1));
    body.add(obj);
  };

  const eyes = [-0.29, 0.29].map((x) => {
    const g = new T.Group(), inner = new T.Group();
    const ball = new T.Mesh(new T.SphereGeometry(0.135, 48, 32), eyeMat);
    ball.scale.set(0.9, 1.12, 0.55);
    const big = new T.Mesh(new T.SphereGeometry(0.036, 16, 12), shine);
    big.position.set(-0.038, 0.058, 0.066);
    const small = new T.Mesh(new T.SphereGeometry(0.016, 12, 8), shine);
    small.position.set(0.034, -0.05, 0.068);
    inner.add(ball, big, small);
    g.add(inner);
    stick(g, x, 0.2, -0.034);
    return inner;
  });

  const curveOn = (fn, lift) => {
    const pts = [];
    for (let i = 0; i <= 18; i++) {
      const t = (i / 18) * 2 - 1, [x, y] = fn(t), { p, n } = surf(x, y);
      pts.push(p.addScaledVector(n, lift));
    }
    return new T.CatmullRomCurve3(pts);
  };
  const tube = (curve) => {
    const g = new T.Group();
    g.add(new T.Mesh(new T.TubeGeometry(curve, 48, 0.017, 12, false), mouthMat));
    for (const t of [0, 1]) {
      const c = new T.Mesh(new T.SphereGeometry(0.017, 12, 8), mouthMat);
      c.position.copy(curve.getPoint(t));
      g.add(c);
    }
    body.add(g);
    return g;
  };
  const smile = tube(curveOn((t) => [t * 0.12, -0.04 - 0.055 * (1 - t * t)], 0.004));
  const flat = tube(curveOn((t) => [t * 0.09, -0.08 + 0.012 * Math.sin(t * Math.PI * 1.5)], 0.004));
  const open = new T.Mesh(new T.SphereGeometry(0.1, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), mouthMat);
  open.scale.set(1, 1.05, 0.3);
  stick(open, 0, -0.035, -0.012);

  const glowTexture = (inner, outer) => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const x = c.getContext("2d"), g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, inner);
    g.addColorStop(1, outer);
    x.fillStyle = g;
    x.fillRect(0, 0, 128, 128);
    return new T.CanvasTexture(c);
  };
  const blush = new T.MeshBasicMaterial({ map: glowTexture("rgba(255,118,172,0.95)", "rgba(255,118,172,0)"), transparent: true, depthWrite: false });
  for (const x of [-0.47, 0.47]) stick(new T.Mesh(new T.PlaneGeometry(0.34, 0.24), blush), x, -0.03, 0.022);

  const arm = (side) => {
    const pivot = new T.Group();
    pivot.position.set(side * 0.86, -0.3, 0.28);
    const m = new T.Mesh(new T.SphereGeometry(1, 40, 24), limb);
    m.scale.set(0.12, 0.22, 0.12);
    m.position.y = -0.15;
    pivot.add(m);
    body.add(pivot);
    return pivot;
  };
  const armL = arm(-1), armR = arm(1);

  const textSprite = (ch, hex) => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const x = c.getContext("2d");
    x.font = "800 104px 'Inter Tight', system-ui, sans-serif";
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillStyle = hex;
    x.fillText(ch, 64, 70);
    const s = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(c), transparent: true, depthWrite: false }));
    s.scale.set(0.42, 0.42, 1);
    return s;
  };
  const bang = textSprite("!", "#7A5CF0");
  bang.position.set(0.68, 1.08, 0.1);
  bang.scale.set(0.62, 0.62, 1);
  body.add(bang);
  const zs = [0, 1, 2].map(() => {
    const z = textSprite("z", "#8F7BE8");
    body.add(z);
    return z;
  });

  const dots = [0, 1, 2].map((i) => {
    const d = new T.Mesh(new T.SphereGeometry(0.07, 24, 16), limb);
    d.position.set(-0.24 + i * 0.24, 1.42, 0);
    body.add(d);
    return d;
  });

  const ring = new T.Mesh(new T.TorusGeometry(1, 0.012, 8, 160), new T.MeshBasicMaterial({ color: lin("#B9A8FF"), transparent: true, opacity: 0.85, toneMapped: false }));
  ring.rotation.x = Math.PI / 2;
  body.add(ring);
  const radiusAt = (y) => {
    const u = Math.max(-1, Math.min(1, y / HALF));
    return (1 - 0.09 * u) * Math.sqrt(1 - u * u);
  };

  // Hierarchy: turn > squash from the floor > body. Squashing from the floor keeps Plum planted while it breathes and hops.
  const turn = new T.Group(), squash = new T.Group();
  squash.position.y = -HALF;
  body.position.y = HALF;
  squash.add(body);
  turn.add(squash);
  scene.add(turn);

  const shadowMat = new T.MeshBasicMaterial({ map: glowTexture("rgba(30,18,70,0.42)", "rgba(30,18,70,0)"), transparent: true, depthWrite: false });
  const shadow = new T.Mesh(new T.PlaneGeometry(2.8, 2.8), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -HALF + 0.002;
  scene.add(shadow);

  // The pointer is read across the whole page, so Plum looks toward it wherever it is, not only over its own box.
  let px = 0, py = 0, dragging = false, moved = 0, lastX = 0, dragYaw = 0, boopAt = -10;
  const listeners = [];
  const on = (target, type, fn, o) => {
    target.addEventListener(type, fn, o);
    listeners.push(() => target.removeEventListener(type, fn, o));
  };
  if (interactive && !still) {
    on(window, "pointermove", (e) => {
      const r = el.getBoundingClientRect();
      px = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
      py = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
      if (dragging) {
        dragYaw += (e.clientX - lastX) * 0.01;
        moved += Math.abs(e.clientX - lastX);
        lastX = e.clientX;
      }
    }, { passive: true });
    // Only a mouse drags, so a finger on a phone still scrolls the page.
    on(el, "pointerdown", (e) => {
      moved = 0;
      if (e.pointerType !== "mouse") return;
      dragging = true;
      lastX = e.clientX;
    });
    on(window, "pointerup", () => {
      dragging = false;
    });
    on(el, "click", () => {
      if (moved < 4) boopAt = clock.getElapsedTime();
      wake();
    });
    on(document, "mouseleave", () => {
      if (!dragging) px = py = 0;
    });
  }

  // Off screen, Plum stops drawing; held still, it draws only until a change settles.
  let visible = true, raf = 0, settle = 0;
  const resize = () => {
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.position.z = w / h < 0.9 ? 9 : 7.4;
    camera.updateProjectionMatrix();
    wake();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(el);
  resize();

  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible) wake();
  });
  io.observe(el);
  function wake() {
    settle = 60;
    if (!raf && visible) raf = requestAnimationFrame(frame);
  }

  const clock = new T.Clock();
  const ease = (cur, target, k) => cur + (target - cur) * k;
  const hopped = hopper();
  // With hopOnClick, a hop runs once from the press instead of on the clock.
  let hopAt = -10;
  let nextBlink = 2, look = { x: 0, y: 0 }, pose = { tiltZ: 0, tiltX: 0, eyeOpen: 1, lift: 0 };
  function frame() {
    raf = 0;
    const t = clock.getElapsedTime(), a = still ? 0 : 1;
    const k = 0.08;

    let tiltZ = 0, tiltX = 0, eyeOpen = 1, lookX = px * 0.028, lookY = -py * 0.022, lift = 0, sy = 1;
    let wave = 0, scribble = 0;
    if (state === "brief") { tiltX = 0.14; lookY = -0.03; lookX = 0.012 * Math.sin(t * 4) * a; scribble = 1; }
    if (state === "work") { lift = 0.03 * Math.sin(t * 5) * a; tiltZ = 0.04 * Math.sin(t * 1.7) * a; lookX = 0.018; lookY = 0.026; }
    if (state === "checks") { lookX = 0.03 * Math.sin(t * 3) * (a || 0); }
    if (state === "ready") {
      const ph = hopOnClick ? (t - hopAt) / HOP_SECONDS : (t % HOP_SECONDS) / HOP_SECONDS;
      if (a && ph >= 0 && ph < HOP_RISE) lift = Math.sin((ph / HOP_RISE) * Math.PI) * 0.28;
      if (a && ph >= HOP_RISE && ph < HOP_RISE + 0.12) sy = 1 - 0.07 * Math.sin(((ph - HOP_RISE) / 0.12) * Math.PI);
      // Between presses, a hopOnClick Plum keeps a small bounce going, so it reads as alive and ready to jump.
      if (a && hopOnClick && !(ph >= 0 && ph < HOP_RISE + 0.12)) {
        const b = Math.sin(t * 5.2);
        lift = 0.06 * Math.abs(b);
        sy = 1 - 0.025 * Math.max(0, 1 - Math.abs(b) * 4);
      }
      if (a && !hopOnClick && hopped(t)) onHop?.();
      wave = 1;
    }
    if (state === "look") { tiltZ = 0.2; tiltX = 0.1; eyeOpen = 0.78; lookX = 0.022; }
    if (state === "quiet") { tiltZ = 0.07; eyeOpen = 0.1; lookY = -0.01; sy = 1 + 0.025 * Math.sin(t * 1.1) * a; }
    else sy *= 1 + 0.014 * Math.sin(t * 2.2) * a;

    if (state !== "quiet" && a && t > nextBlink) {
      if (t > nextBlink + 0.14) nextBlink = t + 2.4 + Math.random() * 2.6;
      else eyeOpen = 0.08;
    }
    const since = t - boopAt;
    if (since < 0.9 && a) sy *= 1 - 0.12 * Math.exp(-since * 6) * Math.cos(since * 22);

    pose.tiltZ = ease(pose.tiltZ, tiltZ, k);
    pose.tiltX = ease(pose.tiltX, tiltX, k);
    pose.lift = ease(pose.lift, lift, 0.35);
    pose.eyeOpen = eyeOpen < 0.2 && state !== "quiet" ? eyeOpen : ease(pose.eyeOpen, eyeOpen, 0.25);
    look.x = ease(look.x, lookX, 0.12);
    look.y = ease(look.y, lookY, 0.12);

    if (!dragging) dragYaw *= 0.94;
    turn.rotation.y = ease(turn.rotation.y, (still ? 0 : px * 0.35) + dragYaw, 0.1);
    turn.rotation.x = ease(turn.rotation.x, still ? 0 : py * 0.08, 0.1);
    squash.position.y = -HALF + pose.lift;
    squash.scale.set(1 / Math.sqrt(sy), sy, 1 / Math.sqrt(sy));
    body.rotation.set(pose.tiltX, 0, pose.tiltZ);
    for (const e of eyes) {
      e.scale.y = pose.eyeOpen;
      e.position.set(look.x, look.y, 0);
    }

    smile.visible = state !== "look" && state !== "ready";
    flat.visible = state === "look";
    open.visible = state === "ready";

    armL.rotation.z = ease(armL.rotation.z, -0.42 + (scribble ? 0.5 + 0.18 * Math.sin(t * 14) * a : 0), 0.2);
    armL.rotation.x = ease(armL.rotation.x, scribble ? -0.9 : 0, 0.1);
    armR.rotation.z = ease(armR.rotation.z, wave ? 2.3 + 0.35 * Math.sin(t * 9) * a : 0.42, 0.15);

    bang.visible = state === "look";
    bang.position.y = 1.08 + 0.05 * Math.sin(t * 4) * a;
    zs.forEach((z, i) => {
      z.visible = state === "quiet";
      const p = a ? (t * 0.35 + i / 3) % 1 : i / 3;
      z.position.set(0.7 + p * 0.5, 1.0 + p * 0.8, 0);
      z.material.opacity = Math.sin(p * Math.PI);
      z.scale.setScalar(0.22 + p * 0.22);
    });
    dots.forEach((d, i) => {
      d.visible = state === "work";
      d.position.y = 1.42 + Math.max(0, Math.sin(t * 6 - i * 0.9)) * 0.12 * a;
    });
    ring.visible = state === "checks";
    const ry = still ? 0.2 : Math.sin(t * 1.6) * 0.95;
    const rr = radiusAt(ry) + 0.06;
    ring.position.y = ry;
    ring.scale.set(rr, rr * 0.93, 1);

    const h = Math.max(0, pose.lift);
    shadow.scale.setScalar(1 - h * 0.8);
    shadowMat.opacity = 1 - h * 1.6;

    renderer.render(scene, camera);
    if (still) settle--;
    if (visible && (!still || settle > 0)) raf = requestAnimationFrame(frame);
  }
  wake();

  // A GPU reset or a browser reclaiming contexts blanks the canvas; the still takes over.
  on(renderer.domElement, "webglcontextlost", (e) => {
    e.preventDefault();
    lost();
  });

  return {
    pose(next) {
      state = next;
      wake();
    },
    hop() {
      hopAt = clock.getElapsedTime();
      onHop?.();
      wake();
    },
    still(next) {
      still = next;
      wake();
    },
    destroy() {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      for (const off of listeners) off();
      scene.traverse((o) => {
        o.geometry?.dispose();
        o.material?.map?.dispose();
        o.material?.dispose();
      });
      envMap.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
