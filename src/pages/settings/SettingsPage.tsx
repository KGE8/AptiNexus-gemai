import { useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useRemote } from '../../hooks/useRemote'

const tabs = ['Profile preferences', 'Appearance', 'Notifications', 'Account', 'Privacy']
const defaults = { focus: 'Engineering', hours: 5, n_reminders: true, n_milestones: true, n_recs: true, n_results: true, n_profile: false, share: false, analytics: false }
type S = typeof defaults
const Toggle = ({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) => <label className="flex items-center justify-between py-2 text-sm">{label}<input type="checkbox" role="switch" checked={on} onChange={e => set(e.target.checked)} /></label>

export default function SettingsPage() {
  const { user, logout } = useAuth()
  const [tab, setTab] = useState(tabs[0])
  const [s, setS] = useRemote<S>('settings', user?.id, defaults)
  const [motion, setMotion] = useState(() => localStorage.getItem('aptinexus.reduceMotion') === 'true')
  const [confirmClear, setConfirmClear] = useState(false)
  const up = <K extends keyof S>(k: K, v: S[K]) => setS({ ...s, [k]: v })
  const setReduce = (v: boolean) => { setMotion(v); localStorage.setItem('aptinexus.reduceMotion', String(v)); document.documentElement.dataset.reduceMotion = String(v) }
  const wipe = () => {
    Object.keys(localStorage).filter(k => k.startsWith('aptinexus.')).forEach(k => localStorage.removeItem(k))
    logout()
  }
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div><h1 className="text-2xl font-semibold text-[#1d1d1f]">Settings</h1><p className="text-sm text-[#6e6e73]">Synced to your AptiNexus account and used to tailor notifications and learning goals.</p></div>
      <div role="tablist" className="flex flex-wrap gap-2">{tabs.map(t => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`btn-ghost !py-1.5 ${tab === t ? 'bg-[#007AFF]/10 text-[#007AFF]' : ''}`}>{t}</button>)}</div>
      <section role="tabpanel" className="glass space-y-2 p-5">
        {tab === 'Profile preferences' && <>
          <label className="block text-sm">Career focus<select className="input mt-1" value={s.focus} onChange={e => up('focus', e.target.value)}>{['Engineering', 'Software', 'Product', 'Research'].map(f => <option key={f}>{f}</option>)}</select></label>
          <label className="block text-sm">Weekly learning goal (hours)<input type="number" min={1} max={40} className="input mt-1" value={s.hours} onChange={e => up('hours', Math.min(40, Math.max(1, Number(e.target.value) || 1)))} /></label></>}
        {tab === 'Appearance' && <><Toggle label="Reduce motion" on={motion} set={setReduce} /><p className="text-xs text-[#6e6e73]">Your system’s reduced-motion preference is always respected.</p></>}
        {tab === 'Notifications' && <><Toggle label="Learning reminders" on={s.n_reminders} set={v => up('n_reminders', v)} /><Toggle label="Roadmap milestones" on={s.n_milestones} set={v => up('n_milestones', v)} /><Toggle label="Skill recommendations" on={s.n_recs} set={v => up('n_recs', v)} /><Toggle label="Assessment results" on={s.n_results} set={v => up('n_results', v)} /><Toggle label="Profile updates" on={s.n_profile} set={v => up('n_profile', v)} /></>}
        {tab === 'Account' && <><p className="text-sm">Name: <span className="text-[#1d1d1f]">{user?.name}</span></p><p className="text-sm">Email: <span className="text-[#1d1d1f]">{user?.email}</span></p>
          {!confirmClear ? (
            <button className="btn-ghost mt-2" onClick={() => setConfirmClear(true)}>Clear local browser session & sign out</button>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-xs text-[#6e6e73]">Sign out and clear local browser cache?</span>
              <button className="btn-primary !py-1 !text-xs" onClick={wipe}>Confirm sign out</button>
              <button className="btn-ghost !py-1 !text-xs" onClick={() => setConfirmClear(false)}>Cancel</button>
            </div>
          )}</>}
        {tab === 'Privacy' && <><Toggle label="Make my profile visible to others" on={s.share} set={v => up('share', v)} /><Toggle label="Share anonymous usage analytics" on={s.analytics} set={v => up('analytics', v)} /><p className="text-xs text-[#6e6e73]">Both are off by default and saved to your account preferences.</p></>}
      </section>
    </div>
  )
}
