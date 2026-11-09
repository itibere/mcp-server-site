// HTMLRewriter so existe no runtime do Workers: versao minima para o Node que
// chama os handlers de a[href], iframe[src] e script[src] e devolve o mesmo corpo.
export function instalarHtmlRewriter(t) {
  const original = globalThis.HTMLRewriter;
  const tags = {
    "a[href]": /<a\s[^>]*href="([^"]*)"/gi,
    "iframe[src]": /<iframe\s[^>]*src="([^"]*)"/gi,
    "script[src]": /<script\s[^>]*src="([^"]*)"/gi,
  };
  globalThis.HTMLRewriter = class {
    constructor() {
      this.regras = [];
    }
    on(seletor, handlers) {
      this.regras.push([seletor, handlers]);
      return this;
    }
    transform(res) {
      const regras = this.regras;
      const body = new ReadableStream({
        async start(c) {
          const html = await res.text();
          for (const [seletor, handlers] of regras) {
            if (!tags[seletor]) continue;
            for (const m of html.matchAll(tags[seletor])) handlers.element?.({ getAttribute: () => m[1], tagName: seletor, onEndTag() {} });
          }
          c.enqueue(new TextEncoder().encode(html));
          c.close();
        },
      });
      return { body };
    }
  };
  t.after(() => {
    globalThis.HTMLRewriter = original;
  });
}
