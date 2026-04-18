// ── Phase W5 — Animation wiring ──
// PXP counter, image fade-in, intersection-observer reveal.
// Loaded via <script src="/animations.js"></script> on every page.

(function () {
  "use strict";

  // ── 1. PXP balance animation ──
  // Wrap the number inside .pxp-badge in a <span class="pxp-amount">
  // so we can animate it with pxpUp/pxpDown keyframes when it changes.
  function normalizePxpBadge(badge) {
    if (!badge) return;
    if (badge.querySelector(".pxp-amount")) return; // already wrapped
    const raw = badge.textContent.trim();
    // Match optional formatted number + "PXP" suffix
    const m = raw.match(/^([\d.,]+)\s*PXP$/i);
    if (m) {
      badge.innerHTML = '<span class="pxp-amount">' + m[1] + '</span> PXP';
    }
  }

  function animatePxp(badge, newValue) {
    if (!badge) return;
    normalizePxpBadge(badge);
    const amountEl = badge.querySelector(".pxp-amount");
    if (!amountEl) {
      badge.textContent = newValue + " PXP";
      return;
    }
    const currentNum = parseFloat(amountEl.textContent.replace(/,/g, "")) || 0;
    const newNum = parseFloat(String(newValue).replace(/,/g, "")) || 0;
    const delta = newNum - currentNum;

    if (delta === 0) {
      amountEl.textContent = newValue;
      return;
    }

    // Remove previous animation class if still lingering
    badge.classList.remove("anim-up", "anim-down");
    // Force reflow to re-trigger animation
    void badge.offsetWidth;
    badge.classList.add(delta > 0 ? "anim-up" : "anim-down");

    // Count up/down smoothly over 500ms
    const startTime = performance.now();
    const duration = 500;
    function tick(now) {
      const t = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      const v = currentNum + delta * eased;
      // Format: use 2 decimal places if original had decimals
      const hasDecimals = String(newValue).includes(".");
      amountEl.textContent = hasDecimals
        ? v.toFixed(2)
        : Math.round(v).toLocaleString();
      if (t < 1) requestAnimationFrame(tick);
      else {
        amountEl.textContent = newValue;
        setTimeout(() => badge.classList.remove("anim-up", "anim-down"), 100);
      }
    }
    requestAnimationFrame(tick);
  }

  // Expose globally so wallet code can call it.
  window.animatePxp = animatePxp;

  // ── 2. Patch existing PXP update sites ──
  // If the page has existing fetches that set `el.textContent = X + " PXP"`,
  // we intercept by observing the badge via MutationObserver.
  // (Non-destructive: pages can also call window.animatePxp directly.)
  function observePxpBadge() {
    const badge = document.getElementById("pxpBal");
    if (!badge) return;
    normalizePxpBadge(badge);
    // Watch for future textContent changes from legacy code
    const observer = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type !== "childList") continue;
        // If someone replaced the whole innerHTML (no .pxp-amount), re-wrap
        if (!badge.querySelector(".pxp-amount")) {
          const raw = badge.textContent.trim();
          const match = raw.match(/^([\d.,]+)\s*PXP$/i);
          if (match) {
            observer.disconnect();
            badge.innerHTML =
              '<span class="pxp-amount">' + match[1] + '</span> PXP';
            observer.observe(badge, { childList: true, subtree: true });
          }
        }
      }
    });
    observer.observe(badge, { childList: true, subtree: true });
  }

  // ── 3. Image fade-in on load ──
  // Finds all .img-fade images; marks them loaded when network finishes.
  function wireImageFadeIn(root) {
    const imgs = (root || document).querySelectorAll("img.img-fade");
    imgs.forEach((img) => {
      if (img.complete && img.naturalWidth > 0) {
        img.classList.add("loaded");
      } else {
        img.addEventListener("load", () => img.classList.add("loaded"), {
          once: true,
        });
        img.addEventListener(
          "error",
          () => img.classList.add("loaded"),
          { once: true }
        );
      }
    });
  }

  // Observe dynamically added images (for infinite scroll / AJAX galleries)
  function observeNewImages() {
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.addedNodes) {
          m.addedNodes.forEach((node) => {
            if (node.nodeType !== 1) return;
            if (node.matches && node.matches("img.img-fade")) {
              wireImageFadeIn(node.parentNode || document);
            } else if (node.querySelectorAll) {
              const fades = node.querySelectorAll("img.img-fade");
              if (fades.length) wireImageFadeIn(node);
            }
          });
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // ── 4. Intersection-observer reveal ──
  // Elements with .reveal fade up when scrolled into view.
  function wireReveal() {
    const elements = document.querySelectorAll(".reveal");
    if (!elements.length || !("IntersectionObserver" in window)) {
      elements.forEach((el) => el.classList.add("in-view"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in-view");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    elements.forEach((el) => io.observe(el));
  }

  // ── Init ──
  function init() {
    observePxpBadge();
    wireImageFadeIn();
    observeNewImages();
    wireReveal();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
