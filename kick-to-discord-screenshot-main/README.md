# Kick + Twitch Screenshot Bot

A chat bot that captures stream moments on command and posts them to Discord. Listens to **Kick** and **Twitch** chat — captures from the Kick stream and sends to your Discord webhook.

## Features

- **Pics, clips, GIFs** — 1080p clips, 720p GIFs, native-resolution screenshots
- **Emoji & sticker previews** — 500×500 emoji, 320×320 sticker, static and animated
- **Leaderboard** — Track who requests the most captures with `!stats`
- **Dual chat** — Kick + Twitch support when multistreaming

## Commands

| Command | Description |
|---------|--------------|
| `!pic` | Capture a screenshot from the stream |
| `!clip` | Capture a 30-second clip (1080p) |
| `!gif` | Capture a 5-second GIF (720p) |
| `!emoji` | Capture a 500×500 static frame |
| `!emoji2` | Capture a 2.5-second animated emoji GIF (500×500) |
| `!sticker` | Capture a 320×320 static frame (Discord sticker size) |
| `!sticker2` | Capture a 2.5-second animated sticker GIF (320×320) |
| `!stats` | Post the request leaderboard to Discord |

Emoji and sticker captures are sized for Discord — right-click and save from the preview to upload to your server.

## Prerequisites

- **Node.js** 18+
- **FFmpeg** (must be in your PATH)
- **Kick** channel streaming (the bot captures from Kick)
- **Discord** webhook URL

## Setup

1. **Clone and install**

   ```bash
   git clone https://github.com/LexieXuwu/kick-twitch-screenshot-bot.git
   cd kick-twitch-screenshot-bot/kick-to-discord-screenshot-main
   npm install
   ```

2. **Create `.env`** in the project root (copy from `.env.example`):

   ```env
   KICK_CHANNEL=your_kick_username
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN
   ```

3. **Optional: Twitch** — Add both to enable Twitch chat alongside Kick. Get OAuth token from [twitchapps.com/tmi](https://twitchapps.com/tmi).

   ```env
   TWITCH_CHANNEL=your_twitch_username
   TWITCH_OAUTH_TOKEN=oauth:your_token
   ```

4. **Optional: Separate webhooks** — Use different webhooks for pics, gifs, clips, emojis (fall back to main if not set).

5. **Build and run**

   ```bash
   npm run build
   npm start
   ```

   Or use `npm run dev` to build and run in one step.


## Troubleshooting

- **Many duplicate Discord posts:** (1) **Several `npm start` processes** — only run one; `bot.lock` blocks a second start from the **same folder**. If you start from different copies of the project, each has its own lock. (2) **Kick reconnect** could stack reconnect timers or leak ping intervals; the chat client now uses a **single reconnect** and clears timers on disconnect. (3) **Duplicate events** are filtered by message id, by **stable sender id** + command (12s), and a final **15s Discord cooldown** per user + command before posting.
- If you see a stale lock after a crash, delete `bot.lock` and start again.

## Usage

- Start the bot **when the Kick channel is live**. It exits if the stream is offline.
- Both Kick and Twitch chat are supported when Twitch credentials are set.
- Screenshots are taken from the Kick stream; Twitch is only used as an extra chat source. Multistreaming (Kick + Twitch) is recommended.
- Discord Level 2 (50MB) or higher recommended for clips and GIFs.

## Embed Colors

- **Kick** → green accent  
- **Twitch** → purple accent  

## License

MIT
