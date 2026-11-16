
"use strict";

(function (global) {
  if (global.KSKFriendRequestUI) return;

  const ROOT = "[data-wa-root]";
  const OPEN_ATTR = "data-ksk-open-notification";
  const CANCEL_ATTR = "data-ksk-cancel-request";

  let observer = null;
  let busy = new Set();
  let syncRunning = false;

  const $ = (selector, parent = document) =>
    parent.querySelector(selector);

  function app() {
    return global.KSKWhatsAppApp || null;
  }

  function friends() {
    return global.KSKSupabaseFriends || null;
  }

  function notifications() {
    return global.KSKSupabaseNotifications || null;
  }

  function root() {
    return $(ROOT);
  }

  function notify(message, type = "info") {
    global.dispatchEvent(new CustomEvent("ksk:toast", {
      detail: { message, type }
    }));
    console.info("[FriendRequestUI]", message);
  }

  function addButton(row, attribute, id, label, className) {
    if (!row || !id) return;

    const existing = row.querySelector(`[${attribute}]`);
    if (existing) {
      existing.dataset.requestId = id;
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.setAttribute(attribute, "");
    button.dataset.requestId = id;
    button.style.flexShrink = "0";
    button.style.marginInlineStart = "8px";

    row.appendChild(button);
  }

  async function syncSentRequests() {
    if (syncRunning) return;

    const page = $( '[data-wa-page-content="contacts"]', root() || document );
    if (!page) return;

    const heading = [...page.querySelectorAll("h3")]
      .find(node => /sent requests/i.test(node.textContent || ""));

    if (!heading) return;

    const section = heading.closest(".wa-section");
    if (!section) return;

    const rows = [...section.querySelectorAll(".wa-list-row")];
    if (!rows.length || rows.every(row => row.querySelector(`[${CANCEL_ATTR}]`))) {
      return;
    }

    syncRunning = true;

    try {
      const api = friends();
      if (!api?.getDashboard) return;

      const response = await api.getDashboard();
      if (!response?.ok) {
        throw new Error(response?.message || "Sent Requests लोड भएन।");
      }

      const outgoing = response.data?.outgoing || [];

      rows.forEach((row, index) => {
        const request = outgoing[index];
        if (!request?.id) return;

        addButton(
          row,
          CANCEL_ATTR,
          request.id,
          "Cancel",
          "wa-button wa-button-quiet"
        );
      });
    } catch (error) {
      console.error("Sent request UI:", error);
    } finally {
      syncRunning = false;
    }
  }

  async function syncNotificationButtons() {
    const page = $( '[data-wa-page-content="notifications"]', root() || document );
    if (!page) return;

    const rows = [...page.querySelectorAll(".wa-list-row")];
    const missing = rows.filter(row =>
      row.querySelector("[data-wa-delete-notification]") &&
      !row.querySelector(`[${OPEN_ATTR}]`)
    );

    if (!missing.length) return;

    missing.forEach(row => {
      const del = row.querySelector("[data-wa-delete-notification]");
      const id = del?.dataset.waDeleteNotification;
      if (!id) return;

      addButton(
        row,
        OPEN_ATTR,
        id,
        "खोल्नुहोस्",
        "wa-button wa-button-quiet"
      );
    });
  }

  async function cancelRequest(button) {
    const id = button.dataset.requestId;
    if (!id || busy.has(id)) return;

    busy.add(id);
    button.disabled = true;
    button.textContent = "रद्द हुँदै…";

    try {
      const api = friends();
      if (!api?.cancelFriendRequest) {
        throw new Error("Cancel Request सेवा उपलब्ध छैन।");
      }

      const response = await api.cancelFriendRequest(id);
      if (!response?.ok) {
        throw new Error(response?.message || "Request रद्द भएन।");
      }

      const application = app();
      if (application?.refresh) {
        await application.refresh();
      }

      notify("Friend Request रद्द भयो।", "success");
    } catch (error) {
      console.error("Cancel request failed:", error);
      button.disabled = false;
      button.textContent = "फेरि प्रयास";
      button.title = error?.message || "रद्द गर्न सकिएन।";
    } finally {
      busy.delete(id);
    }
  }

  async function openNotification(button) {
    const id = button.dataset.requestId;
    if (!id || busy.has(id)) return;

    busy.add(id);
    button.disabled = true;
    button.textContent = "खोल्दै…";

    try {
      const api = notifications();
      const application = app();

      if (!api?.getNotifications || !application) {
        throw new Error("Notification सेवा उपलब्ध छैन।");
      }

      const response = await api.getNotifications({ limit: 100 });
      if (!response?.ok) {
        throw new Error(response?.message || "Notification लोड भएन।");
      }

      const item = (response.data || []).find(
        entry => String(entry.id) === String(id)
      );

      if (!item) {
        throw new Error("Notification भेटिएन।");
      }

      if (!item.read && api.markAsRead) {
        const marked = await api.markAsRead(id);
        if (!marked?.ok) {
          throw new Error(marked?.message || "Notification पढिएको चिन्ह लगाउन सकिएन।");
        }
      }

      if (
        item.entityType === "friend_request" ||
        item.type === "friend_request" ||
        item.type === "friend_accepted"
      ) {
        application.navigate("contacts");
      } else if (
        item.entityType === "conversation" &&
        item.entityId
      ) {
        await application.refresh();
        await application.openChat(item.entityId);
      } else {
        application.navigate("notifications");
      }
    } catch (error) {
      console.error("Open notification failed:", error);
      button.disabled = false;
      button.textContent = "फेरि प्रयास";
      button.title = error?.message || "Notification खोल्न सकिएन।";
    } finally {
      busy.delete(id);
    }
  }

  function bindEvents() {
    document.addEventListener("click", event => {
      const target = event.target instanceof Element
        ? event.target
        : null;

      if (!target) return;

      const cancel = target.closest(`[${CANCEL_ATTR}]`);
      if (cancel) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        cancelRequest(cancel);
        return;
      }

      const open = target.closest(`[${OPEN_ATTR}]`);
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openNotification(open);
      }
    }, true);
  }

  function enhance() {
    syncSentRequests();
    syncNotificationButtons();
  }

  function initialize() {
    const element = root();
    if (!element || observer) return;

    bindEvents();
    enhance();

    observer = new MutationObserver(records => {
      const relevant = records.some(record => {
        const target = record.target instanceof Element
          ? record.target
          : record.target.parentElement;

        return target?.closest(
          '[data-wa-page-content="contacts"],' +
          '[data-wa-page-content="notifications"]'
        );
      });

      if (relevant) enhance();
    });

    observer.observe(element, {
      childList: true,
      subtree: true
    });

    console.info("Mero Sansar Friend Request UI loaded.");
  }

  global.KSKFriendRequestUI = Object.freeze({
    initialize,
    refresh: enhance
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})(window);
