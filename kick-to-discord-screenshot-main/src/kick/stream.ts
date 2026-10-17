import axios from 'axios';

const KICK_API_V2 = 'https://kick.com/api/v2/channels';

export interface StreamInfo {
  isLive: boolean;
  playbackUrl: string | null;
  title: string | null;
  viewerCount: number;
  channelId: number;
  chatroomId: number;
}

export async function getStreamInfo(username: string): Promise<StreamInfo> {
  const response = await axios.get(`${KICK_API_V2}/${encodeURIComponent(username.toLowerCase())}`, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    },
    timeout: 10000,
  });

  const data = response.data ?? {};
  // Kick returns `livestream: null` when offline. The playback_url is present either way,
  // so only treat the channel as live when a livestream object exists.
  const isLive = !!data.livestream;

  return {
    isLive,
    playbackUrl: isLive && data.playback_url ? data.playback_url : null,
    title: data.livestream?.session_title || null,
    viewerCount: data.livestream?.viewer_count || 0,
    channelId: data.id || 0,
    chatroomId: data.chatroom?.id || 0,
  };
}
