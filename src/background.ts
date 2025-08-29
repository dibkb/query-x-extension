/* eslint-disable @typescript-eslint/no-explicit-any */

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
        resolve({
          text: textContent,
          length: textContent.length,
          title: document.title,
          url: location.href,
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
    return { url, ok: true, ...(result as object) };
  } catch (error) {
    return { url, ok: false, error: String(error) };
  } finally {
    if (tab.id) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (error) {
        console.error(error);
      }
    }
  }
}

chrome.runtime.onMessageExternal.addListener(
  (message, _sender, sendResponse) => {
    if (!message || message.type !== "SCRAPE_URLS") return;
    const urls: string[] = Array.isArray(message.urls) ? message.urls : [];
    if (urls.length === 0) {
      sendResponse({ ok: false, error: "No URLs provided" });
      return;
    }

    (async () => {
      const concurrency = 5;
      const queue = [...urls];
      const results: any[] = [];

      const workers = new Array(Math.min(concurrency, queue.length))
        .fill(null)
        .map(async () => {
          while (queue.length > 0) {
            const next = queue.shift();
            if (!next) break;
            const res = await processUrl(next);
            results.push(res);
          }
        });

      await Promise.all(workers);
      sendResponse({ ok: true, results });
    })();
    return true;
  }
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "SCRAPE_URLS") return;
  chrome.runtime.sendMessage(message, sendResponse);
  return true;
});
