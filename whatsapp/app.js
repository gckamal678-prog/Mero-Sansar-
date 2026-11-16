
/* =========================================================
   KSK WHATSAPP — COMPLETE APPLICATION
   File: whatsapp/app.js

   Supabase services:
   - Auth
   - Profile
   - Friends
   - Messages
   - Posts
   - Notifications

   Excluded:
   - Audio calls
   - Video calls
   - Voice recording

   Database-backed features only.
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

    replyTo: null,
    selectedFile: null,
    messageSearch: "",

    requestVersion: 0,
    toastTimer: null
  };

  let root = null;
  let startupPromise = null;
  let eventListenersBound = false;
  let realtimeListenersBound = false;

  /* =====================================================
     UTILITIES
  ===================================================== */

  function service(name) {
    const api = API[name]?.();

    if (!api) {
      throw new Error(
        "आवश्यक Supabase सेवा उपलब्ध छैन: " + name
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
    const words = String(name || "W")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    return words
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

    return new Intl.DateTimeFormat("ne-IN", {
      day: "numeric",
      month: "short"
    }).format(date);
  }

  function formatSize(bytes) {
    const size = Number(bytes) || 0;

    if (size < 1024) return size + " B";
    if (size < 1024 * 1024) {
      return (size / 1024).toFixed(1) + " KB";
    }

    return (size / (1024 * 1024)).toFixed(1) + " MB";
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
    }, 3000);
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

  function currentUserId() {
    return state.user?.id || "";
  }

  function findConversation(id) {
    return state.conversations.find(
      item => String(item.id) === String(id)
    );
  }

  function closeDialog() {
    const element = root?.querySelector("[data-wa-dialog-root]");

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

  /* =====================================================
     ROOT AND APPLICATION SHELL
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
              title="खोज्नुहोस्"
            >⌕</button>

            <button
              class="wa-icon-button"
              type="button"
              data-wa-action="notifications"
              aria-label="सूचनाहरू"
              title="सूचनाहरू"
            >
              ♧
              <span data-wa-notification-count hidden></span>
            </button>

            <button
              class="wa-icon-button"
              type="button"
              data-wa-action="profile"
              aria-label="सेटिङ"
              title="सेटिङ"
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
            data-wa-page="communities"
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
            data-wa-page-content="communities"
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
              data-wa-page="communities"
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
        <section class="wa-empty" style="min-height:100dvh">

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

    button.disabled = true;
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

      button.disabled = false;
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

      if (response.confirmationRequired) {
        showToast(
          "इमेलमा आएको Confirmation Link खोल्नुहोस्।",
          "success"
        );
        return;
      }

      await startApplication();

    } catch (error) {
      showToast(
        error.message || "खाता बनाउन सकिएन।",
        "error"
      );
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
      showToast(
        error.message || "अनुरोध पूरा भएन।",
        "error"
      );
    }
  }

  /* =====================================================
     INITIAL DATA
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

    if (
      conversations.status === "fulfilled" &&
      conversations.value?.ok
    ) {
      state.conversations = conversations.value.data || [];
    }

    if (
      friends.status === "fulfilled" &&
      friends.value?.ok
    ) {
      state.friends = friends.value.data || state.friends;
    }

    if (
      posts.status === "fulfilled" &&
      posts.value?.ok
    ) {
      state.posts = posts.value.data || [];
    }

    if (
      notifications.status === "fulfilled" &&
      notifications.value?.ok
    ) {
      state.notifications = notifications.value.data || [];
    }

    if (profile.status === "fulfilled") {
      state.profile = profile.value || null;
    }

    updateNotificationCount();
    renderCurrentPage();

    return true;
  }

  async function refreshConversations() {
    const response = await service("messages")
      .getConversations();

    state.conversations = resultData(response);

    if (state.page === "chats") {
      renderChats();
    }

    if (state.page === "communities") {
      renderCommunities();
    }

    return state.conversations;
  }

  async function refreshFriends() {
    const response = await service("friends")
      .getDashboard();

    state.friends = resultData(response, state.friends);

    if (state.page === "contacts") {
      renderContacts();
    }

    return state.friends;
  }

  async function refreshUpdates() {
    const response = await service("posts")
      .getFeed({ limit: 40 });

    state.posts = resultData(response);

    if (state.page === "updates") {
      renderUpdates();
    }

    return state.posts;
  }

  /* =====================================================
     NAVIGATION
  ===================================================== */

  function navigate(page) {
    const allowed = [
      "chats",
      "updates",
      "communities",
      "contacts",
      "profile",
      "notifications"
    ];

    if (!allowed.includes(page)) return false;

    state.page = page;
    state.activeChat = null;
    state.messages = [];
    state.replyTo = null;

    service("messages").stopPresence?.();

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

      case "communities":
        renderCommunities();
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

    page.innerHTML = `
      <div class="wa-page-heading">
        <div>
          <h2 class="wa-page-title">Chats</h2>
          <p class="wa-page-description">
            तपाईंका निजी र समूह कुराकानी
          </p>
        </div>

        <button
          class="wa-icon-button"
          type="button"
          data-wa-action="new-chat"
          aria-label="नयाँ च्याट"
          title="नयाँ च्याट"
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
                "कुराकानी भेटिएन",
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
        class="wa-button ${active ? "wa-button-primary" : "wa-button-quiet"}"
        type="button"
        data-wa-chat-filter="${value}"
        style="white-space:nowrap;min-height:34px;padding:6px 13px"
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

    const time = formatTime(item.lastMessageAt);

    return `
      <div
        class="wa-list-row"
        style="cursor:pointer"
        data-wa-conversation-row="${escapeHTML(item.id)}"
      >
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
              </span>

              <span class="wa-row-meta">
                ${escapeHTML(time)}
              </span>
            </span>

            <span class="wa-row-preview">
              ${item.type === "group" ? "👥 " : ""}
              ${escapeHTML(preview)}
            </span>
          </span>
        </button>

        <button
          class="wa-icon-button"
          type="button"
          data-wa-chat-menu="${escapeHTML(item.id)}"
          aria-label="च्याट विकल्प"
          title="च्याट विकल्प"
          style="width:34px;height:34px;flex-basis:34px"
        >⋮</button>
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

            <button
              class="wa-button wa-button-primary"
              type="button"
              data-wa-add-friend="${escapeHTML(person.id)}"
            >
              Add
            </button>
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
  }

  async function sendFriendRequest(userId) {
    const response = await service("friends")
      .sendFriendRequest(userId);

    resultData(response, null);

    state.contactResults = [];

    await refreshFriends();

    showToast("Friend Request पठाइयो।", "success");

    if (state.page === "contacts") {
      renderContacts();
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

  function renderCommunities() {
    const page = root.querySelector(
      '[data-wa-page-content="communities"]'
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

  /* =====================================================
     CHAT DETAIL
  ===================================================== */

  async function openChat(conversationId) {
    const conversation = findConversation(conversationId);

    if (!conversation) {
      showToast("कुराकानी भेटिएन।", "error");
      return;
    }

    state.activeChat = conversation;
    state.page = "chat-detail";
    state.messages = [];
    state.replyTo = null;

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

    renderChatDetail();

    try {
      const response = await service("messages")
        .getMessages(conversationId, { limit: 60 });

      const messages = resultData(response);

      if (state.activeChat?.id !== conversationId) return;

      // Service returns oldest-to-newest. Do not reverse.
      state.messages = messages;

      await hydrateMessageMedia(state.messages);

      renderChatDetail();

      await service("messages").markRead(conversationId);

      service("messages").startPresence(conversationId);

      scrollMessageList();

    } catch (error) {
      showToast(
        error.message || "सन्देश लोड गर्न सकिएन।",
        "error"
      );
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
          >
            ${
              conversation.type === "group"
                ? `${conversation.members?.length || 0} members`
                : "Tap for contact info"
            }
          </span>
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
          background:
            linear-gradient(
              var(--wa-bg),
              var(--wa-bg)
            )
        "
      >
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
                  Replying to: ${escapeHTML(
                    state.replyTo.content || "Message"
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
          title="फाइल जोड्नुहोस्"
        >＋</button>

        <input
          type="file"
          data-wa-file-input
          accept="image/*,video/*,application/pdf,text/plain"
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

    const reply = message.replyToId
      ? `<small style="display:block;color:var(--wa-text-muted)">↪ Reply</small>`
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

          ${reply}

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

            ${mine ? (message.receipts?.length ? "✓✓" : "✓") : ""}
          </div>

          <div style="display:flex;gap:5px;margin-top:5px">
            <button
              type="button"
              data-wa-reply-message="${escapeHTML(message.id)}"
              title="Reply"
              style="border:0;background:transparent;color:var(--wa-text-secondary);font-size:11px"
            >↩ Reply</button>

            ${
              mine && !deleted && message.type === "text"
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
              mine && !deleted
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

    input.disabled = true;

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
        state.messages.push(message);
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
      input.disabled = false;
      input.focus();
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
    const message = state.messages.find(
      item => String(item.id) === String(messageId)
    );

    if (!message) return;

    state.replyTo = message;

    renderChatDetail();

    root.querySelector("[data-wa-message-input]")?.focus();
  }

  async function editMessage(messageId) {
    const message = state.messages.find(
      item => String(item.id) === String(messageId)
    );

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

    state.messages = resultData(response);

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

    const response = await service("messages")
      .searchMessages(state.activeChat.id, term, 50);

    const results = resultData(response);

    showDialog(
      "Search results",
      results.length
        ? `
          <div class="wa-list">
            ${results.map(message => `
              <div class="wa-list-row">
                <div class="wa-row-main">
                  <strong>
                    ${escapeHTML(message.content || message.text || "Attachment")}
                  </strong>
                  <span class="wa-row-preview">
                    ${escapeHTML(formatDate(message.createdAt))}
                  </span>
                </div>
              </div>
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
            नयाँ पोस्ट र गतिविधिहरू
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

          <label class="wa-section-title">
            Name
          </label>

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

          <label class="wa-section-title">
            About
          </label>

          <textarea
            name="bio"
            maxlength="500"
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

          <label class="wa-section-title">
            Location
          </label>

          <input
            name="location"
            maxlength="120"
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

          <label class="wa-section-title">
            Avatar URL
          </label>

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
    if (!root || root.dataset.waEventsBound === "true") {
      return;
    }

    root.dataset.waEventsBound = "true";

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
        showToast(
          error.message || "सन्देश पठाउन सकिएन।",
          "error"
        );
      }
      return;
    }

    if (form.matches("[data-wa-contact-search-form]")) {
      event.preventDefault();

      try {
        const data = new FormData(form);
        await searchUsers(data.get("query"));
      } catch (error) {
        showToast(error.message || "खोज असफल भयो।", "error");
      }
      return;
    }

    if (form.matches("[data-wa-user-search-form]")) {
      event.preventDefault();

      try {
        const data = new FormData(form);
        await searchUsers(data.get("query"));

        const container = root.querySelector(
          "[data-wa-contact-page-results]"
        );

        if (container) {
          container.innerHTML = renderFriendSearchResults();
        }
      } catch (error) {
        showToast(error.message || "खोज असफल भयो।", "error");
      }
      return;
    }

    if (form.matches("[data-wa-create-group]")) {
      event.preventDefault();

      try {
        await createGroup(form);
      } catch (error) {
        showToast(error.message || "समूह बनाउन सकिएन।", "error");
      }
      return;
    }

    if (form.matches("[data-wa-create-post]")) {
      event.preventDefault();

      try {
        await createPost(form);
      } catch (error) {
        showToast(error.message || "Update प्रकाशित भएन।", "error");
      }
      return;
    }

    if (form.matches("[data-wa-update-profile]")) {
      event.preventDefault();

      try {
        await updateProfile(form);
      } catch (error) {
        showToast(error.message || "Profile सुरक्षित भएन।", "error");
      }
      return;
    }

    if (form.matches("[data-wa-global-search]")) {
      event.preventDefault();

      try {
        const data = new FormData(form);
        await performGlobalSearch(data.get("query"));
      } catch (error) {
        showToast(error.message || "खोज असफल भयो।", "error");
      }
    }
  }

  function handleInput(event) {
    const input = event.target;

    if (input.matches("[data-wa-chat-search]")) {
      state.chatSearch = input.value;
      renderChats();

      const next = root.querySelector("[data-wa-chat-search]");

      if (next) {
        next.focus();
        next.setSelectionRange(
          next.value.length,
          next.value.length
        );
      }

      return;
    }

    if (input.matches("[data-wa-message-input]")) {
      if (state.activeChat) {
        service("messages").sendTyping(
          state.activeChat.id,
          Boolean(input.value.trim())
        );
      }
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
        showToast(
          error.message || "फाइल पठाउन सकिएन।",
          "error"
        );
      }

      input.value = "";
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

      if (form) {
        form.requestSubmit();
      }
    }
  }

  /* =====================================================
     SIGN OUT
  ===================================================== */

  async function signOut() {
    try {
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
      showToast(
        error.message || "Log Out असफल भयो।",
        "error"
      );
    }
  }

  /* =====================================================
     REALTIME
  ===================================================== */

  function bindRealtimeEvents() {
    if (realtimeListenersBound) return;

    realtimeListenersBound = true;

    global.addEventListener(
      "ksk:messages-cloud-change",
      async event => {
        if (!state.authenticated) return;

        try {
          await refreshConversations();

          const detail = event.detail || {};

          if (
            state.activeChat &&
            (
              !detail.conversationId ||
              detail.conversationId === state.activeChat.id
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
        if (
          state.authenticated &&
          state.page === "updates"
        ) {
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
      async () => {
        if (!state.authenticated) return;

        try {
          const response = await service("notifications")
            .getNotifications({ limit: 80 });

          state.notifications = resultData(response);

          updateNotificationCount();

          if (state.page === "notifications") {
            renderNotifications();
          }
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
      "ksk:auth-change",
      event => {
        const user = event.detail?.user || null;

        state.user = user;
        state.authenticated = Boolean(user?.id);

        if (!state.authenticated) {
          state.initialized = false;
          state.activeChat = null;
          renderAuthScreen();
        } else if (!state.initialized) {
          startApplication();
        }
      }
    );

    global.addEventListener(
      "ksk:typing-change",
      event => {
        const detail = event.detail || {};

        if (
          !state.activeChat ||
          detail.conversationId !== state.activeChat.id
        ) {
          return;
        }

        const status = root.querySelector(
          "[data-wa-typing-status]"
        );

        if (status && detail.typing) {
          status.textContent = "typing...";
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

        await Promise.allSettled(initializers);

        await loadDashboard();

        state.initialized = true;

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
                onclick="location.reload()"
              >
                पुनः प्रयास
              </button>
            </div>
          `;
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
        authenticated: state.authenticated,
        page: state.page,
        activeChat: state.activeChat,
        conversationCount: state.conversations.length,
        friendCount: state.friends.friends.length
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
