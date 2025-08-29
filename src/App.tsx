"use client";

function App() {
  const getUrl = async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
    });
    chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      func: () => {
        alert("Hello from Query X");
      },
    });
  };

  return (
    <main className="flex flex-col items-center justify-center w-full h-full min-h-screen bg-zinc-900 text-white">
      <div>
        <h1>Query X Extension</h1>
      </div>
      <div>
        <button onClick={getUrl} className="">
          Get URL
        </button>
      </div>
    </main>
  );
}

export default App;
