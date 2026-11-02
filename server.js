
require("dotenv").config();

const { Bot, InputFile } = require("grammy");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const os = require("node:os");
const { spawn } = require("node:child_process");
const ffmpegPath = require("ffmpeg-static");

const BOT_TOKEN = process.env.BOT_TOKEN;
const AUDD_TOKEN = process.env.AUDD_TOKEN;
const BOT_NAME = process.env.BOT_NAME || "PARADOX MUSIC";
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 18);
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN. Copy .env.example to .env and add your Telegram bot token.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);
const catalogPath = path.join(__dirname, "catalog.json");

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"]/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
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

  if (!response.ok) {
    throw new Error("Music search service is unavailable.");
  }

  const data = await response.json();
  return data.results || [];
}

async function searchLyricsPhrase(query) {
  const url = new URL("https://lrclib.net/api/search");
  url.searchParams.set("q", query);

  const response = await fetch(url, {
    headers: {
      "User-Agent": "ParadoxMusicBot/1.0 (Telegram bot)"
    }
  });

  if (!response.ok) {
    throw new Error("Lyrics search service is unavailable.");
  }

  const data = await response.json();
  return Array.isArray(data) ? data.slice(0, 6) : [];
}

function catalogMatch(query) {
  const q = normalize(query);

  if (!q) return null;

  return loadCatalog().find(track => {
    const haystack = normalize(
      `${track.title || ""} ${track.artist || ""}`
    );

    return haystack.includes(q) || q.includes(haystack);
  }) || null;
}

async function sendTrackResults(ctx, query) {
  await ctx.reply("🔎 Ищу музыку…");

  try {
    const [itunesResult, lyricResult] = await Promise.allSettled([
      searchItunes(query),
      searchLyricsPhrase(query)
    ]);

    const itunes =
      itunesResult.status === "fulfilled"
        ? itunesResult.value
        : [];

    const lyricMatches =
      lyricResult.status === "fulfilled"
        ? lyricResult.value
        : [];

    const combined = [...itunes, ...lyricMatches];
    const seen = new Set();

    const results = combined.filter(track => {
      const key = normalize(
        `${track.trackName || track.name || ""} ${track.artistName || track.artist || ""}`
      );

      if (!key || seen.has(key)) return false;

      seen.add(key);
      return true;
    });

    if (!results.length) {
      return ctx.reply(
        "Ничего не найдено. Попробуй другое название или отправь аудиофрагмент."
      );
    }

    const lines = results.slice(0, 6).map((track, index) => {
      const title = track.trackName || track.name || "Без названия";
      const artist = track.artistName || track.artist || "Неизвестный исполнитель";
      const album = track.collectionName || track.albumName;
      const preview = track.previewUrl;
      const link = track.trackViewUrl || track.url || track.externalUrl;

      let line =
        `${index + 1}. <b>${escapeHtml(title)}</b> — ${escapeHtml(artist)}`;

      if (album) {
        line += `\n   <i>${escapeHtml(album)}</i>`;
      }

      if (preview) {
        line += `\n   <a href="${escapeHtml(preview)}">Прослушать фрагмент</a>`;
      }

      if (link) {
        line += ` · <a href="${escapeHtml(link)}">Открыть</a>`;
      }

      return line;
    });

    await ctx.reply(
      "🎵 <b>Результаты поиска</b>\n\n" + lines.join("\n\n"),
      {
        parse_mode: "HTML",
        disable_web_page_preview: true
      }
    );

    const owned = catalogMatch(query);

    if (owned && owned.file) {
      const fullPath = path.resolve(__dirname, owned.file);
      const musicDir = path.resolve(__dirname, "music") + path.sep;

      if (
        fullPath.startsWith(musicDir) &&
        fs.existsSync(fullPath)
      ) {
        await ctx.replyWithAudio(
          new InputFile(fullPath),
          {
            title: owned.title,
            performer: owned.artist,
            caption: "🎧 Из каталога PARADOX MUSIC"
          }
        );
      }
    }

  } catch (err) {
    console.error(err);

    await ctx.reply(
      "Не удалось выполнить поиск. Попробуй немного позже."
    );
  }
}

