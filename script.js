// =====================================================
// Léo Félix Smith — Portfolio
// =====================================================

(function () {
  // =====================================================
  // Page-zoom — scale <body> around the clicked image so the whole page
  // visually dollies in toward it. Both transform and scroll-to-center
  // are driven by a single rAF loop on the same easing function, so they
  // finish in lockstep and the image stays at viewport center throughout
  // the close (no drift / fighting).
  // =====================================================
  const ZOOM_DURATION_MS = 550;
  const ZOOM_FILL_RATIO = 0.82;

  // CSS cubic-bezier(0.22, 0.61, 0.36, 1) implemented in JS so the rAF
  // loop interpolates on exactly the same curve the CSS transition uses
  // for the open animation.
  const zoomEasing = (function () {
    const p1x = 0.22, p1y = 0.61, p2x = 0.36, p2y = 1.0;
    function b(s, c1, c2) {
      return 3 * (1 - s) * (1 - s) * s * c1
           + 3 * (1 - s) * s * s * c2
           + s * s * s;
    }
    function db(s, c1, c2) {
      return 3 * (1 - s) * (1 - s) * c1
           + 6 * (1 - s) * s * (c2 - c1)
           + 3 * s * s * (1 - c2);
    }
    return function (t) {
      // Newton-Raphson to invert x(s) = t, then return y(s).
      let s = t;
      for (let i = 0; i < 6; i++) {
        const x = b(s, p1x, p2x) - t;
        const dx = db(s, p1x, p2x);
        if (Math.abs(dx) < 1e-6) break;
        s -= x / dx;
      }
      return b(s, p1y, p2y);
    };
  })();

  let zoomActive = false;
  let zoomCleanupTimer = null;
  let zoomRAF = null;
  // Captured at zoomIn — used by zoomOut to scroll the page so the image
  // lands centered in the viewport after the transition.
  let zoomedRect = null;
  let zoomedScrollY = 0;
  let zoomedTransform = null; // { tx, ty, scale } at fully-open state
  // The element that gets the sage backlight glow during zoom — usually
  // the .gallery-wrapper or .project-gif containing the clicked image.
  let zoomedGlowTarget = null;

  // Selector for content blocks that should fade away during the page-zoom.
  // Anything above the clicked image translates up + fades; anything below
  // translates down + fades. Excludes the clicked container itself.
  const FADEABLE_SELECTOR = [
    '.hero',
    '.project-header',
    '.project-gif',
    '.project-intro',
    '.project-columns',
    '.project-body',
    '.gallery-wrapper',
    '.reviews',
    '.project-video',
    '.project-links',
    '.awards-label',
    '.awards-row',
    '.about-grid > *',
  ].join(', ');

  function applyFadeClasses(clickedEl) {
    const clickedRect = clickedEl.getBoundingClientRect();
    const clickedMid = clickedRect.top + clickedRect.height / 2;
    document.querySelectorAll(FADEABLE_SELECTOR).forEach((el) => {
      // Don't fade the clicked element itself, or anything containing it
      // (otherwise its parent fades and pulls the clicked image with it).
      if (el === clickedEl || el.contains(clickedEl)) return;
      const rect = el.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (mid < clickedMid) el.classList.add('zoom-fade-up');
      else el.classList.add('zoom-fade-down');
    });
  }

  function removeFadeClasses() {
    document
      .querySelectorAll('.zoom-fade-up, .zoom-fade-down')
      .forEach((el) => {
        el.classList.remove('zoom-fade-up', 'zoom-fade-down');
      });
  }

  // Brute-force scroll lock — every animation frame, if window.scrollY
  // has drifted from the locked position, snap it back. This catches
  // anything overflow:hidden + listener prevention can't (e.g. trackpad
  // momentum, browser-internal scrolling that bypasses event handlers,
  // body-transform-induced container shenanigans).
  let scrollLockY = 0;
  let scrollLockRAF = null;
  function startScrollLock() {
    scrollLockY = window.scrollY;
    function tick() {
      if (window.scrollY !== scrollLockY) {
        window.scrollTo(window.scrollX, scrollLockY);
      }
      scrollLockRAF = requestAnimationFrame(tick);
    }
    if (scrollLockRAF !== null) cancelAnimationFrame(scrollLockRAF);
    scrollLockRAF = requestAnimationFrame(tick);
  }
  function stopScrollLock() {
    if (scrollLockRAF !== null) {
      cancelAnimationFrame(scrollLockRAF);
      scrollLockRAF = null;
    }
  }

  // Defensively wipe every style this module ever sets, regardless of
  // current state. Safe to call any time.
  function clearZoomStyles() {
    stopScrollLock();
    const body = document.body;
    body.style.transform = '';
    body.style.transformOrigin = '';
    body.style.transition = '';
    body.style.overflow = '';
    body.classList.remove('is-zoomed');
    body.classList.remove('zoom-locked');
    document.documentElement.style.overflow = '';
    document.documentElement.classList.remove('zoom-locked');
    removeFadeClasses();
  }

  // Mousedown coords are captured so the click handler can tell apart a
  // real click from a drag-then-release (drags fire click on mouseup
  // wherever the cursor lands, even far from where mousedown happened).
  let zoomMouseDownX = 0;
  let zoomMouseDownY = 0;
  function onZoomedMouseDown(e) {
    zoomMouseDownX = e.clientX;
    zoomMouseDownY = e.clientY;
  }

  // Bound named functions so addEventListener / removeEventListener match.
  function onZoomedClick(e) {
    // If the cursor moved significantly between mousedown and click, it
    // was a drag — never close on drag-release, regardless of where the
    // mouseup landed. (This is what lets the user drag the carousel
    // without accidentally closing.)
    const moved =
      Math.abs(e.clientX - zoomMouseDownX) +
      Math.abs(e.clientY - zoomMouseDownY);
    if (moved > 6) return;

    // Clicks on the prev/next arrows shouldn't close — they're still
    // useful navigation while zoomed. Let the arrow's own click handler
    // run by returning without preventDefault / stopPropagation.
    const target = e.target;
    if (target && target.closest('.gallery-nav')) return;

    // Anything else (image, page background, text, etc.) — clean click
    // closes the zoom.
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    zoomOut();
  }
  function onZoomedKey(e) {
    // Escape is the only key that closes — everything else is absorbed.
    if (e.key === 'Escape') {
      zoomOut();
      return;
    }
    // Swallow scroll keys silently so they neither scroll the page nor
    // close the zoom.
    const SCROLL_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar'];
    if (SCROLL_KEYS.indexOf(e.key) !== -1) {
      e.preventDefault();
    }
  }
  function onZoomedWheel(e) {
    // Block scroll, but do nothing else — wheel doesn't close the zoom.
    if (e.cancelable) e.preventDefault();
  }
  function onZoomedTouch(e) {
    // Block touch-scroll, but don't close.
    if (e.cancelable) e.preventDefault();
  }
  function onZoomedResize() {
    // Don't try to recompute — just close. Safer than half-recomputing
    // a transform during a viewport change.
    zoomOut();
  }

  function bindZoomListeners() {
    // Capture phase so we see events before they reach any element.
    window.addEventListener('mousedown', onZoomedMouseDown, true);
    window.addEventListener('click', onZoomedClick, true);
    window.addEventListener('keydown', onZoomedKey, true);
    window.addEventListener('wheel', onZoomedWheel, { passive: false, capture: true });
    window.addEventListener('touchmove', onZoomedTouch, { passive: false, capture: true });
    window.addEventListener('resize', onZoomedResize);
  }
  function unbindZoomListeners() {
    window.removeEventListener('mousedown', onZoomedMouseDown, true);
    window.removeEventListener('click', onZoomedClick, true);
    window.removeEventListener('keydown', onZoomedKey, true);
    window.removeEventListener('wheel', onZoomedWheel, { passive: false, capture: true });
    window.removeEventListener('touchmove', onZoomedTouch, { passive: false, capture: true });
    window.removeEventListener('resize', onZoomedResize);
  }

  function zoomIn(img) {
    if (zoomActive) return;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    // If a previous close is still in flight, hard-cancel it before opening
    // fresh — never leave overlapping timers/states.
    if (zoomRAF !== null) {
      cancelAnimationFrame(zoomRAF);
      zoomRAF = null;
    }
    if (zoomCleanupTimer !== null) {
      clearTimeout(zoomCleanupTimer);
      zoomCleanupTimer = null;
      clearZoomStyles();
    }

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scale = Math.min(
      (vw * ZOOM_FILL_RATIO) / rect.width,
      (vh * ZOOM_FILL_RATIO) / rect.height
    );
    const imgCx = rect.left + rect.width / 2;
    const imgCy = rect.top + rect.height / 2;
    const tx = vw / 2 - imgCx;
    const ty = vh / 2 - imgCy;
    const originX = imgCx + window.scrollX;
    const originY = imgCy + window.scrollY;

    zoomActive = true;
    zoomedRect = rect;
    zoomedScrollY = window.scrollY;
    zoomedTransform = { tx, ty, scale };
    // Tag the wrapper (or the figure) so it gets an intensified sage
    // backlight during the zoom — feels like the image emerges into focus.
    zoomedGlowTarget = img.closest('.gallery-wrapper, .project-gif, .project-video') || img;
    if (zoomedGlowTarget) zoomedGlowTarget.classList.add('is-zooming-target');
    const body = document.body;
    // Class is used by CSS to suppress the gallery hover-grow while we're
    // zoomed (otherwise the hover scale would compose on top of the body
    // transform and the gallery would visibly pulse during the zoom).
    body.classList.add('is-zoomed');
    // Tag content above/below the clicked element so it can fade + slide
    // away as the zoom takes hold. CSS rule keys off body.is-zoomed so
    // the destination state activates the moment both classes are on.
    applyFadeClasses(img);
    body.style.transformOrigin = `${originX}px ${originY}px`;
    void body.offsetWidth; // commit origin before transitioning
    body.style.transition =
      `transform ${ZOOM_DURATION_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1)`;
    body.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    // Hard scroll lock — multiple layers of defense:
    //   1. `.zoom-locked` class with !important sets overflow:hidden +
    //      touch-action:none + overscroll-behavior:none.
    //   2. wheel/touch/key listeners block input events.
    //   3. startScrollLock() runs a rAF loop that snaps scroll back to
    //      the locked position every frame. This catches anything the
    //      first two miss (trackpad inertia, programmatic scroll from
    //      other code, weird browser behavior with transformed body).
    document.documentElement.classList.add('zoom-locked');
    body.classList.add('zoom-locked');
    startScrollLock();
    // Pause every gallery's auto-scroll while we're zoomed — otherwise
    // the carousel could advance to a different image behind the user.
    document.querySelectorAll('.gallery').forEach((g) => {
      if (g._stopAuto) g._stopAuto();
    });

    // Bind close listeners only AFTER the zoom-in animation has fully
    // completed. zoomOut needs the body to be at its final transform so
    // the rAF loop can start from a known state — closing mid-open
    // would require sampling computed transform mid-flight (messy and
    // error-prone). 50ms padding past duration ensures CSS transition
    // settled.
    setTimeout(() => {
      if (zoomActive) bindZoomListeners();
    }, ZOOM_DURATION_MS + 50);
  }

  function finalizeZoom() {
    // Wipe everything and reset all module state.
    if (zoomRAF !== null) {
      cancelAnimationFrame(zoomRAF);
      zoomRAF = null;
    }
    if (zoomCleanupTimer !== null) {
      clearTimeout(zoomCleanupTimer);
      zoomCleanupTimer = null;
    }
    clearZoomStyles();
    // Resume gallery auto-scroll on galleries the cursor isn't on.
    document.querySelectorAll('.gallery').forEach((g) => {
      const wrapper = g.closest('.gallery-wrapper');
      const onIt = wrapper && wrapper.matches(':hover');
      if (!onIt && g._startAuto) g._startAuto();
    });
    zoomedRect = null;
    zoomedScrollY = 0;
    zoomedTransform = null;
    // Defensive: ensure no element is left tagged with the glow class
    // (e.g. if zoom was hard-canceled before zoomOut got to clear it).
    if (zoomedGlowTarget) {
      zoomedGlowTarget.classList.remove('is-zooming-target');
      zoomedGlowTarget = null;
    }
  }

  function zoomOut() {
    // Always unbind first, so multiple rapid triggers can't keep firing.
    unbindZoomListeners();
    if (!zoomActive) return;
    zoomActive = false;

    stopScrollLock();
    // Drop is-zoomed now so the surrounding-content fades reverse during the
    // same window as the body transform (they're both 550 ms).
    document.body.classList.remove('is-zoomed');
    // Sage backlight fades out over the same 550ms window as the zoom transform.
    if (zoomedGlowTarget) zoomedGlowTarget.classList.remove('is-zooming-target');

    if (!zoomedTransform || !zoomedRect) {
      document.documentElement.classList.remove('zoom-locked');
      document.body.classList.remove('zoom-locked');
      finalizeZoom();
      return;
    }

    const vh = window.innerHeight;
    const imageCenterPageY =
      zoomedRect.top + zoomedRect.height / 2 + zoomedScrollY;
    const maxScroll = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight
    ) - vh;
    const targetScrollY = Math.max(
      0,
      Math.min(imageCenterPageY - vh / 2, maxScroll)
    );
    const scrollDelta = targetScrollY - zoomedScrollY;

    const body = document.body;
    const html = document.documentElement;
    const fromTx = zoomedTransform.tx;
    // Pre-compensate ty by +scrollDelta so the upcoming scroll jump is
    // visually invisible: the scroll moves the image up by scrollDelta in
    // the viewport, the extra ty moves it back down by the same amount.
    const fromTy = zoomedTransform.ty + scrollDelta;
    const fromScale = zoomedTransform.scale;

    // Atomic handoff in one synchronous task: paint the scroll-compensated
    // transform, release overflow:hidden, jump scroll to its final target.
    // Browser paints the result as a single frame, so the image never
    // appears to move. After this, scroll is already at targetScrollY and
    // identity transform = image-at-viewport-center, so the close
    // animation just needs to interpolate the transform back to identity.
    //
    // The inline scroll-behavior:auto override is required: `html` has
    // `scroll-behavior: smooth` globally, which would otherwise turn this
    // scrollTo (and any scroll-restoration the browser does when
    // overflow:hidden is released) into a visible animated scroll.
    body.style.transition = 'none';
    body.style.transform = `translate(${fromTx}px, ${fromTy}px) scale(${fromScale})`;
    html.classList.remove('zoom-locked');
    body.classList.remove('zoom-locked');
    const prevScrollBehavior = html.style.scrollBehavior;
    html.style.scrollBehavior = 'auto';
    window.scrollTo(0, targetScrollY);
    html.style.scrollBehavior = prevScrollBehavior;

    const start = performance.now();
    if (zoomRAF !== null) cancelAnimationFrame(zoomRAF);
    zoomRAF = requestAnimationFrame(function step(now) {
      const elapsed = now - start;
      const t = Math.min(elapsed / ZOOM_DURATION_MS, 1);
      const eased = zoomEasing(t);
      const inv = 1 - eased;

      const tx = fromTx * inv;
      const ty = fromTy * inv;
      const sc = 1 + (fromScale - 1) * inv;
      body.style.transform = `translate(${tx}px, ${ty}px) scale(${sc})`;

      if (t < 1) {
        zoomRAF = requestAnimationFrame(step);
      } else {
        zoomRAF = null;
        body.style.transform = '';
        finalizeZoom();
      }
    });

    // Safety — if rAF stalls (tab backgrounded, etc.), guarantee cleanup.
    if (zoomCleanupTimer !== null) clearTimeout(zoomCleanupTimer);
    zoomCleanupTimer = setTimeout(() => {
      finalizeZoom();
    }, ZOOM_DURATION_MS + 200);
  }

  // Last-resort safety net: if the page is hidden (tab switch, refresh
  // about to happen, etc.) drop out of zoom immediately so the user
  // never returns to a broken state.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && zoomActive) {
      unbindZoomListeners();
      zoomActive = false;
      finalizeZoom();
    }
  });

  // Wire up galleries — wrap each in a carousel container with nav controls
  document.querySelectorAll('.gallery').forEach((gallery) => {
    const title = gallery.dataset.gallery || '';
    const originalImgs = Array.from(gallery.querySelectorAll('img'));
    const total = originalImgs.length;

    // Clone first + last for seamless wrap-around
    const firstClone = originalImgs[0].cloneNode(true);
    const lastClone = originalImgs[total - 1].cloneNode(true);
    firstClone.classList.add('clone');
    lastClone.classList.add('clone');
    gallery.insertBefore(lastClone, originalImgs[0]);
    gallery.appendChild(firstClone);

    // Wrap gallery in .gallery-wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'gallery-wrapper';
    gallery.parentNode.insertBefore(wrapper, gallery);
    wrapper.appendChild(gallery);

    const prev = document.createElement('button');
    prev.className = 'gallery-nav gallery-prev';
    prev.innerHTML = '‹';
    prev.setAttribute('aria-label', 'Previous image');

    const next = document.createElement('button');
    next.className = 'gallery-nav gallery-next';
    next.innerHTML = '›';
    next.setAttribute('aria-label', 'Next image');

    const counter = document.createElement('div');
    counter.className = 'gallery-counter';

    wrapper.appendChild(prev);
    wrapper.appendChild(next);
    // Counter goes BELOW the wrapper (in the gallery's original parent)
    // rather than overlaying the image, so the photo isn't covered.
    wrapper.parentNode.insertBefore(counter, wrapper.nextSibling);

    // Initial position: first real image (skip prepended clone), no animation
    function instantJump(left) {
      gallery.style.scrollBehavior = 'auto';
      gallery.scrollLeft = left;
      void gallery.offsetWidth;
      gallery.style.scrollBehavior = '';
    }
    requestAnimationFrame(() => instantJump(gallery.offsetWidth));

    function visualIdx() {
      return Math.round(gallery.scrollLeft / gallery.offsetWidth);
    }
    function originalIdx() {
      const vi = visualIdx();
      if (vi === 0) return total - 1;             // sitting on leading clone
      if (vi >= total + 1) return 0;              // sitting on trailing clone
      return vi - 1;
    }
    function update() {
      counter.textContent = `${originalIdx() + 1} / ${total}`;
    }
    function smoothTo(vi) {
      gallery.scrollTo({ left: vi * gallery.offsetWidth, behavior: 'smooth' });
    }
    function goNext() {
      const vi = visualIdx();
      smoothTo(vi + 1);
      // Crossed onto trailing clone → silently snap to real first
      if (vi === total) {
        setTimeout(() => instantJump(gallery.offsetWidth), 520);
      }
    }
    function goPrev() {
      const vi = visualIdx();
      smoothTo(vi - 1);
      // Crossed onto leading clone → silently snap to real last
      if (vi === 1) {
        setTimeout(() => instantJump(total * gallery.offsetWidth), 520);
      }
    }

    prev.addEventListener('click', () => { goPrev(); restartAuto(); });
    next.addEventListener('click', () => { goNext(); restartAuto(); });

    let scrollTimer;
    gallery.addEventListener('scroll', () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(update, 50);
    });

    // Auto-scroll every 5s, pause on hover. startAuto MUST clear any prior
    // timer first — without that guard, multiple mouseleaves leak
    // overlapping intervals, which made galleries race when the page-zoom
    // overlay used to swap focus back and forth.
    let autoTimer = null;
    function startAuto() {
      if (autoTimer) clearInterval(autoTimer);
      autoTimer = setInterval(goNext, 5000);
    }
    function stopAuto() {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    }
    function restartAuto() { stopAuto(); startAuto(); }
    wrapper.addEventListener('mouseenter', stopAuto);
    wrapper.addEventListener('mouseleave', startAuto);
    // Expose so the page-zoom handlers can pause auto-scroll while a
    // gallery image is being viewed in the zoomed overlay.
    gallery._stopAuto = stopAuto;
    gallery._startAuto = startAuto;
    startAuto();

    // Mouse drag-to-scroll on the gallery.
    //
    // Best-practice carousel drag:
    //   • Activation threshold — drag doesn't start until the cursor has
    //     moved >ACTIVATE_PX. A small twitch during a click won't move
    //     the gallery (and won't suppress the click → lightbox open).
    //   • Friction multiplier — the image follows the cursor at <1× speed
    //     so wide images don't feel "yanked". Reads as weighted/calmer.
    //   • Distance + velocity commit — releasing the drag commits to the
    //     next image only if the user dragged past COMMIT_RATIO of the
    //     image width OR finished the drag with a flick faster than
    //     FLICK_VELOCITY. Otherwise it snaps back to where it started.
    //     A casual nudge doesn't flip the image, so it doesn't feel grabby.
    const ACTIVATE_PX = 6;
    const FRICTION = 0.85;
    const COMMIT_RATIO = 0.32;          // 32% of width → commits to next
    const FLICK_VELOCITY = 0.55;        // px/ms cursor speed for flick commit

    let armed = false;          // mousedown happened, drag may or may not start
    let dragging = false;       // true once activation threshold is exceeded
    let dragStartX = 0;
    let dragStartScroll = 0;
    let dragMoved = 0;
    let lastDragX = 0;
    let lastDragTime = 0;
    let dragVelocity = 0;       // px / ms, signed (cursor velocity)

    gallery.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      armed = true;
      dragging = false;
      dragStartX = e.pageX;
      dragStartScroll = gallery.scrollLeft;
      dragMoved = 0;
      lastDragX = e.pageX;
      lastDragTime = performance.now();
      dragVelocity = 0;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!armed) return;
      const rawDx = e.pageX - dragStartX;
      // Track velocity (rolling — last sample only; good enough for flick).
      const now = performance.now();
      const dt = now - lastDragTime;
      if (dt > 0) dragVelocity = (e.pageX - lastDragX) / dt;
      lastDragX = e.pageX;
      lastDragTime = now;

      // Don't actually move the gallery until we've passed the activation
      // threshold — otherwise tiny wobbles during a click would scroll.
      if (!dragging) {
        if (Math.abs(rawDx) < ACTIVATE_PX) return;
        dragging = true;
        gallery.classList.add('dragging');
        gallery.style.scrollSnapType = 'none';
        gallery.style.scrollBehavior = 'auto';
        stopAuto();
      }

      dragMoved = Math.abs(rawDx);
      // Friction: image moves slightly slower than the cursor, with the
      // pre-activation pixels excluded so motion stays continuous from
      // the moment dragging actually engages.
      const effectiveDx = (rawDx - Math.sign(rawDx) * ACTIVATE_PX) * FRICTION;
      gallery.scrollLeft = dragStartScroll - effectiveDx;
    });

    window.addEventListener('mouseup', () => {
      if (!armed) return;
      armed = false;
      if (!dragging) return; // wasn't a real drag → click handler will fire
      dragging = false;
      gallery.classList.remove('dragging');
      gallery.style.scrollSnapType = '';
      gallery.style.scrollBehavior = '';

      const width = gallery.offsetWidth;
      const startIdx = Math.round(dragStartScroll / width);
      const galleryDelta = gallery.scrollLeft - dragStartScroll;
      const galleryRatio = galleryDelta / width;
      // Cursor velocity is opposite-signed to gallery direction: dragging
      // the cursor LEFT (negative dragVelocity) scrolls the gallery RIGHT
      // (positive direction = next image).
      const intentDirection =
        Math.abs(dragVelocity) > FLICK_VELOCITY
          ? (dragVelocity < 0 ? 1 : -1)
          : (Math.abs(galleryRatio) >= COMMIT_RATIO
              ? Math.sign(galleryRatio)
              : 0);

      let targetIdx;
      if (intentDirection === 0) {
        // Below threshold + no flick → snap back to where we started.
        targetIdx = startIdx;
      } else {
        // Commit at least one step in the intended direction; if the user
        // dragged across multiple image widths, commit further.
        const stepCount = Math.max(1, Math.round(Math.abs(galleryRatio)));
        targetIdx = startIdx + intentDirection * stepCount;
      }

      gallery.scrollTo({ left: targetIdx * width, behavior: 'smooth' });
      // After the smooth scroll has settled, swap clone for real on wrap.
      setTimeout(() => {
        const vi = visualIdx();
        if (vi === 0) instantJump(total * width);
        else if (vi === total + 1) instantJump(width);
      }, 420);
      restartAuto();
    });

    // Touch swipe — only while zoomed. In normal view the carousel pans via
    // native overflow scroll, but the page-zoom hard-locks touch (touch-action:
    // none + a capture-phase touchmove preventDefault), which would otherwise
    // leave swipe dead and only the arrows working. Here we read the raw touch
    // points (those events still fire even with touch-action: none) and page
    // through the same goPrev/goNext the arrows use.
    const SWIPE_PX = 40;          // min horizontal travel to commit
    const SWIPE_FLICK = 0.4;      // px/ms — a fast flick commits below SWIPE_PX
    let touchX = 0, touchY = 0, touchT = 0, swiping = false;
    gallery.addEventListener('touchstart', (e) => {
      if (!zoomActive) return;
      const t = e.touches[0];
      touchX = t.clientX; touchY = t.clientY; touchT = performance.now();
      swiping = true;
    }, { passive: true });
    gallery.addEventListener('touchend', (e) => {
      if (!swiping) return;
      swiping = false;
      if (!zoomActive) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touchX;
      const dy = t.clientY - touchY;
      const dt = performance.now() - touchT || 1;
      // Only a mostly-horizontal gesture pages; vertical is ignored so the
      // image isn't flipped by an accidental up/down drag.
      if (Math.abs(dx) <= Math.abs(dy)) return;
      if (Math.abs(dx) < SWIPE_PX && Math.abs(dx) / dt < SWIPE_FLICK) return;
      if (dx < 0) goNext(); else goPrev();
      restartAuto();
    }, { passive: true });

    // Click → zoom-in (the same image element grows from its slot to
    // viewport-fill, no backdrop / clone / fade — handler defined below).
    let downX = 0;
    Array.from(gallery.querySelectorAll('img')).forEach((img) => {
      img.addEventListener('mousedown', (e) => { downX = e.clientX; });
      img.addEventListener('click', (e) => {
        if (Math.abs(e.clientX - downX) < 5 && dragMoved < 5) {
          zoomIn(img);
        }
      });
      // Prevent native image drag (ghost image) interfering with our drag
      img.addEventListener('dragstart', (e) => e.preventDefault());
    });

    update();
  });

  // Autoplay videos (.project-gif) get the same zoom-in behavior as
  // gallery images. The <video> inside has pointer-events:none so the
  // click bubbles to the figure; we capture it here and zoom that
  // figure (its rect matches the video exactly since the video fills it).
  document.querySelectorAll('.project-gif').forEach((figure) => {
    let downX = 0;
    figure.addEventListener('mousedown', (e) => { downX = e.clientX; });
    figure.addEventListener('click', (e) => {
      if (Math.abs(e.clientX - downX) < 5) {
        zoomIn(figure);
      }
    });
  });

})();

