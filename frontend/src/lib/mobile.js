// Mobile build (VITE_MOBILE=1) — the standalone app-store version (Capacitor native shell).
//
// There is no backend: nothing to sign in to, everything lives on the phone. Unlike guest
// mode in a browser, this is the user's only copy of their training log, so it can't depend
// on WebView localStorage alone (iOS evicts that under storage pressure). Every persist()
// therefore also lands in a JSON file in the app's private data directory, and boot()
// restores from it. The workout reminder uses native local notifications scheduled per
// planned weekday — no server involved, unlike Web Push in the self-hosted version.
//
// Like the demo build, MOBILE is replaced at build time, so all of this folds away in
// web bundles; the Capacitor plugins are only ever imported behind it.
import { t } from './i18n.js'

export const MOBILE = import.meta.env.VITE_MOBILE === '1'

const FILE = 'opengym-state.json'

export async function nativeLoad() {
  try {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
    const r = await Filesystem.readFile({ path: FILE, directory: Directory.Data, encoding: Encoding.UTF8 })
    return JSON.parse(r.data)
  } catch (e) { return null }   // first launch, or unreadable — localStorage copy takes over
}

export async function nativeSave(state) {
  try {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
    await Filesystem.writeFile({ path: FILE, directory: Directory.Data, data: JSON.stringify(state), encoding: Encoding.UTF8 })
  } catch (e) { /* keep the localStorage copy */ }
}

// (Re)schedule both local reminders: the workout-day one (per weekday that has a routine in
// the weekly plan, ids 100-106) and the daily body-weight check-in (one repeating notification
// with no weekday, id 110). Cheap enough to run after any state change — the plan or either
// reminder's time may just have been edited. `interactive` gates the OS permission prompt to
// the Settings toggle; a background resync never pops a dialog. Unlike the self-hosted Web
// Push version, there's no server to skip a day that's already logged — these just fire.
export async function syncReminder(S, interactive = false) {
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    await LocalNotifications.cancel({ notifications: [0, 1, 2, 3, 4, 5, 6].map(d => ({ id: 100 + d })) }).catch(() => {})
    await LocalNotifications.cancel({ notifications: [{ id: 110 }] }).catch(() => {})
    const r = S.reminder, bwr = S.bwReminder
    if (!r?.on && !bwr?.on) return true
    let perm = await LocalNotifications.checkPermissions()
    if (perm.display !== 'granted' && interactive) perm = await LocalNotifications.requestPermissions()
    if (perm.display !== 'granted') return false
    const notifications = []
    if (r?.on) {
      const [hour, minute] = (r.time || '08:00').split(':').map(Number)
      notifications.push(...Object.entries(S.week || {})
        .filter(([, rid]) => rid && (S.routines || []).some(x => x.id === rid))
        .map(([day, rid]) => ({
          id: 100 + Number(day),
          title: t('Workout day'),
          body: t('{0} is on the plan today — let’s go!', S.routines.find(x => x.id === rid).name),
          // Capacitor weekdays are 1 (Sunday) … 7 (Saturday); S.week uses getDay() 0…6.
          schedule: { on: { weekday: Number(day) + 1, hour, minute }, allowWhileIdle: true },
        })))
    }
    if (bwr?.on) {
      const [hour, minute] = (bwr.time || '08:00').split(':').map(Number)
      // No weekday in the schedule → Capacitor repeats it every day at this time.
      notifications.push({
        id: 110,
        title: t('Weigh-in time'),
        body: t("Log today's body weight 📈"),
        schedule: { on: { hour, minute }, allowWhileIdle: true },
      })
    }
    if (notifications.length) await LocalNotifications.schedule({ notifications })
    return true
  } catch (e) { return false }
}

// WKWebView can't do blob-URL downloads, so the backup goes out through the OS share sheet
// (Files, AirDrop, mail, …) from a temp file instead.
export async function shareExport(json, filename) {
  const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
  const { Share } = await import('@capacitor/share')
  const w = await Filesystem.writeFile({ path: filename, directory: Directory.Cache, data: json, encoding: Encoding.UTF8 })
  await Share.share({ title: filename, url: w.uri })
}
