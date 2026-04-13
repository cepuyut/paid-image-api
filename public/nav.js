// ── Shared Navigation Component ──
// Injects consistent nav + mobile hamburger drawer across all pages.
// Usage: <script src="/nav.js"></script> placed AFTER <body> or at end of <body>.
// The script finds the existing <nav> and enhances it with hamburger + drawer.

(function () {
  "use strict";

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