// =====================================================
// Nav circle — proximity expand + scroll spy
// =====================================================
(function () {
  const nav = document.getElementById('nav-circle');
  if (!nav) return;

  const items = Array.from(nav.querySelectorAll('.nav-circle-item'));

  // Touch devices (any size) and narrow viewports use the tap-to-open circle
  // nav; only wide mouse-driven viewports get the hover pill. Mirrors the CSS
  // `(max-width: 720px), (pointer: coarse)` switch.
  const mobileMQ = window.matchMedia('(max-width: 720px), (pointer: coarse)');

  // Keep the desktop nav's top aligned with .hero-bio regardless of font/layout.
  // offsetTop chain is layout-based (unaffected by CSS animation transforms).
  const heroBio = document.querySelector('.hero-bio');
  function alignNavWithBio() {
    // Circle nav (touch / narrow): a fixed bottom-right button positioned
    // entirely by CSS. Clear any inline top the desktop path set so `bottom`
    // can take over.
    if (mobileMQ.matches) { nav.style.top = ''; return; }
    if (!heroBio) return;
    let top = 0;
    let el = heroBio;
    while (el && el !== document.body) {
      top += el.offsetTop;
      el = el.offsetParent;
    }
    nav.style.top = top + 'px';
  }
  requestAnimationFrame(alignNavWithBio);

  function setActive(sectionId) {
    let activeIdx = -1;
    items.forEach((item, i) => {
      const isActive = item.dataset.section === sectionId;
      if (isActive) activeIdx = i;
      item.classList.toggle('active', isActive);
    });
    // Per-row distance variables for cascade staggers:
    //   --n         signed offset from active (used for vertical spread)
    //   --abs-n     magnitude — used for OUTWARD cascade (expand: active first)
    //   --inv-abs-n maxDistance - magnitude — used for INWARD cascade
    //               (collapse: outermost first, active last)
    if (activeIdx >= 0) {
      const maxAbsN = Math.max(activeIdx, items.length - 1 - activeIdx);
      items.forEach((item, i) => {
        const n = i - activeIdx;
        const absN = Math.abs(n);
        item.style.setProperty('--n', n);
        item.style.setProperty('--abs-n', absN);
        item.style.setProperty('--inv-abs-n', maxAbsN - absN);
      });
    }
  }
  // Seed the variables on initial load using whichever item is marked active
  // in the HTML (Welcome by default).
  const initialActive = items.find((it) => it.classList.contains('active'));
  if (initialActive) setActive(initialActive.dataset.section);

  items.forEach((item) => {
    item.addEventListener('click', () => setActive(item.dataset.section));
  });

  // Scroll spy. We track which sections are currently in the trigger zone
  // (the middle 15% strip of the viewport) and pick the one furthest down
  // in document order — i.e. the section the user has scrolled deepest
  // into. The previous version sorted only the BATCH that just changed
  // intersection state and picked the topmost, which let Welcome stay
  // active while Eriksholm was already in the strip below.
  const sections = items
    .map((i) => document.getElementById(i.dataset.section))
    .filter(Boolean);
  const intersecting = new Set();

  function pickActive() {
    // sections is in document order; iterate in reverse and pick the first
    // intersecting one (= the deepest section the user has reached).
    for (let i = sections.length - 1; i >= 0; i--) {
      if (intersecting.has(sections[i])) {
        setActive(sections[i].id);
        return;
      }
    }
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) intersecting.add(e.target);
        else intersecting.delete(e.target);
      });
      pickActive();
    },
    { rootMargin: '-30% 0px -55% 0px', threshold: 0 }
  );
  sections.forEach((s) => observer.observe(s));

  // Proximity-based expand/collapse — gated on first scroll into Eriksholm
  let collapsed = nav.classList.contains('collapsed');
  let proximityEnabled = false;
  let isHovered = false;
  let raf = null;
  function check(mx, my) {
    if (!proximityEnabled) return;
    // Proximity is a scrolled-state behavior only — never collapse the airy
    // welcome labels while the nav is at the top.
    if (nav.classList.contains('at-top')) return;
    // The pill opens its labels leftward, over the content's right edge. Below
    // the content's max-width (1080px) there's no gutter, so the labels would
    // crowd the body text — keep it collapsed (dots only) in that range.
    if (window.innerWidth < 1080) {
      if (!collapsed) {
        collapsed = true;
        nav.classList.add('collapsed');
      }
      return;
    }
    const r = nav.getBoundingClientRect();
    const dx = Math.max(r.left - mx, 0, mx - r.right);
    const dy = Math.max(r.top - my, 0, my - r.bottom);
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Hysteresis: once expanded, the mouse has to pull back FURTHER to
    // collapse than it took to expand. Prevents flicker at the edge of
    // the proximity zone when the mouse oscillates around the boundary.
    const enterAt = 36;
    const leaveAt = 80;
    const next = collapsed ? dist > enterAt : dist > leaveAt;
    if (next !== collapsed) {
      collapsed = next;
      nav.classList.toggle('collapsed', collapsed);
    }
  }
  document.addEventListener('mousemove', (e) => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => check(e.clientX, e.clientY));
  });

  // Hover lock — never collapse while the cursor is on the nav.
  nav.addEventListener('mouseenter', () => { isHovered = true; });
  nav.addEventListener('mouseleave', () => { isHovered = false; onScroll(); });

  // Open/close the circle menu. Closing holds .expanded for a beat so the rows
  // fade out (CSS .is-closing) before the pill collapses — otherwise the menu
  // blinks out instantly. openMenu cancels any in-flight close.
  let menuCloseTimer = null;
  function openMenu() {
    clearTimeout(menuCloseTimer);
    nav.classList.remove('is-closing');
    nav.classList.add('expanded');
  }
  function closeMenu() {
    if (!nav.classList.contains('expanded')) return;
    nav.classList.add('is-closing');
    clearTimeout(menuCloseTimer);
    menuCloseTimer = setTimeout(() => {
      nav.classList.remove('expanded', 'is-closing');
    }, 180);
  }

  // Tap-to-toggle for the circle nav. Hover-proximity does nothing on touch
  // screens, so the .expanded class is the only way to open the menu.
  function onNavClick(e) {
    if (!mobileMQ.matches) return;
    const link = e.target.closest('.nav-circle-item');
    if (link) {
      // Picked a section — close the menu so the user sees the page.
      closeMenu();
      return;
    }
    // Tap on the dot itself toggles the menu.
    if (nav.classList.contains('expanded')) closeMenu();
    else openMenu();
  }
  nav.addEventListener('click', onNavClick);

  // Tap anywhere outside the open menu to close it.
  document.addEventListener('click', (e) => {
    if (!mobileMQ.matches) return;
    if (!nav.classList.contains('expanded')) return;
    if (nav.contains(e.target)) return;
    closeMenu();
  });

  // Drop the .expanded state if the device switches to the desktop pill — that
  // path has its own (hover) logic and the class would just stick. No fade
  // needed here, so reset instantly.
  mobileMQ.addEventListener('change', (e) => {
    if (!e.matches) {
      clearTimeout(menuCloseTimer);
      nav.classList.remove('expanded', 'is-closing');
    }
  });

  // Collapse trigger: nav closes as soon as the Eriksholm section enters the
  // viewport. At scroll=0 we never collapse so that resize events (and tall
  // viewports where Eriksholm is already visible at load) don't fire the
  // transition prematurely. Hysteresis stops it re-toggling when the user
  // scrolls slowly at the boundary.
  const eriksholmSection = document.querySelector('#eriksholm');
  function shouldCollapse() {
    if (!eriksholmSection) return false;
    if (window.scrollY === 0) return false;
    const sectionTop = eriksholmSection.getBoundingClientRect().top;
    const isCurrentlyAtTop = nav.classList.contains('at-top');
    const margin = 28;
    const threshold = isCurrentlyAtTop
      ? window.innerHeight - margin
      : window.innerHeight + margin;
    return sectionTop < threshold;
  }
  // Welcome ↔ scrolled transition is purely class-toggle. The nav sits in
  // the same position in both states; only the glass and labels change.
  //   Forward (.at-top removed, .collapsed added): labels retract with their
  //     cascade, then the glass fades in (CSS delays it ~0.68s until the
  //     cascade finishes) so the pill appears already-collapsed.
  //   Reverse (.at-top added): glass fades straight out, then labels cascade
  //     back open as transparent airy text.
  function onScroll () {
    const want = shouldCollapse();
    const isAtTop = nav.classList.contains('at-top');

    if (isAtTop && want) {
      nav.classList.remove('at-top');
      // Enable proximity now so the pill collapses once the cursor leaves —
      // even if the user is hovering the nav right now (e.g. they just clicked
      // a label). Only snap to the collapsed (dots) look immediately when
      // they're NOT hovering, so it doesn't close under the cursor.
      proximityEnabled = true;
      if (!isHovered) {
        collapsed = true;
        nav.classList.add('collapsed');
      }
    } else if (!isAtTop && !want) {
      // Back at the welcome state — always restore the airy labels and turn
      // proximity off, regardless of hover, so the nav can't get stuck.
      nav.classList.add('at-top');
      proximityEnabled = false;
      collapsed = false;
      nav.classList.remove('collapsed');
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => { alignNavWithBio(); onScroll(); }, { passive: true });
})();

