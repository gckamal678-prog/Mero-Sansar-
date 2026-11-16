/* =========================================================
   MERO SANSAR — WHATSAPP AUTH SERVICE
   File: whatsapp/supabase-auth.js

   Supabase Auth v2
   - Email/password sign in
   - Email verification
   - Sign up
   - Password recovery
   - Session persistence
   - Auth state events

   Browser-safe publishable key only.
   ========================================================= */

(function (global) {
  "use strict";

  if (global.KSKSupabaseAuth) return;

  const SUPABASE_URL =
    "https://sacyjxnobzunrwzxhwjs.supabase.co";

  const SUPABASE_PUBLISHABLE_KEY =
    "sb_publishable_IikjX5V1uUuhVuCUt569nw_ORYE5cQH";

  const SDK_URL =
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";

  let client = null;
  let session = null;
  let sdkPromise = null;
  let initializationPromise = null;
  let authSubscription = null;
  let recoveryMode = false;

  function emit(name, detail = {}) {
    global.dispatchEvent(
      new CustomEvent(name, { detail })
    );
  }

  function isVerified(user) {
    return Boolean(
      user?.email_confirmed_at ||
      user?.confirmed_at
    );
  }

  function getUser() {
    if (!session?.user || !isVerified(session.user)) {
      return null;
    }

    return session.user;
  }

  function isAuthenticated() {
    return Boolean(getUser() && !recoveryMode);
  }

  function getSession() {
    return isAuthenticated() ? session : null;
  }

  function getClient() {
    return client;
  }

  function loadSDK() {
    if (global.supabase?.createClient) {
      return Promise.resolve(global.supabase);
    }

    if (sdkPromise) return sdkPromise;

    sdkPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector(
        'script[data-mero-supabase-sdk]'
      );

      const script = existing || document.createElement("script");

      const onLoad = () => {
        if (global.supabase?.createClient) {
          resolve(global.supabase);
        } else {
          sdkPromise = null;
          reject(new Error("Supabase SDK उपलब्ध भएन।"));
        }
      };

      const onError = () => {
        sdkPromise = null;
        reject(new Error(
          "Supabase SDK लोड भएन। इन्टरनेट जाँच गर्नुहोस्।"
        ));
      };

      script.addEventListener("load", onLoad, { once: true });
      script.addEventListener("error", onError, { once: true });

      if (!existing) {
        script.src = SDK_URL;
        script.async = true;
        script.dataset.meroSupabaseSdk = "true";
        document.head.appendChild(script);
      } else if (global.supabase?.createClient) {
        resolve(global.supabase);
      }
    });

    return sdkPromise;
  }

  async function initialize() {
    if (client && session !== undefined) return true;
    if (initializationPromise) return initializationPromise;

    initializationPromise = (async () => {
      const sdk = await loadSDK();

      if (!client) {
        client = sdk.createClient(
          SUPABASE_URL,
          SUPABASE_PUBLISHABLE_KEY,
          {
            auth: {
              persistSession: true,
              autoRefreshToken: true,
              detectSessionInUrl: true,
              flowType: "pkce"
            },
            global: {
              headers: {
                "X-Client-Info": "mero-sansar-whatsapp"
              }
            }
          }
        );
      }

      const result = await client.auth.getSession();

      if (result.error) throw result.error;

      session = result.data?.session || null;

      if (session?.user && !isVerified(session.user)) {
        await client.auth.signOut();
        session = null;
      }

      if (!authSubscription) {
        const response = client.auth.onAuthStateChange(
          (event, nextSession) => {
            session = nextSession || null;

            if (event === "PASSWORD_RECOVERY") {
              recoveryMode = true;
              emit("ksk:password-recovery");
            }

            if (event === "SIGNED_OUT") {
              recoveryMode = false;
            }

            if (
              session?.user &&
              !isVerified(session.user)
            ) {
              session = null;
              recoveryMode = false;

              Promise.resolve().then(() => {
                client.auth.signOut().catch(console.error);
              });
            }

            if (
              event === "SIGNED_IN" ||
              event === "SIGNED_OUT" ||
              event === "TOKEN_REFRESHED" ||
              event === "USER_UPDATED"
            ) {
              emit("ksk:auth-change", {
                user: isAuthenticated() ? session.user : null,
                recoveryMode
              });
            }
          }
        );

        authSubscription =
          response.data?.subscription || null;
      }

      emit("ksk:auth-ready", {
        user: isAuthenticated() ? session.user : null,
        recoveryMode
      });

      return true;
    })();

    try {
      return await initializationPromise;
    } catch (error) {
      initializationPromise = null;
      client = null;
      session = null;
      throw error;
    }
  }

  async function signUp(email, password) {
    await initialize();

    const cleanEmail = String(email || "")
      .trim()
      .toLowerCase();

    const cleanPassword = String(password || "");

    if (!cleanEmail || !cleanPassword) {
      throw new Error("इमेल र पासवर्ड आवश्यक छ।");
    }

    if (cleanPassword.length < 8) {
      throw new Error("पासवर्ड कम्तीमा ८ अक्षरको हुनुपर्छ।");
    }

    const result = await client.auth.signUp({
      email: cleanEmail,
      password: cleanPassword,
      options: {
        emailRedirectTo:
          global.location.origin + global.location.pathname
      }
    });

    if (result.error) throw result.error;

    session = result.data?.session || null;

    if (
      session &&
      !isVerified(result.data?.user)
    ) {
      await client.auth.signOut();
      session = null;
    }

    recoveryMode = false;

    return {
      user: result.data?.user || null,
      session,
      confirmationRequired: !isVerified(result.data?.user)
    };
  }

  async function signIn(email, password) {
    await initialize();

    const cleanEmail = String(email || "")
      .trim()
      .toLowerCase();

    const result = await client.auth.signInWithPassword({
      email: cleanEmail,
      password: String(password || "")
    });

    if (result.error) throw result.error;

    const user = result.data?.user;
    const newSession = result.data?.session;

    if (!isVerified(user)) {
      await client.auth.signOut();
      session = null;

      throw new Error(
        "तपाईंको इमेल पुष्टि भएको छैन। इमेलमा आएको Confirmation Link खोल्नुहोस्।"
      );
    }

    if (!newSession) {
      throw new Error("Login Session प्राप्त भएन। फेरि प्रयास गर्नुहोस्।");
    }

    session = newSession;
    recoveryMode = false;

    emit("ksk:auth-change", {
      user,
      recoveryMode: false
    });

    return {
      user,
      session
    };
  }

  async function signOut() {
    await initialize();

    const result = await client.auth.signOut();

    if (result.error) throw result.error;

    session = null;
    recoveryMode = false;

    emit("ksk:auth-change", {
      user: null,
      recoveryMode: false
    });

    return true;
  }

  async function resetPassword(email) {
    await initialize();

    const cleanEmail = String(email || "")
      .trim()
      .toLowerCase();

    if (!cleanEmail) {
      throw new Error("इमेल ठेगाना लेख्नुहोस्।");
    }

    const result = await client.auth.resetPasswordForEmail(
      cleanEmail,
      {
        redirectTo:
          global.location.origin + global.location.pathname
      }
    );

    if (result.error) throw result.error;

    return true;
  }

  async function updatePassword(password) {
    await initialize();

    if (!isAuthenticated()) {
      throw new Error("पहिले आफ्नो खातामा प्रवेश गर्नुहोस्।");
    }

    const cleanPassword = String(password || "");

    if (cleanPassword.length < 8) {
      throw new Error("नयाँ पासवर्ड कम्तीमा ८ अक्षरको हुनुपर्छ।");
    }

    const result = await client.auth.updateUser({
      password: cleanPassword
    });

    if (result.error) throw result.error;

    return true;
  }

  async function changePassword(currentPassword, newPassword) {
    await initialize();

    const user = getUser();

    if (!user?.email) {
      throw new Error("पहिले आफ्नो खातामा प्रवेश गर्नुहोस्।");
    }

    const verification = await client.auth.signInWithPassword({
      email: user.email,
      password: String(currentPassword || "")
    });

    if (verification.error) throw verification.error;

    session = verification.data?.session || session;

    return updatePassword(newPassword);
  }

  global.KSKSupabaseAuth = Object.freeze({
    initialize,
    getClient,
    getSession,
    getUser,
    isAuthenticated,
    isPasswordRecovery() {
      return recoveryMode;
    },
    signUp,
    signIn,
    signOut,
    resetPassword,
    updatePassword,
    changePassword
  });

})(window);
