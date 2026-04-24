// ── Shared Navigation Component ──
// Injects consistent nav + mobile hamburger drawer across all pages.
// Usage: <script src="/nav.js"></script> placed AFTER <body> or at end of <body>.
// The script finds the existing <nav> and enhances it with hamburger + drawer.

(function () {
  "use strict";

  // ── Theme Init (runs immediately, before paint) ──
  (function initTheme() {
    const stored = localStorage.getItem("pixelpay-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = stored || (prefersDark ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
  })();

  const NAV_LINKS = [
    { href: "/studio", label: "Studio" },
    { href: "/gallery", label: "Gallery" },
    { href: "/marketplace", label: "Marketplace" },
    { href: "/swap", label: "Swap" },
    { href: "/profile", label: "Profile" },
  ];

  // Determine active page from pathname
  const path = window.location.pathname.replace(/\/$/, "") || "/";
  function isActive(href) {
    if (href === "/" && path === "/") return true;
    if (href !== "/" && path.startsWith(href)) return true;
    return false;
  }

  // Find the existing nav element
  const nav = document.querySelector("nav");
  if (!nav) return;

  // ── Inject hamburger button into .nav-right ──
  const navRight = nav.querySelector(".nav-right");
  if (!navRight) return;

  // ── Theme toggle button ──
  const SUN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  const MOON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  function getTheme() { return document.documentElement.getAttribute("data-theme") || "dark"; }
  function setTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem("pixelpay-theme", t);
    updateToggleBtn();
  }
  function updateToggleBtn() {
    const isDark = getTheme() === "dark";
    if (themeToggle) {
      themeToggle.innerHTML = isDark
        ? MOON_SVG + "<span>Light</span>"
        : SUN_SVG + "<span>Dark</span>";
      themeToggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
    }
  }

  // Reuse pre-rendered toggle if present (prevents layout flash),
  // otherwise inject one.
  let themeToggle = navRight.querySelector(".theme-toggle");
  if (!themeToggle) {
    themeToggle = document.createElement("button");
    themeToggle.className = "theme-toggle";
    themeToggle.innerHTML = MOON_SVG + "<span>Light</span>";
    navRight.insertBefore(themeToggle, navRight.firstChild);
  }
  themeToggle.addEventListener("click", function () {
    setTheme(getTheme() === "dark" ? "light" : "dark");
  });
  updateToggleBtn();

  const hamburger = document.createElement("button");
  hamburger.className = "hamburger";
  hamburger.setAttribute("aria-label", "Open menu");
  hamburger.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
  navRight.appendChild(hamburger);

  // ── Create overlay ──
  const overlay = document.createElement("div");
  overlay.className = "nav-overlay";
  document.body.appendChild(overlay);

  // ── Create drawer ──
  const drawer = document.createElement("div");
  drawer.className = "nav-drawer";

  // Drawer header
  const drawerHeader = document.createElement("div");
  drawerHeader.className = "nav-drawer-header";
  drawerHeader.innerHTML = '<span style="font-family:var(--font-heading);font-weight:700;font-size:16px;letter-spacing:-0.03em">PixelPay</span>';

  const closeBtn = document.createElement("button");
  closeBtn.className = "nav-drawer-close";
  closeBtn.setAttribute("aria-label", "Close menu");
  closeBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  drawerHeader.appendChild(closeBtn);
  drawer.appendChild(drawerHeader);

  // Drawer links
  const drawerLinks = document.createElement("div");
  drawerLinks.className = "nav-drawer-links";
  NAV_LINKS.forEach(function (link) {
    const a = document.createElement("a");
    a.href = link.href;
    a.textContent = link.label;
    if (isActive(link.href)) a.className = "active";
    drawerLinks.appendChild(a);
  });
  drawer.appendChild(drawerLinks);

  // Drawer footer (wallet + PXP clone)
  const drawerFooter = document.createElement("div");
  drawerFooter.className = "nav-drawer-footer";
  // Clone PXP badge if exists
  const pxpBadge = document.getElementById("pxpBal");
  if (pxpBadge) {
    const pxpClone = pxpBadge.cloneNode(true);
    pxpClone.removeAttribute("id");
    pxpClone.className = "pxp-badge";
    pxpClone.style.display = "";
    pxpClone.style.justifyContent = "center";
    drawerFooter.appendChild(pxpClone);
  }
  // Clone wallet button
  const walletBtn = document.getElementById("walletBtn");
  if (walletBtn) {
    const walletClone = walletBtn.cloneNode(true);
    walletClone.removeAttribute("id");
    walletClone.style.width = "100%";
    walletClone.style.textAlign = "center";
    walletClone.onclick = function () {
      closeDrawer();
      // Trigger original wallet handler
      if (typeof handleWallet === "function") handleWallet();
      else if (typeof connectWallet === "function") connectWallet();
    };
    drawerFooter.appendChild(walletClone);
  }
  drawer.appendChild(drawerFooter);
  document.body.appendChild(drawer);

  // ── Open / Close ──
  function openDrawer() {
    drawer.classList.add("open");
    overlay.classList.add("open");
    document.body.style.overflow = "hidden";
  }

  function closeDrawer() {
    drawer.classList.remove("open");
    overlay.classList.remove("open");
    document.body.style.overflow = "";
  }

  hamburger.addEventListener("click", openDrawer);
  closeBtn.addEventListener("click", closeDrawer);
  overlay.addEventListener("click", closeDrawer);

  // Close on Escape
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && drawer.classList.contains("open")) closeDrawer();
  });
})();
