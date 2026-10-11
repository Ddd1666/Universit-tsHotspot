import { useEffect, useState, type ReactNode } from 'react';
import { get, post, put } from '../api';
import { Icon } from '../components/Icon';
import { ViewHeader } from '../components/ViewHeader';
import { formatBytes } from '../lib/format';
import { useApp } from '../store';
import type { OllamaStatus, QueueStatus, Settings } from '../types';

const EMBED_RE = /embed|bge-|minilm|e5-|gte-|nomic-bert/i;
const NUM_CTX = [2048, 4096, 8192, 12288, 16384, 32768];

function Section({ title, icon, children }: { title: string; icon: string; children: ReactNode }) {
  return (
    <section className="settings-section glass">
      <h2>
        <Icon name={icon} /> {title}
      </h2>
      {children}
    </section>
  );
}

function CopyCmd({ cmd }: { cmd: string }) {
  const { t } = useApp();
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-cmd">
      <code>{cmd}</code>
      <button
        className="btn small"
        onClick={() =>
          void navigator.clipboard?.writeText(cmd).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? t('set.copied') : t('set.copy')}
      </button>
    </div>
  );
}

function NumberField({ label, value, min, max, onCommit }: { label: string; value: number; min: number; max: number; onCommit(v: number): void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="input"
        type="number"
        min={min}
        max={max}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const n = Math.round(Number(v));
          if (Number.isFinite(n) && n >= min && n <= max && n !== value) onCommit(n);
          else setV(String(value));
        }}
      />
    </label>
  );
}

