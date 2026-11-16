/* =========================================================
   MERO SANSAR — WHATSAPP STYLE APPLICATION
   File: whatsapp/app.js

   Connected services:
   - KSKSupabaseAuth
   - KSKSupabaseMessages
   - KSKSupabaseFriends
   - KSKSupabasePosts
   - KSKSupabaseProfile
   - KSKSupabaseNotifications

   Excluded:
   - Video calls
   - Audio calls
   - Voice recording
   ========================================================= */

(function (global) {
  "use strict";

  if (global.KSKWhatsAppApp) return;

  const SERVICES = {
    auth: () => global.KSKSupabaseAuth,
    messages: () => global.KSKSupabaseMessages,
    friends: () => global.KSKSupabaseFriends,
    posts: () => global.KSKSupabasePosts,
    profile: () => global.KSKSupabaseProfile,
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

    conversations: [],
    messages: [],
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

    searchResults: [],
    searchTerm: "",
    loading: false,
    error: ""
  };

  let root = null;
  let toastTimer = null;
  let requestVersion = 0;

  const PAGE_LABELS = {
    chats: "च्याट",
    updates: "अपडेट",
    communities: "समुदाय",
    contacts: "सम्पर्क",
    profile: "प्रोफाइल",
    notifications: "सूचना"
  };

  /* =======================================================
     UTILITIES
  ======================================================= */

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
      const url = new URL(String(value || ""), global.location.href);

      if (url.protocol === "https:" || url.protocol === "http:") {
        return url.href;
      }
    } catch (_) {}

    return "";
  }

  function initials(name) {
    const parts = String(name || "M")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    return parts.slice(0, 2).map(part => part[0]).join("").toUpperCase();
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

  function showToast(message, type = "info") {
    let element = root?.querySelector("[data-wa-toast]");

    if (!element) return;

    element.textContent = String(message || "");
    element.dataset.type = type;
    element.hidden = !message;

    if (toastTimer) {
      global.clearTimeout(toastTimer);
    }

    toastTimer = global.setTimeout(() => {
      element.hidden = true;
    }, 3200);
  }

  function service(name) {
    const api = SERVICES[name]?.();

    if (!api) {
      throw new Error(
        "आवश्यक सेवा उपलब्ध छैन: " + name
      );
    }

    return api;
  }

  function resultData(result, fallback = []) {
    if (!result?.ok) {
      throw new Error(
        result?.message ||
        result?.error ||
        "डाटा लोड गर्न सकिएन।"
      );
    }

    return result.data ?? fallback;
  }

  function avatarHTML(name, image, size = "") {
    const url = safeURL(image);
    const sizeClass = size ? " " + size : "";

    if (url) {
      return `
        <span class="wa-avatar${sizeClass}">
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
      <span class="wa-avatar${sizeClass}">
        ${escapeHTML(initials(name))}
      </span>
    `;
  }

  function setBusy(value) {
    state.loading = Boolean(value);

    root?.querySelectorAll("[data-wa-busy]").forEach(element => {
      element.disabled = state.loading;
    });
  }

  /* =======================================================
     ROOT AND APPLICATION SHELL
  ======================================================= */

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
              <h1 class="wa-brand-title">Mero Sansar</h1>
              <p class="wa-brand-subtitle">
                सबै कुराकानी र समुदाय एकै ठाउँमा
              </p>
            </div>
          </div>

          <div class="wa-header-actions">
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
              aria-label="प्रोफाइल"
              title="प्रोफाइल"
            >
              👤
            </button>
          </div>
        </header>

        <main class="wa-content" id="waMain">

          <section
            class="wa-page is-active"
            data-wa-page-content="chats"
          ></section>

          <section
            class="wa-page"
            data-wa-page-content="updates"
          ></section>

          <section
            class="wa-page"
            data-wa-page-content="communities"
          ></section>

          <section
            class="wa-page"
            data-wa-page-content="contacts"
          ></section>

          <section
            class="wa-page"
            data-wa-page-content="profile"
          ></section>

          <section
            class="wa-page"
            data-wa-page-content="notifications"
          ></section>

          <section
            class="wa-page"
            data-wa-page-content="chat-detail"
          ></section>

        </main>

        <nav class="wa-bottom-nav" aria-label="मुख्य Navigation">
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
              data-wa-page="contacts"
            >
              <span class="wa-nav-icon">☷</span>
              <span>Contacts</span>
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

  /* =======================================================
     AUTHENTICATION SCREEN
  ======================================================= */

  function renderAuthScreen(message = "") {
    root.innerHTML = `
      <div class="wa-shell">
        <section class="wa-empty" style="min-height:100dvh">

          <div class="wa-empty-icon">💬</div>

          <h1 class="wa-page-title">
            Mero Sansar
          </h1>

          <p class="wa-empty-text">
            आफ्नो खातामा प्रवेश गरेर कुराकानी सुरु गर्नुहोस्।
          </p>

          <form
            data-wa-auth-form
            class="wa-card"
            style="width:min(100%,390px);padding:20px;margin-top:20px;text-align:left"
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
              style="width:100%;padding:12px;border:1px solid var(--wa-border);border-radius:10px;background:var(--wa-surface);color:var(--wa-text);margin:8px 0 16px"
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
              style="width:100%;padding:12px;border:1px solid var(--wa-border);border-radius:10px;background:var(--wa-surface);color:var(--wa-text);margin:8px 0 16px"
            >

            <p
              data-wa-auth-message
              style="color:var(--wa-danger);font-size:12px"
            >${escapeHTML(message)}</p>

            <button
              class="wa-button wa-button-primary"
              type="submit"
              data-wa-busy
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
    const auth = service("auth");
    const data = new FormData(form);

    const email = String(data.get("email") || "")
      .trim()
      .toLowerCase();

    const password = String(data.get("password") || "");

    if (!email || !password) return;

    const button = form.querySelector("button[type=submit]");
    const status = form.querySelector("[data-wa-auth-message]");

    button.disabled = true;
    status.textContent = "प्रवेश गर्दै...";

    try {
      await auth.signIn(email, password);

      state.user = auth.getUser();
      state.authenticated = auth.isAuthenticated();

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
      const result = await service("auth").signUp(email, password);

      if (result.confirmationRequired) {
        showToast(
          "इमेलमा आएको Confirmation Link खोल्नुहोस्।",
          "success"
        );
        return;
      }

      await startApplication();

    } catch (error) {
      showToast(error.message || "खाता बनाउन सकिएन।", "error");
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
      showToast("Password reset इमेल पठाइयो।", "success");
    } catch (error) {
      showToast(error.message || "अनुरोध पूरा भएन।", "error");
    }
  }

  /* =======================================================
     INITIAL DATA
  ======================================================= */

  async function loadDashboard() {
    if (!state.authenticated) return false;

    const version = ++requestVersion;

    const jobs = await Promise.allSettled([
      service("messages").getConversations(),
      service("friends").getDashboard(),
      service("posts").getFeed({ limit: 40 }),
      service("notifications").getNotifications({ limit: 80 }),
      service("profile").getMyProfile()
    ]);

    if (version !== requestVersion) return false;

    const [
      conversations,
      friends,
      posts,
      notifications,
      profile
    ] = jobs;

    if (conversations.status === "fulfilled" && conversations.value?.ok) {
      state.conversations = conversations.value.data || [];
    }

    if (friends.status === "fulfilled" && friends.value?.ok) {
      state.friends = friends.value.data || state.friends;
    }

    if (posts.status === "fulfilled" && posts.value?.ok) {
      state.posts = posts.value.data || [];
    }

    if (notifications.status === "fulfilled" && notifications.value?.ok) {
      state.notifications = notifications.value.data || [];
    }

    if (profile.status === "fulfilled") {
      state.profile = profile.value || null;
    }

    updateNotificationCount();
    renderCurrentPage();

    return true;
  }

  /* =======================================================
     PAGE NAVIGATION
  ======================================================= */

  function navigate(page) {
    if (!PAGE_LABELS[page]) return false;

    state.page = page;
    state.activeChat = null;
    state.messages = [];

    root.querySelectorAll("[data-wa-page-content]").forEach(section => {
      const active = section.dataset.waPageContent === page;

      section.classList.toggle("is-active", active);
      section.hidden = !active;
    });

    root.querySelectorAll("[data-wa-page]").forEach(button => {
      const active = button.dataset.waPage === page;

      button.classList.toggle("is-active", active);

      if (active) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
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

  /* =======================================================
     CHATS
  ======================================================= */

  function renderChats() {
    const page = root.querySelector('[data-wa-page-content="chats"]');
    if (!page) return;

    const conversations = state.conversations || [];

    page.innerHTML = `
      <div class="wa-page-heading">
        <div>
          <h2 class="wa-page-title">Chats</h2>
          <p class="wa-page-description">
            साथी र समूहसँगका कुराकानी
          </p>
        </div>

        <button
          class="wa-icon-button"
          type="button"
          data-wa-action="new-chat"
          title="नयाँ कुराकानी"
          aria-label="नयाँ कुराकानी"
        >＋</button>
      </div>

      <label class="wa-search">
        <span>⌕</span>
        <input
          type="search"
          placeholder="कुराकानी खोज्नुहोस्"
          data-wa-chat-search
          autocomplete="off"
        >
      </label>

      <div class="wa-list" data-wa-chat-list>
        ${
          conversations.length
            ? conversations.map(renderConversation).join("")
            : emptyState(
                "अहिलेसम्म कुराकानी छैन",
                "साथी छानेर नयाँ कुराकानी सुरु गर्नुहोस्।",
                "💬"
              )
        }
      </div>
    `;
  }

  function renderConversation(item) {
    const name = item.name || item.title || "कुराकानी";
    const message = item.lastMessage || {};
    const preview = message.content ||
      (message.deletedForEveryone ? "यो सन्देश मेटाइएको छ।" : "नयाँ कुराकानी");

    const time = formatTime(item.lastMessageAt);
    const group = item.type === "group";

    return `
      <button
        class="wa-list-row"
        type="button"
        data-wa-open-chat="${escapeHTML(item.id)}"
        data-search-name="${escapeHTML(name.toLowerCase())}"
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
            ${group ? "👥 " : ""}
            ${escapeHTML(preview)}
          </span>
        </span>

      </button>
    `;
  }

  async function openChat(conversationId) {
    const conversation = state.conversations.find(
      item => String(item.id) === String(conversationId)
    );

    if (!conversation) {
      showToast("कुराकानी भेटिएन।", "error");
      return;
    }

    state.activeChat = conversation;
    state.page = "chat-detail";

    root.querySelectorAll("[data-wa-page-content]").forEach(section => {
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

      state.messages = messages.slice().reverse();

      renderChatDetail();

      await service("messages").markRead(conversationId);

    } catch (error) {
      showToast(error.message || "सन्देश लोड गर्न सकिएन।", "error");
    }
  }

  function renderChatDetail() {
    const page = root.querySelector(
      '[data-wa-page-content="chat-detail"]'
    );

    const conversation = state.activeChat;

    if (!page || !conversation) return;

    const messages = state.messages || [];

    page.innerHTML = `
      <div class="wa-chat-header wa-header">

        <button
          class="wa-icon-button"
          type="button"
          data-wa-action="back-to-chats"
          aria-label="पछाडि"
        >‹</button>

        ${avatarHTML(conversation.name, conversation.avatar, "is-small")}

        <div class="wa-row-main">
          <strong>${escapeHTML(conversation.name)}</strong>
          <div class="wa-row-preview">
            ${
              conversation.type === "group"
                ? `${conversation.members?.length || 0} सदस्य`
                : "कुराकानी"
            }
          </div>
        </div>

      </div>

      <div
        class="wa-message-list"
        data-wa-message-list
        style="padding:16px;min-height:55dvh;display:flex;flex-direction:column;gap:9px"
      >
        ${
          messages.length
            ? messages.map(renderMessage).join("")
            : emptyState(
                "नयाँ कुराकानी",
                "यहाँ आफ्नो पहिलो सन्देश पठाउनुहोस्।",
                "💬"
              )
        }
      </div>

      <form
        data-wa-send-message
        class="wa-message-composer"
        style="position:sticky;bottom:0;display:flex;gap:8px;padding:12px;background:var(--wa-surface);border-top:1px solid var(--wa-border)"
      >

        <input
          name="content"
          type="text"
          maxlength="5000"
          autocomplete="off"
          placeholder="सन्देश लेख्नुहोस्..."
          required
          style="flex:1;min-width:0;border:0;border-radius:22px;background:var(--wa-surface-soft);padding:12px 16px;color:var(--wa-text)"
        >

        <button
          class="wa-button wa-button-primary"
          type="submit"
          data-wa-busy
        >➤</button>

      </form>
    `;

    const list = page.querySelector("[data-wa-message-list]");

    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }

  function renderMessage(message) {
    const own = String(message.senderId) === String(state.user?.id);
    const content = message.deletedForEveryone
      ? "यो सन्देश मेटाइएको छ।"
      : message.content || "";

    return `
      <div
        style="
          align-self:${own ? "flex-end" : "flex-start"};
          max-width:84%;
          min-width:70px;
          padding:9px 12px;
          border-radius:13px;
          background:${own ? "var(--wa-primary)" : "var(--wa-surface)"};
          color:${own ? "#fff" : "var(--wa-text)"};
          border:1px solid var(--wa-border);
          box-shadow:var(--wa-shadow-sm);
          overflow-wrap:anywhere
        "
      >
        <div>${escapeHTML(content)}</div>

        <div style="margin-top:4px;text-align:right;font-size:10px;opacity:.7">
          ${escapeHTML(formatTime(message.createdAt))}
          ${own ? " ✓" : ""}
        </div>
      </div>
    `;
  }

  async function sendMessage(form) {
    const conversation = state.activeChat;
    if (!conversation) return;

    const input = form.elements.content;
    const content = String(input.value || "").trim();

    if (!content) return;

    const button = form.querySelector("button[type=submit]");
    button.disabled = true;

    try {
      const response = await service("messages")
        .sendMessage(conversation.id, content);

      const message = resultData(response, null);

      if (message) {
        state.messages.push(message);
      }

      input.value = "";

      renderChatDetail();

      await refreshConversations();

    } catch (error) {
      showToast(error.message || "सन्देश पठाउन सकिएन।", "error");
      button.disabled = false;
    }
  }

  async function refreshConversations() {
    try {
      const response = await service("messages").getConversations();
      state.conversations = resultData(response);
      if (state.page === "chats") renderChats();
    } catch (error) {
      console.warn("Chat refresh failed:", error);
    }
  }

  /* =======================================================
     UPDATES — POSTS AND SOCIAL FEED
  ======================================================= */

  function renderUpdates() {
    const page = root.querySelector('[data-wa-page-content="updates"]');
    if (!page) return;

    page.innerHTML = `
      <div class="wa-page-heading">
        <div>
          <h2 class="wa-page-title">Updates</h2>
          <p class="wa-page-description">
            साथीहरूका नयाँ पोस्ट र गतिविधि
          </p>
        </div>

        <button
          class="wa-icon-button"
          type="button"
          data-wa-action="refresh-updates"
          aria-label="Refresh"
        >↻</button>
      </div>

      <div class="wa-section">
        <div style="display:flex;align-items:center;gap:12px">
          ${avatarHTML(
            state.profile?.name || "तपाईं",
            state.profile?.avatarUrl || state.profile?.avatar
          )}

          <button
            class="wa-button wa-button-quiet"
            type="button"
            data-wa-action="create-post"
            style="flex:1;justify-content:flex-start"
          >
            के सोच्दै हुनुहुन्छ?
          </button>
        </div>
      </div>

      <div data-wa-post-list>
        ${
          state.posts.length
            ? state.posts.map(renderPost).join("")
            : emptyState(
                "अहिले कुनै पोस्ट छैन",
                "नयाँ पोस्ट प्रकाशित गरेर आफ्नो अपडेट साझा गर्नुहोस्।",
                "◉"
              )
        }
      </div>
    `;
  }

  function renderPost(post) {
    const author = post.authorName || post.name || "Mero Sansar User";
    const avatar = post.authorAvatarUrl || post.avatarUrl || "";
    const media = safeURL(post.mediaUrl || post.media_url);
    const content = post.content || post.text || "";

    return `
      <article class="wa-section" data-wa-post="${escapeHTML(post.id)}">

        <div style="display:flex;align-items:center;gap:10px">
          ${avatarHTML(author, avatar, "is-small")}

          <div class="wa-row-main">
            <strong>${escapeHTML(author)}</strong>
            <div class="wa-row-preview">
              ${escapeHTML(formatDate(post.createdAt || post.created_at))}
            </div>
          </div>
        </div>

        ${
          content
            ? `<p style="white-space:pre-wrap;overflow-wrap:anywhere;margin:14px 0">${escapeHTML(content)}</p>`
            : ""
        }

        ${
          media
            ? `<img src="${escapeHTML(media)}" alt="पोस्टको फोटो" loading="lazy" style="width:100%;max-height:440px;object-fit:cover;border-radius:12px">`
            : ""
        }

      </article>
    `;
  }

  function renderCreatePostDialog() {
    const dialog = root.querySelector("[data-wa-dialog-root]");

    dialog.innerHTML = `
      <div class="wa-dialog-backdrop" data-wa-close-dialog>
        <section
          class="wa-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="waPostDialogTitle"
        >

          <header class="wa-dialog-header">
            <h2 class="wa-dialog-title" id="waPostDialogTitle">
              नयाँ Update
            </h2>

            <button
              class="wa-icon-button"
              type="button"
              data-wa-action="close-dialog"
              aria-label="बन्द गर्नुहोस्"
            >×</button>
          </header>

          <form data-wa-create-post class="wa-dialog-body">

            <textarea
              name="text"
              rows="5"
              maxlength="10000"
              placeholder="के सोच्दै हुनुहुन्छ?"
              style="width:100%;padding:12px;border:1px solid var(--wa-border);border-radius:12px;background:var(--wa-surface);color:var(--wa-text);resize:vertical"
            ></textarea>

            <label style="display:block;margin:14px 0;color:var(--wa-text-secondary)">
              फोटो थप्नुहोस्
              <input
                type="file"
                name="media"
                accept="image/*"
                style="display:block;margin-top:8px"
              >
            </label>

            <button
              class="wa-button wa-button-primary"
              type="submit"
              data-wa-busy
              style="width:100%"
            >
              प्रकाशित गर्नुहोस्
            </button>

          </form>

        </section>
      </div>
    `;
  }

  async function createPost(form) {
    const data = new FormData(form);

    const response = await service("posts").createPost({
      text: String(data.get("text") || ""),
      media: data.get("media")?.size
        ? data.get("media")
        : null
    });

    resultData(response, null);

    root.querySelector("[data-wa-dialog-root]").innerHTML = "";

    await refreshUpdates();

    showToast("पोस्ट प्रकाशित भयो।", "success");
  }

  async function refreshUpdates() {
    const response = await service("posts").getFeed({ limit: 40 });

    state.posts = resultData(response);
    renderUpdates();
  }

  /* =======================================================
     COMMUNITIES — EXISTING GROUP CONVERSATIONS
  ======================================================= */

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
          <h2 class="wa-page-title">Communities</h2>
          <p class="wa-page-description">
            तपाईं आबद्ध समूहहरू
          </p>
        </div>

        <button
          class="wa-icon-button"
          type="button"
          data-wa-action="create-group"
          aria-label="नयाँ समूह"
        >＋</button>
      </div>

      <div class="wa-section">
        <p class="wa-empty-text">
          यहाँ अहिले तपाईंका समूह कुराकानीहरू देखिन्छन्।
          छुट्टै Community र announcement संरचना अर्को चरणमा database सहित जोडिनेछ।
        </p>
      </div>

      <div class="wa-list">
        ${
          groups.length
            ? groups.map(renderConversation).join("")
            : emptyState(
                "समूह भेटिएन",
                "साथीहरू छानेर नयाँ समूह बनाउन सक्नुहुन्छ।",
                "👥"
              )
        }
      </div>
    `;
  }

  function renderCreateGroupDialog() {
    const friends = state.friends.friends || [];

    if (friends.length < 2) {
      showToast(
        "समूह बनाउन कम्तीमा दुई जना साथी आवश्यक छन्।",
        "error"
      );
      return;
    }

    const dialog = root.querySelector("[data-wa-dialog-root]");

    dialog.innerHTML = `
      <div class="wa-dialog-backdrop" data-wa-close-dialog>
        <section
          class="wa-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="waGroupDialogTitle"
        >

          <header class="wa-dialog-header">
            <h2 class="wa-dialog-title" id="waGroupDialogTitle">
              नयाँ समूह
            </h2>

            <button
              class="wa-icon-button"
              type="button"
              data-wa-action="close-dialog"
            >×</button>
          </header>

          <form data-wa-create-group class="wa-dialog-body">

            <label class="wa-section-title">
              समूहको नाम
            </label>

            <input
              name="title"
              required
              maxlength="60"
              placeholder="समूहको नाम"
              style="width:100%;padding:11px;border:1px solid var(--wa-border);border-radius:10px;background:var(--wa-surface);color:var(--wa-text);margin:8px 0 16px"
            >

            <label class="wa-section-title">
              साथीहरू छान्नुहोस्
            </label>

            <div style="max-height:280px;overflow:auto;margin:8px 0 18px">
              ${friends.map(friend => `
                <label style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--wa-divider)">
                  <input
                    type="checkbox"
                    name="members"
                    value="${escapeHTML(friend.id)}"
                  >
                  ${avatarHTML(friend.name, friend.avatarUrl, "is-small")}
                  <span>${escapeHTML(friend.name)}</span>
                </label>
              `).join("")}
            </div>

            <button
              class="wa-button wa-button-primary"
              type="submit"
              style="width:100%"
            >
              समूह बनाउनुहोस्
            </button>

          </form>
        </section>
      </div>
    `;
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

    resultData(response, null);

    root.querySelector("[data-wa-dialog-root]").innerHTML = "";

    await refreshConversations();

    showToast("समूह बनाइयो।", "success");
  }

  /* =======================================================
     CONTACTS AND FRIEND REQUESTS
  ======================================================= */

  function renderContacts() {
    const page = root.querySelector(
      '[data-wa-page-content="contacts"]'
    );

    if (!page) return;

    const incoming = state.friends.incoming || [];
    const friends = state.friends.friends || [];

    page.innerHTML = `
      <div class="wa-page-heading">
        <div>
          <h2 class="wa-page-title">Contacts</h2>
          <p class="wa-page-description">
            साथीहरू र Friend Requests
          </p>
        </div>
      </div>

      <form data-wa-user-search-form class="wa-search">
        <span>⌕</span>

        <input
          name="query"
          type="search"
          minlength="2"
          maxlength="100"
          placeholder="नामबाट साथी खोज्नुहोस्"
          value="${escapeHTML(state.searchTerm)}"
        >

        <button type="submit" class="wa-button wa-button-primary">
          खोज
        </button>
      </form>

      <div data-wa-search-results>
        ${renderSearchResults()}
      </div>

      ${
        incoming.length
          ? `
            <div class="wa-section">
              <h3 class="wa-section-title">
                Friend Requests (${incoming.length})
              </h3>

              ${incoming.map(item => `
                <div class="wa-list-row">
                  ${avatarHTML(item.person?.name, item.person?.avatarUrl)}

                  <div class="wa-row-main">
                    <strong>${escapeHTML(item.person?.name)}</strong>
                    <div class="wa-row-preview">Friend Request</div>
                  </div>

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
            </div>
          `
          : ""
      }

      <div class="wa-section">
        <h3 class="wa-section-title">
          My Friends (${friends.length})
        </h3>

        ${
          friends.length
            ? friends.map(friend => `
              <div class="wa-list-row">
                ${avatarHTML(friend.name, friend.avatarUrl)}

                <div class="wa-row-main">
                  <strong>${escapeHTML(friend.name)}</strong>
                  <div class="wa-row-preview">साथी</div>
                </div>

                <button
                  class="wa-icon-button"
                  type="button"
                  data-wa-open-friend-chat="${escapeHTML(friend.id)}"
                  title="Message"
                >💬</button>

                <button
                  class="wa-icon-button"
                  type="button"
                  data-wa-open-profile="${escapeHTML(friend.id)}"
                  title="Profile"
                >👤</button>
              </div>
            `).join("")
            : emptyState(
                "साथी छैनन्",
                "नाम खोजेर Friend Request पठाउन सक्नुहुन्छ।",
                "👥"
              )
        }
      </div>
    `;
  }

  function renderSearchResults() {
    const results = state.searchResults || [];

    if (!results.length) return "";

    return `
      <div class="wa-section">
        <h3 class="wa-section-title">Search Results</h3>

        ${results.map(person => `
          <div class="wa-list-row">
            ${avatarHTML(person.name, person.avatarUrl)}

            <div class="wa-row-main">
              <strong>${escapeHTML(person.name)}</strong>
            </div>

            <button
              class="wa-button wa-button-primary"
              type="button"
              data-wa-send-friend-request="${escapeHTML(person.id)}"
            >Add</button>
          </div>
        `).join("")}
      </div>
    `;
  }

  async function searchUsers(form) {
    const data = new FormData(form);
    const query = String(data.get("query") || "").trim();

    if (query.length < 2) {
      showToast("कम्तीमा दुई अक्षर लेख्नुहोस्।", "error");
      return;
    }

    state.searchTerm = query;

    const response = await service("friends")
      .searchUsers(query, { limit: 20 });

    state.searchResults = resultData(response);

    renderContacts();
  }

  async function friendAction(action, requestId) {
    const api = service("friends");

    const response = await api.respondToFriendRequest(
      requestId,
      action === "accept" ? "accepted" : "rejected"
    );

    resultData(response, null);

    await refreshFriends();

    showToast(
      action === "accept"
        ? "Friend Request स्वीकार भयो।"
        : "Friend Request अस्वीकार भयो।",
      "success"
    );
  }

  async function sendFriendRequest(userId) {
    const response = await service("friends")
      .sendFriendRequest(userId);

    resultData(response, null);

    state.searchResults = [];

    await refreshFriends();

    showToast("Friend Request पठाइयो।", "success");
  }

  async function refreshFriends() {
    const response = await service("friends").getDashboard();

    state.friends = resultData(response, state.friends);

    if (state.page === "contacts") {
      renderContacts();
    }
  }

  async function openFriendChat(friendId) {
    const response = await service("messages")
      .createDirectChat(friendId);

    const conversationId = resultData(response, null);

    await refreshConversations();

    if (conversationId) {
      await openChat(conversationId);
    }
  }

  /* =======================================================
     PROFILE AND SETTINGS
  ======================================================= */

  function renderProfile() {
    const page = root.querySelector(
      '[data-wa-page-content="profile"]'
    );

    if (!page) return;

    const profile = state.profile || {};
    const name = profile.name || state.user?.email || "मेरो प्रोफाइल";

    page.innerHTML = `
      <div class="wa-page-heading">
        <h2 class="wa-page-title">Settings</h2>
      </div>

      <div class="wa-section">
        <div style="display:flex;align-items:center;gap:15px">
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
          </div>
        </div>
      </div>

      <div class="wa-section">

        <h3 class="wa-section-title">Account</h3>

        <div class="wa-disclosure" aria-expanded="false">
          <button
            class="wa-disclosure-trigger"
            type="button"
            data-wa-action="toggle-disclosure"
          >
            <span>प्रोफाइल विवरण</span>
            <span>⌄</span>
          </button>

          <div class="wa-disclosure-content">
            <p>नाम: ${escapeHTML(name)}</p>
            <p>Bio: ${escapeHTML(profile.bio || "Bio राखिएको छैन।")}</p>
            <p>स्थान: ${escapeHTML(profile.location || "उल्लेख गरिएको छैन।")}</p>
            <p style="overflow-wrap:anywhere">
              इमेल: ${escapeHTML(state.user?.email || "")}
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
              तपाईंका Message, Friend Request र Post सम्बन्धी
              सूचनाहरू Notification पृष्ठमा देखिन्छन्।
            </p>

            <button
              class="wa-button wa-button-quiet"
              type="button"
              data-wa-action="notifications"
            >
              Notifications खोल्नुहोस्
            </button>
          </div>
        </div>

      </div>

      <div class="wa-section">
        <button
          class="wa-button wa-button-danger"
          type="button"
          data-wa-action="signout"
          style="width:100%"
        >
          Log Out
        </button>
      </div>
    `;
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

  /* =======================================================
     NOTIFICATIONS
  ======================================================= */

  function updateNotificationCount() {
    const count = state.notifications.filter(item => !item.read).length;

    const badge = root?.querySelector("[data-wa-notification-count]");

    if (!badge) return;

    badge.hidden = count === 0;
    badge.textContent = count > 99 ? "99+" : String(count);
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
          सबै पढियो
        </button>
      </div>

      <div class="wa-list">
        ${
          items.length
            ? items.map(item => `
              <button
                class="wa-list-row"
                type="button"
                data-wa-notification="${escapeHTML(item.id)}"
                style="background:${item.read ? "var(--wa-surface)" : "var(--wa-surface-soft)"}"
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
                  item.read
                    ? ""
                    : '<span class="wa-unread-count">नयाँ</span>'
                }
              </button>
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

  async function markNotificationRead(notificationId) {
    const response = await service("notifications")
      .markAsRead(notificationId);

    resultData(response, null);

    const item = state.notifications.find(
      notification => String(notification.id) === String(notificationId)
    );

    if (item) item.read = true;

    updateNotificationCount();
    renderNotifications();
  }

  async function markAllNotificationsRead() {
    const response = await service("notifications").markAllAsRead();

    resultData(response, null);

    state.notifications.forEach(item => {
      item.read = true;
    });

    updateNotificationCount();
    renderNotifications();

    showToast("सबै सूचना पढिएको चिन्ह लगाइयो।", "success");
  }

  /* =======================================================
     EMPTY STATES
  ======================================================= */

  function emptyState(title, description, icon = "○") {
    return `
      <div class="wa-empty">
        <div class="wa-empty-icon">${escapeHTML(icon)}</div>
        <h3 class="wa-empty-title">${escapeHTML(title)}</h3>
        <p class="wa-empty-text">${escapeHTML(description)}</p>
      </div>
    `;
  }

  /* =======================================================
     EVENTS
  ======================================================= */

  function bindEvents() {
    if (!root || root.dataset.waEventsBound === "true") return;

    root.dataset.waEventsBound = "true";

    root.addEventListener("click", handleClick);
    root.addEventListener("submit", handleSubmit);
    root.addEventListener("input", handleInput);
  }

  async function handleClick(event) {
    const target = event.target.closest("button,[data-wa-close-dialog]");

    if (!target) return;

    if (target.matches("[data-wa-close-dialog]")) {
      if (event.target === target) {
        root.querySelector("[data-wa-dialog-root]").innerHTML = "";
      }
      return;
    }

    if (target.dataset.waPage) {
      navigate(target.dataset.waPage);
      return;
    }

    if (target.dataset.waOpenChat) {
      await openChat(target.dataset.waOpenChat);
      return;
    }

    if (target.dataset.waOpenFriendChat) {
      await openFriendChat(target.dataset.waOpenFriendChat);
      return;
    }

    if (target.dataset.waOpenProfile) {
      showToast("सार्वजनिक प्रोफाइलको विस्तृत दृश्य अर्को चरणमा जोडिनेछ।");
      return;
    }

    if (target.dataset.waSendFriendRequest) {
      await sendFriendRequest(target.dataset.waSendFriendRequest);
      return;
    }

    if (target.dataset.waFriendAction) {
      await friendAction(
        target.dataset.waFriendAction,
        target.dataset.waRequestId
      );
      return;
    }

    if (target.dataset.waNotification) {
      await markNotificationRead(target.dataset.waNotification);
      return;
    }

    if (target.dataset.waTheme) {
      setTheme(target.dataset.waTheme);
      return;
    }

    const action = target.dataset.waAction;

    switch (action) {
      case "notifications":
        navigate("notifications");
        break;

      case "profile":
        navigate("profile");
        break;

      case "new-chat":
        navigate("contacts");
        break;

      case "back-to-chats":
        navigate("chats");
        break;

      case "create-post":
        renderCreatePostDialog();
        break;

      case "refresh-updates":
        await refreshUpdates();
        break;

      case "create-group":
        renderCreateGroupDialog();
        break;

      case "close-dialog":
        root.querySelector("[data-wa-dialog-root]").innerHTML = "";
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

      default:
        break;
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
      await sendMessage(form);
      return;
    }

    if (form.matches("[data-wa-create-post]")) {
      event.preventDefault();

      try {
        await createPost(form);
      } catch (error) {
        showToast(error.message || "पोस्ट प्रकाशित भएन।", "error");
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

    if (form.matches("[data-wa-user-search-form]")) {
      event.preventDefault();

      try {
        await searchUsers(form);
      } catch (error) {
        showToast(error.message || "खोज असफल भयो।", "error");
      }
    }
  }

  function handleInput(event) {
    const input = event.target;

    if (input.matches("[data-wa-chat-search]")) {
      const term = input.value.trim().toLowerCase();

      root.querySelectorAll("[data-wa-open-chat]").forEach(row => {
        const name = row.dataset.searchName || "";
        row.hidden = Boolean(term && !name.includes(term));
      });
    }
  }

  /* =======================================================
     SIGN OUT
  ======================================================= */

  async function signOut() {
    try {
      await service("auth").signOut();

      state.authenticated = false;
      state.user = null;
      state.profile = null;
      state.conversations = [];
      state.messages = [];
      state.posts = [];
      state.notifications = [];

      renderAuthScreen();

    } catch (error) {
      showToast(error.message || "Log Out असफल भयो।", "error");
    }
  }

  /* =======================================================
     REALTIME EVENTS
  ======================================================= */

  function bindRealtimeEvents() {
    global.addEventListener("ksk:messages-cloud-change", async () => {
      await refreshConversations();

      if (state.activeChat) {
        try {
          const response = await service("messages")
            .getMessages(state.activeChat.id, { limit: 60 });

          state.messages = resultData(response).slice().reverse();

          if (state.page === "chat-detail") {
            renderChatDetail();
          }
        } catch (error) {
          console.warn("Realtime chat refresh:", error);
        }
      }
    });

    global.addEventListener("ksk:posts-cloud-change", async () => {
      if (state.page === "updates") {
        await refreshUpdates();
      }
    });

    global.addEventListener("ksk:notification-cloud-change", async () => {
      try {
        const response = await service("notifications")
          .getNotifications({ limit: 80 });

        state.notifications = resultData(response);

        updateNotificationCount();

        if (state.page === "notifications") {
          renderNotifications();
        }
      } catch (error) {
        console.warn("Notification refresh:", error);
      }
    });

    global.addEventListener("ksk:friends-cloud-change", async () => {
      await refreshFriends();
    });

    global.addEventListener("ksk:auth-change", event => {
      const user = event.detail?.user || null;

      state.user = user;
      state.authenticated = Boolean(user?.id);

      if (!state.authenticated) {
        renderAuthScreen();
      } else {
        startApplication();
      }
    });
  }

  /* =======================================================
     START APPLICATION
  ======================================================= */

  async function startApplication() {
    if (state.initializing) return false;

    state.initializing = true;

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

      renderShell();

      await Promise.allSettled([
        service("messages").initialize(),
        service("friends").initialize(),
        service("posts").initialize(),
        service("notifications").initialize(),
        service("profile").initialize()
      ]);

      await loadDashboard();

      state.initialized = true;

      return true;

    } catch (error) {
      console.error("Mero Sansar initialization:", error);

      if (root) {
        root.innerHTML = `
          <div class="wa-empty">
            <h2 class="wa-empty-title">
              एप सुरु हुन सकेन
            </h2>

            <p class="wa-empty-text">
              ${escapeHTML(error.message || "सेवा उपलब्ध छैन।")}
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

        root.addEventListener("click", event => {
          if (event.target.closest('[data-wa-action="retry"]')) {
            startApplication();
          }
        }, { once: true });
      }

      return false;

    } finally {
      state.initializing = false;
    }
  }

  /* =======================================================
     INITIALIZE
  ======================================================= */

  async function initialize() {
    if (state.initialized) return true;

    if (state.initializing) return false;

    root = getRoot();

    bindRealtimeEvents();

    try {
      const auth = service("auth");

      await auth.initialize();

      if (!auth.isAuthenticated()) {
        renderAuthScreen();
        return false;
      }

      return await startApplication();

    } catch (error) {
      console.error("Mero Sansar startup:", error);

      renderAuthScreen(error.message || "Authentication उपलब्ध छैन।");

      return false;
    }
  }

  /* =======================================================
     PUBLIC API
  ======================================================= */

  global.KSKWhatsAppApp = Object.freeze({
    initialize,
    navigate,
    refresh: loadDashboard,

    openChat,
    refreshConversations,
    refreshFriends,
    refreshUpdates,

    getState() {
      return {
        page: state.page,
        authenticated: state.authenticated,
        conversations: state.conversations.length,
        friends: state.friends.friends?.length || 0,
        posts: state.posts.length,
        notifications: state.notifications.length
      };
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, {
      once: true
    });
  } else {
    initialize();
  }

})(window);
