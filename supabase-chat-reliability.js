
"use strict";

/*
 * MERO SANSAR — CHAT RELIABILITY LAYER
 *
 * FIX:
 * Do not Proxy Object.freeze(KSKSupabaseMessages).
 * A frozen object's non-writable methods cannot be
 * replaced through a Proxy get trap.
 *
 * Use Object.create(original) and own method overrides.
 *
 * Rules:
 * - Accepted friendship required for direct chat creation.
 * - Message sending goes directly to original service.
 * - Supabase RLS remains the final permission authority.
 * - Read receipts and delivered receipts are preserved.
 */

(function (global) {
  "use strict";

  if (global.KSKChatReliabilityLoaded) return;

  const original = global.KSKSupabaseMessages;
  const auth = global.KSKSupabaseAuth;

  if (!original || !auth) {
    console.error(
      "Chat Reliability: required services missing."
    );
    return;
  }

  const deliveredMessages = new Set();

  function failure(code, message) {
    return {
      ok: false,
      code,
      data: null,
      message: message || "अनुरोध पूरा हुन सकेन।"
    };
  }

  async function getContext() {
    const ready = await auth.initialize();

    if (!ready || !auth.isAuthenticated?.()) {
      throw new Error("पहिले आफ्नो खातामा लगइन गर्नुहोस्।");
    }

    const client = auth.getClient?.();
    const user = auth.getUser?.();

    if (!client || !user?.id) {
      throw new Error("Supabase Session उपलब्ध भएन।");
    }

    return { client, user };
  }

  function errorMessage(error) {
    return String(
      error?.message ||
      error?.details ||
      "अनुरोध पूरा हुन सकेन।"
    );
  }

  function isRlsError(message) {
    const value = String(message || "").toLowerCase();

    return (
      value.includes("row-level security") ||
      value.includes("permission denied") ||
      value.includes("42501")
    );
  }

  async function hasFriendship(client, userId, friendId) {
    const [first, second] = [userId, friendId].sort();

    const { data, error } = await client
      .from("friendships")
      .select("user_a_id,user_b_id")
      .eq("user_a_id", first)
      .eq("user_b_id", second)
      .maybeSingle();

    if (error) throw error;

    return Boolean(data);
  }

  /*
   * DIRECT CHAT
   * Only accepted friends can create a direct conversation.
   */
  async function createDirectChat(friendId) {
    try {
      const { client, user } = await getContext();

      const id = String(friendId || "").trim();

      if (!id || id === user.id) {
        return failure(
          "INVALID_FRIEND",
          "मान्य साथी छान्नुहोस्।"
        );
      }

      const friends = await hasFriendship(
        client,
        user.id,
        id
      );

      if (!friends) {
        return failure(
          "FRIENDSHIP_REQUIRED",
          "Friend Request स्वीकार भएपछि मात्र Chat खोल्न मिल्छ।"
        );
      }

      return await original.createDirectChat(id);

    } catch (error) {
      console.error("Direct Chat:", error);

      return failure(
        "DIRECT_CHAT_FAILED",
        errorMessage(error)
      );
    }
  }

  /*
   * SEND MESSAGE
   *
   * IMPORTANT:
   * No extra client-side friendship or membership query.
   * Original service performs the actual INSERT.
   * Supabase RLS validates permission.
   */
  async function sendMessage(
    conversationId,
    content,
    options = {}
  ) {
    try {
      const id = String(conversationId || "").trim();
      const text = String(content || "").trim();

      if (!id) {
        return failure(
          "CONVERSATION_REQUIRED",
          "पहिले कुराकानी छान्नुहोस्।"
        );
      }

      if (!text) {
        return failure(
          "MESSAGE_EMPTY",
          "सन्देश लेख्नुहोस्।"
        );
      }

      console.info("[Mero Sansar] Sending message:", {
        conversationId: id,
        length: text.length
      });

      const response = await original.sendMessage(
        id,
        text,
        options || {}
      );

      if (!response?.ok) {
        console.error(
          "[Mero Sansar] Message send failed:",
          response?.code,
          response?.message
        );

        if (isRlsError(response?.message)) {
          return failure(
            "MESSAGE_NOT_ALLOWED",
            "सन्देश पठाउन अनुमति भएन। साथीपन र Chat सदस्यता जाँच गर्नुहोस्।"
          );
        }

        return response || failure(
          "MESSAGE_SEND_FAILED",
          "सन्देश पठाउन सकिएन।"
        );
      }

      console.info(
        "[Mero Sansar] Message sent successfully:",
        response.data?.id
      );

      return response;

    } catch (error) {
      console.error("[Mero Sansar] Send Message:", error);

      return failure(
        "MESSAGE_SEND_FAILED",
        errorMessage(error)
      );
    }
  }

  /*
   * LOAD MESSAGES + RECEIPTS
   */
  async function getMessages(conversationId, options = {}) {
    const response = await original.getMessages(
      conversationId,
      options || {}
    );

    if (!response?.ok || !Array.isArray(response.data)) {
      return response;
    }

    const messages = response.data;
    const ids = messages
      .map(message => message.id)
      .filter(Boolean);

    if (!ids.length) return response;

    try {
      const { client, user } = await getContext();

      const { data, error } = await client
        .from("message_receipts")
        .select(
          "message_id,user_id,delivered_at,read_at"
        )
        .in("message_id", ids);

      if (error) throw error;

      const receiptMap = new Map();

      (data || []).forEach(row => {
        if (!receiptMap.has(row.message_id)) {
          receiptMap.set(row.message_id, []);
        }

        receiptMap.get(row.message_id).push({
          userId: row.user_id,
          deliveredAt: row.delivered_at || null,
          readAt: row.read_at || null
        });
      });

      messages.forEach(message => {
        const all = receiptMap.get(message.id) || [];

        message.deliveryReceipts = all;

        message.receipts = all.filter(receipt =>
          receipt.userId !== user.id &&
          Boolean(receipt.readAt)
        );
      });

    } catch (error) {
      console.warn(
        "Read Receipt loading:",
        error
      );
    }

    return response;
  }

  /*
   * INCOMING REALTIME MESSAGE
   * Mark incoming messages as delivered.
   */
  async function handleIncomingMessage(event) {
    const detail = event?.detail || {};

    if (detail.action !== "realtime-message") return;
    if (detail.eventType !== "INSERT") return;

    const message = detail.message || {};

    if (!message.id || !message.sender_id) return;

    try {
      const { user } = await getContext();

      if (message.sender_id === user.id) return;
      if (deliveredMessages.has(message.id)) return;

      deliveredMessages.add(message.id);

      const response = await original.markDelivered(
        message.id
      );

      if (!response?.ok) {
        deliveredMessages.delete(message.id);

        console.warn(
          "Delivery receipt failed:",
          response?.message
        );
      }

    } catch (error) {
      deliveredMessages.delete(message.id);

      console.warn(
        "Incoming message delivery:",
        error
      );
    }
  }

  global.addEventListener(
    "ksk:messages-cloud-change",
    handleIncomingMessage
  );

  /*
   * SERVICE FACADE
   *
   * Original service is frozen.
   * Object.create allows safe own method overrides
   * without violating Proxy invariants.
   *
   * All other original service methods remain available
   * through the prototype.
   */
  const facade = Object.create(original);

  Object.defineProperties(facade, {
    createDirectChat: {
      value: createDirectChat,
      enumerable: true,
      configurable: false,
      writable: false
    },

    sendMessage: {
      value: sendMessage,
      enumerable: true,
      configurable: false,
      writable: false
    },

    getMessages: {
      value: getMessages,
      enumerable: true,
      configurable: false,
      writable: false
    }
  });

  global.KSKSupabaseMessages = facade;

  global.KSKChatReliabilityLoaded = true;

  console.info(
    "Mero Sansar Chat Reliability loaded — Service Facade active."
  );

})(window);
