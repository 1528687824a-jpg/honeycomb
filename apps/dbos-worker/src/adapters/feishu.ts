type FeishuSendResult =
  | {
      mode: "dry_run";
      feishuMessageId: null;
      reason: string;
      senderAgentId: string;
    }
  | {
      mode: "sent";
      feishuMessageId: string;
      senderAgentId: string;
    };

let cachedTenantToken: { token: string; expiresAt: number } | null = null;

function getFeishuBaseUrl() {
  return process.env.FEISHU_API_BASE ?? "https://open.feishu.cn";
}

function feishuConfigured() {
  return Boolean(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET);
}

async function getTenantAccessToken(): Promise<string> {
  if (cachedTenantToken && cachedTenantToken.expiresAt > Date.now() + 60_000) {
    return cachedTenantToken.token;
  }

  const response = await fetch(`${getFeishuBaseUrl()}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET
    })
  });

  const data = (await response.json()) as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
    expire?: number;
  };

  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Feishu tenant token request failed: ${data.msg ?? response.statusText}`);
  }

  cachedTenantToken = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + Math.max((data.expire ?? 7200) - 120, 60) * 1000
  };

  return cachedTenantToken.token;
}

export async function sendFeishuTextMessage(input: {
  chatId?: string | null;
  senderAgentId: string;
  mentionAgentId?: string | null;
  text: string;
}): Promise<FeishuSendResult> {
  const chatId = input.chatId ?? process.env.FEISHU_DEFAULT_CHAT_ID ?? null;

  if (process.env.FEISHU_DRY_RUN === "true") {
    return {
      mode: "dry_run",
      feishuMessageId: null,
      reason: "FEISHU_DRY_RUN=true",
      senderAgentId: input.senderAgentId
    };
  }

  if (!chatId) {
    return {
      mode: "dry_run",
      feishuMessageId: null,
      reason: "missing chat id",
      senderAgentId: input.senderAgentId
    };
  }

  if (!feishuConfigured()) {
    return {
      mode: "dry_run",
      feishuMessageId: null,
      reason: "missing FEISHU_APP_ID/FEISHU_APP_SECRET",
      senderAgentId: input.senderAgentId
    };
  }

  const token = await getTenantAccessToken();
  const response = await fetch(`${getFeishuBaseUrl()}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text: input.text })
    })
  });

  const data = (await response.json()) as {
    code?: number;
    msg?: string;
    data?: {
      message_id?: string;
    };
  };

  if (!response.ok || data.code !== 0 || !data.data?.message_id) {
    throw new Error(`Feishu message send failed: ${data.msg ?? response.statusText}`);
  }

  return {
    mode: "sent",
    feishuMessageId: data.data.message_id,
    senderAgentId: input.senderAgentId
  };
}
