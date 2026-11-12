/**
 * FCC Ife Bot (Cloudflare Worker + D1 + cron).
 *
 * Routes
 *   GET  /go/<tag>   Sticker QR lands here: count the scan, redirect to WhatsApp
 *                    with the pre-filled message carrying "(ref TAG)".
 *                    Link-preview crawlers (WhatsApp, Facebook, X...) get a preview
 *                    card (image + title) instead, and are not counted as scans.
 *   GET  /img/...    Images for messages and previews (static files in ./public).
 *   GET  /privacy    Privacy policy page (Meta needs a public URL to publish the app).
 *   GET  /           Meta webhook verification.
 *   POST /           Meta webhook: incoming WhatsApp messages.
 *   cron (every min) Sends follow-ups that are due.
 *
 * Conversation
 *   First message ever  -> welcome (answers link) + follow-up scheduled; tag logged.
 *   Admin sends STATS   -> scans/chats/follow-ups per tag (this week + all time).
 *   Any later message   -> hand-off reply pointing to the main church line
 *                          (max once per HANDOFF_COOLDOWN_HOURS, not before the follow-up).
 *
 * Secrets (synced from GitHub by the deploy workflow): VERIFY_TOKEN, APP_SECRET, ACCESS_TOKEN, ADMIN_NUMBERS
 * Everything else lives in [vars] in wrangler.toml.
 */

const UNTAGGED = "NONE";
const TAG_PATTERN = /\(\s*ref\s+([A-Za-z0-9-]{2,20})\s*\)/i;
const MAX_ATTEMPTS = 3;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path.replace(/\/+$/, "").toLowerCase() === "/privacy") {
      return privacyPage(env);
    }
    if (request.method === "GET" && path.toLowerCase().startsWith("/go/")) {
      if (isPreviewBot(request)) return previewCard(env, url);
      return redirectScan(env, path.slice(4));
    }
    if (request.method === "GET") {
      return verifyWebhook(env, url);
    }
    if (request.method === "POST") {
      return handleWebhook(request, env, ctx);
    }
    return new Response("method not allowed", { status: 405 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDueFollowups(env));
  },
};

// ------------------------------------------------------------------ QR redirect
async function redirectScan(env, rawTag) {
  let tag = decodeURIComponent(rawTag).replace(/\/+$/, "").toUpperCase();
  if (!(tag in tags(env))) tag = UNTAGGED; // unknown codes still reach WhatsApp, untagged
  await bump(env, tag, "scans");
  const text = env.PREFILLED_MESSAGE.replaceAll("{tag}", tag);
  const location = `https://wa.me/${env.ANSWERS_LINE_NUMBER}?text=${encodeURIComponent(text)}`;
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
}

// ------------------------------------------------------------------ link preview card
const PREVIEW_BOTS = /whatsapp|facebookexternalhit|facebot|twitterbot|telegrambot|slackbot|linkedinbot|discordbot|skypeuripreview|googlebot|bingbot/i;

function isPreviewBot(request) {
  return PREVIEW_BOTS.test(request.headers.get("user-agent") || "");
}

function previewCard(env, url) {
  const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const title = esc(env.SHARE_TITLE || "Ever wondered why you exist?");
  const desc = esc(env.SHARE_DESCRIPTION || "Find answers with Fullness of Christ Church, Ile-Ife.");
  const image = env.SHARE_IMAGE ? `<meta property="og:image" content="${esc(env.SHARE_IMAGE)}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(env.SHARE_IMAGE)}">` : "";
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>${title}</title>
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(url.href)}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
${image}
</head><body><h1>${title}</h1><p>${desc}</p></body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}

// ------------------------------------------------------------------ webhook
function verifyWebhook(env, url) {
  const q = url.searchParams;
  if (q.get("hub.mode") === "subscribe" && q.get("hub.verify_token") === env.VERIFY_TOKEN) {
    return new Response(q.get("hub.challenge") || "", { status: 200 });
  }
  return new Response("forbidden", { status: 403 });
}

async function handleWebhook(request, env, ctx) {
  const raw = await request.text();
  if (!(await signatureOk(env.APP_SECRET, raw, request.headers.get("x-hub-signature-256") || ""))) {
    return new Response("bad signature", { status: 401 });
  }
  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const jobs = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name || ""]));
      for (const msg of value.messages || []) {   // delivery/read "statuses" are ignored
        if (!msg.from) continue;
        const text = msg.type === "text" ? msg.text?.body || "" : "";
        jobs.push(
          onIncoming(env, msg.from, names[msg.from] || "", text).catch((e) =>
            console.log("Failed handling message from", msg.from, String(e))
          )
        );
      }
    }
  }
  ctx.waitUntil(Promise.all(jobs)); // reply to Meta right away; work continues
  return new Response("ok", { status: 200 });
}

