// Confetti for the landing page's send-off: a burst from Plum each time it hops. One 2D canvas, drawn only while
// pieces are in the air and the section is on screen, and nothing at all with reduced motion on.

export const PER_BURST = 36;
export const MAX_PIECES = 120;

// The site's own colours (site.css): the violets first, then a few warm and green notes.
const TOKENS = ["--accent", "--accent-hi", "--pink", "--accent", "--yellow", "--orange", "--green"];

// Sizes and speeds are for a 300px Plum; `scale` follows the Plum the burst comes from.
const GRAVITY = 980;
const DRAG = 1.1;

// `n` pieces leaving (x, y), all thrown upward and out to either side.
export function burstPieces(n, x, y, scale, colors, rand = Math.random) {
  return Array.from({ length: n }, () => {
    const w = (5 + rand() * 4) * scale;
    return {
      x: x + (rand() - 0.5) * 120 * scale,
      y,
      vx: (rand() - 0.5) * 600 * scale,
      vy: -(440 + rand() * 380) * scale,
      g: GRAVITY * scale,
      sway: 24 * scale,
      w,
      h: w * (1.4 + rand() * 0.6),
      round: rand() < 0.2,
      rot: rand() * Math.PI,
      spin: (rand() - 0.5) * 12,
      flip: 4 + rand() * 6,
      phase: rand() * Math.PI * 2,
      color: colors[Math.floor(rand() * colors.length)],
      age: 0,
      life: 1.5 + rand() * 0.9,
    };
  });
}

// Moves every piece on by `dt` seconds and drops the ones that have faded or left the canvas.
export function advance(pieces, dt, width, height) {
  return pieces.filter((p) => {
    p.age += dt;
    p.vy += p.g * dt;
    const keep = 1 - DRAG * dt;
    p.vx *= keep;
    p.vy *= keep;
    p.x += p.vx * dt + Math.sin(p.age * 6 + p.phase) * p.sway * dt;
    p.y += p.vy * dt;
    p.rot += p.spin * dt;
    return p.age < p.life && p.y < height + 20 && p.x > -20 && p.x < width + 20;
  });
}

// The last 40% of a piece's life fades it out.
export const alphaOf = (p) => Math.max(0, Math.min(1, (p.life - p.age) / (p.life * 0.4)));

// Mounts confetti in `host` (positioned, clipped), bursting from the element `from`. Returns burst(), which a hop
// calls. Options: motion (the reduced-motion query; matchMedia's unless given, for tests).
/** @param {HTMLElement} host @param {{ from: Element, motion?: MediaQueryList }} opts */
export function mountConfetti(host, { from, motion = matchMedia("(prefers-reduced-motion: reduce)") }) {
  let canvas = null, ctx = null, pieces = [], raf = 0, last = 0, visible = true, dpr = 1;

  const clear = () => {
    pieces = [];
    cancelAnimationFrame(raf);
    raf = 0;
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
  };
  const size = () => {
    dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
  };
  // The canvas is made on the first burst, so a visitor with reduced motion never gets one.
  const make = () => {
    canvas = document.createElement("canvas");
    canvas.className = "confetti";
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.pointerEvents = "none";
    ctx = canvas.getContext("2d");
    if (!ctx) return false;
    host.prepend(canvas);
    size();
    ro.observe(canvas);
    return true;
  };
  const ro = new ResizeObserver(() => canvas && size());
  // A jump to #start can report leaving and arriving in one batch; the last entry is where the section is now.
  const io = new IntersectionObserver((entries) => {
    visible = entries.at(-1).isIntersecting;
    if (!visible) clear();
  });
  io.observe(host);
  const onMotion = () => motion.matches && clear();
  motion.addEventListener?.("change", onMotion);

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    pieces = advance(pieces, dt, w, h);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (const p of pieces) {
      ctx.globalAlpha = alphaOf(p);
      ctx.fillStyle = p.color;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      // A piece turning over shows its edge now and then.
      ctx.scale(1, Math.cos(p.age * p.flip + p.phase));
      if (p.round) {
        ctx.beginPath();
        ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
        ctx.fill();
      } else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    raf = pieces.length && visible ? requestAnimationFrame(frame) : 0;
  }

  return {
    get count() {
      return pieces.length;
    },
    burst() {
      if (motion.matches || !visible) return;
      if (!canvas && !make()) return;
      const r = from.getBoundingClientRect(), c = canvas.getBoundingClientRect();
      const css = getComputedStyle(host);
      const colors = TOKENS.map((t) => css.getPropertyValue(t).trim());
      const fresh = burstPieces(PER_BURST, r.left + r.width / 2 - c.left, r.top + r.height * 0.3 - c.top, r.width / 300 || 1, colors);
      // At the cap, the oldest pieces make room.
      pieces = [...pieces, ...fresh].slice(-MAX_PIECES);
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    },
    destroy() {
      clear();
      io.disconnect();
      ro.disconnect();
      motion.removeEventListener?.("change", onMotion);
      canvas?.remove();
    },
  };
}
