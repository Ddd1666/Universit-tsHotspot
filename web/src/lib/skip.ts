/**
 * Ordner-/Datei-Import: System- und Werkzeugordner überspringen (gleiche Liste wie beim ZIP-Import auf dem Server).
 * Rein funktional (ohne DOM), damit es getestet werden kann.
 */
const SKIP_DIRS = /(^|\/)(__MACOSX|\.git|\.svn|\.hg|node_modules|__pycache__|\.venv|venv|\.idea|\.vscode|\.mypy_cache|\.pytest_cache|\.tox|\.ipynb_checkpoints)(\/|$)/i;
const SKIP_FILES = /(^|\/)(\.[^/]*|Thumbs\.db|desktop\.ini|~\$[^/]*)$/i;

export function shouldSkipPath(relPathOrName: string): boolean {
  const p = relPathOrName.replace(/\\/g, '/');
  return SKIP_DIRS.test(p) || SKIP_FILES.test(p);
}
