
/*
 * KSK WHATSAPP — NAVIGATION CONTROLLER
 * File: app-navigation.js
 *
 * Fixes:
 * - Restore navigation after leaving a chat.
 * - Keep tabs and bottom navigation hidden inside chat detail.
 * - Synchronize navigation visibility after page changes.
 * - Support mobile browser back/forward page restoration.
 *
 * Load AFTER app.js.
 */

(function (global, document) {
  "use strict";

  if (global.KSKWhatsAppNavigation) return;

  const ROOT_SELECTOR = "[data-wa-root], #waApp";
  let observer = null;
  let bound = false;
  let syncQueued = false;

  function appState() {
    try {
      return global.KSKWhatsAppApp?.getState?.() || null;
    } catch (_) {
      return null;
    }
  }

  function getRoot() {
    return document.querySelector(ROOT_SELECTOR);
  }

  function syncNavigation() {
    const root = getRoot();
    const state = appState();

    if (!root || !state || !state.authenticated) return;

    const inChat = state.page === "chat-detail";

    const tabs = root.querySelector(".wa-tabs");
    const bottom = root.querySelector(".wa-bottom-nav");

    [tabs, bottom].forEach(element => {
      if (!element) return;

      if (inChat) {
        element.hidden = true;
        element.setAttribute("aria-hidden", "true");
      } else {
        element.hidden = false;
        element.removeAttribute("aria-hidden");
      }
    });

    root.querySelectorAll("[data-wa-page]").forEach(button => {
      const active = button.dataset.waPage === state.page;

      button.classList.toggle("is-active", active);

      if (button.classList.contains("wa-tab")) {
        button.setAttribute(
          "aria-selected",
          active ? "true" : "false"
        );
      }

      if (button.classList.contains("wa-nav-item")) {
        if (active) {
          button.setAttribute("aria-current", "page");
        } else {
          button.removeAttribute("aria-current");
        }
      }
    });
  }

  function queueSync() {
    if (syncQueued) return;

    syncQueued = true;

    global.setTimeout(() => {
      syncQueued = false;
      syncNavigation();
    }, 0);
  }

  function handleNavigationClick(event) {
    const target = event.target?.closest?.(
      "[data-wa-page], [data-wa-action]"
    );

    if (!target) return;

    const page = target.dataset.waPage || "";
    const action = target.dataset.waAction || "";

    if (
      page === "chats" ||
      page === "updates" ||
      page === "groups" ||
      page === "contacts" ||
      page === "profile" ||
      page === "notifications" ||
      action === "back-to-chats"
    ) {
      queueSync();
    }
  }

  function observeRoot() {
    const root = getRoot();

    if (!root || observer) return;

    observer = new MutationObserver(() => {
      const state = appState();

      if (state?.authenticated && state.page !== "chat-detail") {
        queueSync();
      }
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden"]
    });
  }

  function initialize() {
    if (bound) return;

    bound = true;

    document.addEventListener(
      "click",
      handleNavigationClick,
      true
    );

    document.addEventListener(
      "DOMContentLoaded",
      () => {
        observeRoot();
        queueSync();
      },
      { once: true }
    );

    observeRoot();
    queueSync();

    global.addEventListener("pageshow", queueSync);

    global.KSKWhatsAppNavigation = Object.freeze({
      initialize,
      refresh: syncNavigation
    });
  }

  initialize();

})(window, document);
