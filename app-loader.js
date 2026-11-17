
"use strict";

/*
 * MERO SANSAR — SEQUENTIAL APP LOADER
 * Loads every service in the required order.
 */

(function (window, document) {
  const VERSION = "20261117-3";

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
    "app-navigation.js"
  ];

  const errorBox = document.getElementById("waLoaderError");

  function showError(file) {
    if (!errorBox) return;

    errorBox.style.display = "block";
    errorBox.textContent =
      "एपको फाइल लोड हुन सकेन: " + file +
      " । इन्टरनेट जाँच गरेर पेज Reload गर्नुहोस्।";
  }

  function loadScript(file) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");

      script.src = "./" + file + "?v=" + VERSION;
      script.async = false;

      script.onload = () => resolve(file);

      script.onerror = () => {
        reject(new Error(file));
      };

      document.head.appendChild(script);
    });
  }

  async function start() {
    for (const file of FILES) {
      try {
        await loadScript(file);
        console.info("[Mero Sansar] Loaded:", file);
      } catch (error) {
        console.error("[Mero Sansar] Load failed:", error);
        showError(file);
        return;
      }
    }

    console.info(
      "[Mero Sansar] All application files loaded."
    );
  }

  start();

})(window, document);