export function SettingsView() {
  const { t, settings, updateSettings, ollama, setOllama, queue, boot, stats, toast, ask } = useApp();
  const [url, setUrl] = useState(settings.ollamaUrl);
  const [dataDir, setDataDir] = useState('');
  const [checking, setChecking] = useState(false);
  const [info, setInfo] = useState<{ dataDir: string; dataDirConfigured: string | null } | null>(null);
  const [temp, setTemp] = useState(settings.temperature);
  useEffect(() => setTemp(settings.temperature), [settings.temperature]);

  useEffect(() => setUrl(settings.ollamaUrl), [settings.ollamaUrl]);
  useEffect(() => {
    void get<{ dataDir: string; dataDirConfigured: string | null }>('/api/settings').then(setInfo);
  }, []);

  const save = async (p: Partial<Settings>) => {
    try {
      await updateSettings(p);
      toast(t('set.saved'), 'success');
    } catch {
      /* Toast kommt aus updateSettings */
    }
  };

  const refresh = async () => {
    setChecking(true);
    try {
      setOllama(await post<OllamaStatus>('/api/ollama/refresh'));
    } finally {
      setChecking(false);
    }
  };

  const reindex = async () => {
    if ((await ask({ title: t('set.reindex'), message: t('set.reindexConfirm'), confirmLabel: t('set.reindex') })) !== true) return;
    await post<{ queue: QueueStatus }>('/api/index/reindex');
    toast(t('set.saved'), 'success');
  };

  const chatModels = ollama.models.filter((m) => !EMBED_RE.test(m.name) && !EMBED_RE.test(m.family ?? ''));
  const embedModels = ollama.models.filter((m) => EMBED_RE.test(m.name) || EMBED_RE.test(m.family ?? ''));
  const installed = (name: string) => ollama.models.some((m) => m.name === name || m.name === `${name}:latest`);
  const e = queue.embed;

  return (
    <div className="view settings-view">
      <ViewHeader icon="settings" title={<h1>{t('set.title')}</h1>} />
      <div className="settings-grid">
        {boot.mock && (
          <div className="notice warn wide" role="note">
            <Icon name="alert" size={16} /> {t('set.mock')}
          </div>
        )}

        <Section title={t('set.ollama')} icon="cpu">
          <div className="row gap wrap">
            <span className={`badge ${ollama.reachable ? 'ok' : 'err'}`}>{ollama.reachable ? t('set.reachable') : t('set.unreachable')}</span>
            {ollama.version && (
              <span className="muted small mono">
                {t('set.version')} {ollama.version}
              </span>
            )}
            <span className="spacer" />
            <button className="btn small" onClick={() => void refresh()} disabled={checking}>
              <Icon name="refresh" size={14} /> {t('set.refresh')}
            </button>
          </div>
          <label className="field">
            <span>{t('set.url')}</span>
            <div className="row gap">
              <input className="input mono" value={url} onChange={(ev) => setUrl(ev.target.value)} disabled={boot.mock} />
              <button className="btn small" disabled={url === settings.ollamaUrl || boot.mock} onClick={() => void save({ ollamaUrl: url })}>
                {t('lib.save')}
              </button>
            </div>
          </label>
          {!ollama.reachable && (
            <div className="help-box">
              <strong>{t('set.ollamaHelpTitle')}</strong>
              <ol>
                <li>{t('set.ollamaHelp1')}</li>
                <li>{t('set.ollamaHelp2')}</li>
                <li>{t('set.ollamaHelp3')}</li>
              </ol>
              {ollama.error && <p className="muted small mono">{ollama.error}</p>}
            </div>
          )}
          {ollama.reachable && (
            <>
              <h3>{t('set.running')}</h3>
              {ollama.running.length === 0 && <p className="muted small">{t('set.noneRunning')}</p>}
              {ollama.running.map((r) => (
                <div key={r.name} className="vram-row">
                  <span className="mono">{r.name}</span>
                  <span className="muted small">
                    {formatBytes(r.sizeVram)} VRAM / {formatBytes(r.size)}
                    {r.contextLength ? ` · ctx ${r.contextLength}` : ''}
                  </span>
                  <div className="mini-bar wide" aria-label={t('set.gpu', { p: r.gpuPercent })}>
                    <span style={{ width: `${r.gpuPercent}%` }} />
                  </div>
                  <span className={r.gpuPercent < 100 ? 'warn small' : 'ok small'}>{t('set.gpu', { p: r.gpuPercent })}</span>
                  {r.gpuPercent < 100 && <p className="warn small full">{t('set.cpuWarn')}</p>}
                </div>
              ))}
              <h3>{t('set.installed')}</h3>
              <ul className="model-list">
                {ollama.models.map((m) => (
                  <li key={m.name}>
                    <span className="mono">{m.name}</span>
                    <span className="muted small">
                      {[m.parameterSize, m.quantization, formatBytes(m.size)].filter(Boolean).join(' · ')}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>

        <Section title={t('set.models')} icon="brain">
          <label className="field">
            <span>{t('set.chatModel')}</span>
            <select className="input" value={settings.chatModel} onChange={(ev) => void save({ chatModel: ev.target.value })}>
              {!installed(settings.chatModel) && <option value={settings.chatModel}>{`${settings.chatModel} (${t('set.notInstalled')})`}</option>}
              {chatModels.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
            <small className="muted">{t('set.chatModelHint')}</small>
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={settings.thinking} onChange={(ev) => void save({ thinking: ev.target.checked })} />
            <span>{t('set.thinking')}</span>
          </label>
          <label className="field">
            <span>
              {t('set.temperature')}: <strong className="mono">{temp.toFixed(1)}</strong>
            </span>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.1}
              value={temp}
              onChange={(ev) => setTemp(Number(ev.target.value))}
              onPointerUp={() => temp !== settings.temperature && void save({ temperature: temp })}
              onKeyUp={() => temp !== settings.temperature && void save({ temperature: temp })}
            />
          </label>
          <label className="field">
            <span>{t('set.numCtx')}</span>
            <select className="input" value={settings.numCtx} onChange={(ev) => void save({ numCtx: Number(ev.target.value) })}>
              {[...new Set([...NUM_CTX, settings.numCtx])].sort((a, b) => a - b).map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString()} Token
                </option>
              ))}
            </select>
            <small className="muted">
              <Icon name="info" size={13} /> {t('set.numCtxHint')}
            </small>
          </label>

          <label className="field">
            <span>{t('set.embedModel')}</span>
            <select className="input" value={settings.embeddingModel} onChange={(ev) => void save({ embeddingModel: ev.target.value })}>
              {!installed(settings.embeddingModel) && <option value={settings.embeddingModel}>{`${settings.embeddingModel} (${t('set.notInstalled')})`}</option>}
              {embedModels.map((m) => (
                <option key={m.name} value={m.name.replace(/:latest$/, '')}>
                  {m.name.replace(/:latest$/, '')}
                </option>
              ))}
              {!installed('bge-m3') && <option value="bge-m3">{`bge-m3 (${t('set.notInstalled')})`}</option>}
            </select>
            <small className="muted">{t('set.embedHint')}</small>
            <CopyCmd cmd="ollama pull bge-m3" />
          </label>
          {e.reindexNeeded && (
            <div className="notice warn" role="alert">
              <Icon name="alert" size={16} />
              <span>{t('set.reindexNeeded', { old: e.indexModel ?? '?', new: e.settingsModel })}</span>
              <button className="btn small primary" onClick={() => void reindex()}>
                {t('set.reindex')}
              </button>
            </div>
          )}
          <div className="index-box">
            <div className="row gap wrap">
              <strong>{t('set.index')}</strong>
              <span className={`badge ${e.state === 'idle' ? 'ok' : e.state === 'running' ? 'accent' : 'warn'}`}>{t(`set.embedState.${e.state}`)}</span>
              <span className="spacer" />
              {!e.reindexNeeded && (
                <button className="btn small ghost" onClick={() => void reindex()}>
                  <Icon name="refresh" size={14} /> {t('set.reindex')}
                </button>
              )}
            </div>
            <p className="muted small mono">
              {t('set.indexInfo', { model: e.indexModel ?? '–', dim: e.indexDim ?? '–', done: e.done, pending: e.pending, failed: e.failed })}
            </p>
            {e.lastError && <p className="warn small">{e.lastError}</p>}
          </div>
        </Section>

        <Section title={t('set.appearance')} icon="sun">
          <div className="seg-field">
            <span>{t('set.language')}</span>
            <div className="segmented" role="radiogroup" aria-label={t('set.language')}>
              {(['de', 'en'] as const).map((l) => (
                <button key={l} role="radio" aria-checked={settings.language === l} className={settings.language === l ? 'active' : ''} onClick={() => void updateSettings({ language: l })}>
                  {l === 'de' ? 'Deutsch' : 'English'}
                </button>
              ))}
            </div>
          </div>
          <div className="seg-field">
            <span>{t('set.theme')}</span>
            <div className="segmented" role="radiogroup" aria-label={t('set.theme')}>
              {(['dark', 'light'] as const).map((th) => (
                <button key={th} role="radio" aria-checked={settings.theme === th} className={settings.theme === th ? 'active' : ''} onClick={() => void updateSettings({ theme: th })}>
                  <Icon name={th === 'dark' ? 'moon' : 'sun'} size={14} /> {t(th === 'dark' ? 'set.dark' : 'set.light')}
                </button>
              ))}
            </div>
          </div>
          <div className="seg-field">
            <span>{t('set.accent')}</span>
            <div className="segmented" role="radiogroup" aria-label={t('set.accent')}>
              {(['cyan', 'violet', 'lime'] as const).map((a) => (
                <button key={a} role="radio" aria-checked={settings.accent === a} className={settings.accent === a ? 'active' : ''} onClick={() => void updateSettings({ accent: a })}>
                  <span className={`accent-dot ${a}`} /> {a}
                </button>
              ))}
            </div>
          </div>
          <div className="seg-field">
            <span>{t('set.motion')}</span>
            <div className="segmented" role="radiogroup" aria-label={t('set.motion')}>
              {(['system', 'reduced'] as const).map((m) => (
                <button key={m} role="radio" aria-checked={settings.motion === m} className={settings.motion === m ? 'active' : ''} onClick={() => void updateSettings({ motion: m })}>
                  {t(m === 'system' ? 'set.motionSystem' : 'set.motionReduced')}
                </button>
              ))}
            </div>
          </div>
        </Section>

        <Section title={t('set.import')} icon="upload">
          <div className="field-grid">
            <NumberField label={t('set.maxFile')} value={settings.maxFileSizeMB} min={1} max={4096} onCommit={(v) => void save({ maxFileSizeMB: v })} />
            <NumberField label={t('set.zipEntries')} value={settings.zipMaxEntries} min={1} max={100000} onCommit={(v) => void save({ zipMaxEntries: v })} />
            <NumberField label={t('set.zipTotal')} value={settings.zipMaxTotalMB} min={1} max={16384} onCommit={(v) => void save({ zipMaxTotalMB: v })} />
            <NumberField label={t('set.topK')} value={settings.retrievalTopK} min={1} max={30} onCommit={(v) => void save({ retrievalTopK: v })} />
          </div>
        </Section>

        <Section title={t('set.data')} icon="folder">
          <label className="field">
            <span>{t('set.dataDir')}</span>
            <CopyCmd cmd={info?.dataDir ?? boot.dataDir} />
            <small className="muted">{t('set.dataDirHint')}</small>
          </label>
          <p className="muted small mono">
            {t('set.stats', { sources: stats.sources, chunks: stats.chunks, vectors: stats.vectors, size: formatBytes(stats.bytes) })} · {boot.vectorStore}
          </p>
          <label className="field">
            <span>{t('set.dataDirChange')}</span>
            <div className="row gap">
              <input
                className="input mono"
                value={dataDir}
                onChange={(ev) => setDataDir(ev.target.value)}
                placeholder={boot.platform === 'win32' ? 'D:\\Uni-Hotspot-Daten' : '/pfad/zum/ordner'}
              />
              <button
                className="btn small"
                disabled={!dataDir.trim()}
                onClick={async () => {
                  try {
                    await put('/api/settings/data-dir', { path: dataDir.trim() });
                    toast(t('set.dataDirSaved'), 'success');
                    setDataDir('');
                  } catch (err) {
                    toast((err as Error).message, 'error');
                  }
                }}
              >
                {t('lib.save')}
              </button>
            </div>
            {info?.dataDirConfigured && info.dataDirConfigured !== info.dataDir && <small className="warn">{t('set.dataDirSaved')}</small>}
          </label>
        </Section>

        <Section title={t('set.about')} icon="info">
          <p>
            <strong>Uni-Hotspot</strong> <span className="mono muted">v{boot.version}</span>
          </p>
          <p className="muted">{t('set.privacy')}</p>
        </Section>
      </div>
    </div>
  );
}