async function onIncoming(env, sender, name, text) {
  if (adminNumbers(env).has(sender) && text.trim().toUpperCase() === "STATS") {
    await sendText(env, sender, await statsReport(env));
    return;
  }

  const tag = extractTag(env, text);
  const now = nowSeconds();
  const inserted = await env.DB.prepare(
    "INSERT INTO contacts (wa_id, name, tag, first_seen) VALUES (?, ?, ?, ?) ON CONFLICT(wa_id) DO NOTHING"
  ).bind(sender, name || "-", tag, now).run();

  if (inserted.meta.changes === 1) {
    // First contact (also makes Meta's webhook retries harmless)
    await bump(env, tag, "chats");
    await env.DB.prepare("INSERT INTO followups (wa_id, name, tag, due_at) VALUES (?, ?, ?, ?)")
      .bind(sender, name || "", tag, now + delaySeconds(env)).run();
    const link = (env.ANSWERS_LINKS || {})[tag] || env.ANSWERS_LINK;
    await sendMessage(env, sender, fill(env.WELCOME_MESSAGE, { name, link, tag }),
      { video: env.WELCOME_VIDEO, image: env.WELCOME_IMAGE });
    return;
  }

  // Returning person: hand-off, at most once per cooldown, never before the follow-up
  const cooldown = Math.floor(Number(env.HANDOFF_COOLDOWN_HOURS || 12) * 3600);
  const claimed = await env.DB.prepare(
    `UPDATE contacts SET last_handoff = ?1
     WHERE wa_id = ?2 AND first_seen <= ?3 AND (last_handoff IS NULL OR last_handoff <= ?4)`
  ).bind(now, sender, now - delaySeconds(env), now - cooldown).run();
  if (claimed.meta.changes === 1) {
    const row = await env.DB.prepare("SELECT tag FROM contacts WHERE wa_id = ?").bind(sender).first();
    await sendText(env, sender, fill(env.HANDOFF_MESSAGE, { name, main_link: mainLineLink(env, row?.tag || UNTAGGED) }));
  }
}

// ------------------------------------------------------------------ follow-ups (cron)
async function sendDueFollowups(env) {
  const now = nowSeconds();
  const { results } = await env.DB.prepare(
    `SELECT id, wa_id, name, tag, attempts FROM followups
     WHERE sent_at IS NULL AND due_at <= ? AND attempts < ? ORDER BY due_at LIMIT 50`
  ).bind(now, MAX_ATTEMPTS).all();

  for (const f of results) {
    try {
      const values = {
        name: f.name,
        main_number: env.MAIN_LINE_DISPLAY,
        main_link: mainLineLink(env, f.tag),
        channel_link: env.CHANNEL_LINK || "",
      };
      let body = fill(env.FOLLOWUP_MESSAGE, values);
      // The channel invitation is only added once a channel link is configured
      if (env.CHANNEL_LINK && env.FOLLOWUP_CHANNEL_BLOCK) body += "\n\n" + fill(env.FOLLOWUP_CHANNEL_BLOCK, values);
      await sendMessage(env, f.wa_id, body, { image: env.FOLLOWUP_IMAGE });
      await env.DB.prepare("UPDATE followups SET sent_at = ?, attempts = attempts + 1 WHERE id = ?")
        .bind(nowSeconds(), f.id).run();
      await bump(env, f.tag, "followups");
    } catch (e) {
      console.log("Follow-up failed for", f.wa_id, String(e));
      await env.DB.prepare("UPDATE followups SET attempts = attempts + 1, last_error = ? WHERE id = ?")
        .bind(String(e).slice(0, 500), f.id).run();
    }
  }
}

// ------------------------------------------------------------------ stats
async function bump(env, tag, counter) {
  if (!["scans", "chats", "followups"].includes(counter)) throw new Error("bad counter");
  const sql = `INSERT INTO stats (period, tag, ${counter}) VALUES (?, ?, 1)
               ON CONFLICT(period, tag) DO UPDATE SET ${counter} = ${counter} + 1`;
  await env.DB.batch([
    env.DB.prepare(sql).bind(currentWeek(), tag),
    env.DB.prepare(sql).bind("ALL", tag),
  ]);
}

