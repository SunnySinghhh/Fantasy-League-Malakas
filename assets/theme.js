// Theme toggle + mobile nav wiring, shared across every page.
// The initial theme (before this file loads) is applied by a small inline
// script in <head> to avoid a flash of the wrong theme — see theme-init.js.
(function () {
  "use strict";

  var STORAGE_KEY = "malaka-theme";

  function systemPrefersDark() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function currentTheme() {
    var stored = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch (e) {}
    if (stored === "light" || stored === "dark") return stored;
    return systemPrefersDark() ? "dark" : "light";
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) {}
  }

  function wireToggles() {
    var toggles = document.querySelectorAll(".theme-toggle");
    toggles.forEach(function (btn) {
      btn.setAttribute("aria-label", "Toggle dark mode");
      btn.addEventListener("click", function () {
        var next = currentTheme() === "dark" ? "light" : "dark";
        applyTheme(next);
      });
    });
  }

  function wireMobileNav() {
    var btn = document.querySelector(".nav-menu-btn");
    var menu = document.querySelector(".nav-links");
    if (!btn || !menu) return;
    btn.addEventListener("click", function () {
      menu.classList.toggle("open");
      btn.setAttribute("aria-expanded", menu.classList.contains("open") ? "true" : "false");
    });
    menu.addEventListener("click", function (e) {
      if (e.target.tagName === "A") menu.classList.remove("open");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { wireToggles(); wireMobileNav(); });
  } else {
    wireToggles();
    wireMobileNav();
  }
})();
