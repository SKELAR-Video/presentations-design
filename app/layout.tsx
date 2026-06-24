import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { Providers } from './providers'

const inter = Inter({ subsets: ['latin', 'cyrillic'], weight: ['400', '500', '600'] })

export const metadata: Metadata = {
  title: 'Presentations Design — SKELAR',
  description: 'Генератор корпоративних презентацій SKELAR',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uk" className="h-full">
      <body className={`${inter.className} min-h-full bg-[#090D17] text-white antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
