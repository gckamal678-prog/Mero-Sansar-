
"use strict";

/*
 * WHATSAPP-STYLE APP — CONTACTS SERVICE
 * File: whatsapp/supabase-friends.js
 *
 * Supabase-backed contacts and relationship service.
 *
 * Features:
 * - Search registered users
 * - Send, accept, reject and cancel contact requests
 * - Load contacts and pending requests
 * - Follow and unfollow users
 * - Block and unblock users
 *
 * Dependencies:
 * - whatsapp/supabase-auth.js
 *
 * Uses the existing Supabase tables and RLS policies.
 * No service_role key or privileged client is used.
 */

(function (global) {
  "use strict";

  if (global.KSKSupabaseFriends) return;

  const TABLE = Object.freeze({
    profiles: "profiles",
    requests: "friend_requests",
    friendships: "friendships",
    follows: "user_follows",
    blocks: "user_blocks"
  });

  let initialized = false;

  function result(ok, code, data = null, message = "") {
    return { ok, code, data, message };
  }

  function fail(code, message = "अनुरोध पूरा हुन सकेन।") {
    return result(false, code, null, message);
  }

  function normalizeId(value) {
    if (typeof value !== "string") return "";

    const id = value.trim();

    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      ? id
      : "";
  }

  function auth() {
    return global.KSKSupabaseAuth || null;
  }

  function client() {
    return auth()?.getClient?.() || null;
  }

  function currentUser() {
    if (!auth()?.isAuthenticated?.()) return null;
    return auth()?.getUser?.() || null;
  }

  function currentUserId() {
    return normalizeId(currentUser()?.id);
  }

  async function ready() {
    const authService = auth();

    if (!authService) {
      return fail(
        "AUTH_MODULE_MISSING",
        "Supabase Auth सेवा उपलब्ध छैन।"
      );
    }

    try {
      await authService.initialize();
    } catch (error) {
      return fail(
        error?.code || "AUTH_ERROR",
        error?.message || "प्रमाणीकरण असफल भयो।"
      );
    }

    const supabase = client();
    const userId = currentUserId();

    if (!supabase || !userId) {
      initialized = false;

      return fail(
        "NOT_AUTHENTICATED",
        "पहिले आफ्नो खातामा लगइन गर्नुहोस्।"
      );
    }

    initialized = true;

    return result(true, "READY", {
      client: supabase,
      userId
    });
  }

  function handleError(error) {
    const code = error?.code || "SUPABASE_ERROR";

    const messages = {
      "23505": "यो सम्बन्ध वा Request पहिल्यै रहेको छ।",
      "23503": "प्रयोगकर्ता वा सम्बन्धित रेकर्ड भेटिएन।",
      "42501": "यो कार्य गर्ने अनुमति छैन।",
      "PGRST116": "रेकर्ड भेटिएन।",
      "PGRST301": "तपाईंको Session मान्य छैन। फेरि लगइन गर्नुहोस्।"
    };

    return fail(
      code,
      messages[code] || error?.message || "अनुरोध पूरा हुन सकेन।"
    );
  }

  function notify(type) {
    try {
      global.dispatchEvent(
        new CustomEvent("ksk:friends-cloud-change", {
          detail: { type }
        })
      );
    } catch (_) {
      // Event notification is optional; the database action remains primary.
    }
  }

  function cleanTerm(value) {
    return String(value || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 60)
      .replace(/[\\%_]/g, "\\$&");
  }

  function normalizeProfile(profile) {
    if (!profile) return null;

    const id = normalizeId(profile.id);
    if (!id) return null;

    const name =
      profile.name ||
      [profile.first_name, profile.last_name]
        .filter(Boolean)
        .join(" ") ||
      "WhatsApp User";

    return {
      id,
      userId: id,
      name,
      avatarUrl: profile.avatar_url || null
    };
  }

  async function profilesByIds(supabase, ids) {
    const unique = [
      ...new Set((ids || []).map(normalizeId).filter(Boolean))
    ];

    if (!unique.length) return [];

    const { data, error } = await supabase
      .from(TABLE.profiles)
      .select("id,name,first_name,last_name,avatar_url")
      .in("id", unique);

    if (error) throw error;

    return (data || [])
      .map(normalizeProfile)
      .filter(Boolean);
  }

  /*
   * SEARCH USERS
   */

  async function searchUsers(searchText, options = {}) {
    const term = cleanTerm(searchText);

    if (term.replace(/\\/g, "").length < 2) {
      return fail(
        "SEARCH_TOO_SHORT",
        "कम्तीमा २ अक्षर लेख्नुहोस्।"
      );
    }

    const session = await ready();
    if (!session.ok) return session;

    const { client: supabase, userId } = session.data;

    const requestedLimit = Number(options.limit) || 20;
    const limit = Math.min(20, Math.max(1, requestedLimit));

    try {
      const pattern = `%${term}%`;

      const searches = [
        supabase
          .from(TABLE.profiles)
          .select("id,name,first_name,last_name,avatar_url")
          .ilike("name", pattern)
          .neq("id", userId)
          .limit(limit),

        supabase
          .from(TABLE.profiles)
          .select("id,name,first_name,last_name,avatar_url")
          .ilike("first_name", pattern)
          .neq("id", userId)
          .limit(limit),

        supabase
          .from(TABLE.profiles)
          .select("id,name,first_name,last_name,avatar_url")
          .ilike("last_name", pattern)
          .neq("id", userId)
          .limit(limit)
      ];

      const words = term
        .replace(/\\/g, "")
        .split(" ")
        .filter(Boolean);

      if (words.length >= 2) {
        searches.push(
          supabase
            .from(TABLE.profiles)
            .select("id,name,first_name,last_name,avatar_url")
            .ilike("first_name", `%${words[0]}%`)
            .ilike("last_name", `%${words.slice(1).join(" ")}%`)
            .neq("id", userId)
            .limit(limit)
        );
      }

      const responses = await Promise.all(searches);
      const failedResponse = responses.find(response => response.error);

      if (failedResponse) throw failedResponse.error;

      const uniqueProfiles = new Map();

      for (const response of responses) {
        for (const profile of response.data || []) {
          const normalized = normalizeProfile(profile);

          if (normalized && normalized.id !== userId) {
            uniqueProfiles.set(normalized.id, normalized);
          }
        }
      }

      const users = [...uniqueProfiles.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, limit);

      return result(true, "USERS_SEARCHED", users);
    } catch (error) {
      return handleError(error);
    }
  }

  /*
   * CONTACTS DASHBOARD
   *
   * Preserves the exact data structure expected by app.js:
   * {
   *   userId,
   *   incoming,
   *   outgoing,
   *   friends,
   *   followers,
   *   following,
   *   blocked
   * }
   */

  async function getDashboard() {
    const session = await ready();
    if (!session.ok) return session;

    const { client: supabase, userId } = session.data;

    try {
      const responses = await Promise.all([
        supabase
          .from(TABLE.requests)
          .select("id,sender_id,receiver_id,status,created_at")
          .eq("receiver_id", userId)
          .eq("status", "pending")
          .order("created_at", { ascending: false }),

        supabase
          .from(TABLE.requests)
          .select("id,sender_id,receiver_id,status,created_at")
          .eq("sender_id", userId)
          .eq("status", "pending")
          .order("created_at", { ascending: false }),

        supabase
          .from(TABLE.friendships)
          .select("user_a_id,user_b_id,created_at")
          .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)
          .order("created_at", { ascending: false }),

        supabase
          .from(TABLE.follows)
          .select("follower_id,following_id,created_at")
          .eq("following_id", userId),

        supabase
          .from(TABLE.follows)
          .select("follower_id,following_id,created_at")
          .eq("follower_id", userId),

        supabase
          .from(TABLE.blocks)
          .select("blocker_id,blocked_id,created_at")
          .eq("blocker_id", userId)
      ]);

      const failedResponse = responses.find(response => response.error);
      if (failedResponse) throw failedResponse.error;

      const [
        incoming,
        outgoing,
        friendships,
        followers,
        following,
        blocks
      ] = responses.map(response => response.data || []);

      const profileIds = [
        ...incoming.map(item => item.sender_id),
        ...outgoing.map(item => item.receiver_id),

        ...friendships.map(item =>
          item.user_a_id === userId
            ? item.user_b_id
            : item.user_a_id
        ),

        ...followers.map(item => item.follower_id),
        ...following.map(item => item.following_id),
        ...blocks.map(item => item.blocked_id)
      ];

      const profiles = await profilesByIds(
        supabase,
        profileIds
      );

      const profileMap = new Map(
        profiles.map(profile => [profile.id, profile])
      );

      function person(id, createdAt = null) {
        const normalizedId = normalizeId(id);

        const profile = profileMap.get(normalizedId) || {
          id: normalizedId,
          userId: normalizedId,
          name: "प्रोफाइल उपलब्ध छैन",
          avatarUrl: null
        };

        return {
          ...profile,
          createdAt
        };
      }

      const dashboard = {
        userId,

        incoming: incoming.map(item => ({
          id: item.id,
          createdAt: item.created_at,
          person: person(item.sender_id)
        })),

        outgoing: outgoing.map(item => ({
          id: item.id,
          createdAt: item.created_at,
          person: person(item.receiver_id)
        })),

        friends: friendships.map(item =>
          person(
            item.user_a_id === userId
              ? item.user_b_id
              : item.user_a_id,
            item.created_at
          )
        ),

        followers: followers.map(item =>
          person(item.follower_id, item.created_at)
        ),

        following: following.map(item =>
          person(item.following_id, item.created_at)
        ),

        blocked: blocks.map(item =>
          person(item.blocked_id, item.created_at)
        )
      };

      return result(true, "DASHBOARD_LOADED", dashboard);
    } catch (error) {
      return handleError(error);
    }
  }

  /*
   * SEND CONTACT REQUEST
   */

  async function sendFriendRequest(receiverId) {
    const targetId = normalizeId(receiverId);

    if (!targetId) {
      return fail(
        "INVALID_USER_ID",
        "प्रयोगकर्ता ID मान्य छैन।"
      );
    }

    const session = await ready();
    if (!session.ok) return session;

    const { client: supabase, userId } = session.data;

    if (targetId === userId) {
      return fail(
        "SELF_REQUEST_NOT_ALLOWED",
        "आफैँलाई Request पठाउन मिल्दैन।"
      );
    }

    try {
      const { data, error } = await supabase
        .from(TABLE.requests)
        .insert({
          sender_id: userId,
          receiver_id: targetId,
          status: "pending"
        })
        .select("id,sender_id,receiver_id,status,created_at")
        .single();

      if (error) throw error;

      notify("FRIEND_REQUEST_SENT");

      return result(true, "FRIEND_REQUEST_SENT", data);
    } catch (error) {
      return handleError(error);
    }
  }

  /*
   * ACCEPT OR REJECT REQUEST
   */

  async function respondToFriendRequest(requestId, status) {
    const id = normalizeId(requestId);

    if (!id || !["accepted", "rejected"].includes(status)) {
      return fail(
        "INVALID_REQUEST",
        "Request वा Action मान्य छैन।"
      );
    }

    const session = await ready();
    if (!session.ok) return session;

    const { client: supabase, userId } = session.data;

    try {
      const { data, error } = await supabase
        .from(TABLE.requests)
        .update({
          status,
          updated_at: new Date().toISOString()
        })
        .eq("id", id)
        .eq("receiver_id", userId)
        .eq("status", "pending")
        .select("id,status")
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        return fail(
          "REQUEST_NOT_FOUND",
          "Request भेटिएन वा पहिले नै पूरा भयो।"
        );
      }

      notify("FRIEND_REQUEST_" + status.toUpperCase());

      return result(true, "REQUEST_UPDATED", data);
    } catch (error) {
      return handleError(error);
    }
  }

  /*
   * CANCEL OUTGOING REQUEST
   */

  async function cancelFriendRequest(requestId) {
    const id = normalizeId(requestId);

    if (!id) {
      return fail("INVALID_REQUEST_ID", "Request ID मान्य छैन।");
    }

    const session = await ready();
    if (!session.ok) return session;

    const { client: supabase, userId } = session.data;

    try {
      const { data, error } = await supabase
        .from(TABLE.requests)
        .update({
          status: "cancelled",
          updated_at: new Date().toISOString()
        })
        .eq("id", id)
        .eq("sender_id", userId)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        return fail(
          "REQUEST_NOT_FOUND",
          "Pending Request भेटिएन।"
        );
      }

      notify("FRIEND_REQUEST_CANCELLED");

      return result(true, "REQUEST_CANCELLED", data);
    } catch (error) {
      return handleError(error);
    }
  }

  /*
   * REMOVE CONTACT
   */

  async function removeFriend(friendId) {
    const targetId = normalizeId(friendId);

    if (!targetId) {
      return fail("INVALID_USER_ID", "प्रयोगकर्ता ID मान्य छैन।");
    }

    const session = await ready();
    if (!session.ok) return session;

    const { client: supabase, userId } = session.data;

    if (targetId === userId) {
      return fail("INVALID_USER_ID");
    }

    const [userA, userB] = [userId, targetId].sort();

    try {
      const { data, error } = await supabase
        .from(TABLE.friendships)
        .delete()
        .eq("user_a_id", userA)
        .eq("user_b_id", userB)
        .select("user_a_id");

      if (error) throw error;

      if (!data?.length) {
        return fail(
          "FRIENDSHIP_NOT_FOUND",
          "यो Contact सम्बन्ध भेटिएन।"
        );
      }

      notify("FRIEND_REMOVED");

      return result(true, "FRIEND_REMOVED", data);
    } catch (error) {
      return handleError(error);
    }
  }

  /*
   * FOLLOW USER
   */

  async function followUser(targetId) {
    const id = normalizeId(targetId);

    if (!id) {
      return fail("INVALID_USER_ID", "प्रयोगकर्ता ID मान्य छैन।");
    }

    const session = await ready();
    if (!session.ok) return session;

    const { client: supabase, userId } = session.data;

    if (id === userId) {
      return fail(
        "SELF_FOLLOW_NOT_ALLOWED",
        "आफैँलाई Follow गर्न मिल्दैन।"
      );
    }

    try {
      const { error } = await supabase
        .from(TABLE.follows)
        .insert({
          follower_id: userId,
          following_id: id
        });

      if (error) throw error;

      notify("USER_FOLLOWED");

      return result(true, "USER_FOLLOWED");
    } catch (error) {
      return handleError(error);
    }
  }

  /*
   * UNFOLLOW USER
   */

  async function unfollowUser(targetId) {
    const id = normalizeId(targetId);

    if (!id) {
      return fail("INVALID_USER_ID", "प्रयोगकर्ता ID मान्य छैन।");
    }

    const session = await ready();
    if (!session.ok) return session;

    const { client: supabase, userId } = session.data;

    try {
      const { data, error } = await supabase
        .from(TABLE.follows)
        .delete()
        .eq("follower_id", userId)
        .eq("following_id", id)
        .select("follower_id");

      if (error) throw error;

      if (!data?.length) {
        return fail(
          "NOT_FOLLOWING",
          "यो प्रयोगकर्तालाई Follow गरिएको छैन।"
        );
      }

      notify("USER_UNFOLLOWED");

      return result(true, "USER_UNFOLLOWED");
    } catch (error) {
      return handleError(error);
    }
  }

  /*
   * BLOCK USER
   */

  async function blockUser(targetId) {
    const id = normalizeId(targetId);

    if (!id) {
      return fail("INVALID_USER_ID", "प्रयोगकर्ता ID मान्य छैन।");
    }

    const session = await ready();
    if (!session.ok) return session;

    const { client: supabase, userId } = session.data;

    if (id === userId) {
      return fail(
        "SELF_BLOCK_NOT_ALLOWED",
        "आफैँलाई Block गर्न मिल्दैन।"
      );
    }

    try {
      const { error } = await supabase
        .from(TABLE.blocks)
        .insert({
          blocker_id: userId,
          blocked_id: id
        });

      if (error) throw error;

      notify("USER_BLOCKED");

      return result(true, "USER_BLOCKED");
    } catch (error) {
      return handleError(error);
    }
  }

  /*
   * UNBLOCK USER
   */

  async function unblockUser(targetId) {
    const id = normalizeId(targetId);

    if (!id) {
      return fail("INVALID_USER_ID", "प्रयोगकर्ता ID मान्य छैन।");
    }

    const session = await ready();
    if (!session.ok) return session;

    const { client: supabase, userId } = session.data;

    try {
      const { data, error } = await supabase
        .from(TABLE.blocks)
        .delete()
        .eq("blocker_id", userId)
        .eq("blocked_id", id)
        .select("blocker_id");

      if (error) throw error;

      if (!data?.length) {
        return fail(
          "BLOCK_NOT_FOUND",
          "यो प्रयोगकर्ता Block गरिएको छैन।"
        );
      }

      notify("USER_UNBLOCKED");

      return result(true, "USER_UNBLOCKED");
    } catch (error) {
      return handleError(error);
    }
  }

  /*
   * PUBLIC API
   *
   * Method names and return wrappers match app.js.
   */

  global.KSKSupabaseFriends = Object.freeze({
    initialize: ready,

    isInitialized: () => initialized,

    getCurrentUserId: currentUserId,

    searchUsers,
    getDashboard,

    sendFriendRequest,
    respondToFriendRequest,
    cancelFriendRequest,
    removeFriend,

    followUser,
    unfollowUser,

    blockUser,
    unblockUser
  });

  /*
   * AUTH LIFECYCLE
   */

  global.addEventListener("ksk:auth-ready", () => {
    initialized = Boolean(currentUserId());
  });

  global.addEventListener("ksk:auth-change", () => {
    initialized = Boolean(currentUserId());
  });

})(window);
