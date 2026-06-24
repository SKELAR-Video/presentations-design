import { auth } from '@/auth'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function proxy(req: NextRequest) {
  const session = await auth()

  const isAuthPage = req.nextUrl.pathname.startsWith('/auth')
  const isApi = req.nextUrl.pathname.startsWith('/api')

  if (!session && !isAuthPage && !isApi) {
    const signInUrl = new URL('/auth/signin', req.url)
    signInUrl.searchParams.set('callbackUrl', req.url)
    return NextResponse.redirect(signInUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next|favicon.ico).*)'],
}
