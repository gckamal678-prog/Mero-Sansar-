
"use strict";

/*
 * MERO SANSAR — CHAT RELIABILITY LAYER
 *
 * Load order:
 * supabase-auth.js
 * supabase-messages.js
 * supabase-chat-reliability.js
 * app.js
 *
 * Direct message permission is enforced by Supabase RLS.
 * Client-side friendship pre-check is intentionally removed
 * from sendMessage to prevent false blocking.
 */

(function (global) {
  if (global.KSKChatReliabilityLoaded) return;

  const original = global.KSKSupabaseMessages;
  const auth = global.KSKSupabaseAuth;

  if (!original || !auth) {
    console.error("Chat Reliability: required services missing.");
    return;
  }

  const deliveredMessages = new Set();

  function failure(code, message) {
    return {
      ok: false,
      code,
      data: null,
      message
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
   * Direct Chat creation:
   * Only accepted friends can create a direct chat.
   */
  async function createDirectChat(friendId) {
    try {
      const { client, user } = await getContext();

      if (!friendId || friendId === user.id) {
        return failure(
          "INVALID_FRIEND",
          "मान्य साथी छान्नुहोस्।"
        );
      }

      const friends = await hasFriendship(
        client,
        user.id,
        friendId
      );

      if (!friends) {
        return failure(
          "FRIENDSHIP_REQUIRED",
          "Friend Request स्वीकार भएपछि मात्र Chat खोल्न मिल्छ।"
        );
      }

      return await original.createDirectChat(friendId);

    } catch (error) {
      console.error("Direct Chat:", error);

      return failure(
        "DIRECT_CHAT_FAILED",
        error.message || "Direct Chat बनाउन सकिएन।"
      );
    }
  }

  /*
   * Send Message:
   *
   * IMPORTANT:
   * Do not perform extra client-side conversation,
   * member or friendship queries before sending.
   *
   * The original Supabase message service performs
   * the INSERT. Supabase RLS remains the final authority
   * and blocks messages when friendship is not accepted.
   */
  async function sendMessage(conversationId, content, options) {
    try {
      const response = await original.sendMessage(
        conversationId,
        content,
        options || {}
      );

      if (!response?.ok && isRlsError(response?.message)) {
        return failure(
          "MESSAGE_NOT_ALLOWED",
          "सन्देश पठाउन अनुमति भएन। पहिले साथी बनेको र Chat सदस्यता जाँच गर्नुहोस्।"
        );
      }

      return response;

    } catch (error) {
      console.error("Send Message:", error);

      return failure(
        "MESSAGE_SEND_FAILED",
        error.message || "सन्देश पठाउन सकिएन।"
      );
    }
  }

  /*
   * Load message history with actual read receipts.
   *
   * Only READ receipts are exposed through receipts.
   * Delivery-only receipts remain in deliveryReceipts.
   */
  async function getMessages(conversationId, options) {
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

        message.receipts = all.filter(
          receipt =>
            receipt.userId !== user.id &&
            Boolean(receipt.readAt)
        );
      });

    } catch (error) {
      console.warn("Read Receipt loading:", error);
    }

    return response;
  }

  /*
   * Mark an incoming realtime message as delivered.
   */
  async function handleIncomingMessage(event) {
    const detail = event.detail || {};

    if (detail.action !== "realtime-message") return;
    if (detail.eventType !== "INSERT") return;

    const message = detail.message || {};

    if (!message.id || !message.sender_id) return;

    try {
      const { user } = await getContext();

      if (message.sender_id === user.id) return;
      if (deliveredMessages.has(message.id)) return;

      deliveredMessages.add(message.id);

      const response = await original.markDelivered(message.id);

      if (!response?.ok) {
        deliveredMessages.delete(message.id);

        console.warn(
          "Message delivery receipt failed:",
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
   * Wrap the existing service.
   */
  global.KSKSupabaseMessages = new Proxy(original, {
    get(target, property) {
      if (property === "createDirectChat") {
        return createDirectChat;
      }

      if (property === "sendMessage") {
        return sendMessage;
      }

      if (property === "getMessages") {
        return getMessages;
      }

      return Reflect.get(target, property, target);
    }
  });

  global.KSKChatReliabilityLoaded = true;

  console.info(
    "Mero Sansar Chat Reliability loaded."
  );

})(window);
