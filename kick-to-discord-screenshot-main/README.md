# Kick + Twitch Screenshot Bot

A chat bot that captures stream moments on command and posts them to Discord. Listens to **Kick** and **Twitch** chat — captures from the Kick stream and sends to your Discord webhook.

## Commands

| Command | Description |
|---------|--------------|
| `!pic` | Capture a screenshot from the stream |
| `!clip` | Capture a 30-second clip (1080p) |
| `!gif` | Capture a 5-second GIF (720p) |
| `!emoji` | Capture a 128×128 static frame (Discord emoji size) |
| `!emoji2` | Capture a 2.5-second animated emoji GIF (128×128) |
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

2. **Create `.env`** in the project root:

   ```env
   KICK_CHANNEL=your_kick_username
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

   # Optional: Twitch (add both to enable)
   TWITCH_CHANNEL=your_twitch_username
   TWITCH_OAUTH_TOKEN=oauth:your_token
   ```

   Get your Twitch OAuth token from [twitchapps.com/tmi](https://twitchapps.com/tmi).

3. **Optional: separate webhooks**

   ```env
   DISCORD_WEBHOOK_PICS=https://...
   DISCORD_WEBHOOK_GIFS=https://...
   DISCORD_WEBHOOK_CLIPS=https://...
   DISCORD_WEBHOOK_EMOJIS=https://...
   ```

4. **Build and run**

   ```bash
   npm run build
   npm start
   ```

## Usage

- Start the bot **when the Kick channel is live**. It exits if the stream is offline.
- Both Kick and Twitch chat are supported when Twitch credentials are set.
- Screenshots are taken from the Kick stream; Twitch is only used as an extra chat source. Multistreaming (Kick + Twitch) is recommended.

## Embed Colors

- **Kick** → green accent  
- **Twitch** → purple accent  

## License

MIT
