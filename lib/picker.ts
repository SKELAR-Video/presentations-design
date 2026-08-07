// ─── Google Picker ────────────────────────────────────────────────────────────
// Google's own file-chooser, and the only way an app holding just the drive.file scope
// can reach a document it did not create: picking a file there is what grants access to
// that one file. The alternative — the user pasting a link — cannot work under drive.file,
// because the app has no idea in advance which file it will be handed, so it has to be
// allowed to read them all. That is exactly the "See and download all your Google Drive
// files" line on the consent screen.
//
// Needs a browser-side API key (NEXT_PUBLIC_GOOGLE_API_KEY). It is not a secret in the
// usual sense — it identifies the project to the Picker and is meant to be public — but it
// should still be restricted to the Picker API and to this site's domain in Cloud Console.

type PickedFile = { id: string; name: string; url: string; mimeType: string }

const DOC_MIME    = 'application/vnd.google-apps.document'
const SLIDES_MIME = 'application/vnd.google-apps.presentation'

// One-time script loading, shared by every call.
let loaderPromise: Promise<void> | null = null

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve()
    const el = document.createElement('script')
    el.src = src
    el.onload = () => resolve()
    el.onerror = () => reject(new Error(`Не вдалося завантажити ${src}`))
    document.head.appendChild(el)
  })
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function loadPicker(): Promise<void> {
  if (loaderPromise) return loaderPromise
  loaderPromise = loadScript('https://apis.google.com/js/api.js').then(
    () => new Promise<void>((resolve, reject) => {
      const gapi = (window as any).gapi
      if (!gapi) return reject(new Error('gapi недоступний'))
      gapi.load('picker', { callback: () => resolve(), onerror: () => reject(new Error('Не вдалося ініціалізувати Picker')) })
    }),
  )
  return loaderPromise
}

export function pickerConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_GOOGLE_API_KEY
}

// Opens the chooser and resolves with the picked file, or null if the user closed it.
export async function pickBriefFile(accessToken: string): Promise<PickedFile | null> {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_API_KEY
  if (!apiKey) throw new Error('NEXT_PUBLIC_GOOGLE_API_KEY не заданий — вибір файлу недоступний')

  // Which app the file is being granted to. Skipping this does not fail loudly: the chooser
  // opens, a file comes back, and only the first read of it reports
  // "The user has not granted the app <n> read access to the file <id>".
  const cfg = await fetch('/api/picker-config').then(r => r.json()).catch(() => null)
  if (!cfg?.appId) throw new Error('Не вдалося визначити ідентифікатор застосунку для вибору файлу')

  await loadPicker()
  const picker = (window as any).google?.picker
  if (!picker) throw new Error('Picker недоступний')

  return new Promise<PickedFile | null>((resolve) => {
    // ONE view listing both types, not one view per type. Two views render as two tabs,
    // and a tab nobody notices is a file nobody can pick: the first attempt showed only
    // presentations, because the Docs tab sat behind a header that reads as decoration.
    // Still filtered to Docs and Slides — offering images or folders only invites a pick
    // the pipeline cannot read.
    const view = new picker.DocsView(picker.ViewId.DOCS)
      .setMimeTypes(`${SLIDES_MIME},${DOC_MIME}`)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false)

    const builder = new picker.PickerBuilder()
      .setOAuthToken(accessToken)
      .setDeveloperKey(apiKey)
      .setAppId(cfg.appId)
      .setTitle('Оберіть бриф')
      .setCallback((data: any) => {
        if (data.action === picker.Action.PICKED) {
          const doc = data.docs?.[0]
          if (!doc) return resolve(null)
          resolve({
            id: doc.id,
            name: doc.name,
            mimeType: doc.mimeType,
            // fetch-doc recognises files by URL shape, so hand it the canonical one for
            // this type rather than a bare id, which it would always read as a Doc.
            url: doc.mimeType === SLIDES_MIME
              ? `https://docs.google.com/presentation/d/${doc.id}/edit`
              : `https://docs.google.com/document/d/${doc.id}/edit`,
          })
        } else if (data.action === picker.Action.CANCEL) {
          resolve(null)
        }
      })
    builder.addView(view).build().setVisible(true)
  })
}
