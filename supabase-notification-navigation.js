
"use strict";

/*
 * MERO SANSAR — NOTIFICATION NAVIGATION
 *
 * Responsibilities:
 * - Open the correct conversation from message notifications.
 * - Mark notifications as read when opened.
 * - Route friend-request notifications to Contacts.
 * - Support notifications rendered after realtime updates.
 *
 * Load after app.js and app-navigation.js.
 */

(function (global) {
  if (global.KSKNotificationNavigationLoaded) return;

  const TABLE = "user_notifications";
  const ROOT_SELECTOR = "[data-wa-root]";
  const BUTTON_ATTRIBUTE = "data-ksk-open-notification";

  let observer = null;
  let busy = false;

  function getAuth() {
    return global.KSKSupabaseAuth || null;
  }

  function getApp() {
    return global.KSKWhatsAppApp || null;
  }

  function getNotifications() {
    return global.KSKSupabaseNotifications || null;
  }

  function getRoot() {
    return document.querySelector(ROOT_SELECTOR);
  }

  function getClientAndUser() {
    const auth = getAuth();

    if (!auth) {
      throw new Error("Authentication सेवा उपलब्ध छैन।");
    }

    const client = auth.getClient?.();
    const user = auth.getUser?.();

    if (!client || !user?.id) {
      throw new Error("पहिले आफ्नो खातामा लगइन गर्नुहोस्।");
    }

    return { client, user };
  }

  function findNotificationRow(button) {
    return button.closest(".wa-list-row");
  }

  /*
   * Add an Open button to every notification row.
   * The existing notification UI is preserved.
   */
  function enhanceNotificationRows() {
    const root = getRoot();
    if (!root) return;

    const rows = root.querySelectorAll(
      ".wa-list-row"
    );

    rows.forEach(row => {
      const deleteButton = row.querySelector(
        "[data-wa-delete-notification]"
      );

      if (!deleteButton) return;

      const notificationId =
        deleteButton.dataset.waDeleteNotification;

      if (!notificationId) return;

      const existing = row.querySelector(
        `[${BUTTON_ATTRIBUTE}]`
      );

      if (existing) {
        existing.dataset.notificationId = notificationId;
        return;
      }

      const button = document.createElement("button");

      button.type = "button";
      button.className = "wa-button wa-button-quiet";
      button.textContent = "खोल्नुहोस्";
      button.setAttribute(BUTTON_ATTRIBUTE, "");
      button.dataset.notificationId = notificationId;
      button.setAttribute(
        "aria-label",
        "सम्बन्धित सूचना खोल्नुहोस्"
      );

      button.style.flexShrink = "0";
      button.style.marginInlineStart = "8px";

      row.insertBefore(button, deleteButton);
    });
  }

  async function fetchNotification(notificationId) {
    const { client, user } = getClientAndUser();

    const { data, error } = await client
      .from(TABLE)
      .select(
        "id,recipient_id,actor_id,type,entity_type,entity_id,is_read"
      )
      .eq("id", notificationId)
      .eq("recipient_id", user.id)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      throw new Error(
        "Notification भेटिएन वा तपाईंलाई अनुमति छैन।"
      );
    }

    return data;
  }

  async function markNotificationRead(notificationId) {
    const api = getNotifications();

    if (!api?.markAsRead) {
      throw new Error(
        "Notification सेवा उपलब्ध छैन।"
      );
    }

    const response = await api.markAsRead(notificationId);

    if (!response?.ok) {
      throw new Error(
        response?.message ||
        "Notification पढिएको रूपमा सुरक्षित गर्न सकिएन।"
      );
    }

    return response;
  }

  async function openConversation(conversationId) {
    const app = getApp();

    if (!app?.refresh || !app?.openChat) {
      throw new Error(
        "Chat सेवा अझै सुरु भएको छैन।"
      );
    }

    /*
     * Refresh conversations first so a newly received
     * conversation is available to openChat().
     */
    await app.refresh();

    const opened = await app.openChat(conversationId);

    if (opened === false) {
      throw new Error(
        "सम्बन्धित Chat खोल्न सकिएन।"
      );
    }

    return true;
  }

  async function routeNotification(notification) {
    const entityType = String(
      notification.entity_type || ""
    ).toLowerCase();

    const type = String(
      notification.type || ""
    ).toLowerCase();

    if (
      entityType === "conversation" &&
      notification.entity_id
    ) {
      await openConversation(notification.entity_id);
      return "conversation";
    }

    if (
      entityType === "friend_request" ||
      type === "friend_request" ||
      type === "friend_accepted"
    ) {
      const app = getApp();

      if (!app?.navigate) {
        throw new Error(
          "Contacts पेज उपलब्ध छैन।"
        );
      }

      app.navigate("contacts");
      return "contacts";
    }

    /*
     * Other notification types are marked read,
     * but are not sent to an unrelated page.
     */
    return "read";
  }

  function setButtonState(button, text, disabled) {
    if (!button) return;

    button.textContent = text;
    button.disabled = Boolean(disabled);
    button.setAttribute(
      "aria-busy",
      disabled ? "true" : "false"
    );
  }

  async function handleOpen(button) {
    if (busy || !button) return;

    const notificationId =
      button.dataset.notificationId;

    if (!notificationId) return;

    busy = true;
    setButtonState(button, "खोल्दै…", true);

    try {
      /*
       * Fetch using the current authenticated user's
       * recipient_id. Never trust DOM notification data.
       */
      const notification =
        await fetchNotification(notificationId);

      await markNotificationRead(notificationId);

      await routeNotification(notification);

      setButtonState(button, "खोलियो", true);

    } catch (error) {
      console.error(
        "Notification navigation:",
        error
      );

      setButtonState(button, "फेरि प्रयास", false);

      button.title =
        error?.message ||
        "Notification खोल्न सकिएन।";

    } finally {
      busy = false;
    }
  }

  function bindClick() {
    document.addEventListener(
      "click",
      event => {
        const button = event.target.closest(
          `button[${BUTTON_ATTRIBUTE}]`
        );

        if (!button) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        handleOpen(button);
      },
      true
    );
  }

  function startObserver() {
    const root = getRoot();

    if (!root || observer) return;

    enhanceNotificationRows();

    observer = new MutationObserver(() => {
      enhanceNotificationRows();
    });

    observer.observe(root, {
      childList: true,
      subtree: true
    });
  }

  function initialize() {
    if (global.KSKNotificationNavigationLoaded) {
      return;
    }

    bindClick();
    startObserver();

    /*
     * App may render its root after this script executes.
     * Observe document body until the app root exists.
     */
    if (!observer) {
      const bodyObserver = new MutationObserver(() => {
        if (getRoot()) {
          startObserver();

          if (observer) {
            bodyObserver.disconnect();
          }
        }
      });

      if (document.body) {
        bodyObserver.observe(document.body, {
          childList: true,
          subtree: true
        });
      }
    }

    global.KSKNotificationNavigationLoaded = true;

    console.info(
      "Mero Sansar Notification Navigation loaded."
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
