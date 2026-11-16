
"use strict";

/*
 * KSK WHATSAPP — SUPABASE PROFILE SERVICE
 *
 * Supabase table: public.profiles
 * Authentication: KSKSupabaseAuth
 *
 * Features:
 * - Load current user's profile
 * - Load another user's public profile
 * - Update authenticated user's own profile
 * - Normalize profile fields for WhatsApp UI
 * - Safe validation and error handling
 * - Profile update events
 */

(function (global) {
  "use strict";

  if (global.KSKSupabaseProfile) return;

  const TABLE = "profiles";

  const PROFILE_COLUMNS = [
    "id",
    "name",
    "first_name",
    "last_name",
    "bio",
    "location",
    "avatar_url",
    "cover_url",
    "created_at",
    "updated_at",
    "onboarding_completed"
  ].join(",");

  let initializePromise = null;

  function auth() {
    return global.KSKSupabaseAuth || null;
  }

  function result(ok, code, data = null, message = "") {
    return { ok, code, data, message };
  }

  function fail(code, message) {
    return result(false, code, null, message);
  }

  function emit(name, detail = {}) {
    try {
      global.dispatchEvent(
        new CustomEvent(name, { detail })
      );
    } catch (error) {
      console.warn("Profile event failed:", error);
    }
  }

  function normalizeId(value) {
    const id = String(value || "").trim();

    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      ? id
      : "";
  }

  function normalizeProfile(row) {
    if (!row) return null;

    const firstName = row.first_name || "";
    const lastName = row.last_name || "";
    const name = row.name || [
      firstName,
      lastName
    ].filter(Boolean).join(" ");

    const avatar = row.avatar_url || "";
    const cover = row.cover_url || "";

    return {
      id: row.id || "",
      userId: row.id || "",

      name,

      firstName,
      lastName,

      bio: row.bio || "",
      location: row.location || "",

      avatar,
      avatarUrl: avatar,
      avatar_url: avatar,

      cover,
      coverUrl: cover,
      cover_url: cover,

      createdAt: row.created_at || "",
      updatedAt: row.updated_at || "",

      onboardingCompleted:
        Boolean(row.onboarding_completed)
    };
  }

  function cleanText(value, label, maxLength) {
    const text = String(value ?? "").trim();

    if (text.length > maxLength) {
      throw new Error(
        `${label} बढीमा ${maxLength} अक्षरको हुनुपर्छ।`
      );
    }

    return text;
  }

  function cleanUrl(value, label) {
    const text = String(value ?? "").trim();

    if (!text) return "";

    let url;

    try {
      url = new URL(text);
    } catch {
      throw new Error(`${label} को URL मान्य छैन।`);
    }

    if (!["https:", "http:"].includes(url.protocol)) {
      throw new Error(`${label} को URL मान्य छैन।`);
    }

    return text;
  }

  function buildUpdatePayload(profile) {
    if (
      !profile ||
      typeof profile !== "object" ||
      Array.isArray(profile)
    ) {
      throw new Error("प्रोफाइल विवरण सही छैन।");
    }

    const update = {};

    const has = key =>
      Object.prototype.hasOwnProperty.call(profile, key);

    if (has("name")) {
      update.name = cleanText(
        profile.name,
        "नाम",
        60
      );
    }

    if (has("firstName") || has("first_name")) {
      update.first_name = cleanText(
        has("firstName")
          ? profile.firstName
          : profile.first_name,
        "पहिलो नाम",
        60
      );
    }

    if (has("lastName") || has("last_name")) {
      update.last_name = cleanText(
        has("lastName")
          ? profile.lastName
          : profile.last_name,
        "थर",
        60
      );
    }

    if (has("bio")) {
      update.bio = cleanText(
        profile.bio,
        "परिचय",
        240
      );
    }

    if (has("location")) {
      update.location = cleanText(
        profile.location,
        "स्थान",
        100
      );
    }

    if (has("avatar") || has("avatarUrl") || has("avatar_url")) {
      const value = has("avatarUrl")
        ? profile.avatarUrl
        : has("avatar_url")
          ? profile.avatar_url
          : profile.avatar;

      update.avatar_url = cleanUrl(value, "प्रोफाइल फोटो");
    }

    if (has("cover") || has("coverUrl") || has("cover_url")) {
      const value = has("coverUrl")
        ? profile.coverUrl
        : has("cover_url")
          ? profile.cover_url
          : profile.cover;

      update.cover_url = cleanUrl(value, "कभर फोटो");
    }

    if (!Object.keys(update).length) {
      throw new Error("अपडेट गर्न कुनै विवरण प्राप्त भएन।");
    }

    return update;
  }

  async function initialize() {
    if (initializePromise) return initializePromise;

    initializePromise = (async () => {
      const api = auth();

      if (!api) {
        return false;
      }

      try {
        await api.initialize();

        return Boolean(
          api.getClient?.() &&
          api.isAuthenticated?.()
        );
      } catch (error) {
        console.error(
          "Profile initialization failed:",
          error
        );

        return false;
      }
    })();

    try {
      return await initializePromise;
    } finally {
      initializePromise = null;
    }
  }

  async function getContext() {
    const api = auth();

    if (!api) {
      throw new Error(
        "Supabase Authentication सेवा उपलब्ध छैन।"
      );
    }

    await api.initialize();

    if (!api.isAuthenticated?.()) {
      throw new Error(
        "यो काम गर्न पहिले आफ्नो खातामा लगइन गर्नुहोस्।"
      );
    }

    const client = api.getClient?.();
    const user = api.getUser?.();

    if (!client || !user?.id) {
      throw new Error(
        "प्रयोगकर्ता विवरण प्राप्त भएन।"
      );
    }

    return { client, user };
  }

  /*
   * GET MY PROFILE
   */

  async function getMyProfile() {
    try {
      const { client, user } = await getContext();

      const { data, error } = await client
        .from(TABLE)
        .select(PROFILE_COLUMNS)
        .eq("id", user.id)
        .maybeSingle();

      if (error) throw error;

      const profile = normalizeProfile(data);

      emit("ksk:profile-loaded", {
        profile
      });

      return profile;

    } catch (error) {
      console.error(
        "My profile load failed:",
        error
      );

      throw error;
    }
  }

  /*
   * GET ANOTHER USER'S PUBLIC PROFILE
   */

  async function getProfileById(userId) {
    const id = normalizeId(userId);

    if (!id) {
      throw new Error(
        "प्रयोगकर्ताको ID मान्य छैन।"
      );
    }

    const { client, user } = await getContext();

    if (id === user.id) {
      return getMyProfile();
    }

    const { data, error } = await client
      .from(TABLE)
      .select(PROFILE_COLUMNS)
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.error(
        "Public profile load failed:",
        error
      );

      throw error;
    }

    return normalizeProfile(data);
  }

  /*
   * UPDATE MY PROFILE ONLY
   */

  async function updateMyProfile(profile) {
    const { client, user } = await getContext();

    const update = buildUpdatePayload(profile);

    const { data, error } = await client
      .from(TABLE)
      .update(update)
      .eq("id", user.id)
      .select(PROFILE_COLUMNS)
      .maybeSingle();

    if (error) {
      console.error(
        "Profile update failed:",
        error
      );

      throw error;
    }

    if (!data) {
      throw new Error(
        "प्रोफाइल सुरक्षित भएन। आफ्नो प्रोफाइलको अनुमति जाँच गर्नुहोस्।"
      );
    }

    const updatedProfile = normalizeProfile(data);

    emit("ksk:profile-updated", {
      profile: updatedProfile
    });

    return updatedProfile;
  }

  /*
   * PUBLIC API
   */

  global.KSKSupabaseProfile = Object.freeze({
    initialize,
    getMyProfile,
    getProfileById,
    updateMyProfile,
    normalizeProfile
  });

  console.info(
    "KSK WhatsApp Profile Service loaded."
  );

})(window);