// =====================================================
// Scroll-in reveal — fade + rise from bottom
// =====================================================
(function () {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) return;

  const selectors = [
    '.project-header',
    '.project-gif',
    '.project-meta',
    '.project-body',
    '.project-columns',
    '.gallery-wrapper',
    '.reviews blockquote',
    '.awards-label',
    '.awards-row',
    '.project-video',
    '.project-links',
    '.about-grid > *',
  ];

  const targets = document.querySelectorAll(selectors.join(', '));
  targets.forEach((el) => el.classList.add('reveal'));

  const observer = new IntersectionObserver(
    (entries) => {
      // Sort the batch of newly-visible elements by document order, then stagger
      // them 120ms apart. Each batch restarts the cascade — slow scrolling
      // reveals one-by-one (no delay), fast scrolling reveals as a wave.
      const batch = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) =>
          a.target.compareDocumentPosition(b.target) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
        );
      batch.forEach((entry, i) => {
        const el = entry.target;
        const delay = i * 120;
        el.style.transitionDelay = `${delay}ms`;
        el.classList.add('visible');
        observer.unobserve(el);
        // The stagger delay exists only to cascade the reveal. If left set it
        // also delays every later transition on the element (e.g. the
        // review-quote hover), making them feel laggy — so clear it once the
        // reveal (0.7s) has played out from its staggered start.
        setTimeout(() => { el.style.transitionDelay = ''; }, delay + 800);
      });
    },
    { threshold: 0, rootMargin: '0px' }
  );

  // Continue the 120ms cadence from nav (0.46s) into below-fold reveals
  setTimeout(() => {
    targets.forEach((el) => observer.observe(el));
  }, 580);
})();

