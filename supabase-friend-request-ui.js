
"use strict";

/*
 * MERO SANSAR — FRIEND REQUEST UI PATCH
 *
 * Features:
 * 1. Add Cancel button to outgoing friend requests.
 * 2. Cancel only the current user's pending request.
 * 3. Refresh app data after successful cancellation.
 * 4. Hide legacy post_comment and post_reaction notifications.
 * 5. Preserve all existing Supabase notification methods.
 *
 * Load this file AFTER supabase-notifications.js
 * and BEFORE app.js.
 */

(function (global) {
  "use strict";

  if (global.__KSK_FRIEND_REQUEST_UI_LOADED__) return;
  global.__KSK_FRIEND_REQUEST_UI_LOADED__ = true;

  const LEGACY_NOTIFICATION_TYPES = new Set([
    "post_comment",
    "post_reaction"
  ]);

  const CANCEL_SELECTOR = "[data-ksk-cancel-request]";

  let observer = null;
  let syncRunning = false;
  let syncRequested = false;
  let lastContactsPage = null;

  /* =====================================================
     HELPERS
  ===================================================== */

  function getFriendsAPI() {
    return global.KSKSupabaseFriends || null;
  }

  function getNotificationsAPI() {
    return global.KSKSupabaseNotifications || null;
  }

  function getAppAPI() {
    return global.KSKWhatsAppApp || null;
  }

  function isElement(value) {
    return value instanceof Element;
  }

  function getResultData(response) {
    if (!response || response.ok !== true) {
      throw new Error(
        response?.message ||
        "अनुरोध पूरा हुन सकेन।"
      );
    }

    return response.data;
  }

  function showMessage(message, type = "info") {
    try {
      if (typeof global.showToast === "function") {
        global.showToast(message, type);
        return;
      }

      global.dispatchEvent(
        new CustomEvent("ksk:friend-request-ui-message", {
          detail: { message, type }
        })
      );
    } catch (error) {
      console.warn(
        "Friend request UI message failed:",
        error
      );
    }
  }

  /* =====================================================
     LEGACY NOTIFICATION FILTER
  ===================================================== */

  function installLegacyNotificationFilter() {
    const api = getNotificationsAPI();

    if (
      !api ||
      typeof api.getNotifications !== "function" ||
      api.__kskLegacyFilterInstalled
    ) {
      return;
    }

    const originalGetNotifications =
      api.getNotifications.bind(api);

    const wrappedAPI = {
      ...api,

      __kskLegacyFilterInstalled: true,

      async getNotifications(options = {}) {
        const response =
          await originalGetNotifications(options);

        if (
          !response ||
          response.ok !== true ||
          !Array.isArray(response.data)
        ) {
          return response;
        }

        return {
          ...response,

          data: response.data.filter(item => {
            const type = String(
              item?.type || ""
            ).trim().toLowerCase();

            return !LEGACY_NOTIFICATION_TYPES.has(type);
          })
        };
      }
    };

    global.KSKSupabaseNotifications =
      Object.freeze(wrappedAPI);

    console.info(
      "KSK legacy notification filter installed."
    );
  }

  /* =====================================================
     CONTACTS PAGE
  ===================================================== */

  function getContactsPage() {
    return global.document.querySelector(
      '[data-wa-page-content="contacts"]'
    );
  }

  function getSentRequestsSection(page) {
    if (!page) return null;

    const sections = page.querySelectorAll(
      ".wa-section"
    );

    for (const section of sections) {
      const heading = section.querySelector(
        ".wa-section-title"
      );

      if (!heading) continue;

      if (
        /sent requests/i.test(
          heading.textContent || ""
        )
      ) {
        return section;
      }
    }

    return null;
  }

  function createCancelButton(requestId) {
    const button = global.document.createElement(
      "button"
    );

    button.type = "button";
    button.className =
      "wa-button wa-button-quiet";

    button.textContent = "Cancel";

    button.setAttribute(
      "data-ksk-cancel-request",
      requestId
    );

    button.setAttribute(
      "aria-label",
      "Cancel friend request"
    );

    button.style.whiteSpace = "nowrap";
    button.style.minHeight = "34px";
    button.style.flexShrink = "0";

    return button;
  }

  async function addCancelButtons() {
    const page = getContactsPage();

    if (!page) {
      lastContactsPage = null;
      return;
    }

    const section = getSentRequestsSection(page);

    if (!section) {
      lastContactsPage = page;
      return;
    }

    const rows = Array.from(
      section.querySelectorAll(".wa-list-row")
    );

    if (!rows.length) return;

    /*
     * Avoid fetching the dashboard repeatedly
     * when the same rendered rows are already patched.
     */

    const needsButtons = rows.some(row =>
      !row.querySelector(CANCEL_SELECTOR)
    );

    if (!needsButtons) {
      lastContactsPage = page;
      return;
    }

    const friendsAPI = getFriendsAPI();

    if (
      !friendsAPI ||
      typeof friendsAPI.getDashboard !== "function"
    ) {
      console.warn(
        "Friends service is not available."
      );
      return;
    }

    const response =
      await friendsAPI.getDashboard();

    const dashboard = getResultData(response);

    const outgoing = Array.isArray(dashboard?.outgoing)
      ? dashboard.outgoing
      : [];

    /*
     * renderContacts() creates outgoing rows
     * using outgoing.map(), preserving this order.
     */

    rows.forEach((row, index) => {
      if (row.querySelector(CANCEL_SELECTOR)) {
        return;
      }

      const request = outgoing[index];

      if (!request?.id) return;

      row.appendChild(
        createCancelButton(String(request.id))
      );
    });

    lastContactsPage = page;
  }

  async function synchronizeContacts() {
    if (syncRunning) {
      syncRequested = true;
      return;
    }

    syncRunning = true;

    try {
      do {
        syncRequested = false;

        await addCancelButtons();

      } while (syncRequested);

    } catch (error) {
      console.error(
        "Could not add friend request buttons:",
        error
      );

    } finally {
      syncRunning = false;
    }
  }

  /* =====================================================
     CANCEL FRIEND REQUEST
  ===================================================== */

  async function cancelRequest(button) {
    const requestId = String(
      button.getAttribute(
        "data-ksk-cancel-request"
      ) || ""
    ).trim();

    if (!requestId) {
      showMessage(
        "Friend Request ID भेटिएन।",
        "error"
      );
      return;
    }

    const friendsAPI = getFriendsAPI();

    if (
      !friendsAPI ||
      typeof friendsAPI.cancelFriendRequest !== "function"
    ) {
      showMessage(
        "Friend Request सेवा उपलब्ध छैन।",
        "error"
      );
      return;
    }

    if (button.disabled) return;

    const previousText = button.textContent;

    button.disabled = true;
    button.textContent = "Cancelling…";

    try {
      const response =
        await friendsAPI.cancelFriendRequest(
          requestId
        );

      getResultData(response);

      showMessage(
        "Friend Request Cancel भयो।",
        "success"
      );

      const app = getAppAPI();

      if (
        app &&
        typeof app.refresh === "function"
      ) {
        await app.refresh();
      } else if (
        typeof friendsAPI.getDashboard === "function"
      ) {
        await synchronizeContacts();
      }

    } catch (error) {
      console.error(
        "Cancel friend request failed:",
        error
      );

      showMessage(
        error?.message ||
        "Friend Request Cancel गर्न सकिएन।",
        "error"
      );

      button.disabled = false;
      button.textContent = previousText;
    }
  }

  /* =====================================================
     EVENT HANDLING
  ===================================================== */

  function bindEvents() {
    global.document.addEventListener(
      "click",
      async event => {
        if (!isElement(event.target)) return;

        const button = event.target.closest(
          CANCEL_SELECTOR
        );

        if (!button) return;

        /*
         * Prevent the main app click handler
         * from processing this button.
         */

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        await cancelRequest(button);

      },
      true
    );
  }

  /* =====================================================
     DOM OBSERVER
  ===================================================== */

  function startObserver() {
    const root =
      global.document.querySelector(
        "[data-wa-root]"
      ) ||
      global.document.getElementById("waApp");

    if (!root || observer) return;

    observer = new MutationObserver(() => {
      const page = getContactsPage();

      if (page !== lastContactsPage) {
        synchronizeContacts();
        return;
      }

      const section =
        getSentRequestsSection(page);

      if (!section) return;

      const rows = section.querySelectorAll(
        ".wa-list-row"
      );

      const missingButton = Array.from(rows).some(
        row => !row.querySelector(CANCEL_SELECTOR)
      );

      if (missingButton) {
        synchronizeContacts();
      }
    });

    observer.observe(root, {
      childList: true,
      subtree: true
    });

    synchronizeContacts();
  }

  /* =====================================================
     INITIALIZATION
  ===================================================== */

  function initialize() {
    installLegacyNotificationFilter();
    bindEvents();
    startObserver();

    console.info(
      "KSK Friend Request UI initialized."
    );
  }

  if (global.document.readyState === "loading") {
    global.document.addEventListener(
      "DOMContentLoaded",
      initialize,
      { once: true }
    );
  } else {
    initialize();
  }

})(window);
