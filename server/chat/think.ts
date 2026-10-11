/**
 * Trennt <think>…</think>-Blöcke (z. B. qwen3/deepseek-r1 ohne natives `think`-Feld) aus einem Token-Stream.
 * Robust gegen Tags, die über mehrere Tokens verteilt ankommen.
 */
export class ThinkSplitter {
  private buf = '';
  private inThink = false;

  push(chunk: string): { content: string; thinking: string } {
    this.buf += chunk;
    let content = '';
    let thinking = '';
    for (;;) {
      const tag = this.inThink ? '</think>' : '<think>';
      const idx = this.buf.indexOf(tag);
      if (idx !== -1) {
        const before = this.buf.slice(0, idx);
        if (this.inThink) thinking += before;
        else content += before;
        this.buf = this.buf.slice(idx + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      // möglichen Tag-Anfang am Ende zurückhalten
      let keep = 0;
      for (let k = Math.min(tag.length - 1, this.buf.length); k > 0; k--) {
        if (tag.startsWith(this.buf.slice(-k))) {
          keep = k;
          break;
        }
      }
      const emit = this.buf.slice(0, this.buf.length - keep);
      this.buf = this.buf.slice(this.buf.length - keep);
      if (this.inThink) thinking += emit;
      else content += emit;
      return { content, thinking };
    }
  }

  flush(): { content: string; thinking: string } {
    const rest = this.buf;
    this.buf = '';
    return this.inThink ? { content: '', thinking: rest } : { content: rest, thinking: '' };
  }
}
