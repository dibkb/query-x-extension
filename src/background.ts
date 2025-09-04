/* eslint-disable @typescript-eslint/no-explicit-any */

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const activeUrlTasks = new Map<string, Promise<any>>();

function normalizeUrlString(raw: string): string {
  try {
    const u = new URL(String(raw || "").trim());
    u.hash = "";
    return u.href;
  } catch {
    return String(raw || "").trim();
  }
}

async function execInTab<T = any>(
  tabId: number,
  func: (...args: any[]) => T,
  args: any[] = []
): Promise<T> {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: func as unknown as (...args: any[]) => T,
    args,
    world: "MAIN",
  });
  return injection.result as T;
}

function pageScrollAndExtract(durationMs = 3000) {
  return new Promise((resolve) => {
    let totalHeight = 0;
    const distance = 400;
    const endTime = Date.now() + durationMs;

    function cleanExtractedText(raw: string) {
      try {
        let s = String(raw || "");
        // Normalize newlines
        s = s.replace(/\r\n?/g, "\n");
        // Remove fenced code blocks
        s = s.replace(/```[\s\S]*?```/g, " ");
        // Inline code backticks
        s = s.replace(/`([^`]+)`/g, "$1");
        // Images: keep alt text
        s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1");
        // Links: keep link text
        s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
        // Headings: drop leading # markers
        s = s.replace(/^\s{0,3}#{1,6}\s*/gm, "");
        // Blockquotes: drop leading >
        s = s.replace(/^\s*>\s?/gm, "");
        // List bullets and ordered list markers
        s = s.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "");
        // Emphasis markers
        s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
        s = s.replace(/\*([^*]+)\*/g, "$1");
        s = s.replace(/__([^_]+)__/g, "$1");
        s = s.replace(/_([^_]+)_/g, "$1");
        // Horizontal rules
        s = s.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, " ");
        // Collapse all whitespace (including newlines and non-breaking spaces)
        s = s.replace(/[\s\u00A0]+/g, " ").trim();
        return s;
      } catch {
        return String(raw || "")
          .replace(/[\s\u00A0]+/g, " ")
          .trim();
      }
    }

    function collectImageUrls(): string[] {
      try {
        const urls = new Set<string>();
        const toAbs = (u: string) => {
          try {
            return new URL(u, document.baseURI).href;
          } catch {
            return u;
          }
        };

        // <img src>
        Array.from(document.images).forEach((img) => {
          const src =
            (img as HTMLImageElement).src ||
            (img as HTMLImageElement).getAttribute("src") ||
            "";
          if (src) urls.add(toAbs(src));
          const srcset =
            (img as HTMLImageElement).srcset ||
            (img as HTMLImageElement).getAttribute("srcset") ||
            "";
          if (srcset) {
            srcset
              .split(",")
              .map((s) => s.trim().split(/\s+/)[0])
              .filter(Boolean)
              .forEach((u) => urls.add(toAbs(u)));
          }
        });

        // <source srcset> inside <picture>
        document.querySelectorAll("source[srcset]").forEach((el) => {
          const srcset = (el.getAttribute("srcset") || "").trim();
          if (!srcset) return;
          srcset
            .split(",")
            .map((s) => s.trim().split(/\s+/)[0])
            .filter(Boolean)
            .forEach((u) => urls.add(toAbs(u)));
        });

        return Array.from(urls);
      } catch {
        return [];
      }
    }

    const timer = setInterval(() => {
      window.scrollBy(0, distance);
      totalHeight += distance;
      if (Date.now() >= endTime || totalHeight >= document.body.scrollHeight) {
        clearInterval(timer);

        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: (node) => {
              if (!(node as any).parentElement) return NodeFilter.FILTER_REJECT;
              const style = window.getComputedStyle(
                (node as any).parentElement as Element
              );
              const isHidden =
                style.display === "none" ||
                style.visibility === "hidden" ||
                parseFloat((style.opacity || "1") as string) === 0;
              if (isHidden) return NodeFilter.FILTER_REJECT;
              const text = (node.nodeValue || "").replace(/\s+/g, " ").trim();
              if (!text) return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            },
          }
        );

        const parts: string[] = [];
        while (walker.nextNode()) {
          parts.push((walker.currentNode as any).nodeValue as string);
        }
        const textContent = parts.join("\n");
        const cleaned = cleanExtractedText(textContent);
        const imgurl = collectImageUrls();
        resolve({
          text: cleaned,
          length: cleaned.length,
          title: document.title,
          url: location.href,
          imgurl,
        });
      }
    }, 150);
  });
}

async function processUrl(url: string) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    for (let i = 0; i < 60; i++) {
      const updated = await chrome.tabs.get(tab.id!);
      if (updated && updated.status === "complete") break;
      await delay(250);
    }
    const result = await execInTab(tab.id!, pageScrollAndExtract, [3000]);
    return { url, ok: true, tabId: tab.id!, ...(result as object) };
  } catch (error) {
    return { url, ok: false, tabId: tab.id!, error: String(error) };
  }
}

function scrapeUrlOnce(url: string): Promise<any> {
  const key = normalizeUrlString(url);
  const existing = activeUrlTasks.get(key);
  if (existing) return existing;
  const task = (async () => {
    return await processUrl(key);
  })().finally(() => {
    activeUrlTasks.delete(key);
  });
  activeUrlTasks.set(key, task);
  return task;
}

chrome.runtime.onMessageExternal.addListener(
  (message, _sender, sendResponse) => {
    if (!message || message.type !== "SCRAPE_URLS") return;
    const urls: string[] = Array.isArray(message.urls) ? message.urls : [];
    const uniqueUrls = Array.from(
      new Set(
        urls
          .filter((u) => typeof u === "string" && u.trim().length > 0)
          .map((u) => normalizeUrlString(u))
      )
    );
    if (uniqueUrls.length === 0) {
      sendResponse({ ok: false, error: "No URLs provided" });
      return;
    }

    (async () => {
      const concurrency = 5;
      const queue = [...uniqueUrls];
      const results: any[] = [];

      const workers = new Array(Math.min(concurrency, queue.length))
        .fill(null)
        .map(async () => {
          while (queue.length > 0) {
            const next = queue.shift();
            if (!next) break;
            const res = await scrapeUrlOnce(next);
            results.push(res);
          }
        });

      await Promise.all(workers);
      sendResponse({ ok: true, results });
      // After responding, close all created tabs
      const tabIdsToClose = Array.from(
        new Set(
          results
            .map((r) =>
              r && typeof r.tabId === "number" ? (r.tabId as number) : null
            )
            .filter((id): id is number => id !== null)
        )
      );
      if (tabIdsToClose.length > 0) {
        try {
          await chrome.tabs.remove(tabIdsToClose);
        } catch (error) {
          console.error(error);
        }
      }
    })();
    return true;
  }
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "SCRAPE_URLS") return;
  chrome.runtime.sendMessage(message, sendResponse);
  return true;
});
