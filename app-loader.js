
"use strict";

/*
 * MERO SANSAR — WHATSAPP APPLICATION LOADER
 * Version: 20261117-4
 *
 * Loads Supabase services in dependency order.
 * Stops safely when a required service fails.
 */

(function (window, document) {
  const VERSION = "20261117-4";

  const FILES = [
    "supabase-auth.js",
    "supabase-profile.js",
    "supabase-friends.js",
    "supabase-messages.js",
    "supabase-posts.js",
    "supabase-notifications.js",
    "supabase-friend-request-ui.js",
    "supabase-chat-reliability.js",
    "app.js",
    "app-navigation.js",
    "supabase-notification-navigation.js"
  ];

  const errorBox = document.getElementById("waLoaderError");

  let started = false;

  function showError(file, error) {
    console.error("[Mero Sansar] Loading error:", file, error);

    if (!errorBox) return;

    errorBox.style.display = "block";
    errorBox.textContent =
      "एपको आवश्यक फाइल लोड भएन: " + file +
      " । कृपया फाइलको नाम र GitHub Root जाँच गर्नुहोस्।";
  }

  function loadScript(file) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");

      script.src = "./" + file + "?v=" + VERSION;
      script.async = false;

      script.onload = () => {
        console.info("[Mero Sansar] Loaded:", file);
        resolve(file);
      };

      script.onerror = () => {
        reject(new Error("Failed to load " + file));
      };

      document.head.appendChild(script);
    });
  }

  async function start() {
    if (started) return;

    started = true;

    for (const file of FILES) {
      try {
        await loadScript(file);
      } catch (error) {
        showError(file, error);
        started = false;
        return;
      }
    }

    console.info(
      "[Mero Sansar] All application services loaded."
    );
  }

  start();

})(window, document);