// =====================================================
// Cursor — direct 1:1 mouse tracking with hover/click size states
// =====================================================
(function () {
  const cursor = document.getElementById('cursor');
  if (!cursor) return;
  // Skip on touch devices
  if (window.matchMedia('(pointer: coarse)').matches) return;

  // Move the cursor element out of <body> and onto <html> directly. The
  // page-zoom feature transforms <body>, which would otherwise turn the
  // body into the containing block for any position:fixed children —
  // including this cursor — making it follow the body's scale/translate
  // and disappear off-screen. Fixed children of <html> are unaffected.
  if (cursor.parentNode === document.body) {
    document.documentElement.appendChild(cursor);
  }

  let visible = false;

  // Coalesce mousemove into one style write per frame. mousemove can fire more
  // often than the display refreshes; writing cursor.style.transform on every
  // event does redundant work. Stash the latest coords and flush once per rAF
  // so we touch the DOM at most once per painted frame.
  let curX = 0;
  let curY = 0;
  let cursorRAF = null;
  function flushCursor() {
    cursorRAF = null;
    cursor.style.transform = `translate3d(${curX}px, ${curY}px, 0)`;
  }
  document.addEventListener('mousemove', (e) => {
    curX = e.clientX;
    curY = e.clientY;
    if (!visible) {
      visible = true;
      cursor.classList.add('visible');
    }
    if (cursorRAF === null) cursorRAF = requestAnimationFrame(flushCursor);
  });

  document.addEventListener('mouseleave', () => {
    visible = false;
    cursor.classList.remove('visible');
  });
  document.addEventListener('mouseenter', () => {
    visible = true;
    cursor.classList.add('visible');
  });

  // Hover state on interactive elements
  const interactiveSelector = 'a, button, .gallery img, .gallery-nav, .nav-circle-item, .project-gif, [role="button"]';
  document.addEventListener('mouseover', (e) => {
    if (e.target.closest(interactiveSelector)) cursor.classList.add('hover');
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest(interactiveSelector)) cursor.classList.remove('hover');
  });

  // Click squish
  document.addEventListener('mousedown', () => cursor.classList.add('click'));
  document.addEventListener('mouseup', () => cursor.classList.remove('click'));

  // Cross-origin iframes (the YouTube player) capture mouse events and stop
  // forwarding them to the parent — so the custom cursor would freeze in
  // place at whatever spot the mouse left the page proper. Hide it whenever
  // the user interacts inside an iframe (window blurs, iframe becomes the
  // active element) and re-show it the moment the parent regains focus.
  function handleFocusChange() {
    const inIframe =
      document.activeElement && document.activeElement.tagName === 'IFRAME';
    if (inIframe) {
      visible = false;
      cursor.classList.remove('visible');
    }
  }
  // The cursor reappears naturally on the next mousemove after focus returns,
  // so only the blur side needs handling.
  window.addEventListener('blur', handleFocusChange);
})();

