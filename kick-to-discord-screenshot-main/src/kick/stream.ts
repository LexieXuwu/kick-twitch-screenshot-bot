import axios from 'axios';

const KICK_API_V2 = 'https://kick.com/api/v2/channels';

export interface StreamInfo {
  isLive: boolean;
  playbackUrl: string | null;
  title: string | null;
  viewerCount: number;
  chatroomId: number;
}

export async function getStreamInfo(username: string): Promise<StreamInfo> {
  const response = await axios.get(`${KICK_API_V2}/${username.toLowerCase()}`, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    timeout: 10000,
  });

  const data = response.data;

  return {
    isLive: data.livestream !== null,
    playbackUrl: data.playback_url || null,
    title: data.livestream?.session_title || null,
    viewerCount: data.livestream?.viewer_count || 0,
    chatroomId: data.chatroom?.id || 0,
  };
}
