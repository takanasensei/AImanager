import express from "express";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const app = express();

// LINE署名検証のため raw body が必要
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// デバッグ用 health（原因を可視化）
app.get("/health", async (req, res) => {
  try {
    // ① Render -> インターネット疎通チェック
    const netResp = await fetch("https://www.google.com/generate_204");
    const net_ok = netResp.ok;

    // ② Render -> Supabase疎通チェック（RESTに直で叩く）
    const base = (process.env.SUPABASE_URL || "").trim();
    const url = `${base}/rest/v1/users?select=user_id&limit=1`;

    const r = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      },
    });

    const body = await r.text();

    return res.json({
      ok: r.ok,
      net_ok,
      status: r.status,
      supabase_url: base,
      body: body.slice(0, 200),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      supabase_url: (process.env.SUPABASE_URL || "").trim(),
      error: String(e),
      cause: e?.cause ? String(e.cause) : null,
    });
  }
});

// LINE署名検証
function verifyLineSignature(req) {
  const signature = req.headers["x-line-signature"];
  if (!signature) return false;

  const hash = crypto
    .createHmac("sha256", process.env.LINE_CHANNEL_SECRET)
    .update(req.rawBody)
    .digest("base64");

  return hash === signature;
}

// LINE Reply API
async function replyToLine(replyToken, text) {
  const resp = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error("LINE reply failed:", resp.status, body);
  }
}

async function ensureUser(userId) {
  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (data) return data;

  const { data: created, error } = await supabase
    .from("users")
    .insert([{ user_id: userId, role: "staff", is_active: true }])
    .select("*")
    .single();

  if (error) console.error("ensureUser insert error:", error);
  return created;
}

async function saveMessage(userId, role, content) {
  const { error } = await supabase
    .from("conversations")
    .insert([{ user_id: userId, role, content }]);
  if (error) console.error("saveMessage error:", error);
}
async function searchManualKeyword(query, k = 5) {
  const { data, error } = await supabase
    .from("manual_chunks")
    .select("source,page,section,content")
    .textSearch("tsv", query, { type: "plain" })
    .limit(k);

  if (error) {
    console.error("keyword search error:", error);
    return [];
  }
  return data ?? [];
}
async function getRecentMessages(userId, limit = 12) {
  const { data, error } = await supabase
    .from("conversations")
    .select("role,content,created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) console.error("getRecentMessages error:", error);

  return (data ?? [])
    .reverse()
    .map((x) => ({ role: x.role, content: x.content }));
}

function buildSystemPrompt(userRole) {
  const roleRules =
    userRole === "leader"
      ? "リーダー向け。詳細手順はOK。ただし原価・秘匿レシピ・個人情報は出さない。"
      : "スタッフ向け。原価・秘匿レシピ・個人情報は出さない。困ったら責任者に確認を促す。";

  return `
あなたは高菜先生プロジェクトのAI店長。
結論→手順→注意点→そのまま使えるセリフ、の順で短く具体的に。
不明点は推測せず「確認が必要」と言う。
${roleRules}
`.trim();
}

// LINE Webhook
app.post("/webhook", async (req, res) => {
  if (!verifyLineSignature(req)) return res.status(401).send("Invalid signature");

  const events = req.body?.events ?? [];
  // 先に200返してタイムアウト防止
  res.status(200).send("OK");

  for (const ev of events) {
    if (ev.type !== "message") continue;
    if (ev.message?.type !== "text") continue;

    const userId = ev.source?.userId;
    const text = ev.message.text;
    const replyToken = ev.replyToken;

    if (!userId || !replyToken) continue;

    const user = await ensureUser(userId);
    if (!user?.is_active) {
      await replyToLine(replyToken, "このアカウントは現在利用できません。");
      continue;
    }

    await saveMessage(userId, "user", text);

    const history = await getRecentMessages(userId, 12);
    const system = buildSystemPrompt(user.role);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [{ role: "system", content: system }, ...history],
    });

    const reply =
      completion.choices?.[0]?.message?.content ??
      "すみません、もう一度お願いします。";

    await saveMessage(userId, "assistant", reply);
    await replyToLine(replyToken, reply);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port", port));