// =====================================================
// Click ring — single sage halo emanates from every click point.
// Mirrors the cursor squish in time. Spawned on mousedown for snappy
// "the click registered" feedback. Element is appended to <html> (not
// <body>) so the page-zoom transform doesn't displace it.
// =====================================================
(function () {
  if (window.matchMedia('(pointer: coarse)').matches) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // primary click only
    const ring = document.createElement('div');
    ring.className = 'click-ring';
    // Position via CSS variables so the keyframe (which controls scale)
    // can keep the translate constant — otherwise scaling around top-left
    // would drift the ring as it grows.
    ring.style.setProperty('--cx', `${e.clientX}px`);
    ring.style.setProperty('--cy', `${e.clientY}px`);
    document.documentElement.appendChild(ring);
    // Self-cleanup once the keyframe finishes. animationend fires reliably;
    // a setTimeout safety net catches the rare case where the tab was
    // backgrounded mid-animation and the event never fires.
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      ring.remove();
    };
    ring.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, 800);
  });
})();

// =====================================================
// Lite YouTube embed — load iframe only on play button click
// =====================================================
(function () {
  // Quieter player chrome:
  //   rel=0              — only show videos from same channel at the end
  //   modestbranding=1   — drops the YouTube watermark (legacy, mostly ignored now)
  //   iv_load_policy=3   — hide annotation overlays
  //   cc_load_policy=0   — don't auto-show captions
  //   color=white        — neutral progress bar (no red)
  //   playsinline=1      — keep inline on iOS instead of going full-screen
  //   fs=1               — keep the full-screen button available
  //   autoplay=1         — start playing once the iframe replaces the poster
  const params = [
    'autoplay=1',
    'rel=0',
    'modestbranding=1',
    'iv_load_policy=3',
    'cc_load_policy=0',
    'color=white',
    'playsinline=1',
    'fs=1',
  ].join('&');

  document.querySelectorAll('.project-video').forEach((wrapper) => {
    const btn = wrapper.querySelector('.video-play');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const id = wrapper.dataset.videoId;
      const title = wrapper.dataset.title || '';
      if (!id) return;
      const iframe = document.createElement('iframe');
      iframe.src = `https://www.youtube.com/embed/${id}?${params}`;
      iframe.title = title;
      iframe.frameBorder = '0';
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
      iframe.allowFullscreen = true;
      btn.replaceWith(iframe);
    });
  });
})();

