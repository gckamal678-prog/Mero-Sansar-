
"use strict";

/*
 * MERO SANSAR — INDEPENDENT CHAT RELIABILITY
 *
 * Responsibilities:
 * - Create direct chats only for accepted friends.
 * - Send messages directly through Supabase INSERT.
 * - Send replies through the same INSERT path.
 * - Keep Supabase RLS as final permission authority.
 * - Preserve original Messenger methods.
 * - Load delivery/read receipts without breaking chat.
 */

(function (global) {
  "use strict";

  if (global.KSKChatReliabilityLoaded) return;

  const original = global.KSKSupabaseMessages;
  const auth = global.KSKSupabaseAuth;

  if (!original || !auth) {
    console.error(
      "[Mero Sansar] Chat Reliability: services missing."
    );
    return;
  }

  const MESSAGE_TABLE = "messages";
  const RECEIPT_TABLE = "message_receipts";
  const MAX_MESSAGE_LENGTH = 5000;

  const deliveredMessages = new Set();

  function result(ok, code, data = null, message = "") {
    return { ok, code, data, message };
  }

  function failure(code, message) {
    return result(
      false,
      code,
      null,
      message || "अनुरोध पूरा हुन सकेन।"
    );
  }

  function errorMessage(error) {
    return String(
      error?.message ||
      error?.details ||
      error?.hint ||
      "Supabase अनुरोध असफल भयो।"
    );
  }

  async function getContext() {
    const initialized = await auth.initialize();

    if (!initialized || !auth.isAuthenticated?.()) {
      throw new Error("पहिले आफ्नो खातामा लगइन गर्नुहोस्।");
    }

    const client = auth.getClient?.();
    const user = auth.getUser?.();

    if (!client || !user?.id) {
      throw new Error("Supabase Session उपलब्ध भएन।");
    }

    return { client, user };
  }

  function notify(action, detail = {}) {
    try {
      global.dispatchEvent(
        new CustomEvent("ksk:messages-cloud-change", {
          detail: { action, ...detail }
        })
      );
    } catch (error) {
      console.warn(
        "[Mero Sansar] Message event:",
        error
      );
    }
  }

  function normalizeMessage(row, userId) {
    if (!row) return null;

    return {
      id: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,

      content: row.content || "",
      text: row.content || "",

      type: row.message_type || "text",

      mediaPath: row.media_path || null,
      mediaName: row.media_name || null,
      mediaMime: row.media_mime || null,
      mediaSize: row.media_size || null,

      replyToId: row.reply_to_id || null,
      forwardedFromId: row.forwarded_from_id || null,

      deletedAt: row.deleted_at || null,
      deletedForEveryone: Boolean(
        row.deleted_for_everyone
      ),

      fromMe: row.sender_id === userId,

      createdAt: row.created_at,
      editedAt: row.edited_at || null,

      receipts: [],
      deliveryReceipts: []
    };
  }

  function isRlsError(error) {
    const message = errorMessage(error).toLowerCase();

    return (
      message.includes("row-level security") ||
      message.includes("permission denied") ||
      message.includes("42501") ||
      error?.code === "42501"
    );
  }

  /*
   * ACCEPTED FRIENDSHIP CHECK
   */
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
   * CREATE DIRECT CHAT
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

      const accepted = await hasFriendship(
        client,
        user.id,
        id
      );

      if (!accepted) {
        return failure(
          "FRIENDSHIP_REQUIRED",
          "Friend Request स्वीकार भएपछि मात्र Chat खोल्न मिल्छ।"
        );
      }

      return await original.createDirectChat(id);

    } catch (error) {
      console.error(
        "[Mero Sansar] Direct Chat:",
        error
      );

      return failure(
        "DIRECT_CHAT_FAILED",
        errorMessage(error)
      );
    }
  }

  /*
   * INDEPENDENT MESSAGE INSERT
   *
   * This function does not call original.sendMessage().
   * The INSERT is performed directly from this file.
   * Database RLS remains responsible for authorization.
   */
  async function sendMessage(
    conversationId,
    content,
    options = {}
  ) {
    try {
      const { client, user } = await getContext();

      const id = String(
        conversationId || ""
      ).trim();

      const text = String(
        content || ""
      ).trim();

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

      if (text.length > MAX_MESSAGE_LENGTH) {
        return failure(
          "MESSAGE_TOO_LONG",
          "सन्देश बढीमा 5000 अक्षरको हुनुपर्छ।"
        );
      }

      const row = {
        conversation_id: id,
        sender_id: user.id,
        content: text,
        message_type: "text",
        media_path: null,
        media_name: null,
        media_mime: null,
        media_size: null,
        reply_to_id: options?.replyToId || null,
        forwarded_from_id:
          options?.forwardedFromId || null
      };

      console.info(
        "[Mero Sansar] Independent message INSERT:",
        {
          conversationId: id,
          senderId: user.id,
          length: text.length
        }
      );

      const { data, error } = await client
        .from(MESSAGE_TABLE)
        .insert(row)
        .select([
          "id",
          "conversation_id",
          "sender_id",
          "content",
          "message_type",
          "media_path",
          "media_name",
          "media_mime",
          "media_size",
          "reply_to_id",
          "forwarded_from_id",
          "deleted_at",
          "deleted_for_everyone",
          "created_at",
          "edited_at"
        ].join(","))
        .single();

      if (error) {
        console.error(
          "[Mero Sansar] Supabase INSERT error:",
          error
        );

        if (isRlsError(error)) {
          return failure(
            "MESSAGE_NOT_ALLOWED",
            "सन्देश पठाउन अनुमति भएन। साथीपन र Chat सदस्यता जाँच गर्नुहोस्।"
          );
        }

        return failure(
          "MESSAGE_INSERT_FAILED",
          errorMessage(error)
        );
      }

      const message = normalizeMessage(
        data,
        user.id
      );

      if (!message?.id) {
        return failure(
          "MESSAGE_RESPONSE_INVALID",
          "Supabase बाट सन्देशको पुष्टि प्राप्त भएन।"
        );
      }

      notify("message-sent", {
        conversationId: id,
        message
      });

      console.info(
        "[Mero Sansar] Message INSERT successful:",
        message.id
      );

      return result(
        true,
        "MESSAGE_SENT",
        message,
        "सन्देश पठाइयो।"
      );

    } catch (error) {
      console.error(
        "[Mero Sansar] Independent Send:",
        error
      );

      return failure(
        "MESSAGE_SEND_FAILED",
        errorMessage(error)
      );
    }
  }

  /*
   * REPLY
   *
   * Reply also uses this file's independent INSERT.
   */
  async function replyMessage(
    conversationId,
    content,
    replyToId
  ) {
    const target = String(
      replyToId || ""
    ).trim();

    if (!target) {
      return failure(
        "REPLY_TARGET_REQUIRED",
        "जवाफ दिने सन्देश छान्नुहोस्।"
      );
    }

    return sendMessage(
      conversationId,
      content,
      { replyToId: target }
    );
  }

  /*
   * LOAD MESSAGES + RECEIPTS
   */
  async function getMessages(
    conversationId,
    options = {}
  ) {
    const response = await original.getMessages(
      conversationId,
      options || {}
    );

    if (
      !response?.ok ||
      !Array.isArray(response.data)
    ) {
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
        .from(RECEIPT_TABLE)
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
        const receipts =
          receiptMap.get(message.id) || [];

        message.deliveryReceipts = receipts;

        message.receipts = receipts.filter(
          receipt =>
            receipt.userId !== user.id &&
            Boolean(receipt.readAt)
        );
      });

    } catch (error) {
      console.warn(
        "[Mero Sansar] Receipt loading:",
        error
      );
    }

    return response;
  }

  /*
   * INCOMING REALTIME MESSAGE DELIVERY
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
          "[Mero Sansar] Delivery receipt failed:",
          response?.message
        );
      }

    } catch (error) {
      deliveredMessages.delete(message.id);

      console.warn(
        "[Mero Sansar] Incoming delivery:",
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
   * Original frozen service is preserved as prototype.
   * Send and Reply are replaced by independent functions.
   */
  const facade = Object.create(original);

  Object.defineProperties(facade, {
    createDirectChat: {
      value: createDirectChat,
      enumerable: true
    },

    sendMessage: {
      value: sendMessage,
      enumerable: true
    },

    replyMessage: {
      value: replyMessage,
      enumerable: true
    },

    getMessages: {
      value: getMessages,
      enumerable: true
    }
  });

  global.KSKSupabaseMessages = facade;
  global.KSKChatReliabilityLoaded = true;

  console.info(
    "[Mero Sansar] Independent Chat Reliability loaded."
  );

})(window);
