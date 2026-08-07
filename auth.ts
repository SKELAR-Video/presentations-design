import NextAuth from 'next-auth'
import Google from 'next-auth/providers/google'

const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN ?? 'skelar.tech'

async function refreshAccessToken(refreshToken: string) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to refresh token')
  return {
    accessToken: data.access_token as string,
    expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in as number),
    refreshToken: (data.refresh_token as string | undefined) ?? refreshToken,
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          // drive.file and nothing else: the app reaches a file only if this app created it,
          // or if the user handed it over through Google's own picker. It cannot enumerate
          // a Drive, cannot open a file nobody chose, and cannot touch anything it did not
          // make. On the consent screen this is one line — "only the specific Google Drive
          // files you use with this app" — where the previous pair spelled out "See and
          // download ALL your Google Drive files" and "See ALL your Google Docs documents".
          //
          // What had to exist before those two could go:
          //   · lib/picker.ts       — the user picks the brief, which is what grants access
          //                           to that one file under this scope
          //   · ensureOwnMaster()   — the template is built by the app rather than read from
          //                           somebody else's Drive
          // Removing either one puts the broad scopes back.
          //
          // MASTER_DECK_ID must be unset for this to hold: it points at a shared template
          // this app did not create, and copying it is exactly the operation drive.file
          // refuses.
          scope: [
            'openid',
            'email',
            'profile',
            'https://www.googleapis.com/auth/drive.file',
          ].join(' '),
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    }),
  ],
  callbacks: {
    async signIn({ user, profile }) {
      const email = user?.email ?? profile?.email ?? ''
      return email.endsWith(`@${ALLOWED_DOMAIN}`)
    },
    async jwt({ token, account }) {
      // First sign-in: store tokens and expiry
      if (account) {
        return {
          ...token,
          accessToken: account.access_token,
          refreshToken: account.refresh_token,
          expiresAt: account.expires_at, // Unix seconds
        }
      }

      // Token still valid (with 60s buffer)
      const expiresAt = token.expiresAt as number | undefined
      if (!expiresAt || Date.now() < expiresAt * 1000 - 60_000) {
        return token
      }

      // Token expired — refresh it silently
      try {
        const refreshed = await refreshAccessToken(token.refreshToken as string)
        return { ...token, ...refreshed }
      } catch (err) {
        console.error('[auth] token refresh failed:', err)
        return { ...token, error: 'RefreshAccessTokenError' }
      }
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken as string
      if (token.error) session.error = token.error as string
      return session
    },
  },
  pages: {
    signIn: '/auth/signin',
    error: '/auth/error',
  },
})