// =====================================================
// Hide broken images gracefully — defended against src="" placeholders
// which some browsers fire `error` for.
// =====================================================
document.querySelectorAll('img').forEach((img) => {
  img.addEventListener('error', () => {
    if (!img.getAttribute('src')) return;
    img.style.opacity = '0.3';
    img.style.pointerEvents = 'none';
  });
});

// =====================================================
// Email link — assembles the address from data-* parts at runtime so the
// static HTML never contains the full address (anti-scraping). Click copies
// the address to the clipboard and briefly swaps the label to "copied!"
// instead of opening the user's mail client. The mailto href stays as a
// keyboard / right-click "copy link" fallback.
// =====================================================
(function () {
  const el = document.getElementById('contact-email');
  if (!el) return;
  const user = el.dataset.u;
  const domain = el.dataset.d;
  if (!user || !domain) return;
  const at = String.fromCharCode(64);
  const addr = user + at + domain;
  el.setAttribute('href', 'mai' + 'lto:' + addr);

  const textEl = el.querySelector('.contact-email-text');
  let revertTimer = null;

  el.addEventListener('click', (e) => {
    e.preventDefault();
    const original = textEl ? textEl.textContent : 'Email';
    const flash = (msg) => {
      if (textEl) textEl.textContent = msg;
      el.classList.add('copied');
      clearTimeout(revertTimer);
      revertTimer = setTimeout(() => {
        if (textEl) textEl.textContent = original;
        el.classList.remove('copied');
      }, 1600);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(addr).then(
        () => flash('copied!'),
        () => flash('press ⌘/ctrl+C')
      );
    } else {
      // Legacy fallback: select hidden textarea + execCommand
      const ta = document.createElement('textarea');
      ta.value = addr;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(ta);
      flash(ok ? 'copied!' : 'press ⌘/ctrl+C');
    }
  });
})();
