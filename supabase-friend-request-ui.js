
"use strict";

/*
 * MERO SANSAR
 * Complete Friend Request Flow UI
 *
 * Load order:
 * supabase-friends.js
 * supabase-notifications.js
 * supabase-friend-request-ui.js
 * app.js
 */

(function (global) {
  "use strict";

  if (global.__KSK_FRIEND_FLOW_V2__) return;
  global.__KSK_FRIEND_FLOW_V2__ = true;

  const LEGACY_TYPES = new Set([
    "post_comment",
    "post_reaction"
  ]);

  const CANCEL_SELECTOR = "[data-ksk-flow-action='cancel']";
  const ACTION_SELECTOR = "[data-ksk-flow-action]";

  let observer = null;
  let dashboardPromise = null;
  let syncTimer = null;
  let syncing = false;
  let syncAgain = false;

  const enhancedRows = new WeakSet();

  /* =====================================================
     SERVICES
  ===================================================== */

  function friends() {
    return global.KSKSupabaseFriends || null;
  }

  function app() {
    return global.KSKWhatsAppApp || null;
  }

  function notifications() {
    return global.KSKSupabaseNotifications || null;
  }

  function getRoot() {
    return document.querySelector("[data-wa-root]") ||
      document.getElementById("waApp");
  }

  function success(response) {
    if (!response || response.ok !== true) {
      throw new Error(
        response?.message ||
        response?.code ||
        "अनुरोध पूरा हुन सकेन।"
      );
    }

    return response.data;
  }

  function message(text, type = "info") {
    const toast = document.querySelector("[data-wa-toast]");

    if (toast) {
      toast.textContent = text;
      toast.hidden = false;
      toast.dataset.type = type;
      return;
    }

    global.dispatchEvent(
      new CustomEvent("ksk:friend-flow-message", {
        detail: { text, type }
      })
    );
  }

  function normal(value) {
    return String(value || "")
      .trim()
      .replace(/\s+/g, " ")
      .toLocaleLowerCase();
  }

  function escapeText(value) {
    return String(value || "")
      .replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[character]);
  }

  /* =====================================================
     LEGACY NOTIFICATION FILTER
  ===================================================== */

  function installNotificationFilter() {
    const api = notifications();

    if (
      !api ||
      typeof api.getNotifications !== "function" ||
      api.__kskFlowFilter
    ) {
      return;
    }

    const original = api.getNotifications.bind(api);

    const replacement = {
      ...api,

      __kskFlowFilter: true,

      async getNotifications(options = {}) {
        const response = await original(options);

        if (
          !response?.ok ||
          !Array.isArray(response.data)
        ) {
          return response;
        }

        return {
          ...response,
          data: response.data.filter(item =>
            !LEGACY_TYPES.has(
              normal(item.type)
            )
          )
        };
      }
    };

    global.KSKSupabaseNotifications =
      Object.freeze(replacement);
  }

  /* =====================================================
     DASHBOARD
  ===================================================== */

  async function getDashboard(force = false) {
    const api = friends();

    if (!api?.getDashboard) {
      throw new Error(
        "Friend service उपलब्ध छैन।"
      );
    }

    if (dashboardPromise && !force) {
      return dashboardPromise;
    }

    dashboardPromise = (async () => {
      const response = await api.getDashboard();
      return success(response) || {};
    })();

    try {
      return await dashboardPromise;
    } finally {
      dashboardPromise = null;
    }
  }

  function findPersonRequest(list, personId, personName) {
    const id = String(personId || "");
    const name = normal(personName);

    return (list || []).find(item => {
      if (id && String(item.person?.id || "") === id) {
        return true;
      }

      return name &&
        normal(item.person?.name) === name;
    }) || null;
  }

  /* =====================================================
     BUTTONS
  ===================================================== */

  function makeButton(action, requestId, label, style) {
    const button = document.createElement("button");

    button.type = "button";
    button.className =
      "wa-button " + (style || "wa-button-quiet");

    button.textContent = label;

    button.dataset.kskFlowAction = action;
    button.dataset.kskRequestId = requestId;

    button.style.whiteSpace = "nowrap";
    button.style.minHeight = "34px";
    button.style.flexShrink = "0";

    return button;
  }

  function makeActionGroup() {
    const group = document.createElement("span");

    group.dataset.kskFlowControls = "true";
    group.style.display = "flex";
    group.style.alignItems = "center";
    group.style.gap = "6px";
    group.style.flexWrap = "wrap";

    return group;
  }

  /* =====================================================
     NEW CHAT SEARCH RESULTS
  ===================================================== */

  function getSearchContainers() {
    return document.querySelectorAll(
      "[data-wa-contact-results], " +
      "[data-wa-contact-page-results]"
    );
  }

  function getSearchPersonName(row) {
    const title = row.querySelector(".wa-row-title");

    if (title) return title.textContent.trim();

    const main = row.querySelector(".wa-row-main");

    if (!main) return "";

    return main.textContent
      .replace(/\b(Add|Message|Pending)\b/gi, "")
      .trim();
  }

  function hasFriend(dashboard, name) {
    return (dashboard.friends || []).some(person =>
      normal(person.name) === normal(name)
    );
  }

  function enhanceSearchRow(row, dashboard) {
    if (enhancedRows.has(row)) return;

    const name = getSearchPersonName(row);

    if (!name) return;

    if (hasFriend(dashboard, name)) {
      enhancedRows.add(row);
      return;
    }

    const incoming = findPersonRequest(
      dashboard.incoming,
      "",
      name
    );

    const outgoing = findPersonRequest(
      dashboard.outgoing,
      "",
      name
    );

    /*
     * Incoming takes priority.
     * Reciprocal requests remain independently actionable.
     */

    const oldButton = row.querySelector(
      "[data-wa-add-friend], " +
      "[data-wa-open-friend-chat]"
    );

    if (oldButton) oldButton.remove();

    const oldPending = Array.from(row.children).find(child =>
      normal(child.textContent) === "pending"
    );

    if (oldPending) oldPending.remove();

    const group = makeActionGroup();

    if (incoming?.id) {
      group.appendChild(
        makeButton(
          "accept",
          incoming.id,
          "Accept",
          "wa-button-primary"
        )
      );

      group.appendChild(
        makeButton(
          "reject",
          incoming.id,
          "Reject",
          "wa-button-quiet"
        )
      );
    }

    if (outgoing?.id) {
      group.appendChild(
        makeButton(
          "cancel",
          outgoing.id,
          "Cancel",
          "wa-button-quiet"
        )
      );
    }

    if (!incoming && !outgoing) {
      /*
       * Preserve the original Add button.
       * app.js already handles data-wa-add-friend.
       */
      const add = document.createElement("span");
      add.textContent = "Add";
      add.className = "wa-row-preview";
      group.appendChild(add);
    }

    row.appendChild(group);
    enhancedRows.add(row);
  }

  async function enhanceSearchResults() {
    const containers = getSearchContainers();

    if (!containers.length) return;

    const dashboard = await getDashboard();

    containers.forEach(container => {
      const rows = container.querySelectorAll(
        ".wa-list-row"
      );

      rows.forEach(row => {
        enhanceSearchRow(row, dashboard);
      });
    });
  }

  /* =====================================================
     CONTACTS — SENT REQUESTS CANCEL
  ===================================================== */

  function getSentSection() {
    const page = document.querySelector(
      '[data-wa-page-content="contacts"]'
    );

    if (!page) return null;

    return Array.from(
      page.querySelectorAll(".wa-section")
    ).find(section =>
      /sent requests/i.test(
        section.querySelector(
          ".wa-section-title"
        )?.textContent || ""
      )
    ) || null;
  }

  async function enhanceSentRequests() {
    const section = getSentSection();

    if (!section) return;

    const rows = Array.from(
      section.querySelectorAll(".wa-list-row")
    );

    if (!rows.length) return;

    const dashboard = await getDashboard();
    const outgoing = dashboard.outgoing || [];

    rows.forEach((row, index) => {
      if (row.querySelector(CANCEL_SELECTOR)) {
        return;
      }

      const request = outgoing[index];

      if (!request?.id) return;

      row.appendChild(
        makeButton(
          "cancel",
          request.id,
          "Cancel",
          "wa-button-quiet"
        )
      );
    });
  }

  /* =====================================================
     REFRESH
  ===================================================== */

  async function refreshEverything() {
    dashboardPromise = null;

    const api = app();

    if (api?.refresh) {
      await api.refresh();
    }

    dashboardPromise = null;

    await synchronize();
  }

  /* =====================================================
     FRIEND REQUEST ACTIONS
  ===================================================== */

  async function performAction(action, requestId, button) {
    const api = friends();

    if (!api) {
      throw new Error(
        "Friend service उपलब्ध छैन।"
      );
    }

    if (button?.disabled) return;

    const previous = button?.textContent || "";

    if (button) {
      button.disabled = true;
      button.textContent =
        action === "accept" ? "Accepting…" :
        action === "reject" ? "Rejecting…" :
        "Cancelling…";
    }

    try {
      let response;

      if (action === "accept" || action === "reject") {
        response = await api.respondToFriendRequest(
          requestId,
          action === "accept" ? "accepted" : "rejected"
        );
      } else if (action === "cancel") {
        response = await api.cancelFriendRequest(
          requestId
        );
      } else {
        throw new Error("अमान्य Friend Request action।");
      }

      success(response);

      dashboardPromise = null;

      await refreshEverything();

      message(
        action === "accept"
          ? "Friend Request स्वीकार भयो।"
          : action === "reject"
            ? "Friend Request अस्वीकार भयो।"
            : "Friend Request Cancel भयो।",
        "success"
      );

    } catch (error) {
      console.error(
        "Friend request action failed:",
        error
      );

      if (button) {
        button.disabled = false;
        button.textContent = previous;
      }

      message(
        error?.message ||
        "Friend Request कार्य पूरा भएन।",
        "error"
      );
    }
  }

  /* =====================================================
     CLICK HANDLER
  ===================================================== */

  function bindActions() {
    document.addEventListener(
      "click",
      async event => {
        const target = event.target;

        if (!(target instanceof Element)) return;

        const button = target.closest(ACTION_SELECTOR);

        if (!button) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        await performAction(
          button.dataset.kskFlowAction,
          button.dataset.kskRequestId,
          button
        );
      },
      true
    );
  }

  /* =====================================================
     MUTATION OBSERVER
  ===================================================== */

  async function synchronize() {
    if (syncing) {
      syncAgain = true;
      return;
    }

    syncing = true;

    try {
      do {
        syncAgain = false;

        await enhanceSearchResults();
        await enhanceSentRequests();

      } while (syncAgain);

    } catch (error) {
      console.warn(
        "Friend flow synchronization:",
        error
      );

    } finally {
      syncing = false;
    }
  }

  function scheduleSync() {
    if (syncTimer !== null) {
      global.clearTimeout(syncTimer);
    }

    syncTimer = global.setTimeout(() => {
      syncTimer = null;
      synchronize();
    }, 80);
  }

  function startObserver() {
    const root = getRoot();

    if (!root || observer) return;

    observer = new MutationObserver(() => {
      scheduleSync();
    });

    observer.observe(root, {
      childList: true,
      subtree: true
    });

    scheduleSync();
  }

  /* =====================================================
     APP / FRIEND REALTIME REFRESH
  ===================================================== */

  function bindRealtimeRefresh() {
    global.addEventListener(
      "ksk:friends-cloud-change",
      () => {
        dashboardPromise = null;
        scheduleSync();
      }
    );

    global.addEventListener(
      "ksk:notification-cloud-change",
      event => {
        if (
          event.detail?.item?.type === "friend_request" ||
          event.detail?.item?.type === "friend_accepted"
        ) {
          dashboardPromise = null;
          scheduleSync();
        }
      }
    );

    global.addEventListener("focus", () => {
      dashboardPromise = null;
      scheduleSync();
    });

    global.addEventListener("online", () => {
      dashboardPromise = null;
      scheduleSync();
    });
  }

  /* =====================================================
     INITIALIZE
  ===================================================== */

  function initialize() {
    installNotificationFilter();
    bindActions();
    bindRealtimeRefresh();
    startObserver();

    console.info(
      "KSK Friend Request Flow V2 loaded."
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      initialize,
      { once: true }
    );
  } else {
    initialize();
  }

})(window);
