// R-AUTH-1: hand-written Discord OAuth2 authorization-code flow, scope `identify`.
export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

export interface DiscordClient {
  authorizeUrl(state: string): string;
  exchange(code: string): Promise<DiscordUser>;
}

export function discordClient(opts: { clientId: string; clientSecret: string; redirectUri: string; fetchImpl?: typeof fetch }): DiscordClient {
  const f = opts.fetchImpl ?? fetch;
  return {
    authorizeUrl(state) {
      const q = new URLSearchParams({
        client_id: opts.clientId,
        response_type: 'code',
        scope: 'identify',
        redirect_uri: opts.redirectUri,
        state,
        prompt: 'none',
      });
      return `https://discord.com/oauth2/authorize?${q}`;
    },
    async exchange(code) {
      const tokenRes = await f('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: opts.clientId,
          client_secret: opts.clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: opts.redirectUri,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!tokenRes.ok) throw new Error(`discord token exchange failed: ${tokenRes.status}`);
      const token = (await tokenRes.json()) as { access_token: string; token_type: string };
      const meRes = await f('https://discord.com/api/users/@me', {
        headers: { authorization: `${token.token_type} ${token.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!meRes.ok) throw new Error(`discord /users/@me failed: ${meRes.status}`);
      const me = (await meRes.json()) as DiscordUser;
      if (!/^\d+$/.test(me.id)) throw new Error('discord returned an invalid user id');
      return me;
    },
  };
}

export function avatarUrl(discordId: string, avatar: string | null | undefined): string | null {
  if (!avatar) return null;
  return `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.png?size=64`;
}
