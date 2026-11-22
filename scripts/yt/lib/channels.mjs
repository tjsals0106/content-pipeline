export const CHANNELS = Object.freeze({
  seonmin_mov: {
    key: 'seonmin_mov',
    name: 'Seonmin MOV',
    tokenEnv: 'YT_SEONMINMOV_REFRESH_TOKEN',
    channelIdEnv: 'YT_CHANNEL_ID_SEONMIN_MOV',
  },
  meliv_music: {
    key: 'meliv_music',
    name: 'Meliv Music',
    tokenEnv: 'YT_MELIV_REFRESH_TOKEN',
    channelIdEnv: 'YT_CHANNEL_ID_MELIV_MUSIC',
  },
  viriditas_worship: {
    key: 'viriditas_worship',
    name: 'Viriditas Worship',
    tokenEnv: 'YT_VIRIDITAS_REFRESH_TOKEN',
    channelIdEnv: 'YT_CHANNEL_ID_VIRIDITAS_WORSHIP',
  },
});

export const CHANNEL_KEYS = Object.keys(CHANNELS);

export function channelRefreshToken(channelKey, env = process.env) {
  const token = env[CHANNELS[channelKey].tokenEnv];
  return token && token.trim() ? token.trim() : null;
}

export function expectedChannelId(channelKey, env = process.env) {
  const id = env[CHANNELS[channelKey].channelIdEnv];
  return id && id.trim() ? id.trim() : null;
}
