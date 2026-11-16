
"use strict";

/*
 * KSK WHATSAPP — SUPABASE NOTIFICATIONS
 *
 * Table: public.user_notifications
 * Source of truth: Supabase
 *
 * Supports:
 * - Load current user's notifications
 * - Mark one notification as read
 * - Mark all notifications as read
 * - Delete own notification
 * - Realtime INSERT / UPDATE / DELETE
 * - Realtime reconnect with exponential backoff
 * - Authentication changes and cleanup
 *
 * Notification creation is database-managed.
 * No client-side notification INSERT.
 */

(function (global) {
  "use strict";

  if (global.KSKSupabaseNotifications) return;

  const TABLE = "user_notifications";
  const CHANNEL_PREFIX = "ksk-user-notifications";

  const SELECT_FIELDS = [
    "id",
    "recipient_id",
    "actor_id",
    "type",
    "text",
    "entity_type",
    "entity_id",
    "is_read",
    "created_at"
  ].join(",");

  let realtimeChannel = null;
  let realtimeClient = null;
  let realtimeUserId = "";
  let realtimeStartPromise = null;

  let realtimeGeneration = 0;
  let retryTimer = null;
  let retryAttempt = 0;

  let initialized = false;

  /* =====================================================
     UTILITIES
  ===================================================== */

  function result(ok, code, data = null, message = "") {
    return { ok, code, data, message };
  }

  function fail(code, message) {
    return result(false, code, null, message);
  }

  function normalizeId(value) {
    if (typeof value !== "string") return "";

    const id = value.trim();

    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      ? id
      : "";
  }

  function normalizeText(value, limit = 500) {
    return String(value ?? "")
      .trim()
      .slice(0, limit);
  }

  function auth() {
    return global.KSKSupabaseAuth || null;
  }

  function emit(action, item = null, extra = {}) {
    try {
      global.dispatchEvent(
        new CustomEvent("ksk:notification-cloud-change", {
          detail: {
            collection: TABLE,
            action,
            item,
            ...extra
          }
        })
      );
    } catch (error) {
      console.warn("Notification event failed:", error);
    }
  }

  function normalizeNotification(item) {
    if (!item) return null;

    return {
      id: item.id,
      recipientId: item.recipient_id,
      actorId: item.actor_id || "",
      type: item.type || "system",
      text: item.text || "",
      entityType: item.entity_type || "",
      entityId: item.entity_id || "",
      read: Boolean(item.is_read),
      createdAt: item.created_at || "",
      time: item.created_at || ""
    };
  }

  function handleError(error) {
    const code = error?.code || "SUPABASE_ERROR";

    const messages = {
      "42501": "यो कार्य गर्ने अनुमति छैन।",
      "23503": "सम्बन्धित प्रयोगकर्ता भेटिएन।",
      "PGRST116": "Notification भेटिएन।",
      "23505": "यो विवरण पहिले नै सुरक्षित छ।"
    };

    return fail(
      code,
      messages[code] ||
        error?.message ||
        "Notification अनुरोध पूरा हुन सकेन।"
    );
  }

  /* =====================================================
     AUTHENTICATION CONTEXT
  ===================================================== */

  async function ready() {
    const api = auth();

    if (!api) {
      return fail(
        "AUTH_MODULE_MISSING",
        "Supabase Authentication सेवा उपलब्ध छैन।"
      );
    }

    try {
      await api.initialize();
    } catch (error) {
      return fail(
        error?.code || "AUTH_ERROR",
        error?.message || "Authentication सुरु हुन सकेन।"
      );
    }

    if (!api.isAuthenticated?.()) {
      return fail(
        "NOT_AUTHENTICATED",
        "पहिले आफ्नो खातामा लगइन गर्नुहोस्।"
      );
    }

    const client = api.getClient?.();
    const user = api.getUser?.();
    const userId = normalizeId(user?.id);

    if (!client || !userId) {
      return fail(
        "USER_NOT_AVAILABLE",
        "प्रयोगकर्ता विवरण प्राप्त भएन।"
      );
    }

    return result(true, "READY", {
      client,
      user,
      userId
    });
  }

  /* =====================================================
     LOAD NOTIFICATIONS
  ===================================================== */

  async function getNotifications(options = {}) {
    const session = await ready();

    if (!session.ok) return session;

    const { client, userId } = session.data;

    const requestedLimit = Number(options.limit) || 80;

    const limit = Math.min(
      200,
      Math.max(1, Math.floor(requestedLimit))
    );

    try {
      const { data, error } = await client
        .from(TABLE)
        .select(SELECT_FIELDS)
        .eq("recipient_id", userId)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) throw error;

      return result(
        true,
        "NOTIFICATIONS_LOADED",
        (data || [])
          .map(normalizeNotification)
          .filter(Boolean)
      );

    } catch (error) {
      return handleError(error);
    }
  }

  /* =====================================================
     CREATE NOTIFICATION
     DATABASE MANAGED ONLY
  ===================================================== */

  async function createNotification(input = {}) {
    const session = await ready();

    if (!session.ok) return session;

    const type = normalizeText(input.type || "system", 60);

    if (type === "message") {
      return fail(
        "MESSAGE_NOTIFICATION_AUTOMATIC",
        "Message Notification Database Trigger बाट स्वतः सिर्जना हुन्छ।"
      );
    }

    return fail(
      "CLIENT_INSERT_NOT_ALLOWED",
      "सुरक्षाका लागि Browser बाट Notification सीधै सिर्जना गर्न मिल्दैन।"
    );
  }

  /* =====================================================
     MARK ONE AS READ
  ===================================================== */

  async function markAsRead(notificationId) {
    const id = normalizeId(notificationId);

    if (!id) {
      return fail(
        "INVALID_NOTIFICATION_ID",
        "Notification ID मान्य छैन।"
      );
    }

    const session = await ready();

    if (!session.ok) return session;

    const { client, userId } = session.data;

    try {
      const { data, error } = await client
        .from(TABLE)
        .update({ is_read: true })
        .eq("id", id)
        .eq("recipient_id", userId)
        .select(SELECT_FIELDS)
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        return fail(
          "NOTIFICATION_NOT_FOUND",
          "Notification भेटिएन वा अनुमति छैन।"
        );
      }

      const item = normalizeNotification(data);

      emit("read", item);

      return result(
        true,
        "NOTIFICATION_READ",
        item
      );

    } catch (error) {
      return handleError(error);
    }
  }

  /* =====================================================
     MARK ALL AS READ
  ===================================================== */

  async function markAllAsRead() {
    const session = await ready();

    if (!session.ok) return session;

    const { client, userId } = session.data;

    try {
      const { data, error } = await client
        .from(TABLE)
        .update({ is_read: true })
        .eq("recipient_id", userId)
        .eq("is_read", false)
        .select("id");

      if (error) throw error;

      const count = data?.length || 0;

      emit("mark-all-read", null, { count });

      return result(
        true,
        "ALL_NOTIFICATIONS_READ",
        { count }
      );

    } catch (error) {
      return handleError(error);
    }
  }

  /* =====================================================
     DELETE NOTIFICATION
  ===================================================== */

  async function deleteNotification(notificationId) {
    const id = normalizeId(notificationId);

    if (!id) {
      return fail(
        "INVALID_NOTIFICATION_ID",
        "Notification ID मान्य छैन।"
      );
    }

    const session = await ready();

    if (!session.ok) return session;

    const { client, userId } = session.data;

    try {
      const { data, error } = await client
        .from(TABLE)
        .delete()
        .eq("id", id)
        .eq("recipient_id", userId)
        .select("id")
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        return fail(
          "NOTIFICATION_NOT_FOUND",
          "Notification भेटिएन वा अनुमति छैन।"
        );
      }

      emit("delete", { id: data.id });

      return result(
        true,
        "NOTIFICATION_DELETED",
        { id: data.id }
      );

    } catch (error) {
      return handleError(error);
    }
  }

  /* =====================================================
     STOP REALTIME
  ===================================================== */

  async function stopRealtime() {
    realtimeGeneration += 1;
    realtimeStartPromise = null;
    retryAttempt = 0;

    if (retryTimer !== null) {
      global.clearTimeout(retryTimer);
      retryTimer = null;
    }

    const channel = realtimeChannel;
    const client = realtimeClient;

    realtimeChannel = null;
    realtimeClient = null;
    realtimeUserId = "";

    if (channel && client?.removeChannel) {
      try {
        await client.removeChannel(channel);
      } catch (error) {
        console.warn(
          "Notification Realtime cleanup failed:",
          error
        );
      }
    }

    return true;
  }

  /* =====================================================
     RETRY MANAGEMENT
  ===================================================== */

  function scheduleRetry(generation) {
    if (
      generation !== realtimeGeneration ||
      retryTimer !== null
    ) {
      return false;
    }

    const delay = Math.min(
      30000,
      1500 * Math.pow(2, Math.min(retryAttempt, 5))
    );

    retryAttempt += 1;

    retryTimer = global.setTimeout(() => {
      retryTimer = null;

      if (generation !== realtimeGeneration) return;

      startRealtime();
    }, delay);

    return true;
  }

  /* =====================================================
     REALTIME EVENT HANDLER
  ===================================================== */

  function handleRealtimePayload(payload, generation) {
    if (generation !== realtimeGeneration) return;

    const eventType = String(
      payload?.eventType || ""
    ).toUpperCase();

    if (eventType === "INSERT" && payload?.new) {
      const item = normalizeNotification(payload.new);

      if (item) emit("add", item);

      return;
    }

    if (eventType === "UPDATE" && payload?.new) {
      const item = normalizeNotification(payload.new);

      if (item) emit("update", item);

      return;
    }

    if (eventType === "DELETE" && payload?.old?.id) {
      emit("delete", {
        id: payload.old.id
      });
    }
  }

  /* =====================================================
     START REALTIME
  ===================================================== */

  async function startRealtime() {
    if (realtimeStartPromise) {
      return realtimeStartPromise;
    }

    const generation = realtimeGeneration;

    let startPromise;

    startPromise = (async () => {
      const session = await ready();

      if (!session.ok) {
        if (generation === realtimeGeneration) {
          emit("realtime-status", null, {
            status: "AUTH_REQUIRED"
          });
        }

        return false;
      }

      const { client, userId } = session.data;

      if (generation !== realtimeGeneration) {
        return false;
      }

      if (
        realtimeChannel &&
        realtimeClient === client &&
        realtimeUserId === userId
      ) {
        return true;
      }

      const previousChannel = realtimeChannel;
      const previousClient = realtimeClient;

      realtimeChannel = null;
      realtimeClient = null;
      realtimeUserId = "";

      if (previousChannel && previousClient?.removeChannel) {
        try {
          await previousClient.removeChannel(previousChannel);
        } catch (error) {
          console.warn(
            "Previous notification channel cleanup failed:",
            error
          );
        }
      }

      if (generation !== realtimeGeneration) {
        return false;
      }

      let channel = null;
      let timeoutId = null;

      try {
        const subscribed = await new Promise(resolve => {
          let settled = false;

          const finish = value => {
            if (settled) return;

            settled = true;

            if (timeoutId !== null) {
              global.clearTimeout(timeoutId);
              timeoutId = null;
            }

            resolve(value);
          };

          channel = client
            .channel(CHANNEL_PREFIX + ":" + userId)
            .on(
              "postgres_changes",
              {
                event: "*",
                schema: "public",
                table: TABLE,
                filter: "recipient_id=eq." + userId
              },
              payload => {
                handleRealtimePayload(
                  payload,
                  generation
                );
              }
            );

          realtimeChannel = channel;
          realtimeClient = client;
          realtimeUserId = userId;

          timeoutId = global.setTimeout(() => {
            emit("realtime-status", null, {
              status: "TIMED_OUT"
            });

            finish(false);
          }, 15000);

          channel.subscribe(status => {
            if (generation !== realtimeGeneration) {
              finish(false);
              return;
            }

            emit("realtime-status", null, {
              status
            });

            if (status === "SUBSCRIBED") {
              retryAttempt = 0;

              if (retryTimer !== null) {
                global.clearTimeout(retryTimer);
                retryTimer = null;
              }

              finish(true);
              return;
            }

            if (
              status === "CHANNEL_ERROR" ||
              status === "TIMED_OUT" ||
              status === "CLOSED"
            ) {
              if (realtimeChannel === channel) {
                realtimeChannel = null;
                realtimeClient = null;
                realtimeUserId = "";
              }

              finish(false);
              scheduleRetry(generation);
            }
          });
        });

        if (
          !subscribed ||
          generation !== realtimeGeneration
        ) {
          if (realtimeChannel === channel) {
            realtimeChannel = null;
            realtimeClient = null;
            realtimeUserId = "";
          }

          if (channel && client.removeChannel) {
            try {
              await client.removeChannel(channel);
            } catch (error) {
              console.warn(
                "Notification channel cleanup failed:",
                error
              );
            }
          }

          scheduleRetry(generation);

          return false;
        }

        return true;

      } catch (error) {
        console.error(
          "Notification Realtime error:",
          error
        );

        if (realtimeChannel === channel) {
          realtimeChannel = null;
          realtimeClient = null;
          realtimeUserId = "";
        }

        if (channel && client.removeChannel) {
          try {
            await client.removeChannel(channel);
          } catch (_) {}
        }

        emit("realtime-status", null, {
          status: "CHANNEL_ERROR",
          message: error?.message || ""
        });

        scheduleRetry(generation);

        return false;
      }

    })().finally(() => {
      if (realtimeStartPromise === startPromise) {
        realtimeStartPromise = null;
      }
    });

    realtimeStartPromise = startPromise;

    return startPromise;
  }

  /* =====================================================
     INITIALIZE
  ===================================================== */

  async function initialize() {
    const session = await ready();

    if (!session.ok) {
      initialized = false;
      return session;
    }

    initialized = true;

    await startRealtime();

    return result(
      true,
      "NOTIFICATIONS_INITIALIZED",
      { realtime: Boolean(realtimeChannel) }
    );
  }

  /* =====================================================
     AUTHENTICATION EVENTS
  ===================================================== */

  global.addEventListener("ksk:auth-ready", event => {
    if (event?.detail?.user?.id) {
      startRealtime();
    }
  });

  global.addEventListener("ksk:auth-change", event => {
    const user = event?.detail?.user;

    stopRealtime().then(() => {
      if (user?.id) {
        startRealtime();
      } else {
        initialized = false;
      }
    });
  });

  /* =====================================================
     NETWORK RECONNECT
  ===================================================== */

  global.addEventListener("online", () => {
    if (retryTimer !== null) {
      global.clearTimeout(retryTimer);
      retryTimer = null;
    }

    startRealtime();
  });

  /* =====================================================
     PAGE RESTORE
  ===================================================== */

  global.addEventListener("pageshow", event => {
    if (event?.persisted) {
      startRealtime();
    }
  });

  /* =====================================================
     PAGE EXIT
  ===================================================== */

  global.addEventListener("pagehide", () => {
    stopRealtime();
  });

  /* =====================================================
     PUBLIC API
  ===================================================== */

  global.KSKSupabaseNotifications = Object.freeze({
    initialize,
    getNotifications,
    createNotification,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    startRealtime,
    stopRealtime
  });

  console.info(
    "KSK WhatsApp Notifications Service loaded."
  );

})(window);
