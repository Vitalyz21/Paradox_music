require("dotenv").config();

const { Bot, InputFile } = require("grammy");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const ffmpegPath = require("ffmpeg-static");

const BOT_TOKEN = process.env.BOT_TOKEN;
const AUDD_TOKEN = process.env.AUDD_TOKEN;
const BOT_NAME = process.env.BOT_NAME || "PARADOX MUSIC";
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 18);
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const catalogPath = path.join(__dirname, "catalog.json");

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN. Add it to the Render environment variables.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"]/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
  }[ch]));
}

function normalize(value = "") {
  return String(value).toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9а-яё]+/gi, " ")
    .trim();
}

function loadCatalog() {
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Could not read catalog.json:", err.message);
    return [];
  }
}

async function searchItunes(query) {
  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("term", query);
  url.searchParams.set("entity", "song");
  url.searchParams.set("limit", "6");
  const response = await fetch(url);
  if (!response.ok) throw new Error("Music search service is unavailable.");
  const data = await response.json();
  return data.results || [];
}

async function searchLyricsPhrase(query) {
  const url = new URL("https://lrclib.net/api/search");
  url.searchParams.set("q", query);
  const response = await fetch(url, {
    headers: { "User-Agent": "ParadoxMusic/1.0" }
  });
  if (!response.ok) throw new Error("Lyrics search service is unavailable.");
  const data = await response.json();
  return Array.isArray(data) ? data.slice(0, 6) : [];
}

function catalogMatch(query) {
  const q = normalize(query);
  if (!q) return null;
  return loadCatalog().find(track => {
    const haystack = normalize(`${track.title || ""} ${track.artist || ""}`);
    return haystack && (haystack.includes(q) || q.includes(haystack));
  }) || null;
}

function mergeSearchResults(itunes, lyricMatches) {
  const combined = [
    ...itunes.map(track => ({
      title: track.trackName || "Без названия",
      artist: track.artistName || "Неизвестный исполнитель",
      album: track.collectionName || "",
      cover: track.artworkUrl100 || track.artworkUrl60 || "",
      preview: track.previewUrl || "",
      url: track.trackViewUrl || ""
    })),
    ...lyricMatches.map(track => ({
      title: track.trackName || "Без названия",
      artist: track.artistName || "Неизвестный исполнитель",
      album: track.albumName || "",
      cover: "",
      preview: "",
      url: track.url || ""
    }))
  ];

  const seen = new Set();
  return combined.filter(track => {
    const key = normalize(`${track.title} ${track.artist}`);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

async function searchMusic(query) {
  const [itunesResult, lyricResult] = await Promise.allSettled([
    searchItunes(query),
    searchLyricsPhrase(query)
  ]);
  const itunes = itunesResult.status === "fulfilled" ? itunesResult.value : [];
  const lyrics = lyricResult.status === "fulfilled" ? lyricResult.value : [];
  const results = mergeSearchResults(itunes, lyrics);

  if (!results.length && itunesResult.status === "rejected" && lyricResult.status === "rejected") {
    throw new Error("Сервисы поиска музыки временно недоступны.");
  }
  return results;
}

async function readRequestBody(req, maxBytes = MAX_FILE_BYTES) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error(`Файл слишком большой. Максимум: ${MAX_FILE_MB} МБ.`);
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function extractMp3(inputBuffer) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-vn", "-ac", "1", "-ar", "44100",
      "-t", "90", "-f", "mp3", "pipe:1"
    ];
    const proc = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";

    proc.stdout.on("data", chunk => chunks.push(chunk));
    proc.stderr.on("data", chunk => { stderr += chunk.toString(); });
    proc.on("error", reject);
    proc.on("close", code => {
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error(stderr || "Audio conversion failed."));
    });
    proc.stdin.end(inputBuffer);
  });
}