async function downloadTelegramFile(fileId) {
  const file = await bot.api.getFile(fileId);

  if (!file.file_path) {
    throw new Error("Telegram file path is missing.");
  }

  const url =
    `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Could not download the Telegram attachment.");
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error(
      `Файл слишком большой. Максимум: ${MAX_FILE_MB} МБ.`
    );
  }

  return buffer;
}

function extractMp3(inputBuffer) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-vn",
      "-ac", "1",
      "-ar", "44100",
      "-t", "90",
      "-f", "mp3",
      "pipe:1"
    ];

    const proc = spawn(
      ffmpegPath,
      args,
      {
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    const chunks = [];
    let stderr = "";

    proc.stdout.on("data", chunk => chunks.push(chunk));

    proc.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });

    proc.on("error", reject);

    proc.on("close", code => {
      if (code === 0 && chunks.length) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(
          new Error(stderr || "Audio conversion failed.")
        );
      }
    });

    proc.stdin.end(inputBuffer);
  });
}

async function recognizeAudio(buffer) {
  if (!AUDD_TOKEN) {
    throw new Error(
      "Распознавание аудио ещё не настроено: добавь AUDD_TOKEN в переменные окружения."
    );
  }

  const form = new FormData();

  form.append("api_token", AUDD_TOKEN);
  form.append("return", "apple_music,spotify");

  form.append(
    "file",
    new Blob([buffer], { type: "audio/mpeg" }),
    "audio.mp3"
  );

  const response = await fetch(
    "https://api.audd.io/",
    {
      method: "POST",
      body: form
    }
  );

  if (!response.ok) {
    throw new Error("Recognition service is unavailable.");
  }

  const payload = await response.json();

  if (payload.status !== "success" || !payload.result) {
    return null;
  }

  return payload.result;
}

async function processMedia(ctx, fileId) {
  await ctx.reply(
    "🎧 Слушаю фрагмент и пытаюсь определить трек…"
  );

  try {
    const original = await downloadTelegramFile(fileId);
    const mp3 = await extractMp3(original);
    const result = await recognizeAudio(mp3);

    if (!result) {
      return ctx.reply(
        "Не удалось определить песню. Попробуй отправить более длинный и чёткий фрагмент."
      );
    }

    const title = result.title || "Неизвестный трек";
    const artist = result.artist || "Неизвестный исполнитель";

    const album = result.album
      ? `\n💿 Альбом: ${escapeHtml(result.album)}`
      : "";

    const links = [];

    const apple =
      result.apple_music && result.apple_music.url;

    const spotify =
      result.spotify &&
      result.spotify.external_urls &&
      result.spotify.external_urls.spotify;

    if (apple) {
      links.push(
        `<a href="${escapeHtml(apple)}">Apple Music</a>`
      );
    }

    if (spotify) {
      links.push(
        `<a href="${escapeHtml(spotify)}">Spotify</a>`
      );
    }

    if (result.song_link) {
      links.push(
        `<a href="${escapeHtml(result.song_link)}">Открыть трек</a>`
      );
    }

    await ctx.reply(
      `✅ <b>Музыка найдена</b>\n\n🎵 ${escapeHtml(title)}\n👤 ${escapeHtml(artist)}${album}` +
      (links.length ? `\n\n${links.join(" · ")}` : ""),
      {
        parse_mode: "HTML",
        disable_web_page_preview: true
      }
    );

  } catch (err) {
    console.error("Recognition error:", err);

    await ctx.reply(
      err.message.includes("слишком большой") ||
      err.message.includes("не настроено")
        ? err.message
        : "Не получилось распознать файл. Проверь настройки сервиса и попробуй ещё раз."
    );
  }
}

// START COMMAND

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

// HELP COMMAND

bot.command("help", ctx => ctx.reply(
  "Команды:\n/start — начать\n/help — помощь\n\n" +
  "Текст — поиск песни.\nГолосовое, аудио или видео — распознавание музыки.\n" +
  "Ссылки открываются на исходной платформе; защищённое авторским правом аудио не скачивается."
));

// TEXT SEARCH

bot.on("message:text", async ctx => {
  const text = ctx.message.text.trim();

  if (/^https?:\/\//i.test(text)) {
    return ctx.reply(
      "🔗 Получил ссылку. Открой её на исходной платформе или отправь сюда короткий аудиофрагмент/видеофайл — попробую распознать музыку.\n\n" +
      "Я не скачиваю защищённую авторским правом музыку с платформ."
    );
  }

  if (text.startsWith("/")) return;

  if (text.length < 2) {
    return ctx.reply(
      "Напиши название песни, исполнителя или несколько слов из неё."
    );
  }

  await sendTrackResults(ctx, text);
});

// AUDIO / VIDEO RECOGNITION

bot.on(
  ["message:voice", "message:audio", "message:video", "message:video_note"],
  async ctx => {
    const msg = ctx.message;

    const fileId =
      msg.voice?.file_id ||
      msg.audio?.file_id ||
      msg.video?.file_id ||
      msg.video_note?.file_id;

    if (fileId) {
      await processMedia(ctx, fileId);
    }
  }
);

bot.catch(err => {
  console.error("Bot error:", err);
});

// =====================================
// RENDER HTTP SERVER
// =====================================

const PORT = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {

  if (req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8"
    });

    return res.end(
      JSON.stringify({
        status: "ok",
        bot: BOT_NAME
      })
    );
  }

  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8"
  });

  res.end(`${BOT_NAME} is running.`);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

// =====================================
// TELEGRAM BOT START
// =====================================

bot.start({
  onStart: info => {
    console.log(
      `${BOT_NAME} started as @${info.username}`
    );
  }
}).catch(err => {
  console.error("Failed to start Telegram bot:", err);
  process.exit(1);
});

// =====================================
// GRACEFUL SHUTDOWN
// =====================================

function shutdown() {
  console.log("Shutting down PARADOX MUSIC...");

  server.close();
  bot.stop();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