async function statsReport(env) {
  const t = tags(env);
  const lines = [];
  for (const [title, period] of [["This week", currentWeek()], ["All time", "ALL"]]) {
    const { results } = await env.DB.prepare(
      "SELECT tag, scans, chats, followups FROM stats WHERE period = ? ORDER BY tag"
    ).bind(period).all();
    lines.push(period === "ALL" ? `*${title}*` : `*${title}* (${period})`);
    if (!results.length) lines.push("No activity yet.");
    const total = { scans: 0, chats: 0, followups: 0 };
    for (const r of results) {
      for (const k of Object.keys(total)) total[k] += r[k];
      lines.push(`${r.tag} (${t[r.tag] || "untagged"}): ${r.scans} scans, ${r.chats} chats, ${r.followups} follow-ups`);
    }
    if (results.length) lines.push(`Total: ${total.scans} scans, ${total.chats} chats, ${total.followups} follow-ups`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

// ------------------------------------------------------------------ privacy page
function privacyPage(env) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const contact = env.PRIVACY_CONTACT
    ? `<p>Questions or deletion requests: ${esc(env.PRIVACY_CONTACT)}, or message us on WhatsApp at +${esc(env.MAIN_LINE_NUMBER)}.</p>`
    : `<p>Questions or deletion requests: message us on WhatsApp at +${esc(env.MAIN_LINE_NUMBER)}.</p>`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy Policy - Fullness of Christ Church Ile-Ife answers line</title>
<style>body{font-family:system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 20px;line-height:1.6;color:#222}</style>
</head><body>
<h1>Privacy Policy</h1>
<p>This policy covers the WhatsApp answers line run by Fullness of Christ Church, Ile-Ife.</p>
<h2>What we collect</h2>
<p>When you message the answers line we receive your WhatsApp number, your WhatsApp profile name, your messages,
the location code included in the message (for example, which hall's sticker you scanned) and the time of your messages.
When you open one of our sticker links we count the visit; we do not record who opened it.</p>
<h2>How we use it</h2>
<p>Only to reply to you (the answers link and one follow-up message), to point you to our main church line,
and to count how many people each location reaches. We do not sell or share your information,
and we do not send you messages you did not start.</p>
<h2>Where it is stored</h2>
<p>Messages pass through WhatsApp (Meta). Your number, name, location code and first-contact time are stored
in a private database on Cloudflare.</p>
<h2>Deleting your data</h2>
<p>Ask us and we will delete your record within 7 days.</p>
${contact}
</body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ------------------------------------------------------------------ helpers
function tags(env) {
  return Object.fromEntries(Object.entries(env.TAGS || {}).map(([k, v]) => [k.toUpperCase(), v]));
}

function adminNumbers(env) {
  return new Set(String(env.ADMIN_NUMBERS || "").split(",").map((s) => s.trim()).filter(Boolean));
}

function delaySeconds(env) {
  return Math.max(0, Number(env.FOLLOWUP_DELAY_SECONDS ?? 900));
}

function extractTag(env, text) {
  const m = TAG_PATTERN.exec(text || "");
  if (!m) return UNTAGGED;
  const tag = m[1].toUpperCase();
  return tag in tags(env) ? tag : UNTAGGED;
}

function mainLineLink(env, tag) {
  const text = env.HELLO_MESSAGE.replaceAll("{tag}", tag);
  return `https://wa.me/${env.MAIN_LINE_NUMBER}?text=${encodeURIComponent(text)}`;
}

function currentWeek(date = new Date()) {
  // ISO-8601 week number, UTC
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function fill(template, values) {
  let out = template;
  for (const [k, v] of Object.entries(values)) out = out.replaceAll(`{${k}}`, v || "");
  return out.replace(/ +([,!.])/g, "$1").trim(); // tidy "Hi ," when the name is unknown
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

async function signatureOk(secret, raw, header) {
  if (!header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(7);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

const CAPTION_LIMIT = 1024; // WhatsApp's maximum media caption length

// Sends the text as the caption of a video (preferred) or picture, falling back step by step
// (video -> picture -> plain text) so the person always gets the message.
async function sendMessage(env, to, body, media = {}) {
  if (body.length <= CAPTION_LIMIT) {
    for (const type of ["video", "image"]) {
      const link = media[type];
      if (!link) continue;
      try {
        return await graphSend(env, { messaging_product: "whatsapp", to, type, [type]: { link, caption: body } });
      } catch (e) {
        if (String(e).includes(" 401 ")) throw e; // bad token: nothing else will work either
        console.log(`${type} send failed, trying the next option:`, String(e));
      }
    }
  }
  return sendText(env, to, body);
}

async function sendText(env, to, body) {
  return graphSend(env, { messaging_product: "whatsapp", to, type: "text", text: { body, preview_url: true } });
}

async function graphSend(env, payload) {
  const base = env.GRAPH_BASE || "https://graph.facebook.com";
  const res = await fetch(`${base}/${env.GRAPH_VERSION || "v23.0"}/${env.PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`WhatsApp send failed: ${res.status} ${await res.text()}`);
  return res.json();
}
