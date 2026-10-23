import { useCallback, useEffect, useState } from 'react';
import { get, post } from '../api';
import { formatBytes } from '../lib/format';
import { useApp, useHubEvent } from '../store';
import type { MediaStatus, Settings } from '../types';
import { Icon } from './Icon';

const EMBED_RE = /embed|bge-|minilm|e5-|gte-|nomic-bert/i;

/** Einstellungen → Medien: Werkzeug-Status + bestätigter Download, Schalter je Typ, Sprache, Modelle, Limits. */
export function MediaSettings({ save }: { save(p: Partial<Settings>): Promise<void> }) {
  const { t, lang, settings, ollama, ask, toast, toastError } = useApp();
  const [st, setSt] = useState<MediaStatus | null>(null);
  const [maxDur, setMaxDur] = useState(String(settings.mediaMaxDurationMin));
  useEffect(() => setMaxDur(String(settings.mediaMaxDurationMin)), [settings.mediaMaxDurationMin]);

  const load = useCallback(() => {
    void get<MediaStatus>('/api/media/status')
      .then(setSt)
      .catch(() => {});
  }, []);
  useEffect(load, [load]);
  useHubEvent((e) => {
    if (e.type !== 'media-setup') return;
    setSt((s) => (s ? { ...s, setup: e.setup } : s));
    if (!e.setup.running) {
      load();
      if (e.setup.done.length && !e.setup.error) toast(t('set.mediaInstallDone'), 'success');
    }
  });

  const modelItems = (st?.items ?? []).filter((i) => i.id.startsWith('model-'));
  const whisperChoices = [...new Set([...modelItems.map((i) => i.id.slice(6)), ...(st?.tools.models ?? []), settings.whisperModel])];
  const missing = (st?.items ?? []).filter((i) => !i.installed && (!i.id.startsWith('model-') || i.id === `model-${settings.whisperModel}`));
  const size = missing.reduce((n, i) => n + i.size, 0);
  const setup = st?.setup;

  const install = async () => {
    if (!st || !missing.length) return;
    const list = missing.map((i) => `• ${i.label} – ${formatBytes(i.size, lang)}`).join('\n');
    const ok = await ask({ title: t('set.mediaInstallTitle'), message: `${t('set.mediaInstallText', { dir: st.toolsDir })}\n\n${list}`, confirmLabel: t('set.mediaInstallConfirm') });
    if (ok !== true) return;
    try {
      await post('/api/media/setup', { ids: missing.map((i) => i.id), confirm: true });
      load();
    } catch (err) {
      toastError(err);
    }
  };

  const toggle = (key: keyof Settings, label: string) => (
    <label className="toggle-row" key={key}>
      <input type="checkbox" checked={settings[key] as boolean} onChange={(ev) => void save({ [key]: ev.target.checked })} />
      <span>{label}</span>
    </label>
  );
  const tool = (label: string, ok: boolean) => (
    <li key={label}>
      <span>{label}</span>
      <span className={`badge ${ok ? 'ok' : 'warn'}`}>{ok ? t('set.toolInstalled') : t('set.toolMissing')}</span>
    </li>
  );
  const visionModels = ollama.models.filter((m) => !EMBED_RE.test(m.name) && !EMBED_RE.test(m.family ?? ''));

  return (
    <section className="settings-section glass" aria-labelledby="media-settings">
      <h2 id="media-settings">
        <Icon name="video" /> {t('set.media')}
      </h2>
      <h3>{t('set.mediaTools')}</h3>
      <ul className="model-list">
        {tool('ffmpeg', !!st?.tools.ffmpeg)}
        {tool('whisper.cpp', !!st?.tools.whisper)}
        {tool(`${t('set.whisperModel')} „${settings.whisperModel}“`, !!st?.tools.models.includes(settings.whisperModel))}
      </ul>
      <small className="muted">{t('set.mediaToolsHint')}</small>
      {st && !st.supported && <p className="warn small">{t('set.mediaUnsupported', { dir: st.toolsDir })}</p>}
      {st?.supported && missing.length > 0 && !setup?.running && (
        <div className="row gap wrap">
          <button className="btn small primary" onClick={() => void install()}>
            <Icon name="download" size={14} /> {t('set.mediaInstall', { size: formatBytes(size, lang) })}
          </button>
        </div>
      )}
      {setup?.running && setup.current && (
        <div className="job-progress" role="status">
          <div className="mini-bar wide">
            <span style={{ width: `${setup.total ? Math.round((setup.received / setup.total) * 100) : 0}%` }} />
          </div>
          <span className="muted small mono">{t('set.mediaInstalling', { id: setup.current, p: setup.total ? Math.round((setup.received / setup.total) * 100) : 0 })}</span>
          <button className="btn small ghost" onClick={() => void post('/api/media/setup/cancel')}>
            {t('queue.cancel')}
          </button>
        </div>
      )}
      {setup?.error && <p className="err small">{`${setup.error.id}: ${t(`detail.${setup.error.code}` as 'detail.download_network')}`}</p>}
      <small className="muted">{t('set.mediaCli')}</small>
      <code className="mono small cli-cmd">node scripts/setup-media.mjs</code>

      <h3>{t('set.mediaTypes')}</h3>
      {toggle('mediaImages', t('set.mediaImages'))}
      {toggle('mediaScanOcr', t('set.mediaScanOcr'))}
      {toggle('mediaAudio', t('set.mediaAudio'))}
      {toggle('mediaVideo', t('set.mediaVideo'))}
      {toggle('mediaKeyframes', t('set.mediaKeyframes'))}
      {toggle('mediaEmbeddedImages', t('set.mediaEmbedded'))}

      <div className="seg-field">
        <span>{t('set.mediaLanguage')}</span>
        <div className="segmented" role="radiogroup" aria-label={t('set.mediaLanguage')}>
          {(['auto', 'de', 'en'] as const).map((l) => (
            <button key={l} role="radio" aria-checked={settings.mediaLanguage === l} className={settings.mediaLanguage === l ? 'active' : ''} onClick={() => void save({ mediaLanguage: l })}>
              {l === 'auto' ? t('set.langAuto') : l === 'de' ? 'Deutsch' : 'English'}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span>{t('set.whisperModel')}</span>
        <select className="input" value={settings.whisperModel} onChange={(ev) => void save({ whisperModel: ev.target.value })}>
          {whisperChoices.map((m) => (
            <option key={m} value={m}>
              {st?.tools.models.includes(m) ? m : `${m} (${t('set.notInstalled')})`}
            </option>
          ))}
        </select>
        <small className="muted">{t('set.whisperHint')}</small>
      </label>
      <label className="field">
        <span>{t('set.visionModel')}</span>
        <select className="input" value={settings.visionModel} onChange={(ev) => void save({ visionModel: ev.target.value })}>
          {!visionModels.some((m) => m.name === settings.visionModel || m.name === `${settings.visionModel}:latest`) && (
            <option value={settings.visionModel}>{`${settings.visionModel} (${t('set.notInstalled')})`}</option>
          )}
          {visionModels.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>
        <small className="muted">{t('set.visionHint')}</small>
      </label>
      <label className="field">
        <span>{t('set.maxDuration')}</span>
        <input
          className="input"
          type="number"
          min={1}
          max={1440}
          value={maxDur}
          onChange={(ev) => setMaxDur(ev.target.value)}
          onBlur={() => {
            const n = Math.round(Number(maxDur));
            if (Number.isFinite(n) && n >= 1 && n <= 1440 && n !== settings.mediaMaxDurationMin) void save({ mediaMaxDurationMin: n });
            else setMaxDur(String(settings.mediaMaxDurationMin));
          }}
        />
      </label>
    </section>
  );
}
