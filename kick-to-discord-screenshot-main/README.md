# Kick + Twitch Screenshot Bot

A chat bot that captures stream moments on command and posts them to Discord. Listens to **Kick** and **Twitch** chat — captures from the Kick stream and sends to your Discord webhook.

## Features

- **Pics, clips, GIFs** — 1080p clips, 720p GIFs, native-resolution screenshots
- **Emoji & sticker previews** — 500×500 emoji, 320×320 sticker, static and animated
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

## Run automatically at login (Windows)

The bot can run as a Windows scheduled task called **Kick Screenshot Bot**: it starts about 30 seconds after you log in, runs in the background with no window, restarts itself if it crashes, and keeps waiting for your stream between broadcasts. No terminal needed.

**Install (once, no admin rights):** right-click `install-task.ps1` → **Run with PowerShell**, or run this in the project folder:

```bash
powershell -ExecutionPolicy Bypass -File install-task.ps1
```

This registers the task and starts the bot right away. The task runs `start-bot-hidden.vbs`, which runs the launcher `start-bot.ps1` without a window; the launcher runs `node dist\index.js` and restarts it if it exits with an error. If you also start the bot with `npm start`, the launcher notices `bot.lock` and waits; it takes over when that one stops.

**Check that it is running**

- Open `logs\bot.log` in the project folder. The last lines should show `launcher: starting bot`, then `[Chat] Subscribed to chatroom ...` and the "Running" box. Everything the bot prints goes to this file with a timestamp on each line (it rolls over to `logs\bot.prev.log` at 10 MB).
- Or open Task Scheduler (press the Windows key, type *Task Scheduler*), click **Task Scheduler Library**, and look for **Kick Screenshot Bot** with status **Running**.

**Start / stop by hand**

- Task Scheduler → right-click **Kick Screenshot Bot** → **Run** or **End**.
- Or from a terminal:

  ```bash
  schtasks /Run /TN "Kick Screenshot Bot"
  ```

  ```bash
  schtasks /End /TN "Kick Screenshot Bot"
  ```

- After `npm run build`, end the task and run it again so it picks up the new code (or just end the `node.exe` process in Task Manager: the launcher starts a fresh one within 10 seconds).
- Ending only `node.exe` does **not** stop the bot for good, because the launcher restarts it. Use **End** on the task.

**Disable or remove**

- Task Scheduler → right-click **Kick Screenshot Bot** → **Disable** (keeps the task but it no longer starts at login) or **Delete**.
- Or from a terminal:

  ```bash
  schtasks /Delete /TN "Kick Screenshot Bot" /F
  ```

- If you move the project folder, run `install-task.ps1` again so the task points at the new location.

## Troubleshooting

- **Chat never reacts to commands:** Kick retired its old public Pusher chat feed. The bot now asks Kick's realtime API (`web.kick.com/api/v1/realtime/...`) where chat lives and connects there (currently a Centrifugo websocket). You should see `[Chat] Connected to Kick realtime (centrifugo)` and `[Chat] Subscribed to chatroom ...` at startup; if Kick changes this again you will see `[Chat] ... error` lines instead.
- **Many duplicate Discord posts:** (1) **Several `npm start` processes** — only run one; `bot.lock` blocks a second start from the **same folder**. If you start from different copies of the project, each has its own lock. (2) **Duplicate events** are filtered by message id, by **stable sender id** + command (12s), and a final **15s Discord cooldown** per user + command before posting.
- **`!clip` / `!gif` say "not enough buffer segments":** the stream just went live (or FFmpeg just restarted after a hiccup). Wait ~30 seconds and try again.
- **`[Buffer] FFmpeg stopped ... restarting`:** normal when the stream ends or Kick rotates the playback token. The buffer restarts itself with a fresh URL; if the channel is offline the bot notices within a minute and pauses the buffer.
- If you see a stale lock after a crash, delete `bot.lock` and start again.

## Usage

- Start the bot whenever you like. If the Kick channel is offline it **waits** (checking every 30s), connects to chat right away, and starts the clip buffer as soon as the stream goes live. When the stream ends it goes back to waiting, so you can leave it running between streams.
- While the channel is offline, commands are ignored (logged in the terminal, nothing is posted).
- Both Kick and Twitch chat are supported when Twitch credentials are set.
- Screenshots are taken from the Kick stream; Twitch is only used as an extra chat source. Multistreaming (Kick + Twitch) is recommended.
- Discord Level 2 (50MB) or higher recommended for clips and GIFs.

## Embed Colors

- **Kick** → green accent  
- **Twitch** → purple accent  

## License

MIT
