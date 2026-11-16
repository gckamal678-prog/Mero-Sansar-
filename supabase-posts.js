
"use strict";

/*
 * WHATSAPP-STYLE APP — UPDATES SERVICE
 * File: whatsapp/supabase-posts.js
 *
 * Supabase-backed Updates / Posts service.
 *
 * Features:
 * - Load Updates feed
 * - Load saved posts
 * - Load own posts
 * - Create text and image updates
 * - Edit and delete own posts
 * - Private Storage signed media URLs
 * - Realtime post and comment changes
 *
 * Dependencies:
 * - whatsapp/supabase-auth.js
 * - whatsapp/supabase-profile.js
 *
 * Tables:
 * - posts
 * - profiles
 * - post_comments
 * - saved_posts
 *
 * Storage:
 * - posts-media
 *
 * Browser client uses publishable key through Auth service.
 * Never use service_role keys in this file.
 */

(function (global) {
  "use strict";

  if (global.KSKSupabasePosts) return;

  const TABLE = "posts";
  const BUCKET = "posts-media";

  const MAX_CONTENT_LENGTH = 10000;
  const MAX_FILE_SIZE = 10 * 1024 * 1024;

  const SIGNED_URL_SECONDS = 3600;
  const SIGNED_URL_REFRESH_MARGIN = 30000;

  const COMMENT_COUNT_PAGE_SIZE = 1000;

  const ALLOWED_TYPES = Object.freeze([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif"
  ]);

  const SELECT_COLUMNS = [
    "id",
    "user_id",
    "content",
    "media_path",
    "media_mime_type",
    "author_name",
    "author_avatar_url",
    "created_at",
    "updated_at"
  ].join(",");

  const SIGNED_URL_CACHE = new Map();

  let realtimeChannel = null;
  let realtimeUserId = "";
  let realtimeStarting = null;

  function authService() {
    return global.KSKSupabaseAuth || null;
  }

  function makeResult(ok, code, data = null, message = "") {
    return { ok, code, data, message };
  }

  function errorMessage(error) {
    return String(
      error?.message ||
      error?.details ||
      error?.hint ||
      "Updates सम्बन्धी काम पूरा गर्न सकिएन।"
    );
  }

  function dispatchChange(detail = {}) {
    try {
      global.dispatchEvent(
        new CustomEvent("ksk:posts-cloud-change", { detail })
      );
    } catch (_) {}
  }

  function clearSignedUrlCache() {
    SIGNED_URL_CACHE.clear();
  }

  async function getContext() {
    const auth = authService();

    if (!auth) {
      throw new Error("Supabase Auth सेवा उपलब्ध छैन।");
    }

    if (typeof auth.initialize !== "function") {
      throw new Error("Supabase Auth सुरु गर्ने विधि उपलब्ध छैन।");
    }

    const initialized = await auth.initialize();

    if (!initialized) {
      throw new Error("Supabase Auth सुरु हुन सकेन।");
    }

    if (!auth.isAuthenticated?.()) {
      throw new Error("पहिले आफ्नो खातामा लगइन गर्नुहोस्।");
    }

    const client = auth.getClient?.();
    const user = auth.getUser?.();

    if (!client || !user?.id) {
      throw new Error("लगइन Session प्राप्त भएन। फेरि प्रयास गर्नुहोस्।");
    }

    return { client, user };
  }

  function cleanContent(value) {
    const content = String(value ?? "").trim();

    if (content.length > MAX_CONTENT_LENGTH) {
      throw new Error(
        `Update बढीमा ${MAX_CONTENT_LENGTH} अक्षरको हुनुपर्छ।`
      );
    }

    return content;
  }

  function createId() {
    if (global.crypto?.randomUUID) {
      return global.crypto.randomUUID();
    }

    throw new Error(
      "यो Browser मा सुरक्षित ID बनाउन सकिएन। Browser अपडेट गर्नुहोस्।"
    );
  }

  function getFileExtension(file) {
    const extensions = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif"
    };

    return extensions[
      String(file?.type || "").toLowerCase()
    ] || "";
  }

  function validateMedia(file) {
    if (!file) return true;

    if (!(file instanceof Blob)) {
      throw new Error("फोटो फाइल मान्य छैन।");
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      throw new Error(
        "JPEG, PNG, WebP वा GIF फोटो मात्र प्रयोग गर्न सकिन्छ।"
      );
    }

    if (file.size <= 0) {
      throw new Error("फोटो फाइल खाली छ।");
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new Error("फोटोको आकार 10 MB भन्दा बढी हुनुहुँदैन।");
    }

    return true;
  }

  async function getAuthorProfile() {
    const profileAPI = global.KSKSupabaseProfile;

    if (!profileAPI?.getMyProfile) {
      throw new Error("Supabase Profile सेवा उपलब्ध छैन।");
    }

    const profile = await profileAPI.getMyProfile();

    if (!profile) {
      throw new Error("आफ्नो प्रोफाइल प्राप्त गर्न सकिएन।");
    }

    const name = String(profile.name || "").trim();

    if (!name) {
      throw new Error(
        "Update प्रकाशित गर्नुअघि आफ्नो प्रोफाइलमा नाम राख्नुहोस्।"
      );
    }

    return {
      name: name.slice(0, 120),
      avatar: String(
        profile.avatarUrl || profile.avatar || ""
      ).trim()
    };
  }

  async function uploadMedia(client, userId, file, postId) {
    if (!file) return null;

    validateMedia(file);

    const extension = getFileExtension(file);

    if (!extension) {
      throw new Error("फोटोको प्रकार पहिचान गर्न सकिएन।");
    }

    const path =
      `${userId}/${postId}/${createId()}.${extension}`;

    const { data, error } = await client
      .storage
      .from(BUCKET)
      .upload(path, file, {
        cacheControl: "3600",
        contentType: file.type,
        upsert: false
      });

    if (error) throw error;

    return {
      path: data?.path || path,
      mimeType: file.type
    };
  }

  async function getSignedMediaUrl(path, clientOverride = null) {
    const mediaPath = String(path || "").trim();

    if (!mediaPath) return "";

    const cached = SIGNED_URL_CACHE.get(mediaPath);

    if (
      cached &&
      cached.expiresAt > Date.now() + SIGNED_URL_REFRESH_MARGIN
    ) {
      return cached.url;
    }

    let client = clientOverride;

    if (!client) {
      const context = await getContext();
      client = context.client;
    }

    const { data, error } = await client
      .storage
      .from(BUCKET)
      .createSignedUrl(mediaPath, SIGNED_URL_SECONDS);

    if (error) throw error;

    const url = data?.signedUrl || "";

    if (url) {
      SIGNED_URL_CACHE.set(mediaPath, {
        url,
        expiresAt: Date.now() + SIGNED_URL_SECONDS * 1000
      });
    }

    return url;
  }

  /*
   * PROFILE LOOKUP
   *
   * If profile lookup is restricted by RLS, post snapshots
   * remain available as a fallback.
   */

  async function getAuthorAvatarMap(rows, client) {
    const userIds = [
      ...new Set(
        (rows || [])
          .map(row => String(row?.user_id || "").trim())
          .filter(Boolean)
      )
    ];

    const avatarMap = new Map();

    if (!userIds.length || !client) return avatarMap;

    try {
      const { data, error } = await client
        .from("profiles")
        .select("id,avatar_url")
        .in("id", userIds);

      if (error) throw error;

      (data || []).forEach(profile => {
        const id = String(profile?.id || "").trim();
        const avatar = String(profile?.avatar_url || "").trim();

        if (id && avatar) avatarMap.set(id, avatar);
      });
    } catch (error) {
      console.warn(
        "Profile avatar lookup failed; using post snapshots.",
        error
      );
    }

    return avatarMap;
  }

  /*
   * COMMENT COUNTS
   *
   * Comment count is supplementary. If the comments table
   * is unavailable under current RLS, the feed still loads.
   */

  async function getCommentCountMap(rows, client) {
    const postIds = [
      ...new Set(
        (rows || [])
          .map(row => String(row?.id || "").trim())
          .filter(Boolean)
      )
    ];

    const countMap = new Map(
      postIds.map(id => [id, 0])
    );

    if (!postIds.length || !client) return countMap;

    let offset = 0;

    try {
      while (true) {
        const { data, error } = await client
          .from("post_comments")
          .select("post_id")
          .in("post_id", postIds)
          .range(
            offset,
            offset + COMMENT_COUNT_PAGE_SIZE - 1
          );

        if (error) throw error;

        const page = Array.isArray(data) ? data : [];

        page.forEach(row => {
          const id = String(row?.post_id || "");

          if (countMap.has(id)) {
            countMap.set(id, countMap.get(id) + 1);
          }
        });

        if (page.length < COMMENT_COUNT_PAGE_SIZE) break;

        offset += COMMENT_COUNT_PAGE_SIZE;
      }
    } catch (error) {
      console.warn(
        "Comment counts unavailable; displaying zero counts.",
        error
      );
    }

    return countMap;
  }

  /*
   * NORMALIZE POST
   *
   * Provides both database-style and app-style aliases.
   * app.js currently reads authorName/name and
   * authorAvatarUrl/avatarUrl.
   */

  async function normalizePost(
    row,
    client,
    avatarMap = null,
    commentCount = 0
  ) {
    if (!row) return null;

    let mediaUrl = "";

    if (row.media_path) {
      try {
        mediaUrl = await getSignedMediaUrl(
          row.media_path,
          client
        );
      } catch (error) {
        console.warn(
          "Update media URL could not be created:",
          error
        );
      }
    }

    const authorId = String(row.user_id || "").trim();

    const currentAvatar = avatarMap instanceof Map
      ? avatarMap.get(authorId)
      : "";

    const authorName = String(
      row.author_name || "WhatsApp User"
    );

    const authorAvatarUrl = String(
      currentAvatar ||
      row.author_avatar_url ||
      ""
    );

    return {
      id: row.id,

      author: authorName,
      authorName,
      name: authorName,

      authorId,

      authorAvatar: authorAvatarUrl,
      authorAvatarUrl,
      avatarUrl: authorAvatarUrl,

      authorInitial: authorName.charAt(0),

      text: row.content || "",
      content: row.content || "",

      mediaPath: row.media_path || "",
      mediaType: row.media_mime_type || "",
      mediaUrl,
      media_url: mediaUrl,

      createdAt: row.created_at || "",
      created_at: row.created_at || "",

      updatedAt: row.updated_at || "",

      likes: 0,
      liked: false,
      comments: [],

      commentCount: Math.max(
        0,
        Number(commentCount) || 0
      ),

      reactionCounts: {}
    };
  }

  async function normalizeRows(rows, client) {
    const sourceRows = Array.isArray(rows) ? rows : [];

    if (!sourceRows.length) return [];

    const [avatarMap, commentCountMap] = await Promise.all([
      getAuthorAvatarMap(sourceRows, client),
      getCommentCountMap(sourceRows, client)
    ]);

    return Promise.all(
      sourceRows.map(row => {
        const id = String(row?.id || "");

        return normalizePost(
          row,
          client,
          avatarMap,
          commentCountMap.get(id) || 0
        );
      })
    );
  }

  /*
   * REALTIME
   */

  async function stopRealtime() {
    const auth = authService();
    const client = auth?.getClient?.();
    const oldChannel = realtimeChannel;

    realtimeChannel = null;
    realtimeUserId = "";
    realtimeStarting = null;

    if (oldChannel && client?.removeChannel) {
      try {
        await client.removeChannel(oldChannel);
      } catch (error) {
        console.warn("Updates Realtime cleanup failed:", error);
      }
    }

    return true;
  }

  async function startRealtime() {
    if (realtimeStarting) return realtimeStarting;

    realtimeStarting = (async () => {
      let context;

      try {
        context = await getContext();
      } catch (_) {
        await stopRealtime();
        return false;
      }

      const { client, user } = context;

      if (
        realtimeChannel &&
        realtimeUserId === user.id
      ) {
        return true;
      }

      if (realtimeChannel) {
        const oldChannel = realtimeChannel;
        realtimeChannel = null;
        realtimeUserId = "";

        try {
          await client.removeChannel(oldChannel);
        } catch (_) {}
      }

      const channel = client
        .channel("ksk-updates-live")

        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: TABLE
          },
          payload => {
            dispatchChange({
              action: "realtime",
              eventType: payload?.eventType || "",
              postId:
                payload?.new?.id ||
                payload?.old?.id ||
                ""
            });
          }
        )

        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "post_comments"
          },
          payload => {
            dispatchChange({
              action: "comment-realtime",
              eventType: payload?.eventType || "",
              postId:
                payload?.new?.post_id ||
                payload?.old?.post_id ||
                ""
            });
          }
        );

      realtimeChannel = channel;
      realtimeUserId = user.id;

      channel.subscribe(status => {
        if (status === "CHANNEL_ERROR") {
          console.warn("Updates Realtime channel error.");
        }

        if (status === "TIMED_OUT") {
          console.warn("Updates Realtime connection timed out.");
        }

        if (status === "SUBSCRIBED") {
          console.info("Updates Realtime connected.");
        }
      });

      return true;
    })();

    try {
      return await realtimeStarting;
    } catch (error) {
      console.warn("Updates Realtime could not start:", error);

      realtimeChannel = null;
      realtimeUserId = "";

      return false;
    } finally {
      realtimeStarting = null;
    }
  }

  /*
   * INITIALIZE
   */

  async function initialize() {
    try {
      const context = await getContext();

      startRealtime().catch(error => {
        console.warn("Updates Realtime startup failed:", error);
      });

      return Boolean(context.client && context.user?.id);
    } catch (error) {
      console.error(
        "Supabase Updates initialization failed:",
        error
      );

      return false;
    }
  }

  /*
   * FEED
   */

  async function getFeed(options = {}) {
    try {
      const { client } = await getContext();

      const requestedLimit = Number(options.limit || 50);

      const limit = Math.min(
        100,
        Math.max(
          1,
          Number.isFinite(requestedLimit) ? requestedLimit : 50
        )
      );

      let query = client
        .from(TABLE)
        .select(SELECT_COLUMNS)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit);

      if (options.before) {
        query = query.lt("created_at", options.before);
      }

      const { data, error } = await query;

      if (error) throw error;

      const posts = await normalizeRows(data, client);

      return makeResult(true, "FEED_LOADED", posts);
    } catch (error) {
      console.error("Updates Feed Load Failed:", error);

      return makeResult(
        false,
        "FEED_LOAD_FAILED",
        null,
        errorMessage(error)
      );
    }
  }

  /*
   * SAVED POSTS
   */

  async function getSavedPosts(options = {}) {
    try {
      const { client, user } = await getContext();

      const { data: savedRows, error: savedError } = await client
        .from("saved_posts")
        .select("post_id,created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (savedError) throw savedError;

      const savedIds = [
        ...new Set(
          (savedRows || [])
            .map(row => String(row?.post_id || "").trim())
            .filter(Boolean)
        )
      ];

      if (!savedIds.length) {
        return makeResult(true, "SAVED_POSTS_LOADED", []);
      }

      const posts = [];

      for (let offset = 0; offset < savedIds.length; offset += 100) {
        const batch = savedIds.slice(offset, offset + 100);

        const { data, error } = await client
          .from(TABLE)
          .select(SELECT_COLUMNS)
          .in("id", batch);

        if (error) throw error;

        if (Array.isArray(data)) posts.push(...data);
      }

      const normalized = await normalizeRows(posts, client);

      const orderMap = new Map(
        savedIds.map((id, index) => [id, index])
      );

      normalized.sort((a, b) =>
        (orderMap.get(String(a?.id || "")) ?? Number.MAX_SAFE_INTEGER) -
        (orderMap.get(String(b?.id || "")) ?? Number.MAX_SAFE_INTEGER)
      );

      const limit = Number(options.limit);

      return makeResult(
        true,
        "SAVED_POSTS_LOADED",
        Number.isFinite(limit) && limit > 0
          ? normalized.slice(0, limit)
          : normalized
      );
    } catch (error) {
      console.error("Saved Updates Load Failed:", error);

      return makeResult(
        false,
        "SAVED_POSTS_LOAD_FAILED",
        null,
        errorMessage(error)
      );
    }
  }

  /*
   * MY POSTS
   */

  async function getMyPosts(options = {}) {
    try {
      const { client, user } = await getContext();

      const requestedLimit = Number(options.limit || 50);

      const limit = Math.min(
        100,
        Math.max(
          1,
          Number.isFinite(requestedLimit) ? requestedLimit : 50
        )
      );

      const { data, error } = await client
        .from(TABLE)
        .select(SELECT_COLUMNS)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit);

      if (error) throw error;

      const posts = await normalizeRows(data, client);

      return makeResult(true, "MY_POSTS_LOADED", posts);
    } catch (error) {
      console.error("My Updates Load Failed:", error);

      return makeResult(
        false,
        "MY_POSTS_LOAD_FAILED",
        null,
        errorMessage(error)
      );
    }
  }

  /*
   * CREATE UPDATE
   */

  async function createPost(input = {}) {
    let uploadedPath = "";
    let uploadClient = null;

    try {
      const { client, user } = await getContext();

      uploadClient = client;

      const content = cleanContent(input.text);
      const file = input.media || null;

      validateMedia(file);

      if (!content && !file) {
        throw new Error("केही लेख्नुहोस् वा फोटो थप्नुहोस्।");
      }

      const profile = await getAuthorProfile();
      const postId = createId();

      let media = null;

      if (file) {
        media = await uploadMedia(
          client,
          user.id,
          file,
          postId
        );

        uploadedPath = media.path;
      }

      const payload = {
        id: postId,
        user_id: user.id,
        content,
        media_path: media?.path || null,
        media_mime_type: media?.mimeType || null,
        author_name: profile.name,
        author_avatar_url: profile.avatar || null
      };

      const { data, error } = await client
        .from(TABLE)
        .insert(payload)
        .select(SELECT_COLUMNS)
        .single();

      if (error) throw error;

      const post = await normalizePost(data, client);

      dispatchChange({
        action: "create",
        post
      });

      return makeResult(
        true,
        "POST_CREATED",
        post,
        "Update सफलतापूर्वक प्रकाशित भयो।"
      );
    } catch (error) {
      if (uploadedPath && uploadClient) {
        try {
          const { error: cleanupError } = await uploadClient
            .storage
            .from(BUCKET)
            .remove([uploadedPath]);

          if (cleanupError) {
            console.warn(
              "Failed upload cleanup:",
              cleanupError
            );
          }
        } catch (cleanupError) {
          console.warn("Failed upload cleanup:", cleanupError);
        }

        SIGNED_URL_CACHE.delete(uploadedPath);
      }

      console.error("Update Creation Failed:", error);

      return makeResult(
        false,
        "POST_CREATE_FAILED",
        null,
        errorMessage(error)
      );
    }
  }

  /*
   * UPDATE OWN POST
   */

  async function updatePost(postId, changes = {}) {
    try {
      const { client, user } = await getContext();

      const id = String(postId || "").trim();

      if (!id) {
        throw new Error("Update ID उपलब्ध छैन।");
      }

      const payload = {};

      if (
        Object.prototype.hasOwnProperty.call(changes, "text")
      ) {
        payload.content = cleanContent(changes.text);
      }

      if (!Object.keys(payload).length) {
        throw new Error("अपडेट गर्न कुनै विवरण प्राप्त भएन।");
      }

      payload.updated_at = new Date().toISOString();

      const { data, error } = await client
        .from(TABLE)
        .update(payload)
        .eq("id", id)
        .eq("user_id", user.id)
        .select(SELECT_COLUMNS)
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        throw new Error(
          "Update भेटिएन वा सम्पादन गर्ने अनुमति छैन।"
        );
      }

      const post = await normalizePost(data, client);

      dispatchChange({
        action: "update",
        post,
        postId: id
      });

      return makeResult(
        true,
        "POST_UPDATED",
        post,
        "Update परिवर्तन भयो।"
      );
    } catch (error) {
      console.error("Update Edit Failed:", error);

      return makeResult(
        false,
        "POST_UPDATE_FAILED",
        null,
        errorMessage(error)
      );
    }
  }

  /*
   * DELETE OWN POST
   */

  async function deletePost(postId) {
    try {
      const { client, user } = await getContext();

      const id = String(postId || "").trim();

      if (!id) {
        throw new Error("Update ID उपलब्ध छैन।");
      }

      const { data, error } = await client
        .from(TABLE)
        .delete()
        .eq("id", id)
        .eq("user_id", user.id)
        .select("id,media_path")
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        throw new Error(
          "Update भेटिएन वा मेटाउने अनुमति छैन।"
        );
      }

      if (data.media_path) {
        try {
          const { error: storageError } = await client
            .storage
            .from(BUCKET)
            .remove([data.media_path]);

          if (storageError) {
            console.warn(
              "Update deleted but media cleanup failed:",
              storageError
            );
          }
        } catch (cleanupError) {
          console.warn(
            "Update media cleanup failed:",
            cleanupError
          );
        }

        SIGNED_URL_CACHE.delete(data.media_path);
      }

      dispatchChange({
        action: "delete",
        postId: id
      });

      return makeResult(
        true,
        "POST_DELETED",
        { id },
        "Update मेटियो।"
      );
    } catch (error) {
      console.error("Update Delete Failed:", error);

      return makeResult(
        false,
        "POST_DELETE_FAILED",
        null,
        errorMessage(error)
      );
    }
  }

  /*
   * AUTH LIFECYCLE
   */

  global.addEventListener("ksk:auth-change", event => {
    clearSignedUrlCache();

    const user = event.detail?.user;

    if (!user?.id) {
      stopRealtime();
      return;
    }

    startRealtime().catch(error => {
      console.warn("Updates Realtime restart failed:", error);
    });
  });

  global.addEventListener("ksk:auth-ready", event => {
    const user = event.detail?.user;

    if (user?.id) {
      startRealtime().catch(error => {
        console.warn("Updates Realtime startup failed:", error);
      });
    } else {
      stopRealtime();
    }
  });

  /*
   * PUBLIC API
   */

  global.KSKSupabasePosts = Object.freeze({
    initialize,

    getFeed,
    getSavedPosts,
    getMyPosts,

    createPost,
    updatePost,
    deletePost,

    getSignedMediaUrl,
    clearSignedUrlCache,

    startRealtime,
    stopRealtime
  });

  console.info("KSK Supabase Updates service loaded.");

})(window);
