# 🤖 UltraSaveBot

<div align="center">
  <p>A fast, reliable, and easy-to-use Telegram bot that resolves video links and downloads media instantly using <code>yt-dlp</code> and <code>Telegraf</code>.</p>
</div>

## ✨ Features

- **Media Downloading:** Downloads videos and audio from hundreds of supported sites using powerful `yt-dlp` integration.
- **Auto Download:** Can automatically detect links and start downloading.
- **Customizable File Size Limits:** Prevent massive file downloads by configuring size limits.
- **Proxy Support:** Bypass geo-restrictions by routing traffic through a proxy.
- **Easy Deployment:** Ready-to-use files provided for seamless Docker, Railway, and Native Windows hosting.

## 🚀 Installation

### Prerequisites

If you plan to run this directly without Docker, verify you have the following installed:
- [Node.js](https://nodejs.org/en/) (v18 or newer)
- [`ffmpeg`](https://ffmpeg.org/download.html) (Ensure its `bin` directory is in your `PATH`)
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp/releases) executable downloaded and placed in your repository root.

### Setup Steps

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/UltraSaveBot.git
   cd UltraSaveBot
   ```
2. Install dependencies:
   ```bash
   npm ci
   ```
3. Copy `.env.example` to `.env` and set up your variables (see below).
4. Build and start the bot:
   ```bash
   npm run build
   npm start
   ```

## ⚙️ Environment Variables

Configuration is handled simply through a `.env` file. You can start by copying `.env.example`:
```bash
cp .env.example .env
```

| Variable | Description | Required | Default |
| :--- | :--- | :---: | :--- |
| `BOT_TOKEN` | Your Telegram Bot token obtained from [@BotFather](https://t.me/BotFather) | ✅ | - |
| `MAX_DOWNLOAD_MB` | Maximum allowed file size to download (in MB) | ❌ | `50` |
| `AUTO_DOWNLOAD` | Automatically download links detected in chat (`true` or `false`) | ❌ | `false` |
| `YTDLP_PATH` | Path to customize the `yt-dlp` binary location if not in root | ❌ | `./yt-dlp` |
| `FFMPEG_LOCATION` | Path to directory containing `ffmpeg` and `ffprobe` | ❌ | (from PATH) |
| `YTDLP_JS_RUNTIMES` | JS runtime used by yt-dlp to bypass some validations | ❌ | `node` |
| `YTDLP_PROXY` | Outbound proxy URL for `yt-dlp` routing | ❌ | - |
| `COOKIES_FROM_BROWSER` | Extracts cookies from a local browser (for native hosts) | ❌ | - |

## 🕹️ Usage

1. Open Telegram and search for your bot.
2. Press "Start" to initiate interaction.
3. Send a valid video link (e.g., YouTube, TikTok, Instagram, Twitter/X).
4. The bot will automatically notify you of the progress and finally send the downloaded media directly in the chat!

## 🐳 Docker setup

The easiest and cleanest way to run the bot is via Docker, as it encapsulates all dependencies (`Node.js`, `ffmpeg`, and `yt-dlp`) perfectly without cluttering your host system.

1. Configure your `.env` file first (ensure `BOT_TOKEN` is set).
2. Build the container:
   ```bash
   docker compose build
   ```
3. Run the bot in the background:
   ```bash
   docker compose up -d
   ```
4. Check logs to ensure everything is running perfectly:
   ```bash
   docker compose logs -f bot
   ```
To stop the bot, simply run `docker compose down`.

## 🚂 Deployment (Railway)

We provide native support for Railway deployment out-of-the-box using the included `railway.json` and `Dockerfile`.

1. Create a new project on [Railway](https://railway.app/).
2. Select **Deploy from GitHub repo** and point it to your fork of this bot.
3. Railway will automatically detect the `Dockerfile` for deployment.
4. Go to the project's **Variables** tab and set `BOT_TOKEN` (along with any other optional variables you want).
5. Deploy and enjoy your 24/7 worker!

## 📝 Notes

- **Cloudflare Not Supported:** Cloudflare Workers/Pages is not suitable for this bot because it requires background processes, binary executions (`yt-dlp`, `ffmpeg`), and local file storage logic which Cloudflare does not natively support.
- **File Limits:** Keep in mind that the Telegram Bot API natively restricts bots to sending files up to 50MB. (Note: Using a custom Local Bot API server can increase this limit to 2000MB, but requires extra infrastructure).

## 📁 Project Structure

```text
📦 UltraSaveBot
 ┣ 📂 downloads          # Temporary directory for media processing
 ┣ 📂 logs               # Runtime logs and errors are output here
 ┣ 📜 .env.example       # Example configuration environment sheet
 ┣ 📜 .gitignore         # Untracked files configs
 ┣ 📜 Dockerfile         # Blueprint for production Docker image
 ┣ 📜 README.md          # Project documentation (You are here!)
 ┣ 📜 compose.yaml       # Docker compose setup
 ┣ 📜 index.js           # Main application entry point
 ┣ 📜 package.json       # Node.js dependencies & scripts
 ┣ 📜 railway.json       # Config-as-code format for Railway deployments
 ┣ 📜 render.yaml        # Render.com blueprint specification
 ┗ 📜 yt-dlp.exe         # Executable for yt-dlp downloads (Windows)
```

---
<div align="center">
  <i>Built with ❤️ using Telegraf and yt-dlp</i>
</div>
