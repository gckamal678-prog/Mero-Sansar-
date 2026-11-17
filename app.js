/* =========================================================
   KSK WHATSAPP — COMPLETE APPLICATION
   File: whatsapp/app.js

   WhatsApp-style application powered by existing Supabase
   services and database schema.

   Includes:
   - Authentication
   - Chats and unread filtering
   - Direct messages and groups
   - Realtime messages, receipts and typing
   - Message pagination, reply, edit and delete
   - Chat preferences
   - Group member management
   - Contacts and friend requests
   - Updates feed (posts table)
   - Profile and notifications
   - Search and media attachments

   Excluded:
   - Audio calls
   - Video calls
   - Voice recording
   ========================================================= */

(function (global) {
  "use strict";

  if (global.KSKWhatsAppApp) return;

  const API = {
    auth: () => global.KSKSupabaseAuth,
    profile: () => global.KSKSupabaseProfile,
    friends: () => global.KSKSupabaseFriends,
    messages: () => global.KSKSupabaseMessages,
    posts: () => global.KSKSupabasePosts,
    notifications: () => global.KSKSupabaseNotifications
  };

  const state = {
    initialized: false,
    initializing: false,
    authenticated: false,

    user: null,
    profile: null,

    page: "chats",
    activeChat: null,
    messages: [],

    conversations: [],

    friends: {
      userId: "",
      incoming: [],
      outgoing: [],
      friends: [],
      followers: [],
      following: [],
      blocked: []
    },

    posts: [],
    notifications: [],

    chatFilter: "all",
    chatSearch: "",
    contactSearch: "",
    contactResults: [],
    messageSearch: "",

    replyTo: null,
    loadingOlder: false,
    hasOlderMessages: true,

    typingUsers: new Set(),
    presenceUsers: [],

    realtime: {
      messages: false,
      notifications: false,
      online: navigator.onLine
    },

    requestVersion: 0,
    chatRequestVersion: 0,

    toastTimer: null,
    typingTimer: null
  };

  let root = null;
  let startupPromise = null;
  let eventsBound = false;
  let realtimeEventsBound = false;

  const PAGE_NAMES = [
    "chats",
    "updates",
    "groups",
    "contacts",
    "profile",
    "notifications",
    "chat-detail"
  ];

  /* =====================================================
     UTILITIES
  ===================================================== */

  function service(name) {
    const api = API[name]?.();

    if (!api) {
      throw new Error(
        "Supabase सेवा उपलब्ध छैन: " + name
      );
    }

    return api;
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);
  }

  function safeURL(value) {
    try {
      const url = new URL(
        String(value || ""),
        global.location.href
      );

      if (
        url.protocol === "https:" ||
        url.protocol === "http:"
      ) {
        return url.href;
      }
    } catch (_) {}

    return "";
  }

  function initials(name) {
    return String(name || "W")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(word => word.charAt(0))
      .join("")
      .toUpperCase();
  }

  function formatTime(value) {
    if (!value) return "";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return "";

    return new Intl.DateTimeFormat("ne-IN", {
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function formatDate(value) {
    if (!value) return "";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return "";

    const now = new Date();

    if (date.toDateString() === now.toDateString()) {
      return formatTime(value);
    }

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === yesterday.toDateString()) {
      return "हिजो";
    }

    return new Intl.DateTimeFormat("ne-IN", {
      day: "numeric",
      month: "short"
    }).format(date);
  }

  function currentUserId() {
    return state.user?.id || "";
  }

  function resultData(response, fallback = []) {
    if (!response?.ok) {
      throw new Error(
        response?.message ||
        response?.error ||
        "अनुरोध पूरा हुन सकेन।"
      );
    }

    return response.data ?? fallback;
  }

  function findConversation(id) {
    return state.conversations.find(
      item => String(item.id) === String(id)
    );
  }

  function findMessage(id) {
    return state.messages.find(
      item => String(item.id) === String(id)
    );
  }

  function avatarHTML(name, image, size = "") {
    const url = safeURL(image);
    const className = size ? " " + size : "";

    if (url) {
      return `
        <span class="wa-avatar${className}">
          <img
            src="${escapeHTML(url)}"
            alt="${escapeHTML(name || "प्रयोगकर्ता")}"
            loading="lazy"
            referrerpolicy="no-referrer"
          >
        </span>
      `;
    }

    return `
      <span class="wa-avatar${className}">
        ${escapeHTML(initials(name))}
      </span>
    `;
  }

  function emptyState(title, description, icon = "○") {
    return `
      <div class="wa-empty">
        <div class="wa-empty-icon">${escapeHTML(icon)}</div>
        <h3 class="wa-empty-title">${escapeHTML(title)}</h3>
        <p class="wa-empty-text">${escapeHTML(description)}</p>
      </div>
    `;
  }

  function showToast(message, type = "info") {
    const element = root?.querySelector("[data-wa-toast]");

    if (!element) return;

    element.textContent = String(message || "");
    element.dataset.type = type;
    element.hidden = !message;

    if (state.toastTimer) {
      global.clearTimeout(state.toastTimer);
    }

    state.toastTimer = global.setTimeout(() => {
      element.hidden = true;
    }, 3200);
  }

  function setButtonLoading(button, loading, label) {
    if (!button) return;

    if (loading) {
      button.dataset.originalText = button.textContent;
      button.disabled = true;

      if (label) button.textContent = label;
    } else {
      button.disabled = false;

      if (button.dataset.originalText) {
        button.textContent = button.dataset.originalText;
        delete button.dataset.originalText;
      }
    }
  }

  function closeDialog() {
    const element = root?.querySelector(
      "[data-wa-dialog-root]"
    );

    if (element) element.innerHTML = "";
  }

  function showDialog(title, content) {
    const container = root?.querySelector(
      "[data-wa-dialog-root]"
    );

    if (!container) return;

    container.innerHTML = `
      <div
        class="wa-dialog-backdrop"
        data-wa-close-dialog
      >
        <section
          class="wa-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="${escapeHTML(title)}"
        >
          <header class="wa-dialog-header">
            <h2 class="wa-dialog-title">
              ${escapeHTML(title)}
            </h2>

            <button
              class="wa-icon-button"
              type="button"
              data-wa-action="close-dialog"
              aria-label="बन्द गर्नुहोस्"
            >×</button>
          </header>

          <div class="wa-dialog-body">
            ${content}
          </div>
        </section>
      </div>
    `;
  }

  function showError(error, fallback = "काम पूरा हुन सकेन।") {
    console.error(error);

    showToast(
      error?.message || fallback,
      "error"
    );
  }

  /* =====================================================
     ROOT AND SHELL
  ===================================================== */

  function getRoot() {
    let element =
      document.querySelector("[data-wa-root]") ||
      document.getElementById("waApp");

    if (!element) {
      element = document.createElement("div");
      element.id = "waApp";
      element.dataset.waRoot = "true";
      document.body.appendChild(element);
    }

    element.classList.add("wa-app");

    return element;
  }

  function renderShell() {
    root.innerHTML = `
      <div class="wa-shell">

        <header class="wa-header">
          <div class="wa-brand">
            <div class="wa-brand-mark" aria-hidden="true">
              <span>💬</span>
            </div>

            <div class="wa-brand-copy">
              <h1 class="wa-brand-title">WhatsApp</h1>
              <p class="wa-brand-subtitle">
                निजी कुराकानी
              </p>
            </div>
          </div>

          <div class="wa-header-actions">
            <button
              class="wa-icon-button"
              type="button"
              data-wa-action="global-search"
              aria-label="खोज्नुहोस्"
            >⌕</button>

            <button
              class="wa-icon-button"
              type="button"
              data-wa-action="notifications"
              aria-label="सूचनाहरू"
            >
              ♧
              <span data-wa-notification-count hidden></span>
            </button>

            <button
              class="wa-icon-button"
              type="button"
              data-wa-action="profile"
              aria-label="Settings"
            >⋮</button>
          </div>
        </header>

        <nav class="wa-tabs" aria-label="मुख्य पृष्ठ">
          <button
            class="wa-tab is-active"
            type="button"
            data-wa-page="chats"
            aria-selected="true"
          >
            <span class="wa-tab-icon">💬</span>
            Chats
          </button>

          <button
            class="wa-tab"
            type="button"
            data-wa-page="updates"
            aria-selected="false"
          >
            <span class="wa-tab-icon">◉</span>
            Updates
          </button>

          <button
            class="wa-tab"
            type="button"
            data-wa-page="groups"
            aria-selected="false"
          >
            <span class="wa-tab-icon">👥</span>
            Groups
          </button>
        </nav>

        <main class="wa-content" id="waMain">

          <section
            class="wa-page is-active"
            data-wa-page-content="chats"
          ></section>

          <section
            class="wa-page"
            data-wa-page-content="updates"
            hidden
          ></section>

          <section
            class="wa-page"
            data-wa-page-content="groups"
            hidden
          ></section>

          <section
            class="wa-page"
            data-wa-page-content="contacts"
            hidden
          ></section>

          <section
            class="wa-page"
            data-wa-page-content="profile"
            hidden
          ></section>

          <section
            class="wa-page"
            data-wa-page-content="notifications"
            hidden
          ></section>

          <section
            class="wa-page"
            data-wa-page-content="chat-detail"
            hidden
          ></section>

        </main>

        <nav class="wa-bottom-nav" aria-label="Navigation">
          <div class="wa-bottom-inner">

            <button
              class="wa-nav-item is-active"
              type="button"
              data-wa-page="chats"
              aria-current="page"
            >
              <span class="wa-nav-icon">💬</span>
              <span>Chats</span>
            </button>

            <button
              class="wa-nav-item"
              type="button"
              data-wa-page="updates"
            >
              <span class="wa-nav-icon">◉</span>
              <span>Updates</span>
            </button>

            <button
              class="wa-nav-item"
              type="button"
              data-wa-page="groups"
            >
              <span class="wa-nav-icon">👥</span>
              <span>Groups</span>
            </button>

            <button
              class="wa-nav-item"
              type="button"
              data-wa-page="profile"
            >
              <span class="wa-nav-icon">⚙</span>
              <span>Settings</span>
            </button>

          </div>
        </nav>

      </div>

      <div
        class="wa-toast"
        data-wa-toast
        role="status"
        aria-live="polite"
        hidden
      ></div>

      <div data-wa-dialog-root></div>
    `;

    bindEvents();
  }

  /* =====================================================
     AUTHENTICATION
  ===================================================== */

  function renderAuthScreen(message = "") {
    root.innerHTML = `
      <div class="wa-shell">
        <section
          class="wa-empty"
          style="min-height:100dvh;padding:24px"
        >
          <div class="wa-empty-icon">💬</div>

          <h1 class="wa-page-title">WhatsApp</h1>

          <p class="wa-empty-text">
            आफ्नो खातामा प्रवेश गरेर कुराकानी सुरु गर्नुहोस्।
          </p>

          <form
            class="wa-card"
            data-wa-auth-form
            style="
              width:min(100%,390px);
              padding:20px;
              margin-top:20px;
              text-align:left
            "
          >
            <label class="wa-section-title" for="waEmail">
              इमेल ठेगाना
            </label>

            <input
              id="waEmail"
              name="email"
              type="email"
              autocomplete="email"
              required
              maxlength="254"
              style="
                width:100%;
                padding:12px;
                border:1px solid var(--wa-border);
                border-radius:10px;
                background:var(--wa-surface);
                color:var(--wa-text);
                margin:8px 0 16px
              "
            >

            <label class="wa-section-title" for="waPassword">
              पासवर्ड
            </label>

            <input
              id="waPassword"
              name="password"
              type="password"
              autocomplete="current-password"
              required
              minlength="8"
              style="
                width:100%;
                padding:12px;
                border:1px solid var(--wa-border);
                border-radius:10px;
                background:var(--wa-surface);
                color:var(--wa-text);
                margin:8px 0 16px
              "
            >

            <p
              data-wa-auth-message
              style="color:var(--wa-danger);font-size:12px"
            >${escapeHTML(message)}</p>

            <button
              class="wa-button wa-button-primary"
              type="submit"
              style="width:100%"
            >
              Login
            </button>

            <button
              class="wa-button wa-button-quiet"
              type="button"
              data-wa-action="signup"
              style="width:100%;margin-top:10px"
            >
              नयाँ खाता बनाउनुहोस्
            </button>

            <button
              class="wa-button wa-button-quiet"
              type="button"
              data-wa-action="forgot-password"
              style="width:100%;margin-top:6px"
            >
              पासवर्ड बिर्सनुभयो?
            </button>
          </form>
        </section>
      </div>
    `;

    bindEvents();
  }

  async function handleAuthSubmit(form) {
    const data = new FormData(form);

    const email = String(data.get("email") || "")
      .trim()
      .toLowerCase();

    const password = String(data.get("password") || "");

    const button = form.querySelector(
      'button[type="submit"]'
    );

    const status = form.querySelector(
      "[data-wa-auth-message]"
    );

    if (!email || !password) return;

    setButtonLoading(button, true, "प्रवेश गर्दै...");
    status.textContent = "प्रवेश गर्दै...";

    try {
      await service("auth").signIn(email, password);

      state.user = service("auth").getUser();
      state.authenticated = service("auth").isAuthenticated();

      if (!state.authenticated) {
        throw new Error("Login सफल भएन।");
      }

      await startApplication();

    } catch (error) {
      status.textContent =
        error?.message || "Login गर्न सकिएन।";

      setButtonLoading(button, false);
    }
  }

  async function handleSignup() {
    const email = root.querySelector("#waEmail")?.value.trim();
    const password = root.querySelector("#waPassword")?.value;

    if (!email || !password) {
      showToast("इमेल र पासवर्ड भर्नुहोस्।", "error");
      return;
    }

    try {
      const response = await service("auth")
        .signUp(email, password);

      if (response?.confirmationRequired) {
        showToast(
          "इमेलमा आएको Confirmation Link खोल्नुहोस्।",
          "success"
        );
        return;
      }

      await startApplication();

    } catch (error) {
      showError(error, "खाता बनाउन सकिएन।");
    }
  }

  async function handleForgotPassword() {
    const email = root.querySelector("#waEmail")?.value.trim();

    if (!email) {
      showToast("पहिले इमेल लेख्नुहोस्।", "error");
      return;
    }

    try {
      await service("auth").resetPassword(email);

      showToast(
        "Password reset इमेल पठाइयो।",
        "success"
      );
    } catch (error) {
      showError(error, "अनुरोध पूरा भएन।");
    }
  }

  /* =====================================================
     DASHBOARD DATA
  ===================================================== */

  async function loadDashboard() {
    if (!state.authenticated) return false;

    const version = ++state.requestVersion;

    const jobs = await Promise.allSettled([
      service("messages").getConversations(),
      service("friends").getDashboard(),
      service("posts").getFeed({ limit: 40 }),
      service("notifications").getNotifications({ limit: 80 }),
      service("profile").getMyProfile()
    ]);

    if (version !== state.requestVersion) return false;

    const [
      conversations,
      friends,
      posts,
      notifications,
      profile
    ] = jobs;

    const failures = [];

    if (
      conversations.status === "fulfilled" &&
      conversations.value?.ok
    ) {
      state.conversations = conversations.value.data || [];
    } else {
      failures.push("Chats");
    }

    if (
      friends.status === "fulfilled" &&
      friends.value?.ok
    ) {
      state.friends = friends.value.data || state.friends;
    } else {
      failures.push("Contacts");
    }

    if (
      posts.status === "fulfilled" &&
      posts.value?.ok
    ) {
      state.posts = posts.value.data || [];
    } else {
      failures.push("Updates");
    }

    if (
      notifications.status === "fulfilled" &&
      notifications.value?.ok
    ) {
      state.notifications = notifications.value.data || [];
    } else {
      failures.push("Notifications");
    }

    if (profile.status === "fulfilled") {
      state.profile = profile.value || null;
    } else {
      failures.push("Profile");
    }

    updateNotificationCount();
    renderCurrentPage();

    if (failures.length) {
      showToast(
        "केही सेवा लोड भएनन्: " + failures.join(", "),
        "error"
      );
    }

    return true;
  }

  async function refreshConversations() {
    const response = await service("messages")
      .getConversations();

    state.conversations = resultData(response);

    if (state.page === "chats") renderChats();
    if (state.page === "groups") renderGroups();

    if (state.activeChat) {
      const updated = findConversation(state.activeChat.id);

      if (updated) {
        state.activeChat = updated;
      }
    }

    return state.conversations;
  }

  async function refreshFriends() {
    const response = await service("friends")
      .getDashboard();

    state.friends = resultData(response, state.friends);

    if (state.page === "contacts") renderContacts();

    return state.friends;
  }

  async function refreshUpdates() {
    const response = await service("posts")
      .getFeed({ limit: 40 });

    state.posts = resultData(response);

    if (state.page === "updates") renderUpdates();

    return state.posts;
  }

  async function refreshNotifications() {
    const response = await service("notifications")
      .getNotifications({ limit: 80 });

    state.notifications = resultData(response);

    updateNotificationCount();

    if (state.page === "notifications") {
      renderNotifications();
    }

    return state.notifications;
  }

  /* =====================================================
     NAVIGATION
  ===================================================== */

  function navigate(page) {
    if (!PAGE_NAMES.includes(page) || page === "chat-detail") {
      return false;
    }

    if (state.activeChat) {
      service("messages").stopPresence?.();
    }

    state.page = page;
    state.activeChat = null;
    state.messages = [];
    state.replyTo = null;

    root.querySelectorAll("[data-wa-page-content]")
      .forEach(section => {
        const active =
          section.dataset.waPageContent === page;

        section.classList.toggle("is-active", active);
        section.hidden = !active;
      });

    root.querySelectorAll("[data-wa-page]")
      .forEach(button => {
        const active = button.dataset.waPage === page;

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

    renderCurrentPage();

    return true;
  }

  function renderCurrentPage() {
    if (!root || !state.authenticated) return;

    switch (state.page) {
      case "chats":
        renderChats();
        break;

      case "updates":
        renderUpdates();
        break;

      case "groups":
        renderGroups();
        break;

      case "contacts":
        renderContacts();
        break;

      case "profile":
        renderProfile();
        break;

      case "notifications":
        renderNotifications();
        break;
    }
  }

  /* =====================================================
     CHAT LIST
  ===================================================== */

  function isUnread(conversation) {
    const latest = conversation.lastMessage;

    if (!latest || latest.senderId === currentUserId()) {
      return false;
    }

    if (!conversation.lastReadAt) return true;

    return new Date(latest.createdAt).getTime() >
      new Date(conversation.lastReadAt).getTime();
  }

  function renderChats() {
    const page = root.querySelector(
      '[data-wa-page-content="chats"]'
    );

    if (!page) return;

    const term = state.chatSearch.toLowerCase();

    let conversations = [...state.conversations];

    if (state.chatFilter === "groups") {
      conversations = conversations.filter(
        item => item.type === "group"
      );
    } else if (state.chatFilter === "unread") {
      conversations = conversations.filter(isUnread);
    } else if (state.chatFilter === "pinned") {
      conversations = conversations.filter(
        item => item.isPinned
      );
    } else if (state.chatFilter === "archived") {
      conversations = conversations.filter(
        item => item.isArchived
      );
    } else {
      conversations = conversations.filter(
        item => !item.isArchived
      );
    }

    if (term) {
      conversations = conversations.filter(item => {
        const name = String(item.name || "").toLowerCase();
        const preview = String(
          item.lastMessage?.content || ""
        ).toLowerCase();

        return name.includes(term) || preview.includes(term);
      });
    }

    conversations.sort((a, b) => {
      if (a.isPinned !== b.isPinned) {
        return a.isPinned ? -1 : 1;
      }

      return new Date(b.lastMessageAt || b.createdAt || 0) -
        new Date(a.lastMessageAt || a.createdAt || 0);
    });

    const unreadCount = state.conversations.filter(isUnread).length;

    page.innerHTML = `
      <div class="wa-page-heading">
        <div>
          <h2 class="wa-page-title">Chats</h2>
          <p class="wa-page-description">
            ${state.conversations.length} कुराकानी
            ${unreadCount ? ` · ${unreadCount} नपढिएका` : ""}
          </p>
        </div>

        <button
          class="wa-icon-button"
          type="button"
          data-wa-action="new-chat"
          aria-label="नयाँ च्याट"
        >＋</button>
      </div>

      <label class="wa-search">
        <span>⌕</span>
        <input
          type="search"
          placeholder="Search or start a new chat"
          data-wa-chat-search
          value="${escapeHTML(state.chatSearch)}"
          autocomplete="off"
        >
      </label>

      <div
        style="
          display:flex;
          gap:7px;
          overflow-x:auto;
          padding:0 14px 12px
        "
      >
        ${chatFilterButton("all", "All")}
        ${chatFilterButton("unread", "Unread")}
        ${chatFilterButton("pinned", "Pinned")}
        ${chatFilterButton("groups", "Groups")}
        ${chatFilterButton("archived", "Archived")}
      </div>

      <div class="wa-list" data-wa-chat-list>
        ${
          conversations.length
            ? conversations.map(renderConversation).join("")
            : emptyState(
                state.chatFilter === "unread"
                  ? "नपढिएको सन्देश छैन"
                  : "कुराकानी भेटिएन",
                "नयाँ च्याट सुरु गर्न + थिच्नुहोस्।",
                "💬"
              )
        }
      </div>
    `;
  }

  function chatFilterButton(value, label) {
    const active = state.chatFilter === value;

    return `
      <button
        class="wa-button ${
          active ? "wa-button-primary" : "wa-button-quiet"
        }"
        type="button"
        data-wa-chat-filter="${value}"
        style="
          white-space:nowrap;
          min-height:34px;
          padding:6px 13px
        "
      >
        ${label}
      </button>
    `;
  }

  function renderConversation(item) {
    const name = item.name || item.title || "कुराकानी";
    const latest = item.lastMessage || {};

    let preview = latest.content ||
      (latest.deletedForEveryone
        ? "यो सन्देश मेटाइएको छ।"
        : "नयाँ कुराकानी");

    if (latest.type && latest.type !== "text") {
      preview = latest.type === "image"
        ? "📷 Photo"
        : latest.type === "video"
          ? "🎬 Video"
          : "📎 Attachment";
    }

    const unread = isUnread(item);

    return `
      <div class="wa-list-row">
        <button
          type="button"
          data-wa-open-chat="${escapeHTML(item.id)}"
          style="
            display:flex;
            align-items:center;
            gap:12px;
            flex:1;
            min-width:0;
            padding:0;
            border:0;
            background:transparent;
            color:inherit;
            text-align:left;
            cursor:pointer
          "
        >
          ${avatarHTML(name, item.avatar)}

          <span class="wa-row-main">
            <span class="wa-row-top">
              <span class="wa-row-title">
                ${escapeHTML(name)}
                ${item.isPinned ? " 📌" : ""}
              </span>

              <span class="wa-row-meta">
                ${escapeHTML(formatDate(item.lastMessageAt))}
              </span>
            </span>

            <span class="wa-row-preview">
              ${item.type === "group" ? "👥 " : ""}
              ${escapeHTML(preview)}
            </span>
          </span>
        </button>

        <div
          style="
            display:flex;
            flex-direction:column;
            align-items:center;
            gap:4px
          "
        >
          ${
            unread
              ? `
                <span
                  style="
                    width:9px;
                    height:9px;
                    border-radius:50%;
                    background:var(--wa-accent)
                  "
                ></span>
              `
              : ""
          }

          <button
            class="wa-icon-button"
            type="button"
            data-wa-chat-menu="${escapeHTML(item.id)}"
            aria-label="च्याट विकल्प"
            style="width:34px;height:34px;flex-basis:34px"
          >⋮</button>
        </div>
      </div>
    `;
  }

  function showChatMenu(conversationId) {
    const conversation = findConversation(conversationId);

    if (!conversation) return;

    showDialog(
      conversation.name || "Chat options",
      `
        <div style="display:grid;gap:10px">

          <button
            class="wa-button wa-button-quiet"
            data-wa-chat-preference="pin"
            data-wa-chat-id="${escapeHTML(conversationId)}"
            type="button"
          >
            ${conversation.isPinned ? "Unpin chat" : "Pin chat"}
          </button>

          <button
            class="wa-button wa-button-quiet"
            data-wa-chat-preference="archive"
            data-wa-chat-id="${escapeHTML(conversationId)}"
            type="button"
          >
            ${conversation.isArchived ? "Unarchive chat" : "Archive chat"}
          </button>

          <button
            class="wa-button wa-button-quiet"
            data-wa-chat-preference="mute"
            data-wa-chat-id="${escapeHTML(conversationId)}"
            type="button"
          >
            ${conversation.isMuted ? "Unmute notifications" : "Mute notifications"}
          </button>

          <button
            class="wa-button wa-button-quiet"
            data-wa-open-chat="${escapeHTML(conversationId)}"
            type="button"
          >
            Open chat
          </button>

        </div>
      `
    );
  }

  async function updateChatPreference(conversationId, action) {
    const conversation = findConversation(conversationId);

    if (!conversation) return;

    const changes = {};

    if (action === "pin") {
      changes.is_pinned = !conversation.isPinned;
    } else if (action === "archive") {
      changes.is_archived = !conversation.isArchived;
    } else if (action === "mute") {
      changes.is_muted = !conversation.isMuted;
    } else {
      return;
    }

    const response = await service("messages")
      .updateChatPreferences(conversationId, changes);

    resultData(response, null);

    await refreshConversations();

    closeDialog();

    showToast("Chat preference सुरक्षित भयो।", "success");
  }

  /* =====================================================
     NEW CHAT AND CONTACT SEARCH
  ===================================================== */

  function openNewChat() {
    state.contactSearch = "";
    state.contactResults = [];

    showDialog(
      "New chat",
      `
        <form data-wa-contact-search-form>
          <label class="wa-search" style="margin:0 0 14px">
            <span>⌕</span>
            <input
              type="search"
              name="query"
              placeholder="नाम खोज्नुहोस्"
              minlength="2"
              required
              autocomplete="off"
            >
          </label>

          <button
            class="wa-button wa-button-primary"
            type="submit"
            style="width:100%"
          >
            Search people
          </button>
        </form>

        <div style="margin-top:16px">
          <button
            class="wa-list-row"
            type="button"
            data-wa-action="create-group"
          >
            <span class="wa-avatar">👥</span>
            <span class="wa-row-main">
              <strong>New group</strong>
              <span class="wa-row-preview">
                साथीहरू जोडेर समूह बनाउनुहोस्
              </span>
            </span>
          </button>
        </div>

        <div data-wa-contact-results>
          ${renderFriendSearchResults()}
        </div>
      `
    );
  }

  function renderFriendSearchResults() {
    const results = state.contactResults || [];

    if (!results.length) {
      return emptyState(
        "मानिस खोज्नुहोस्",
        "नाम लेखेर साथी खोज्न सक्नुहुन्छ।",
        "👤"
      );
    }

    const friendIds = new Set(
      (state.friends.friends || []).map(item => item.id)
    );

    const outgoingIds = new Set(
      (state.friends.outgoing || []).map(item => item.person?.id)
    );

    return `
      <div class="wa-list" style="margin-top:12px">
        ${results.map(person => `
          <div class="wa-list-row">
            ${avatarHTML(person.name, person.avatarUrl)}

            <span class="wa-row-main">
              <span class="wa-row-title">
                ${escapeHTML(person.name)}
              </span>
            </span>

            ${
              friendIds.has(person.id)
                ? `
                  <button
                    class="wa-button wa-button-primary"
                    type="button"
                    data-wa-open-friend-chat="${escapeHTML(person.id)}"
                  >Message</button>
                `
                : outgoingIds.has(person.id)
                  ? `<span class="wa-row-preview">Pending</span>`
                  : `
                    <button
                      class="wa-button wa-button-primary"
                      type="button"
                      data-wa-add-friend="${escapeHTML(person.id)}"
                    >Add</button>
                  `
            }
          </div>
        `).join("")}
      </div>
    `;
  }

  async function searchUsers(query) {
    const term = String(query || "").trim();

    if (term.length < 2) {
      throw new Error("कम्तीमा दुई अक्षर लेख्नुहोस्।");
    }

    const response = await service("friends")
      .searchUsers(term, { limit: 20 });

    state.contactResults = resultData(response);

    const container = root.querySelector(
      "[data-wa-contact-results]"
    );

    if (container) {
      container.innerHTML = renderFriendSearchResults();
    }

    const pageContainer = root.querySelector(
      "[data-wa-contact-page-results]"
    );

    if (pageContainer) {
      pageContainer.innerHTML = renderFriendSearchResults();
    }
  }

  async function sendFriendRequest(userId) {
    const response = await service("friends")
      .sendFriendRequest(userId);

    resultData(response, null);

    state.contactResults = [];

    await refreshFriends();

    showToast("Friend Request पठाइयो।", "success");

    if (state.page === "contacts") renderContacts();

    const container = root.querySelector(
      "[data-wa-contact-results]"
    );

    if (container) {
      container.innerHTML = renderFriendSearchResults();
    }
  }

  async function openFriendChat(friendId) {
    const response = await service("messages")
      .createDirectChat(friendId);

    const conversationId = resultData(response, null);

    await refreshConversations();

    closeDialog();

    if (conversationId) {
      await openChat(conversationId);
    }
  }

  /* =====================================================
     GROUPS
  ===================================================== */

  function renderGroups() {
    const page = root.querySelector(
      '[data-wa-page-content="groups"]'
    );

    if (!page) return;

    const groups = state.conversations.filter(
      item => item.type === "group"
    );

    page.innerHTML = `
      <div class="wa-page-heading">
        <div>
          <h2 class="wa-page-title">Groups</h2>
          <p class="wa-page-description">
            तपाईं सदस्य भएको समूह कुराकानी
          </p>
        </div>

        <button
          class="wa-icon-button"
          type="button"
          data-wa-action="create-group"
          aria-label="नयाँ समूह"
        >＋</button>
      </div>

      <div class="wa-list">
        ${
          groups.length
            ? groups.map(renderConversation).join("")
            : emptyState(
                "समूह छैन",
                "साथीहरूसँग नयाँ समूह बनाउनुहोस्।",
                "👥"
              )
        }
      </div>
    `;
  }

  function renderCreateGroupDialog() {
    const friends = state.friends.friends || [];

    showDialog(
      "New group",
      `
        <form data-wa-create-group>

          <label class="wa-section-title" for="waGroupName">
            Group name
          </label>

          <input
            id="waGroupName"
            name="title"
            type="text"
            maxlength="60"
            required
            placeholder="समूहको नाम"
            style="
              width:100%;
              padding:12px;
              border:1px solid var(--wa-border);
              border-radius:10px;
              background:var(--wa-surface);
              color:var(--wa-text);
              margin-bottom:16px
            "
          >

          <h3 class="wa-section-title">
            साथी छान्नुहोस्
          </h3>

          ${
            friends.length
              ? friends.map(person => `
                <label
                  class="wa-list-row"
                  style="cursor:pointer"
                >
                  <input
                    type="checkbox"
                    name="members"
                    value="${escapeHTML(person.id)}"
                  >

                  ${avatarHTML(person.name, person.avatarUrl)}

                  <span class="wa-row-main">
                    ${escapeHTML(person.name)}
                  </span>
                </label>
              `).join("")
              : emptyState(
                  "साथी छैनन्",
                  "पहिले साथी जोड्नुहोस्।",
                  "👤"
                )
          }

          <button
            class="wa-button wa-button-primary"
            type="submit"
            style="width:100%;margin-top:16px"
            ${friends.length < 2 ? "disabled" : ""}
          >
            Create group
          </button>

        </form>
      `
    );
  }

  async function createGroup(form) {
    const data = new FormData(form);

    const title = String(data.get("title") || "").trim();
    const members = data.getAll("members").map(String);

    if (members.length < 2) {
      throw new Error("कम्तीमा दुई जना साथी छान्नुहोस्।");
    }

    const response = await service("messages")
      .createGroup(members, title);

    const conversationId = resultData(response, null);

    await refreshConversations();

    closeDialog();

    showToast("समूह बनाइयो।", "success");

    if (conversationId) {
      await openChat(conversationId);
    }
  }

  function openGroupInfo(conversation) {
    const members = conversation.members || [];
    const isAdmin = conversation.role === "admin";

    const friends = state.friends.friends || [];

    const existing = new Set(
      members.map(member => member.id)
    );

    const available = friends.filter(
      person => !existing.has(person.id)
    );

    showDialog(
      conversation.name || "Group info",
      `
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
          ${avatarHTML(conversation.name, conversation.avatar, "is-large")}

          <div>
            <strong>${escapeHTML(conversation.name)}</strong>
            <p class="wa-row-preview">
              ${members.length} members
            </p>
          </div>
        </div>

        <h3 class="wa-section-title">Members</h3>

        <div class="wa-list">
          ${members.map(member => `
            <div class="wa-list-row">
              ${avatarHTML(member.name, member.avatar, "is-small")}

              <span class="wa-row-main">
                <strong>${escapeHTML(member.name)}</strong>
                <span class="wa-row-preview">
                  ${escapeHTML(member.role || "member")}
                  ${member.id === currentUserId() ? " · You" : ""}
                </span>
              </span>

              ${
                isAdmin &&
                member.id !== currentUserId()
                  ? `
                    <button
                      class="wa-icon-button"
                      type="button"
                      data-wa-group-remove="${escapeHTML(member.id)}"
                      data-wa-group-id="${escapeHTML(conversation.id)}"
                      aria-label="Remove member"
                    >×</button>
                  `
                  : ""
              }
            </div>
          `).join("")}
        </div>

        ${
          isAdmin && available.length
            ? `
              <form data-wa-group-add style="margin-top:16px">
                <input
                  type="hidden"
                  name="conversationId"
                  value="${escapeHTML(conversation.id)}"
                >

                <label class="wa-section-title">
                  Add friend
                </label>

                <select
                  name="memberId"
                  required
                  style="
                    width:100%;
                    padding:12px;
                    border:1px solid var(--wa-border);
                    border-radius:10px;
                    background:var(--wa-surface);
                    color:var(--wa-text)
                  "
                >
                  <option value="">साथी छान्नुहोस्</option>
                  ${available.map(person => `
                    <option value="${escapeHTML(person.id)}">
                      ${escapeHTML(person.name)}
                    </option>
                  `).join("")}
                </select>

                <button
                  class="wa-button wa-button-primary"
                  type="submit"
                  style="width:100%;margin-top:10px"
                >
                  Add member
                </button>
              </form>
            `
            : ""
        }
      `
    );
  }

  async function addGroupMember(form) {
    const data = new FormData(form);

    const conversationId = String(
      data.get("conversationId") || ""
    );

    const memberId = String(data.get("memberId") || "");

    if (!conversationId || !memberId) {
      throw new Error("सदस्य छान्नुहोस्।");
    }

    const response = await service("messages")
      .manageGroupMember(
        conversationId,
        "add",
        memberId
      );

    resultData(response, null);

    await refreshConversations();

    const conversation = findConversation(conversationId);

    closeDialog();

    if (conversation) openGroupInfo(conversation);

    showToast("सदस्य थपियो।", "success");
  }

  async function removeGroupMember(conversationId, memberId) {
    if (!global.confirm("यो सदस्यलाई समूहबाट हटाउने?")) return;

    const response = await service("messages")
      .manageGroupMember(
        conversationId,
        "remove",
        memberId
      );

    resultData(response, null);

    await refreshConversations();

    const conversation = findConversation(conversationId);

    closeDialog();

    if (conversation) openGroupInfo(conversation);

    showToast("सदस्य हटाइयो।", "success");
  }

  /* =====================================================
     CHAT DETAIL
  ===================================================== */

  async function openChat(conversationId) {
    const conversation = findConversation(conversationId);

    if (!conversation) {
      showToast("कुराकानी भेटिएन।", "error");
      return;
    }

    const requestVersion = ++state.chatRequestVersion;

    await service("messages").stopPresence?.();

    state.activeChat = conversation;
    state.page = "chat-detail";
    state.messages = [];
    state.replyTo = null;
    state.hasOlderMessages = true;
    state.loadingOlder = false;
    state.typingUsers.clear();
    state.presenceUsers = [];

    root.querySelectorAll("[data-wa-page-content]")
      .forEach(section => {
        section.classList.remove("is-active");
        section.hidden = true;
      });

    const page = root.querySelector(
      '[data-wa-page-content="chat-detail"]'
    );

    page.hidden = false;
    page.classList.add("is-active");

    root.querySelector(".wa-tabs")?.setAttribute("hidden", "");
    root.querySelector(".wa-bottom-nav")?.setAttribute("hidden", "");

    renderChatDetail();

    try {
      const response = await service("messages")
        .getMessages(conversationId, { limit: 60 });

      if (requestVersion !== state.chatRequestVersion) return;

      const messages = resultData(response);

      if (state.activeChat?.id !== conversationId) return;

      state.messages = messages;
      state.hasOlderMessages = messages.length >= 60;

      await hydrateMessageMedia(state.messages);

      if (requestVersion !== state.chatRequestVersion) return;

      renderChatDetail();

      const readResponse = await service("messages")
        .markRead(conversationId);

      if (readResponse?.ok) {
        await refreshConversations();
      }

      await service("messages").startPresence(conversationId);

      scrollMessageList();

    } catch (error) {
      showError(error, "सन्देश लोड गर्न सकिएन।");
    }
  }

  async function hydrateMessageMedia(messages) {
    const api = service("messages");

    await Promise.all((messages || []).map(async message => {
      if (!message.mediaPath || message.mediaUrl) return;

      try {
        const response = await api.getMediaUrl(
          message.mediaPath
        );

        if (response?.ok) {
          message.mediaUrl = response.data;
        }
      } catch (error) {
        console.warn("Message media URL:", error);
      }
    }));
  }

  function renderChatDetail() {
    const page = root.querySelector(
      '[data-wa-page-content="chat-detail"]'
    );

    const conversation = state.activeChat;

    if (!page || !conversation) return;

    const messages = state.messages || [];

    const statusText = state.typingUsers.size
      ? "typing..."
      : conversation.type === "group"
        ? `${conversation.members?.length || 0} members`
        : " ";

    page.innerHTML = `
      <header class="wa-chat-header wa-header">

        <button
          class="wa-icon-button"
          type="button"
          data-wa-action="back-to-chats"
          aria-label="पछाडि"
        >‹</button>

        ${avatarHTML(
          conversation.name,
          conversation.avatar,
          "is-small"
        )}

        <button
          type="button"
          data-wa-chat-info="${escapeHTML(conversation.id)}"
          style="
            flex:1;
            min-width:0;
            padding:0;
            border:0;
            background:transparent;
            text-align:left;
            color:inherit
          "
        >
          <strong>${escapeHTML(conversation.name)}</strong>

          <span
            class="wa-row-preview"
            data-wa-typing-status
          >${escapeHTML(statusText)}</span>
        </button>

        <button
          class="wa-icon-button"
          type="button"
          data-wa-action="chat-search"
          aria-label="सन्देश खोज्नुहोस्"
        >⌕</button>

        <button
          class="wa-icon-button"
          type="button"
          data-wa-chat-menu="${escapeHTML(conversation.id)}"
          aria-label="थप विकल्प"
        >⋮</button>

      </header>

      <div
        class="wa-message-list"
        data-wa-message-list
        style="
          padding:14px;
          min-height:48dvh;
          display:flex;
          flex-direction:column;
          gap:8px;
          background:var(--wa-bg)
        "
      >
        ${
          state.hasOlderMessages && messages.length
            ? `
              <button
                class="wa-button wa-button-quiet"
                type="button"
                data-wa-action="load-older"
                ${state.loadingOlder ? "disabled" : ""}
              >
                ${state.loadingOlder ? "लोड हुँदैछ..." : "पुराना सन्देश"}
              </button>
            `
            : ""
        }

        ${
          messages.length
            ? messages.map(renderMessage).join("")
            : emptyState(
                "नयाँ कुराकानी",
                "नमस्कार लेखेर कुराकानी सुरु गर्नुहोस्।",
                "💬"
              )
        }
      </div>

      <div
        data-wa-reply-preview
        ${state.replyTo ? "" : "hidden"}
        style="
          padding:8px 14px;
          border-top:1px solid var(--wa-border);
          background:var(--wa-surface)
        "
      >
        ${
          state.replyTo
            ? `
              <div style="display:flex;justify-content:space-between;gap:10px">
                <span>
                  Replying to:
                  ${escapeHTML(
                    state.replyTo.content || "Attachment"
                  )}
                </span>

                <button
                  type="button"
                  data-wa-action="cancel-reply"
                >×</button>
              </div>
            `
            : ""
        }
      </div>

      <form
        data-wa-send-message
        style="
          display:flex;
          align-items:flex-end;
          gap:8px;
          padding:10px;
          border-top:1px solid var(--wa-border);
          background:var(--wa-surface)
        "
      >
        <button
          class="wa-icon-button"
          type="button"
          data-wa-action="attach-file"
          aria-label="फाइल जोड्नुहोस्"
        >＋</button>

        <input
          type="file"
          data-wa-file-input
          accept="image/*,video/*,application/pdf,text/plain,.doc,.docx"
          hidden
        >

        <textarea
          name="message"
          data-wa-message-input
          rows="1"
          maxlength="5000"
          placeholder="Message"
          style="
            flex:1;
            min-width:0;
            max-height:120px;
            resize:none;
            padding:11px 14px;
            border:0;
            border-radius:20px;
            outline:0;
            background:var(--wa-surface-soft);
            color:var(--wa-text)
          "
        ></textarea>

        <button
          class="wa-button wa-button-primary"
          type="submit"
          aria-label="सन्देश पठाउनुहोस्"
          style="min-width:44px;padding:8px 13px"
        >➤</button>
      </form>
    `;

    const list = page.querySelector("[data-wa-message-list]");

    if (list && messages.length) {
      list.scrollTop = list.scrollHeight;
    }
  }

  function renderMessage(message) {
    const mine = message.senderId === currentUserId();

    const deleted = Boolean(message.deletedForEveryone);

    const content = deleted
      ? "यो सन्देश मेटाइएको छ।"
      : message.content || message.text || "";

    let media = "";

    if (!deleted && message.mediaUrl) {
      const url = safeURL(message.mediaUrl);

      if (url && message.type === "image") {
        media = `
          <a
            href="${escapeHTML(url)}"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img
              src="${escapeHTML(url)}"
              alt="Shared image"
              loading="lazy"
              style="
                display:block;
                max-width:100%;
                max-height:280px;
                border-radius:10px;
                margin-bottom:6px
              "
            >
          </a>
        `;
      } else if (url && message.type === "video") {
        media = `
          <video
            controls
            preload="metadata"
            src="${escapeHTML(url)}"
            style="
              width:min(100%,300px);
              max-height:240px;
              border-radius:10px
            "
          ></video>
        `;
      } else if (url) {
        media = `
          <a
            href="${escapeHTML(url)}"
            target="_blank"
            rel="noopener noreferrer"
            style="display:block;padding:8px"
          >
            📎 ${escapeHTML(message.mediaName || "Attachment")}
          </a>
        `;
      }
    }

    const receipt = mine
      ? message.receipts?.length
        ? "✓✓"
        : "✓"
      : "";

    return `
      <div
        style="
          display:flex;
          justify-content:${mine ? "flex-end" : "flex-start"}
        "
      >
        <article
          class="wa-message-bubble"
          data-wa-message="${escapeHTML(message.id)}"
          style="
            position:relative;
            max-width:min(82%,440px);
            min-width:90px;
            padding:9px 11px 6px;
            border-radius:12px;
            background:${
              mine
                ? "color-mix(in srgb,var(--wa-accent) 18%,var(--wa-surface))"
                : "var(--wa-surface)"
            };
            border:1px solid var(--wa-border);
            box-shadow:var(--wa-shadow-sm);
            overflow-wrap:anywhere
          "
        >
          ${
            message.replyToId
              ? `<small style="display:block;color:var(--wa-text-muted)">↪ Reply</small>`
              : ""
          }

          ${media}

          ${
            content
              ? `
                <div style="white-space:pre-wrap">
                  ${escapeHTML(content)}
                </div>
              `
              : ""
          }

          <div
            style="
              display:flex;
              justify-content:flex-end;
              gap:5px;
              align-items:center;
              margin-top:4px;
              color:var(--wa-text-muted);
              font-size:10px
            "
          >
            ${message.editedAt ? "Edited · " : ""}
            ${escapeHTML(formatTime(message.createdAt))}
            <span>${receipt}</span>
          </div>

          ${
            !deleted
              ? `
                <div style="display:flex;gap:5px;margin-top:5px">
                  <button
                    type="button"
                    data-wa-reply-message="${escapeHTML(message.id)}"
                    style="border:0;background:transparent;color:var(--wa-text-secondary);font-size:11px"
                  >↩ Reply</button>

                  ${
                    mine && message.type === "text"
                      ? `
                        <button
                          type="button"
                          data-wa-edit-message="${escapeHTML(message.id)}"
                          style="border:0;background:transparent;color:var(--wa-text-secondary);font-size:11px"
                        >Edit</button>
                      `
                      : ""
                  }

                  ${
                    mine
                      ? `
                        <button
                          type="button"
                          data-wa-delete-message="${escapeHTML(message.id)}"
                          style="border:0;background:transparent;color:var(--wa-danger);font-size:11px"
                        >Delete</button>
                      `
                      : ""
                  }
                </div>
              `
              : ""
          }
        </article>
      </div>
    `;
  }

  function scrollMessageList() {
    const list = root?.querySelector("[data-wa-message-list]");

    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }

  async function loadOlderMessages() {
    if (
      !state.activeChat ||
      state.loadingOlder ||
      !state.messages.length ||
      !state.hasOlderMessages
    ) {
      return;
    }

    state.loadingOlder = true;

    const conversationId = state.activeChat.id;
    const first = state.messages[0];

    const cursor = {
      id: first.id,
      createdAt: first.createdAt
    };

    const list = root.querySelector("[data-wa-message-list]");
    const oldHeight = list?.scrollHeight || 0;

    renderChatDetail();

    try {
      const response = await service("messages")
        .getOlderMessages(
          conversationId,
          cursor,
          60
        );

      const older = resultData(response);

      if (state.activeChat?.id !== conversationId) return;

      await hydrateMessageMedia(older);

      const known = new Set(
        state.messages.map(item => item.id)
      );

      state.messages = [
        ...older.filter(item => !known.has(item.id)),
        ...state.messages
      ];

      state.hasOlderMessages = older.length >= 60;

      state.loadingOlder = false;

      renderChatDetail();

      const nextList = root.querySelector("[data-wa-message-list]");

      if (nextList) {
        nextList.scrollTop =
          nextList.scrollHeight - oldHeight;
      }

    } catch (error) {
      state.loadingOlder = false;
      renderChatDetail();
      showError(error, "पुराना सन्देश लोड गर्न सकिएन।");
    }
  }

  /* =====================================================
     SEND, REPLY, EDIT, DELETE AND MEDIA
  ===================================================== */

  async function sendMessage(form) {
    const conversation = state.activeChat;

    if (!conversation) {
      throw new Error("पहिले कुराकानी छान्नुहोस्।");
    }

    const input = form.querySelector(
      "[data-wa-message-input]"
    );

    const text = String(input?.value || "").trim();

    if (!text) return;

    const button = form.querySelector(
      'button[type="submit"]'
    );

    setButtonLoading(button, true, "…");

    try {
      const response = state.replyTo
        ? await service("messages").replyMessage(
            conversation.id,
            text,
            state.replyTo.id
          )
        : await service("messages").sendMessage(
            conversation.id,
            text
          );

      const message = resultData(response, null);

      if (message) {
        const exists = state.messages.some(
          item => item.id === message.id
        );

        if (!exists) state.messages.push(message);
      }

      state.replyTo = null;
      input.value = "";

      await service("messages").sendTyping(
        conversation.id,
        false
      );

      renderChatDetail();
      scrollMessageList();

      await refreshConversations();

    } finally {
      setButtonLoading(button, false);
      input?.focus();
    }
  }

  async function sendAttachment(file) {
    if (!state.activeChat || !file) return;

    const response = await service("messages")
      .uploadMedia(state.activeChat.id, file);

    const message = resultData(response, null);

    if (message) {
      state.messages.push(message);
      await hydrateMessageMedia([message]);
    }

    renderChatDetail();
    scrollMessageList();

    await refreshConversations();

    showToast("फाइल पठाइयो।", "success");
  }

  async function replyToMessage(messageId) {
    const message = findMessage(messageId);

    if (!message) return;

    state.replyTo = message;

    renderChatDetail();

    root.querySelector("[data-wa-message-input]")?.focus();
  }

  async function editMessage(messageId) {
    const message = findMessage(messageId);

    if (!message || message.senderId !== currentUserId()) return;

    const updated = global.prompt(
      "सन्देश सम्पादन गर्नुहोस्",
      message.content || message.text || ""
    );

    if (updated === null) return;

    const response = await service("messages")
      .editMessage(messageId, updated);

    const edited = resultData(response, null);

    const index = state.messages.findIndex(
      item => String(item.id) === String(messageId)
    );

    if (index >= 0 && edited) {
      state.messages[index] = edited;
    }

    renderChatDetail();

    showToast("सन्देश सम्पादन भयो।", "success");
  }

  async function deleteMessage(messageId) {
    const confirmed = global.confirm(
      "यो सन्देश सबैका लागि मेटाउने?"
    );

    if (!confirmed) return;

    const response = await service("messages")
      .deleteMessage(messageId, true);

    resultData(response, null);

    await reloadActiveMessages();

    showToast("सन्देश मेटाइयो।", "success");
  }

  async function reloadActiveMessages() {
    if (!state.activeChat) return;

    const conversationId = state.activeChat.id;

    const response = await service("messages")
      .getMessages(conversationId, { limit: 60 });

    const messages = resultData(response);

    if (state.activeChat?.id !== conversationId) return;

    state.messages = messages;

    await hydrateMessageMedia(state.messages);

    if (state.activeChat?.id === conversationId) {
      renderChatDetail();
      scrollMessageList();
    }
  }

  async function searchCurrentChat() {
    if (!state.activeChat) return;

    const term = global.prompt(
      "सन्देश खोज्नुहोस्",
      state.messageSearch
    );

    if (term === null) return;

    if (term.trim().length < 2) {
      showToast("कम्तीमा दुई अक्षर लेख्नुहोस्।", "error");
      return;
    }

    state.messageSearch = term.trim();

    const response = await service("messages")
      .searchMessages(state.activeChat.id, term, 50);

    const results = resultData(response);

    showDialog(
      "Search results",
      results.length
        ? `
          <div class="wa-list">
            ${results.map(message => `
              <button
                class="wa-list-row"
                type="button"
                data-wa-jump-message="${escapeHTML(message.id)}"
              >
                <span class="wa-row-main">
                  <strong>
                    ${escapeHTML(message.content || message.text || "Attachment")}
                  </strong>
                  <span class="wa-row-preview">
                    ${escapeHTML(formatDate(message.createdAt))}
                  </span>
                </span>
              </button>
            `).join("")}
          </div>
        `
        : emptyState(
            "नतिजा भेटिएन",
            "यो शब्द भएको सन्देश छैन।",
            "⌕"
          )
    );
  }

  /* =====================================================
     CONTACTS AND FRIEND REQUESTS
  ===================================================== */

  function renderContacts() {
    const page = root.querySelector(
      '[data-wa-page-content="contacts"]'
    );

    if (!page) return;

    const friends = state.friends.friends || [];
    const incoming = state.friends.incoming || [];
    const outgoing = state.friends.outgoing || [];

    page.innerHTML = `
      <div class="wa-page-heading">
        <div>
          <h2 class="wa-page-title">Contacts</h2>
          <p class="wa-page-description">
            साथीहरू र Friend Requests
          </p>
        </div>

        <button
          class="wa-icon-button"
          type="button"
          data-wa-action="new-chat"
        >＋</button>
      </div>

      <section class="wa-section">
        <h3 class="wa-section-title">Find people</h3>

        <form data-wa-user-search-form>
          <label class="wa-search" style="margin:0">
            <span>⌕</span>
            <input
              type="search"
              name="query"
              placeholder="नाम खोज्नुहोस्"
              minlength="2"
              required
            >
          </label>

          <button
            class="wa-button wa-button-primary"
            type="submit"
            style="width:100%;margin-top:10px"
          >
            Search
          </button>
        </form>

        <div data-wa-contact-page-results>
          ${
            state.contactResults.length
              ? renderFriendSearchResults()
              : ""
          }
        </div>
      </section>

      ${
        incoming.length
          ? `
            <section class="wa-section">
              <h3 class="wa-section-title">
                Friend Requests (${incoming.length})
              </h3>

              ${incoming.map(item => `
                <div class="wa-list-row">
                  ${avatarHTML(
                    item.person?.name,
                    item.person?.avatarUrl
                  )}

                  <span class="wa-row-main">
                    <strong>
                      ${escapeHTML(item.person?.name || "User")}
                    </strong>
                  </span>

                  <button
                    class="wa-button wa-button-primary"
                    type="button"
                    data-wa-friend-action="accept"
                    data-wa-request-id="${escapeHTML(item.id)}"
                  >Accept</button>

                  <button
                    class="wa-button wa-button-quiet"
                    type="button"
                    data-wa-friend-action="reject"
                    data-wa-request-id="${escapeHTML(item.id)}"
                  >×</button>
                </div>
              `).join("")}
            </section>
          `
          : ""
      }

      ${
        outgoing.length
          ? `
            <section class="wa-section">
              <h3 class="wa-section-title">
                Sent requests (${outgoing.length})
              </h3>

              ${outgoing.map(item => `
                <div class="wa-list-row">
                  ${avatarHTML(
                    item.person?.name,
                    item.person?.avatarUrl
                  )}

                  <span class="wa-row-main">
                    ${escapeHTML(item.person?.name || "User")}
                    <span class="wa-row-preview">Pending</span>
                  </span>
                </div>
              `).join("")}
            </section>
          `
          : ""
      }

      <section class="wa-section">
        <h3 class="wa-section-title">
          My friends (${friends.length})
        </h3>

        <div class="wa-list">
          ${
            friends.length
              ? friends.map(person => `
                <button
                  class="wa-list-row"
                  type="button"
                  data-wa-open-friend-chat="${escapeHTML(person.id)}"
                >
                  ${avatarHTML(person.name, person.avatarUrl)}

                  <span class="wa-row-main">
                    <span class="wa-row-title">
                      ${escapeHTML(person.name)}
                    </span>
                    <span class="wa-row-preview">
                      Message
                    </span>
                  </span>

                  <span>›</span>
                </button>
              `).join("")
              : emptyState(
                  "साथी छैनन्",
                  "नाम खोजेर साथी जोड्नुहोस्।",
                  "👤"
                )
          }
        </div>
      </section>
    `;
  }

  async function handleFriendAction(action, requestId) {
    const status = action === "accept"
      ? "accepted"
      : "rejected";

    const response = await service("friends")
      .respondToFriendRequest(requestId, status);

    resultData(response, null);

    await refreshFriends();

    showToast(
      action === "accept"
        ? "Friend Request स्वीकार भयो।"
        : "Friend Request अस्वीकार भयो।",
      "success"
    );
  }

  /* =====================================================
     UPDATES
     Existing posts table is used. This is not a
     24-hour WhatsApp Status implementation.
  ===================================================== */

  function renderUpdates() {
    const page = root.querySelector(
      '[data-wa-page-content="updates"]'
    );

    if (!page) return;

    const posts = state.posts || [];

    page.innerHTML = `
      <div class="wa-page-heading">
        <div>
          <h2 class="wa-page-title">Updates</h2>
          <p class="wa-page-description">
            साझा गरिएका पोस्ट र गतिविधिहरू
          </p>
        </div>

        <button
          class="wa-icon-button"
          type="button"
          data-wa-action="refresh-updates"
          title="Refresh"
        >↻</button>
      </div>

      <section class="wa-section">
        <button
          class="wa-list-row"
          type="button"
          data-wa-action="create-post"
          style="
            width:100%;
            border:0;
            border-radius:12px;
            background:var(--wa-surface-soft)
          "
        >
          ${avatarHTML(
            state.profile?.name || state.user?.email,
            state.profile?.avatarUrl
          )}

          <span class="wa-row-main">
            <span class="wa-row-title">
              Share an update
            </span>
            <span class="wa-row-preview">
              फोटो वा टेक्स्ट पोस्ट गर्नुहोस्
            </span>
          </span>

          <span>＋</span>
        </button>
      </section>

      <div style="padding:0 12px 16px">
        ${
          posts.length
            ? posts.map(renderPost).join("")
            : emptyState(
                "अहिलेसम्म Update छैन",
                "पहिलो पोस्ट तपाईंले साझा गर्न सक्नुहुन्छ।",
                "◉"
              )
        }
      </div>
    `;
  }

  function renderPost(post) {
    const name = post.authorName ||
      post.name ||
      "WhatsApp User";

    const avatar = post.authorAvatarUrl ||
      post.avatarUrl ||
      "";

    const content = post.content || post.text || "";

    const media = safeURL(
      post.mediaUrl || post.media_url
    );

    return `
      <article
        class="wa-card"
        style="margin-bottom:14px"
      >
        <div
          class="wa-card-body"
          style="display:flex;align-items:center;gap:10px"
        >
          ${avatarHTML(name, avatar, "is-small")}

          <div class="wa-row-main">
            <strong>${escapeHTML(name)}</strong>
            <div class="wa-row-preview">
              ${escapeHTML(formatDate(post.createdAt || post.created_at))}
            </div>
          </div>
        </div>

        ${
          content
            ? `
              <div class="wa-card-body" style="padding-top:0">
                <p style="white-space:pre-wrap;margin:0">
                  ${escapeHTML(content)}
                </p>
              </div>
            `
            : ""
        }

        ${
          media
            ? `
              <img
                src="${escapeHTML(media)}"
                alt="Update media"
                loading="lazy"
                style="
                  display:block;
                  width:100%;
                  max-height:420px;
                  object-fit:contain;
                  background:var(--wa-surface-soft)
                "
              >
            `
            : ""
        }

        ${
          post.authorId === currentUserId()
            ? `
              <div
                class="wa-card-body"
                style="display:flex;justify-content:flex-end;gap:8px"
              >
                <button
                  class="wa-button wa-button-quiet"
                  type="button"
                  data-wa-edit-post="${escapeHTML(post.id)}"
                >Edit</button>

                <button
                  class="wa-button wa-button-danger"
                  type="button"
                  data-wa-delete-post="${escapeHTML(post.id)}"
                >Delete</button>
              </div>
            `
            : ""
        }
      </article>
    `;
  }

  function renderCreatePostDialog() {
    showDialog(
      "Create update",
      `
        <form data-wa-create-post>

          <textarea
            name="text"
            maxlength="5000"
            rows="5"
            placeholder="के सोच्दै हुनुहुन्छ?"
            style="
              width:100%;
              resize:vertical;
              padding:12px;
              border:1px solid var(--wa-border);
              border-radius:10px;
              background:var(--wa-surface);
              color:var(--wa-text)
            "
          ></textarea>

          <label
            class="wa-button wa-button-quiet"
            style="width:100%;margin-top:12px"
          >
            📷 फोटो छान्नुहोस्
            <input
              type="file"
              name="media"
              accept="image/*"
              hidden
            >
          </label>

          <button
            class="wa-button wa-button-primary"
            type="submit"
            style="width:100%;margin-top:14px"
          >
            Publish
          </button>

        </form>
      `
    );
  }

  async function createPost(form) {
    const data = new FormData(form);

    const response = await service("posts").createPost({
      text: String(data.get("text") || "").trim(),
      media: data.get("media") instanceof File &&
        data.get("media").size
          ? data.get("media")
          : null
    });

    resultData(response, null);

    closeDialog();

    await refreshUpdates();

    showToast("Update प्रकाशित भयो।", "success");
  }

  async function editPost(postId) {
    const post = state.posts.find(
      item => String(item.id) === String(postId)
    );

    if (!post || post.authorId !== currentUserId()) return;

    const value = global.prompt(
      "Update सम्पादन गर्नुहोस्",
      post.content || post.text || ""
    );

    if (value === null) return;

    const response = await service("posts")
      .updatePost(postId, { text: value });

    resultData(response, null);

    await refreshUpdates();

    showToast("Update सम्पादन भयो।", "success");
  }

  async function deletePost(postId) {
    if (!global.confirm("यो Update मेटाउने?")) return;

    const response = await service("posts")
      .deletePost(postId);

    resultData(response, null);

    await refreshUpdates();

    showToast("Update मेटाइयो।", "success");
  }

  /* =====================================================
     PROFILE AND SETTINGS
  ===================================================== */

  function renderProfile() {
    const page = root.querySelector(
      '[data-wa-page-content="profile"]'
    );

    if (!page) return;

    const profile = state.profile || {};
    const name = profile.name || state.user?.email || "My profile";

    page.innerHTML = `
      <div class="wa-page-heading">
        <h2 class="wa-page-title">Settings</h2>
      </div>

      <section class="wa-section">
        <div style="display:flex;align-items:center;gap:14px">
          ${avatarHTML(
            name,
            profile.avatarUrl || profile.avatar,
            "is-large"
          )}

          <div class="wa-row-main">
            <h3 style="margin:0;font-size:18px">
              ${escapeHTML(name)}
            </h3>

            <p class="wa-row-preview">
              ${escapeHTML(profile.bio || state.user?.email || "")}
            </p>

            <button
              class="wa-button wa-button-quiet"
              type="button"
              data-wa-action="edit-profile"
              style="margin-top:8px"
            >
              Edit profile
            </button>
          </div>
        </div>
      </section>

      <section class="wa-section">
        <h3 class="wa-section-title">Account</h3>

        <div class="wa-disclosure" aria-expanded="false">
          <button
            class="wa-disclosure-trigger"
            type="button"
            data-wa-action="toggle-disclosure"
          >
            <span>Profile information</span>
            <span>⌄</span>
          </button>

          <div class="wa-disclosure-content">
            <p>Name: ${escapeHTML(name)}</p>
            <p>Bio: ${escapeHTML(profile.bio || "—")}</p>
            <p>Location: ${escapeHTML(profile.location || "—")}</p>
            <p style="overflow-wrap:anywhere">
              Email: ${escapeHTML(state.user?.email || "")}
            </p>
          </div>
        </div>

        <div class="wa-disclosure" aria-expanded="false">
          <button
            class="wa-disclosure-trigger"
            type="button"
            data-wa-action="toggle-disclosure"
          >
            <span>Appearance</span>
            <span>⌄</span>
          </button>

          <div class="wa-disclosure-content">
            <button
              class="wa-button wa-button-quiet"
              type="button"
              data-wa-theme="light"
            >Light Mode</button>

            <button
              class="wa-button wa-button-quiet"
              type="button"
              data-wa-theme="dark"
            >Dark Mode</button>

            <button
              class="wa-button wa-button-quiet"
              type="button"
              data-wa-theme="system"
            >System Default</button>
          </div>
        </div>

        <div class="wa-disclosure" aria-expanded="false">
          <button
            class="wa-disclosure-trigger"
            type="button"
            data-wa-action="toggle-disclosure"
          >
            <span>Notifications</span>
            <span>⌄</span>
          </button>

          <div class="wa-disclosure-content">
            <p>
              Message र Friend Request का सूचनाहरू यहाँ व्यवस्थापन हुन्छन्।
            </p>

            <button
              class="wa-button wa-button-quiet"
              type="button"
              data-wa-action="notifications"
            >
              Open notifications
            </button>
          </div>
        </div>
      </section>

      <section class="wa-section">
        <button
          class="wa-button wa-button-danger"
          type="button"
          data-wa-action="signout"
          style="width:100%"
        >
          Log Out
        </button>
      </section>
    `;
  }

  function renderEditProfileDialog() {
    const profile = state.profile || {};

    showDialog(
      "Edit profile",
      `
        <form data-wa-update-profile>

          <label class="wa-section-title">Name</label>

          <input
            name="name"
            required
            maxlength="100"
            value="${escapeHTML(profile.name || "")}"
            style="
              width:100%;
              padding:12px;
              margin-bottom:14px;
              border:1px solid var(--wa-border);
              border-radius:10px;
              background:var(--wa-surface);
              color:var(--wa-text)
            "
          >

          <label class="wa-section-title">About</label>

          <textarea
            name="bio"
            maxlength="240"
            rows="3"
            style="
              width:100%;
              padding:12px;
              margin-bottom:14px;
              border:1px solid var(--wa-border);
              border-radius:10px;
              background:var(--wa-surface);
              color:var(--wa-text)
            "
          >${escapeHTML(profile.bio || "")}</textarea>

          <label class="wa-section-title">Location</label>

          <input
            name="location"
            maxlength="100"
            value="${escapeHTML(profile.location || "")}"
            style="
              width:100%;
              padding:12px;
              margin-bottom:14px;
              border:1px solid var(--wa-border);
              border-radius:10px;
              background:var(--wa-surface);
              color:var(--wa-text)
            "
          >

          <label class="wa-section-title">Avatar URL</label>

          <input
            name="avatarUrl"
            type="url"
            value="${escapeHTML(profile.avatarUrl || "")}"
            placeholder="https://..."
            style="
              width:100%;
              padding:12px;
              margin-bottom:14px;
              border:1px solid var(--wa-border);
              border-radius:10px;
              background:var(--wa-surface);
              color:var(--wa-text)
            "
          >

          <button
            class="wa-button wa-button-primary"
            type="submit"
            style="width:100%"
          >
            Save changes
          </button>

        </form>
      `
    );
  }

  async function updateProfile(form) {
    const data = new FormData(form);

    const updated = await service("profile")
      .updateMyProfile({
        name: String(data.get("name") || "").trim(),
        bio: String(data.get("bio") || "").trim(),
        location: String(data.get("location") || "").trim(),
        avatarUrl: String(data.get("avatarUrl") || "").trim()
      });

    state.profile = updated;

    closeDialog();
    renderProfile();

    showToast("Profile सुरक्षित भयो।", "success");
  }

  function setTheme(theme) {
    if (theme === "system") {
      document.documentElement.removeAttribute("data-theme");
      return;
    }

    if (theme === "light" || theme === "dark") {
      document.documentElement.dataset.theme = theme;
    }
  }

  /* =====================================================
     NOTIFICATIONS
  ===================================================== */

  function updateNotificationCount() {
    const count = state.notifications.filter(
      item => !item.read
    ).length;

    const badge = root?.querySelector(
      "[data-wa-notification-count]"
    );

    if (!badge) return;

    badge.hidden = count === 0;
    badge.textContent = count > 99
      ? "99+"
      : String(count);
  }

  function renderNotifications() {
    const page = root.querySelector(
      '[data-wa-page-content="notifications"]'
    );

    if (!page) return;

    const items = state.notifications || [];

    page.innerHTML = `
      <div class="wa-page-heading">
        <div>
          <h2 class="wa-page-title">Notifications</h2>
          <p class="wa-page-description">
            तपाईंका नयाँ गतिविधिहरू
          </p>
        </div>

        <button
          class="wa-button wa-button-quiet"
          type="button"
          data-wa-action="mark-all-read"
        >
          Mark all read
        </button>
      </div>

      <div class="wa-list">
        ${
          items.length
            ? items.map(item => `
              <div
                class="wa-list-row"
                style="
                  background:${
                    item.read
                      ? "var(--wa-surface)"
                      : "var(--wa-surface-soft)"
                  }
                "
              >
                <span class="wa-avatar is-small">🔔</span>

                <span class="wa-row-main">
                  <span class="wa-row-title">
                    ${escapeHTML(item.text || item.type || "Notification")}
                  </span>

                  <span class="wa-row-preview">
                    ${escapeHTML(formatDate(item.createdAt))}
                  </span>
                </span>

                ${
                  !item.read
                    ? `
                      <button
                        class="wa-button wa-button-quiet"
                        type="button"
                        data-wa-notification="${escapeHTML(item.id)}"
                      >
                        Read
                      </button>
                    `
                    : ""
                }

                <button
                  class="wa-icon-button"
                  type="button"
                  data-wa-delete-notification="${escapeHTML(item.id)}"
                  aria-label="Delete notification"
                >×</button>
              </div>
            `).join("")
            : emptyState(
                "नयाँ सूचना छैन",
                "नयाँ गतिविधि भए यहाँ देखिनेछ।",
                "🔔"
              )
        }
      </div>
    `;
  }

  async function markNotificationRead(id) {
    const response = await service("notifications")
      .markAsRead(id);

    resultData(response, null);

    const item = state.notifications.find(
      notification => String(notification.id) === String(id)
    );

    if (item) item.read = true;

    updateNotificationCount();
    renderNotifications();
  }

  async function markAllNotificationsRead() {
    const response = await service("notifications")
      .markAllAsRead();

    resultData(response, null);

    state.notifications.forEach(item => {
      item.read = true;
    });

    updateNotificationCount();
    renderNotifications();

    showToast("सबै सूचना पढिएको चिन्ह लगाइयो।", "success");
  }

  async function deleteNotification(id) {
    const response = await service("notifications")
      .deleteNotification(id);

    resultData(response, null);

    state.notifications = state.notifications.filter(
      item => String(item.id) !== String(id)
    );

    updateNotificationCount();
    renderNotifications();
  }

  /* =====================================================
     GLOBAL SEARCH
  ===================================================== */

  function openGlobalSearch() {
    showDialog(
      "Search",
      `
        <form data-wa-global-search>
          <label class="wa-search" style="margin:0">
            <span>⌕</span>
            <input
              name="query"
              type="search"
              minlength="2"
              placeholder="Messages खोज्नुहोस्"
              required
            >
          </label>

          <button
            class="wa-button wa-button-primary"
            type="submit"
            style="width:100%;margin-top:12px"
          >
            Search messages
          </button>
        </form>

        <div data-wa-global-results></div>
      `
    );
  }

  async function performGlobalSearch(query) {
    const response = await service("messages")
      .searchMessages(null, query, 50);

    const results = resultData(response);

    const container = root.querySelector(
      "[data-wa-global-results]"
    );

    if (!container) return;

    container.innerHTML = results.length
      ? `
        <div class="wa-list" style="margin-top:14px">
          ${results.map(message => {
            const conversation = findConversation(
              message.conversationId
            );

            return `
              <button
                class="wa-list-row"
                type="button"
                data-wa-search-result="${escapeHTML(message.conversationId)}"
              >
                <span class="wa-avatar is-small">💬</span>

                <span class="wa-row-main">
                  <strong>
                    ${escapeHTML(conversation?.name || "Chat")}
                  </strong>

                  <span class="wa-row-preview">
                    ${escapeHTML(message.content || message.text || "Attachment")}
                  </span>
                </span>
              </button>
            `;
          }).join("")}
        </div>
      `
      : emptyState(
          "नतिजा भेटिएन",
          "खोजिएको सन्देश उपलब्ध छैन।",
          "⌕"
        );
  }

  /* =====================================================
     EVENT DELEGATION
  ===================================================== */

  function bindEvents() {
    if (!root || eventsBound) return;

    eventsBound = true;

    root.addEventListener("click", handleClick);
    root.addEventListener("submit", handleSubmit);
    root.addEventListener("input", handleInput);
    root.addEventListener("change", handleChange);
    root.addEventListener("keydown", handleKeydown);
  }

  async function handleClick(event) {
    const target = event.target.closest(
      "button,[data-wa-close-dialog]"
    );

    if (!target) return;

    try {
      if (target.matches("[data-wa-close-dialog]")) {
        if (event.target === target) closeDialog();
        return;
      }

      if (target.dataset.waPage) {
        navigate(target.dataset.waPage);
        return;
      }

      if (target.dataset.waOpenChat) {
        closeDialog();
        await openChat(target.dataset.waOpenChat);
        return;
      }

      if (target.dataset.waOpenFriendChat) {
        await openFriendChat(target.dataset.waOpenFriendChat);
        return;
      }

      if (target.dataset.waChatInfo) {
        const conversation = findConversation(
          target.dataset.waChatInfo
        );

        if (conversation?.type === "group") {
          openGroupInfo(conversation);
        } else if (conversation) {
          showDialog(
            conversation.name,
            `
              <div style="text-align:center;padding:20px">
                ${avatarHTML(
                  conversation.name,
                  conversation.avatar,
                  "is-large"
                )}

                <h3>${escapeHTML(conversation.name)}</h3>
                <p class="wa-row-preview">Personal chat</p>
              </div>
            `
          );
        }

        return;
      }

      if (target.dataset.waChatFilter) {
        state.chatFilter = target.dataset.waChatFilter;
        renderChats();
        return;
      }

      if (target.dataset.waChatMenu) {
        showChatMenu(target.dataset.waChatMenu);
        return;
      }

      if (target.dataset.waChatPreference) {
        await updateChatPreference(
          target.dataset.waChatId,
          target.dataset.waChatPreference
        );
        return;
      }

      if (target.dataset.waAddFriend) {
        await sendFriendRequest(target.dataset.waAddFriend);
        return;
      }

      if (target.dataset.waFriendAction) {
        await handleFriendAction(
          target.dataset.waFriendAction,
          target.dataset.waRequestId
        );
        return;
      }

      if (target.dataset.waGroupRemove) {
        await removeGroupMember(
          target.dataset.waGroupId,
          target.dataset.waGroupRemove
        );
        return;
      }

      if (target.dataset.waReplyMessage) {
        await replyToMessage(target.dataset.waReplyMessage);
        return;
      }

      if (target.dataset.waEditMessage) {
        await editMessage(target.dataset.waEditMessage);
        return;
      }

      if (target.dataset.waDeleteMessage) {
        await deleteMessage(target.dataset.waDeleteMessage);
        return;
      }

      if (target.dataset.waEditPost) {
        await editPost(target.dataset.waEditPost);
        return;
      }

      if (target.dataset.waDeletePost) {
        await deletePost(target.dataset.waDeletePost);
        return;
      }

      if (target.dataset.waNotification) {
        await markNotificationRead(target.dataset.waNotification);
        return;
      }

      if (target.dataset.waDeleteNotification) {
        await deleteNotification(
          target.dataset.waDeleteNotification
        );
        return;
      }

      if (target.dataset.waSearchResult) {
        closeDialog();
        await openChat(target.dataset.waSearchResult);
        return;
      }

      if (target.dataset.waJumpMessage) {
        const id = target.dataset.waJumpMessage;
        closeDialog();

        const message = findMessage(id);

        if (message) {
          root.querySelector(
            `[data-wa-message="${CSS.escape(id)}"]`
          )?.scrollIntoView({ behavior: "smooth", block: "center" });
        } else {
          showToast(
            "यो सन्देश हालको लोड गरिएको इतिहासमा छैन।",
            "info"
          );
        }

        return;
      }

      if (target.dataset.waTheme) {
        setTheme(target.dataset.waTheme);
        return;
      }

      if (target.dataset.waAction) {
        switch (target.dataset.waAction) {
          case "new-chat":
            openNewChat();
            break;

          case "create-group":
            renderCreateGroupDialog();
            break;

          case "create-post":
            renderCreatePostDialog();
            break;

          case "refresh-updates":
            await refreshUpdates();
            break;

          case "notifications":
            navigate("notifications");
            break;

          case "profile":
            navigate("profile");
            break;

          case "edit-profile":
            renderEditProfileDialog();
            break;

          case "global-search":
            openGlobalSearch();
            break;

          case "chat-search":
            await searchCurrentChat();
            break;

          case "back-to-chats":
            navigate("chats");
            break;

          case "attach-file":
            root.querySelector("[data-wa-file-input]")?.click();
            break;

          case "cancel-reply":
            state.replyTo = null;
            renderChatDetail();
            break;

          case "mark-all-read":
            await markAllNotificationsRead();
            break;

          case "load-older":
            await loadOlderMessages();
            break;

          case "signout":
            await signOut();
            break;

          case "signup":
            await handleSignup();
            break;

          case "forgot-password":
            await handleForgotPassword();
            break;

          case "close-dialog":
            closeDialog();
            break;

          case "toggle-disclosure": {
            const disclosure = target.closest(".wa-disclosure");

            if (disclosure) {
              const expanded =
                disclosure.getAttribute("aria-expanded") === "true";

              disclosure.setAttribute(
                "aria-expanded",
                expanded ? "false" : "true"
              );
            }
            break;
          }

          default:
            break;
        }
      }
    } catch (error) {
      showError(error);
    }
  }

  async function handleSubmit(event) {
    const form = event.target;

    if (!form.matches("form")) return;

    if (form.matches("[data-wa-auth-form]")) {
      event.preventDefault();
      await handleAuthSubmit(form);
      return;
    }

    if (form.matches("[data-wa-send-message]")) {
      event.preventDefault();

      try {
        await sendMessage(form);
      } catch (error) {
        showError(error, "सन्देश पठाउन सकिएन।");
      }
      return;
    }

    if (form.matches("[data-wa-contact-search-form]")) {
      event.preventDefault();

      try {
        const data = new FormData(form);
        await searchUsers(data.get("query"));
      } catch (error) {
        showError(error, "खोज असफल भयो।");
      }
      return;
    }

    if (form.matches("[data-wa-user-search-form]")) {
      event.preventDefault();

      try {
        const data = new FormData(form);
        await searchUsers(data.get("query"));
      } catch (error) {
        showError(error, "खोज असफल भयो।");
      }
      return;
    }

    if (form.matches("[data-wa-create-group]")) {
      event.preventDefault();

      try {
        await createGroup(form);
      } catch (error) {
        showError(error, "समूह बनाउन सकिएन।");
      }
      return;
    }

    if (form.matches("[data-wa-group-add]")) {
      event.preventDefault();

      try {
        await addGroupMember(form);
      } catch (error) {
        showError(error, "सदस्य थप्न सकिएन।");
      }
      return;
    }

    if (form.matches("[data-wa-create-post]")) {
      event.preventDefault();

      try {
        await createPost(form);
      } catch (error) {
        showError(error, "Update प्रकाशित भएन।");
      }
      return;
    }

    if (form.matches("[data-wa-update-profile]")) {
      event.preventDefault();

      try {
        await updateProfile(form);
      } catch (error) {
        showError(error, "Profile सुरक्षित भएन।");
      }
      return;
    }

    if (form.matches("[data-wa-global-search]")) {
      event.preventDefault();

      try {
        const data = new FormData(form);
        await performGlobalSearch(data.get("query"));
      } catch (error) {
        showError(error, "खोज असफल भयो।");
      }
    }
  }

  function handleInput(event) {
    const input = event.target;

    if (input.matches("[data-wa-chat-search]")) {
      const cursor = input.selectionStart;

      state.chatSearch = input.value;

      renderChats();

      const next = root.querySelector("[data-wa-chat-search]");

      if (next) {
        next.focus();

        try {
          next.setSelectionRange(cursor, cursor);
        } catch (_) {}
      }

      return;
    }

    if (input.matches("[data-wa-message-input]")) {
      if (!state.activeChat) return;

      const conversationId = state.activeChat.id;
      const typing = Boolean(input.value.trim());

      service("messages").sendTyping(
        conversationId,
        typing
      );

      if (state.typingTimer) {
        global.clearTimeout(state.typingTimer);
      }

      state.typingTimer = global.setTimeout(() => {
        service("messages").sendTyping(
          conversationId,
          false
        );
      }, 1800);
    }
  }

  async function handleChange(event) {
    const input = event.target;

    if (input.matches("[data-wa-file-input]")) {
      const file = input.files?.[0];

      if (!file) return;

      try {
        await sendAttachment(file);
      } catch (error) {
        showError(error, "फाइल पठाउन सकिएन।");
      }

      input.value = "";
      return;
    }

    if (input.matches('[data-wa-create-post] input[name="media"]')) {
      return;
    }
  }

  function handleKeydown(event) {
    if (
      event.target.matches("[data-wa-message-input]") &&
      event.key === "Enter" &&
      !event.shiftKey
    ) {
      event.preventDefault();

      const form = event.target.closest("form");

      if (form) form.requestSubmit();
    }

    if (event.key === "Escape") {
      closeDialog();
    }
  }

  /* =====================================================
     SIGN OUT
  ===================================================== */

  async function signOut() {
    try {
      await service("messages").stopRealtime?.();
      await service("messages").stopPresence?.();
      await service("notifications").stopRealtime?.();

      await service("auth").signOut();

      state.authenticated = false;
      state.initialized = false;
      state.user = null;
      state.profile = null;

      state.conversations = [];
      state.messages = [];
      state.posts = [];
      state.notifications = [];

      state.activeChat = null;

      renderAuthScreen();

    } catch (error) {
      showError(error, "Log Out असफल भयो।");
    }
  }

  /* =====================================================
     REALTIME EVENTS
  ===================================================== */

  function bindRealtimeEvents() {
    if (realtimeEventsBound) return;

    realtimeEventsBound = true;

    global.addEventListener(
      "ksk:messages-cloud-change",
      async event => {
        if (!state.authenticated) return;

        const detail = event.detail || {};

        const message = detail.message || {};
        const conversationId =
          detail.conversationId ||
          message.conversation_id ||
          message.conversationId ||
          detail.receipt?.conversation_id ||
          "";

        try {
          await refreshConversations();

          if (
            state.activeChat &&
            (
              !conversationId ||
              String(conversationId) === String(state.activeChat.id)
            )
          ) {
            await reloadActiveMessages();

            await service("messages")
              .markRead(state.activeChat.id);
          }
        } catch (error) {
          console.warn("Message realtime refresh:", error);
        }
      }
    );

    global.addEventListener(
      "ksk:posts-cloud-change",
      async () => {
        if (!state.authenticated) return;

        if (state.page === "updates") {
          try {
            await refreshUpdates();
          } catch (error) {
            console.warn("Updates realtime:", error);
          }
        }
      }
    );

    global.addEventListener(
      "ksk:notification-cloud-change",
      async event => {
        if (!state.authenticated) return;

        const detail = event.detail || {};

        if (detail.action === "add" && detail.item) {
          const exists = state.notifications.some(
            item => item.id === detail.item.id
          );

          if (!exists) {
            state.notifications.unshift(detail.item);
          }

          updateNotificationCount();

          if (state.page === "notifications") {
            renderNotifications();
          }

          return;
        }

        try {
          await refreshNotifications();
        } catch (error) {
          console.warn("Notification realtime:", error);
        }
      }
    );

    global.addEventListener(
      "ksk:friends-cloud-change",
      async () => {
        if (!state.authenticated) return;

        try {
          await refreshFriends();
        } catch (error) {
          console.warn("Friends realtime:", error);
        }
      }
    );

    global.addEventListener(
      "ksk:typing-change",
      event => {
        const detail = event.detail || {};

        if (
          !state.activeChat ||
          String(detail.conversationId) !==
            String(state.activeChat.id)
        ) {
          return;
        }

        if (detail.typing) {
          state.typingUsers.add(detail.userId);
        } else {
          state.typingUsers.delete(detail.userId);
        }

        const status = root.querySelector(
          "[data-wa-typing-status]"
        );

        if (status) {
          status.textContent = state.typingUsers.size
            ? "typing..."
            : state.activeChat.type === "group"
              ? `${state.activeChat.members?.length || 0} members`
              : " ";
        }
      }
    );

    global.addEventListener(
      "ksk:auth-change",
      event => {
        const user = event.detail?.user || null;

        state.user = user;
        state.authenticated = Boolean(user?.id);

        if (!state.authenticated) {
          state.initialized = false;
          state.activeChat = null;
          state.conversations = [];
          state.messages = [];

          renderAuthScreen();
        } else if (!state.initialized) {
          startApplication();
        }
      }
    );

    global.addEventListener("online", () => {
      state.realtime.online = true;

      if (state.authenticated) {
        service("messages").startRealtime?.();
        service("messages").updateLastSeen?.();

        loadDashboard().catch(error => {
          console.warn("Reconnect refresh:", error);
        });
      }
    });

    global.addEventListener("offline", () => {
      state.realtime.online = false;

      if (state.authenticated) {
        showToast(
          "इन्टरनेट जडान छैन। पुनः जडानको प्रतीक्षामा...",
          "error"
        );
      }
    });

    global.addEventListener("ksk:messages-cloud-change", event => {
      const detail = event.detail || {};

      if (detail.action === "realtime-connected") {
        state.realtime.messages = true;
      }

      if (detail.action === "realtime-error") {
        state.realtime.messages = false;
      }
    });

    global.addEventListener(
      "ksk:notification-cloud-change",
      event => {
        const status = event.detail?.status;

        if (status === "SUBSCRIBED") {
          state.realtime.notifications = true;
        }

        if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          state.realtime.notifications = false;
        }
      }
    );
  }

  /* =====================================================
     APPLICATION STARTUP
  ===================================================== */

  async function startApplication() {
    if (startupPromise) return startupPromise;

    startupPromise = (async () => {
      state.initializing = true;

      try {
        const auth = service("auth");

        await auth.initialize();

        if (!auth.isAuthenticated()) {
          state.authenticated = false;
          state.initialized = false;

          renderAuthScreen();

          return false;
        }

        state.user = auth.getUser();
        state.authenticated = true;

        renderShell();

        const initializers = [
          service("messages").initialize(),
          service("friends").initialize(),
          service("posts").initialize(),
          service("notifications").initialize(),
          service("profile").initialize()
        ];

        const initResults = await Promise.allSettled(
          initializers
        );

        const failed = initResults
          .map((result, index) => ({
            result,
            name: [
              "Messages",
              "Contacts",
              "Updates",
              "Notifications",
              "Profile"
            ][index]
          }))
          .filter(item =>
            item.result.status === "rejected" ||
            item.result.value?.ok === false
          )
          .map(item => item.name);

        await loadDashboard();

        state.initialized = true;

        if (failed.length) {
          showToast(
            "केही सेवा सुरु भएनन्: " + failed.join(", "),
            "error"
          );
        }

        return true;

      } catch (error) {
        console.error("WhatsApp startup:", error);

        if (root) {
          root.innerHTML = `
            <div class="wa-empty">
              <h2 class="wa-empty-title">
                एप सुरु हुन सकेन
              </h2>

              <p class="wa-empty-text">
                ${escapeHTML(
                  error.message || "सेवा उपलब्ध छैन।"
                )}
              </p>

              <button
                class="wa-button wa-button-primary"
                type="button"
                data-wa-action="retry"
              >
                पुनः प्रयास
              </button>
            </div>
          `;

          const retry = root.querySelector(
            '[data-wa-action="retry"]'
          );

          retry?.addEventListener("click", () => {
            global.location.reload();
          });
        }

        return false;

      } finally {
        state.initializing = false;
        startupPromise = null;
      }
    })();

    return startupPromise;
  }

  /* =====================================================
     INITIALIZE
  ===================================================== */

  async function initialize() {
    if (state.initialized) return true;

    root = getRoot();

    bindEvents();
    bindRealtimeEvents();

    try {
      const auth = service("auth");

      await auth.initialize();

      if (!auth.isAuthenticated()) {
        state.authenticated = false;
        renderAuthScreen();
        return false;
      }

      state.user = auth.getUser();
      state.authenticated = true;

      return await startApplication();

    } catch (error) {
      console.error("WhatsApp initialization:", error);

      renderAuthScreen(
        error.message || "Authentication उपलब्ध छैन।"
      );

      return false;
    }
  }

  /* =====================================================
     PUBLIC APPLICATION API
  ===================================================== */

  global.KSKWhatsAppApp = Object.freeze({
    initialize,

    getState() {
      return {
        initialized: state.initialized,
        initializing: state.initializing,
        authenticated: state.authenticated,
        page: state.page,
        activeChat: state.activeChat,
        conversationCount: state.conversations.length,
        friendCount: state.friends.friends.length,
        unreadCount: state.conversations.filter(isUnread).length,
        realtime: { ...state.realtime }
      };
    },

    refresh: loadDashboard,

    navigate,

    openChat,

    signOut
  });

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