async function recognizeAudio(buffer) {
  if (!AUDD_TOKEN) {
    const err = new Error("Распознавание не настроено: добавь AUDD_TOKEN в переменные окружения Render.");
    err.statusCode = 503;
    throw err;
  }

  const form = new FormData();
  form.append("api_token", AUDD_TOKEN);
  form.append("return", "apple_music,spotify");
  form.append("file", new Blob([buffer], { type: "audio/mpeg" }), "audio.mp3");

  const response = await fetch("https://api.audd.io/", {
    method: "POST",
    body: form
  });
  if (!response.ok) throw new Error("Сервис распознавания AudD временно недоступен.");

  const payload = await response.json();
  if (payload.status !== "success") {
    throw new Error(payload.error?.error_message || "AudD не смог обработать аудио.");
  }
  return payload.result || null;
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(data));
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp"
};

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true, service: "PARADOX MUSIC" });
  }

  if (req.method === "GET" && url.pathname === "/api/search") {
    const query = (url.searchParams.get("q") || "").trim();
    if (query.length < 2 || query.length > 120) {
      return sendJson(res, 400, { error: "Запрос должен содержать от 2 до 120 символов." });
    }
    try {
      const results = await searchMusic(query);
      return sendJson(res, 200, { results });
    } catch (err) {
      console.error("Web search error:", err);
      return sendJson(res, 502, { error: err.message || "Ошибка поиска музыки." });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/recognize") {
    try {
      const input = await readRequestBody(req);
      if (!input.length) return sendJson(res, 400, { error: "Аудиофайл пуст." });

      const mp3 = await extractMp3(input);
      const result = await recognizeAudio(mp3);
      if (!result) {
        return sendJson(res, 200, {
          found: false,
          message: "Не удалось определить песню. Попробуй более чёткий фрагмент."
        });
      }

      return sendJson(res, 200, {
        found: true,
        title: result.title || "Неизвестный трек",
        artist: result.artist || "Неизвестный исполнитель",
        album: result.album || "",
        links: {
          appleMusic: result.apple_music?.url || "",
          spotify: result.spotify?.external_urls?.spotify || "",
          song: result.song_link || ""
        }
      });
    } catch (err) {
      console.error("Web recognition error:", err);
      return sendJson(res, err.statusCode || 502, {
        error: err.message || "Не удалось распознать аудио."
      });
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { error: "Method not allowed." });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { error: "Invalid URL." });
  }

  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${requestedPath}`);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, "index.html")) {
    return sendJson(res, 403, { error: "Forbidden." });
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff"
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error("HTTP server error:", err);
    if (!res.headersSent) sendJson(res, 500, { error: "Внутренняя ошибка сервера." });
    else res.destroy();
  });
});

async function downloadTelegramFile(fileId) {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram file path is missing.");
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("Could not download the Telegram attachment.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error(`Файл слишком большой. Максимум: ${MAX_FILE_MB} МБ.`);
  }
  return buffer;
}

async function sendTrackResults(ctx, query) {
  await ctx.reply("🔎 Ищу музыку…");
  try {
    const results = await searchMusic(query);
    if (!results.length) {
      return ctx.reply("Ничего не найдено. Попробуй другое название или отправь аудиофрагмент.");
    }

    const lines = results.map((track, index) => {
      let line = `${index + 1}. <b>${escapeHtml(track.title)}</b> — ${escapeHtml(track.artist)}`;
      if (track.album) line += `\n   <i>${escapeHtml(track.album)}</i>`;
      if (track.preview) line += `\n   <a href="${escapeHtml(track.preview)}">Прослушать фрагмент</a>`;
      if (track.url) line += ` · <a href="${escapeHtml(track.url)}">Открыть</a>`;
      return line;
    });

    await ctx.reply("🎵 <b>Результаты поиска</b>\n\n" + lines.join("\n\n"), {
      parse_mode: "HTML",
      disable_web_page_preview: true
    });

    const owned = catalogMatch(query);
    if (owned && owned.file) {
      const fullPath = path.resolve(__dirname, owned.file);
      const musicDir = path.resolve(__dirname, "music") + path.sep;
      if (fullPath.startsWith(musicDir) && fs.existsSync(fullPath)) {
        await ctx.replyWithAudio(new InputFile(fullPath), {
          title: owned.title,
          performer: owned.artist,
          caption: "🎧 Из каталога PARADOX MUSIC"
        });
      }
    }
  } catch (err) {
    console.error(err);
    await ctx.reply("Не удалось выполнить поиск. Попробуй немного позже.");
  }
}

async function processMedia(ctx, fileId) {
  await ctx.reply("🎧 Слушаю фрагмент и пытаюсь определить трек…");
  try {
    const original = await downloadTelegramFile(fileId);
    const mp3 = await extractMp3(original);
    const result = await recognizeAudio(mp3);

    if (!result) {
      return ctx.reply("Не удалось определить песню. Попробуй отправить более длинный и чёткий фрагмент.");
    }

    const title = result.title || "Неизвестный трек";
    const artist = result.artist || "Неизвестный исполнитель";
    const album = result.album ? `\n💿 Альбом: ${escapeHtml(result.album)}` : "";
    const links = [];
    const apple = result.apple_music?.url;
    const spotify = result.spotify?.external_urls?.spotify;
    if (apple) links.push(`<a href="${escapeHtml(apple)}">Apple Music</a>`);
    if (spotify) links.push(`<a href="${escapeHtml(spotify)}">Spotify</a>`);
    if (result.song_link) links.push(`<a href="${escapeHtml(result.song_link)}">Открыть трек</a>`);

    await ctx.reply(
      `✅ <b>Музыка найдена</b>\n\n🎵 ${escapeHtml(title)}\n👤 ${escapeHtml(artist)}${album}` +
      (links.length ? `\n\n${links.join(" · ")}` : ""),
      { parse_mode: "HTML", disable_web_page_preview: true }
    );
  } catch (err) {
    console.error("Recognition error:", err);
    await ctx.reply(err.message.includes("слишком большой") || err.message.includes("не настроено")
      ? err.message
      : "Не получилось распознать файл. Проверь настройки сервиса и попробуй ещё раз.");
  }
}

bot.command("start", async ctx => {
  await ctx.reply(
    `👋 Привет! Это ${BOT_NAME}.\n\n` +
    "Отправь мне:\n" +
    "🎵 название песни или исполнителя\n" +
    "🔤 несколько слов из песни\n" +
    "🎙 голосовое сообщение с музыкой\n" +
    "🔊 аудиофайл\n" +
    "📹 видео или видеосообщение с музыкой\n" +
    "🔗 ссылку на музыкальный ролик\n\n" +
    "Я найду информацию о треке или попробую распознать его по аудио."
  );
});

bot.command("help", ctx => ctx.reply(
  "Команды:\n/start — начать\n/help — помощь\n\n" +
  "Текст — поиск песни.\nГолосовое, аудио или видео — распознавание музыки.\n" +
  "Ссылки открываются на исходной платформе; защищённое авторским правом аудио не скачивается."
));

bot.on("message:text", async ctx => {
  const text = ctx.message.text.trim();
  if (/^https?:\/\//i.test(text)) {
    return ctx.reply(
      "🔗 Получил ссылку. Открой её на исходной платформе или отправь сюда короткий аудиофрагмент/видеофайл — попробую распознать музыку.\n\n" +
      "Я не скачиваю защищённую авторским правом музыку с платформ."
    );
  }
  if (text.startsWith("/")) return;
  if (text.length < 2) return ctx.reply("Напиши название песни, исполнителя или несколько слов из неё.");
  await sendTrackResults(ctx, text);
});

bot.on(["message:voice", "message:audio", "message:video", "message:video_note"], async ctx => {
  const msg = ctx.message;
  const fileId =
    msg.voice?.file_id ||
    msg.audio?.file_id ||
    msg.video?.file_id ||
    msg.video_note?.file_id;
  if (fileId) await processMedia(ctx, fileId);
});

bot.catch(err => {
  console.error("Bot error:", err);
});

server.listen(PORT, HOST, () => {
  console.log(`PARADOX MUSIC web server listening on ${HOST}:${PORT}`);
});

bot.start({
  onStart: info => console.log(`${BOT_NAME} started as @${info.username}`)
}).catch(err => {
  console.error("Telegram bot failed to start:", err);
  process.exitCode = 1;
});

async function shutdown(signal) {
  console.log(`${signal} received; shutting down...`);
  try { await bot.stop(); } catch (err) { console.error("Bot shutdown error:", err); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
